//! Agent 循环：流式事件发布、工具执行、权限询问、中止与断点续传。

use crate::hub::{Hub, RunHandle};
use anyhow::Result;
use futures::StreamExt;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use worldbase_protocol::event::{EventFrame, EventKind, StreamChannel};
use worldbase_protocol::types::{
    Capabilities, ChatContentPart, ChatMessage, ChatRunContext, ImageUrl as ProtocolImageUrl, Role,
    ToolCallRecord, ToolDescriptor, ToolResultRecord,
};
use worldbase_providers::{ChatOptions, ContentBlock, LlmMessage, LlmRole, LlmTool, StreamChunk};

/// 单轮/多轮工具循环的最大步数（防失控）。
// Keep the segment budget aligned with Electron's agent loop.  A terminal
// event is emitted when this guard is reached, so callers never wait forever
// for a stream that silently stopped after the last tool result.
const MAX_STEPS: usize = 128;
const MAX_DUPLICATE_ITERATIONS: usize = 6;
const MAX_TOKENS: u32 = 8192;
// Electron's longest foreground tool timeout is currently five minutes, and
// spawn_subagents can legitimately outlive one foreground command. Keep the
// transport deadline comfortably above either handler's own lifecycle.
const ELECTRON_HOST_TOOL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1800);

fn serialize_tool_result(result: Result<serde_json::Value>) -> (String, bool) {
    match result {
        Ok(value) => {
            // Match Electron AgentCore: a structured result containing an
            // `error` field is a failed tool call even when the handler chose
            // to return it instead of throwing.
            let is_error = value
                .as_object()
                .is_some_and(|object| object.contains_key("error"));
            (
                serde_json::to_string(&value).unwrap_or_else(|_| "null".into()),
                is_error,
            )
        }
        Err(error) => (error.to_string(), true),
    }
}

/// ChatMessage 历史 → LLM 消息历史。
pub fn to_llm_messages(messages: &[ChatMessage]) -> Vec<LlmMessage> {
    let mut out = Vec::new();
    let mut index = 0;
    while index < messages.len() {
        let msg = &messages[index];

        // Tool responses are meaningful only as the contiguous response batch
        // for the immediately preceding assistant tool calls. Orphaned
        // responses must never become ordinary user text.
        if !msg.tool_results.is_empty() {
            index += 1;
            continue;
        }

        if msg.role == Role::Assistant && !msg.tool_calls.is_empty() {
            let mut expected_ids = std::collections::HashSet::new();
            let metadata_valid = msg.tool_calls.iter().all(|call| {
                !call.id.trim().is_empty()
                    && !call.name.trim().is_empty()
                    && call.args.is_object()
                    && expected_ids.insert(call.id.trim().to_string())
            });

            if !metadata_valid {
                // Preserve useful prose from a malformed assistant record, but
                // strip calls that no provider can safely replay.
                if !msg.content.is_empty() {
                    out.push(LlmMessage::text(LlmRole::Assistant, msg.content.clone()));
                }
                index += 1;
                continue;
            }

            let mut next_index = index + 1;
            let mut matched_ids = std::collections::HashSet::new();
            let mut result_blocks = Vec::new();
            let mut invalid_results = false;
            while next_index < messages.len() && !messages[next_index].tool_results.is_empty() {
                for result in &messages[next_index].tool_results {
                    let id = result.tool_call_id.trim();
                    if id.is_empty()
                        || !expected_ids.contains(id)
                        || !matched_ids.insert(id.to_string())
                    {
                        invalid_results = true;
                        break;
                    }
                    result_blocks.push(ContentBlock::ToolResult {
                        tool_use_id: result.tool_call_id.clone(),
                        content: result.content.clone(),
                        is_error: result.is_error,
                    });
                }
                next_index += 1;
            }

            // Providers require an exact one-to-one tool response batch. Drop
            // the whole interrupted batch when even one response is missing,
            // duplicated, or unrelated; the following ordinary user turn is
            // still retained on its next iteration.
            if !invalid_results
                && !result_blocks.is_empty()
                && matched_ids.len() == expected_ids.len()
            {
                let mut assistant_blocks = record_content_blocks(msg);
                assistant_blocks.extend(msg.tool_calls.iter().map(|call| ContentBlock::ToolUse {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    input: call.args.clone(),
                    raw_input: None,
                    input_error: None,
                }));
                out.push(LlmMessage {
                    role: LlmRole::Assistant,
                    content: assistant_blocks,
                });
                out.push(LlmMessage {
                    role: LlmRole::User,
                    content: result_blocks,
                });
            }
            index = next_index;
            continue;
        }

        let blocks = record_content_blocks(msg);
        if !blocks.is_empty() {
            let role = match msg.role {
                Role::Assistant => LlmRole::Assistant,
                _ => LlmRole::User,
            };
            out.push(LlmMessage {
                role,
                content: blocks,
            });
        }
        index += 1;
    }
    out
}

fn record_content_blocks(message: &ChatMessage) -> Vec<ContentBlock> {
    if message.parts.is_empty() {
        return (!message.content.is_empty())
            .then(|| ContentBlock::Text {
                text: message.content.clone(),
            })
            .into_iter()
            .collect();
    }

    let mut blocks = Vec::new();
    let mut has_text_part = false;
    for part in &message.parts {
        match part {
            ChatContentPart::Text { text } if !text.is_empty() => {
                has_text_part = true;
                blocks.push(ContentBlock::Text { text: text.clone() });
            }
            ChatContentPart::ImageUrl { image_url } if !image_url.url.is_empty() => {
                blocks.push(ContentBlock::ImageUrl {
                    url: image_url.url.clone(),
                });
            }
            ChatContentPart::Thinking {
                thinking,
                signature,
            } => {
                blocks.push(ContentBlock::Thinking {
                    thinking: thinking.clone(),
                    signature: signature.clone(),
                });
            }
            ChatContentPart::RedactedThinking { data } => {
                blocks.push(ContentBlock::RedactedThinking { data: data.clone() });
            }
            _ => {}
        }
    }
    if !has_text_part && !message.content.is_empty() {
        blocks.insert(
            0,
            ContentBlock::Text {
                text: message.content.clone(),
            },
        );
    }
    blocks
}

fn persisted_content_parts(message: &LlmMessage) -> Vec<ChatContentPart> {
    // Keep the legacy compact representation for ordinary text-only replies;
    // once a provider block or image is present, retain every replayable block
    // in its original order.
    if !message.content.iter().any(|block| {
        matches!(
            block,
            ContentBlock::ImageUrl { .. }
                | ContentBlock::Thinking { .. }
                | ContentBlock::RedactedThinking { .. }
        )
    }) {
        return Vec::new();
    }

    message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } if !text.is_empty() => {
                Some(ChatContentPart::Text { text: text.clone() })
            }
            ContentBlock::ImageUrl { url } if !url.is_empty() => Some(ChatContentPart::ImageUrl {
                image_url: ProtocolImageUrl { url: url.clone() },
            }),
            ContentBlock::Thinking {
                thinking,
                signature,
            } => Some(ChatContentPart::Thinking {
                thinking: thinking.clone(),
                signature: signature.clone(),
            }),
            ContentBlock::RedactedThinking { data } => {
                Some(ChatContentPart::RedactedThinking { data: data.clone() })
            }
            _ => None,
        })
        .collect()
}

fn system_prompt(
    hub: &Hub,
    agent: Option<&worldbase_protocol::types::AgentDefinition>,
    context: &ChatRunContext,
) -> String {
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let base = format!(
        "今天是 {today}（UTC）。工作区目录：{}\n\
         使用当前提供的工具完成文件、搜索、文档、项目、MCP 等工作。\n\
         只调用本轮可见的工具；回答保持精炼、结构清晰。",
        hub.workspace.display()
    );
    let mut prompt = match agent {
        Some(a) if !a.system_prompt.trim().is_empty() => {
            format!(
                "{}\n\n[Agent 人设：{}]\n{}",
                a.name, a.description, a.system_prompt
            ) + "\n\n"
                + &base
        }
        _ => format!("你是 WorldBase 智能助手，运行在 Rust harness 内。\n{base}"),
    };
    let mut sections = Vec::new();
    for section in context
        .active_skill_contents
        .iter()
        .chain(context.system_prompt_sections.iter())
    {
        let section = section.trim();
        if !section.is_empty() && !sections.iter().any(|known: &String| known == section) {
            sections.push(section.to_string());
        }
    }
    if !sections.is_empty() {
        prompt.push_str("\n\n");
        prompt.push_str(&sections.join("\n\n"));
    }
    if let Some(project_id) = context
        .target_project_id
        .as_deref()
        .map(str::trim)
        .filter(|project_id| !project_id.is_empty())
    {
        prompt.push_str(&format!(
            "\n\n## Active target project\n- This conversation is currently bound to existing project ID: {project_id}.\n- Prefer that project for all read/write/build/runtime actions unless the user explicitly switches to another project.\n- Do not create a new project; use the existing project ID when a project tool requires `project_id`."
        ));
    }
    // Rust owns memory retrieval when the Electron backend selector is set to
    // Rust.  The host passes concrete scope IDs and the current user query;
    // keeping retrieval here means prompt construction no longer opens the
    // TypeScript MemoryStore on the Rust path.
    if !context.memory_scopes.is_empty() {
        let options = worldbase_protocol::types::WorkspaceMemorySearchOptions {
            query: context.memory_query.clone(),
            scopes: context
                .memory_scopes
                .iter()
                .map(|scope| worldbase_protocol::types::MemorySearchScopeEntry {
                    scope_type: scope.scope_type.clone(),
                    scope_id: scope.scope_id.clone(),
                })
                .collect(),
            memory_types: Vec::new(),
            limit: Some(40),
        };
        if let Ok(entries) = hub.store.search_workspace_memories(&options) {
            let mut sections = Vec::new();
            for (kind, title) in [
                ("user_trait", "User traits memory"),
                ("agent_skill", "Agent skills memory"),
                ("step", "Reusable steps memory"),
                ("knowledge", "Knowledge memory"),
            ] {
                let lines: Vec<String> = entries
                    .iter()
                    .filter(|entry| {
                        entry.memory_type == kind
                            && !entry.title.is_empty()
                            && !entry.summary.is_empty()
                    })
                    .take(8)
                    .map(|entry| {
                        if entry.title == entry.summary {
                            format!("- {}", entry.summary)
                        } else {
                            format!("- {}: {}", entry.title, entry.summary)
                        }
                    })
                    .collect();
                if !lines.is_empty() {
                    sections.push(format!("## {title}\n{}", lines.join("\n")));
                }
            }
            if !sections.is_empty() {
                prompt.push_str("\n\n");
                prompt.push_str(&sections.join("\n\n"));
            }
        }
    }
    prompt
}

#[cfg(test)]
mod tests {
    use super::*;
    use worldbase_protocol::types::{ToolCallRecord, ToolResultRecord};

    #[test]
    fn complete_tool_batches_are_preserved_exactly() {
        let history = vec![
            ChatMessage {
                id: 1,
                role: Role::Assistant,
                content: "Working.".into(),
                parts: vec![],
                tool_calls: vec![
                    ToolCallRecord {
                        id: "call-1".into(),
                        name: "read_file".into(),
                        args: serde_json::json!({"path": "a.txt"}),
                    },
                    ToolCallRecord {
                        id: "call-2".into(),
                        name: "read_file".into(),
                        args: serde_json::json!({"path": "b.txt"}),
                    },
                ],
                tool_results: vec![],
                created_at: None,
            },
            ChatMessage {
                id: 2,
                role: Role::User,
                content: String::new(),
                parts: vec![],
                tool_calls: vec![],
                tool_results: vec![
                    ToolResultRecord {
                        tool_call_id: "call-1".into(),
                        name: String::new(),
                        content: "one".into(),
                        is_error: false,
                    },
                    ToolResultRecord {
                        tool_call_id: "call-2".into(),
                        name: String::new(),
                        content: "two".into(),
                        is_error: false,
                    },
                ],
                created_at: None,
            },
        ];

        let messages = to_llm_messages(&history);

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].tool_uses().len(), 2);
        assert_eq!(messages[1].role, LlmRole::User);
        assert_eq!(messages[1].content.len(), 2);
    }

    #[test]
    fn incomplete_tool_batches_are_dropped_without_consuming_the_next_user_turn() {
        let history = vec![
            ChatMessage {
                id: 1,
                role: Role::Assistant,
                content: "partial".into(),
                parts: vec![],
                tool_calls: vec![
                    ToolCallRecord {
                        id: "call-1".into(),
                        name: "read_file".into(),
                        args: serde_json::json!({}),
                    },
                    ToolCallRecord {
                        id: "call-2".into(),
                        name: "read_file".into(),
                        args: serde_json::json!({}),
                    },
                ],
                tool_results: vec![],
                created_at: None,
            },
            ChatMessage {
                id: 2,
                role: Role::User,
                content: "must not leak as user text".into(),
                parts: vec![],
                tool_calls: vec![],
                tool_results: vec![ToolResultRecord {
                    tool_call_id: "call-1".into(),
                    name: String::new(),
                    content: "one".into(),
                    is_error: false,
                }],
                created_at: None,
            },
            ChatMessage {
                id: 3,
                role: Role::User,
                content: "continue".into(),
                parts: vec![],
                tool_calls: vec![],
                tool_results: vec![],
                created_at: None,
            },
        ];

        let messages = to_llm_messages(&history);

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].text_view(), "continue");
    }

    #[test]
    fn malformed_tool_metadata_keeps_only_assistant_text() {
        let history = vec![
            ChatMessage {
                id: 1,
                role: Role::Assistant,
                content: "Useful explanation".into(),
                parts: vec![],
                tool_calls: vec![ToolCallRecord {
                    id: String::new(),
                    name: "read_file".into(),
                    args: serde_json::json!({}),
                }],
                tool_results: vec![],
                created_at: None,
            },
            ChatMessage {
                id: 2,
                role: Role::User,
                content: "orphan result text".into(),
                parts: vec![],
                tool_calls: vec![],
                tool_results: vec![ToolResultRecord {
                    tool_call_id: "missing".into(),
                    name: String::new(),
                    content: "result".into(),
                    is_error: false,
                }],
                created_at: None,
            },
        ];

        let messages = to_llm_messages(&history);

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, LlmRole::Assistant);
        assert_eq!(messages[0].text_view(), "Useful explanation");
        assert!(messages[0].tool_uses().is_empty());
    }

    #[test]
    fn assistant_image_parts_are_persisted_and_replayed() {
        let assistant = LlmMessage {
            role: LlmRole::Assistant,
            content: vec![
                ContentBlock::Text {
                    text: "preview".into(),
                },
                ContentBlock::ImageUrl {
                    url: "data:image/png;base64,aGVsbG8=".into(),
                },
            ],
        };
        let parts = persisted_content_parts(&assistant);
        assert_eq!(parts.len(), 2);

        let history = vec![ChatMessage {
            id: 1,
            role: Role::Assistant,
            content: "preview".into(),
            parts,
            tool_calls: vec![],
            tool_results: vec![],
            created_at: None,
        }];
        let replayed = to_llm_messages(&history);
        assert_eq!(replayed.len(), 1);
        assert!(matches!(
            &replayed[0].content[1],
            ContentBlock::ImageUrl { url } if url == "data:image/png;base64,aGVsbG8="
        ));
    }

    #[test]
    fn anthropic_thinking_parts_are_persisted_and_replayed_with_opaque_data() {
        let assistant = LlmMessage {
            role: LlmRole::Assistant,
            content: vec![
                ContentBlock::Thinking {
                    thinking: "look up the file".into(),
                    signature: "sig-byte-for-byte".into(),
                },
                ContentBlock::Text {
                    text: "I found it.".into(),
                },
                ContentBlock::RedactedThinking {
                    data: "encrypted-thinking-payload".into(),
                },
            ],
        };

        let parts = persisted_content_parts(&assistant);
        assert!(matches!(
            &parts[..],
            [
                ChatContentPart::Thinking { thinking, signature },
                ChatContentPart::Text { text },
                ChatContentPart::RedactedThinking { data }
            ] if thinking == "look up the file"
                && signature == "sig-byte-for-byte"
                && text == "I found it."
                && data == "encrypted-thinking-payload"
        ));

        let replayed = to_llm_messages(&[ChatMessage {
            id: 1,
            role: Role::Assistant,
            content: "I found it.".into(),
            parts,
            tool_calls: vec![],
            tool_results: vec![],
            created_at: None,
        }]);

        assert_eq!(replayed.len(), 1);
        assert!(matches!(
            &replayed[0].content[..],
            [
                ContentBlock::Thinking { thinking, signature },
                ContentBlock::Text { text },
                ContentBlock::RedactedThinking { data }
            ] if thinking == "look up the file"
                && signature == "sig-byte-for-byte"
                && text == "I found it."
                && data == "encrypted-thinking-payload"
        ));
    }

    #[test]
    fn folder_workspace_tools_require_a_selected_workspace_for_each_run() {
        let empty = ChatRunContext::default();
        assert!(!tool_visible_for_run("list_workspace_files", &empty));
        assert!(!tool_visible_for_run("run_workspace_command", &empty));
        assert!(tool_visible_for_run("read_project_file", &empty));

        let selected = ChatRunContext {
            workspace_root: Some("/tmp/project".into()),
            ..ChatRunContext::default()
        };
        assert!(tool_visible_for_run("list_workspace_files", &selected));
        assert!(tool_visible_for_run("run_workspace_command", &selected));
    }

    #[test]
    fn persisted_and_request_allow_lists_can_intersect_to_deny_all() {
        let context = ChatRunContext {
            allowed_tool_names: vec!["read_file".into()],
            denied_tool_names: vec!["memory_search".into()],
            ..ChatRunContext::default()
        };
        let agent: worldbase_protocol::types::AgentDefinition =
            serde_json::from_value(serde_json::json!({
                "id": "policy-agent",
                "name": "Policy agent",
                "allowedTools": ["write_file"],
                "deniedTools": ["delete_file"]
            }))
            .unwrap();

        let policy = run_tool_policy(&context, Some(&agent));

        assert_eq!(policy.allowed, Some(std::collections::HashSet::new()));
        assert!(policy.denied.contains("memory_search"));
        assert!(policy.denied.contains("delete_file"));
        assert!(!tool_allowed_for_run("read_file", &policy));
        assert!(!tool_allowed_for_run("write_file", &policy));
    }

    #[test]
    fn structured_tool_errors_match_electron_failure_semantics() {
        let (content, is_error) = serialize_tool_result(Ok(serde_json::json!({
            "ok": false,
            "error": "host rejected the action"
        })));
        assert!(is_error);
        assert!(content.contains("host rejected the action"));

        let (_, is_error) = serialize_tool_result(Ok(serde_json::json!({
            "ok": false,
            "queued": 0
        })));
        assert!(
            !is_error,
            "Node treats only an explicit error field as failure"
        );
    }
}

fn llm_tools(tools: &[Arc<dyn worldbase_tools::Tool>]) -> Vec<LlmTool> {
    tools
        .iter()
        .map(|t| LlmTool {
            name: t.name().to_string(),
            description: t.description().to_string(),
            input_schema: t.input_schema(),
        })
        .collect()
}

fn llm_custom_tools(tools: &[ToolDescriptor]) -> Vec<LlmTool> {
    tools
        .iter()
        .map(|tool| LlmTool {
            name: tool.name.clone(),
            description: tool.description.clone(),
            input_schema: tool.input_schema.clone(),
        })
        .collect()
}

#[derive(Default)]
struct RunToolPolicy {
    /// `None` means unrestricted. `Some(empty)` is a real deny-all policy,
    /// which can result from intersecting two non-empty allow lists.
    allowed: Option<std::collections::HashSet<String>>,
    denied: std::collections::HashSet<String>,
}

fn normalized_tool_names(values: &[String]) -> std::collections::HashSet<String> {
    values
        .iter()
        .map(|name| name.trim())
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn optional_allow_list(values: &[String]) -> Option<std::collections::HashSet<String>> {
    let values = normalized_tool_names(values);
    (!values.is_empty()).then_some(values)
}

fn run_tool_policy(
    context: &ChatRunContext,
    agent: Option<&worldbase_protocol::types::AgentDefinition>,
) -> RunToolPolicy {
    let request_allowed = optional_allow_list(&context.allowed_tool_names);
    let agent_allowed = agent.and_then(|agent| optional_allow_list(&agent.allowed_tools));
    let allowed = match (request_allowed, agent_allowed) {
        (Some(request), Some(agent)) => Some(request.intersection(&agent).cloned().collect()),
        (Some(allowed), None) | (None, Some(allowed)) => Some(allowed),
        (None, None) => None,
    };
    let mut denied = normalized_tool_names(&context.denied_tool_names);
    if let Some(agent) = agent {
        denied.extend(normalized_tool_names(&agent.denied_tools));
    }
    RunToolPolicy { allowed, denied }
}

fn tool_allowed_for_run(name: &str, policy: &RunToolPolicy) -> bool {
    policy
        .allowed
        .as_ref()
        .is_none_or(|allowed| allowed.contains(name))
        && !policy.denied.contains(name)
}

fn platform_tools(
    tools: Vec<Arc<dyn worldbase_tools::Tool>>,
    context: &ChatRunContext,
) -> Vec<Arc<dyn worldbase_tools::Tool>> {
    tools
        .into_iter()
        .filter(|tool| tool_visible_for_run(tool.name(), context))
        .collect()
}

fn run_tools(
    tools: Vec<Arc<dyn worldbase_tools::Tool>>,
    context: &ChatRunContext,
    policy: &RunToolPolicy,
) -> Vec<Arc<dyn worldbase_tools::Tool>> {
    platform_tools(tools, context)
        .into_iter()
        .filter(|tool| tool_allowed_for_run(tool.name(), policy))
        .collect()
}

fn is_folder_workspace_tool(name: &str) -> bool {
    matches!(
        name,
        "list_workspace_files"
            | "read_workspace_file"
            | "write_workspace_file"
            | "edit_workspace_file"
            | "patch_workspace_file"
            | "delete_workspace_file"
            | "glob_workspace"
            | "grep_workspace"
            | "run_workspace_command"
            | "get_workspace_command_status"
    )
}

fn tool_visible_for_run(name: &str, context: &ChatRunContext) -> bool {
    !is_folder_workspace_tool(name)
        || context
            .workspace_root
            .as_deref()
            .is_some_and(|root| !root.trim().is_empty())
}

fn executable_custom_tools(
    custom_tools: &[ToolDescriptor],
    builtin_tools: &[Arc<dyn worldbase_tools::Tool>],
) -> Vec<ToolDescriptor> {
    let builtin_names: std::collections::HashSet<&str> =
        builtin_tools.iter().map(|tool| tool.name()).collect();
    let mut names = std::collections::HashSet::new();

    custom_tools
        .iter()
        .filter(|tool| {
            let name = tool.name.trim();
            let is_host_override = tool.domain == "electron_host_override";
            !name.is_empty()
                // Electron can explicitly retain authority for an operation
                // whose data/runtime lives in the desktop host. Ordinary
                // custom tools still cannot shadow a native Rust builtin.
                && (is_host_override || !builtin_names.contains(name))
                && names.insert(name)
        })
        .cloned()
        .collect()
}

fn run_custom_tools(
    custom_tools: Vec<ToolDescriptor>,
    policy: &RunToolPolicy,
) -> Vec<ToolDescriptor> {
    custom_tools
        .into_iter()
        .filter(|tool| tool_allowed_for_run(tool.name.trim(), policy))
        .collect()
}

fn apply_persisted_agent_context(
    hub: &Hub,
    context: &mut ChatRunContext,
    agent: Option<&worldbase_protocol::types::AgentDefinition>,
) {
    let Some(agent) = agent else {
        return;
    };

    if context.reasoning_effort.is_none()
        && matches!(
            agent.reasoning_strength.as_str(),
            "low" | "medium" | "high" | "max"
        )
    {
        context.reasoning_effort = Some(agent.reasoning_strength.clone());
    }

    if agent.skill_ids.is_empty() {
        return;
    }
    let skills = match hub.skills.list() {
        Ok(skills) => skills,
        Err(error) => {
            tracing::warn!(agent_id = %agent.id, %error, "failed to load persisted agent skills");
            return;
        }
    };
    let by_name = skills
        .into_iter()
        .map(|skill| (skill.name, skill.instructions))
        .collect::<std::collections::HashMap<_, _>>();
    for skill_id in &agent.skill_ids {
        let Some(instructions) = by_name.get(skill_id) else {
            continue;
        };
        let instructions = instructions.trim();
        if !instructions.is_empty()
            && !context
                .active_skill_contents
                .iter()
                .any(|known| known.trim() == instructions)
        {
            context.active_skill_contents.push(instructions.to_string());
        }
    }
}

pub struct ChatRun {
    pub stream_id: String,
    pub conversation_id: String,
}

/// 发起一次 chat：立即返回 stream_id，事件经 channel + hub.event_tx 下发。
pub fn start_chat(
    hub: Arc<Hub>,
    conversation_id: String,
    user_text: String,
    content_parts: Vec<ChatContentPart>,
    capabilities: Capabilities,
    interactive: bool,
    agent_id: Option<String>,
    provider_id: Option<String>,
    model: Option<String>,
    context: ChatRunContext,
) -> Result<ChatRun> {
    start_chat_with_stream_id(
        hub,
        conversation_id,
        user_text,
        content_parts,
        capabilities,
        interactive,
        agent_id,
        provider_id,
        model,
        context,
        None,
    )
}

/// Start a normal Rust agent loop on a caller-owned stream. Native group
/// rounds assign each member a derived child stream so member cleanup cannot
/// overwrite the parent group's cancellation handle.
pub fn start_chat_with_stream_id(
    hub: Arc<Hub>,
    conversation_id: String,
    user_text: String,
    content_parts: Vec<ChatContentPart>,
    capabilities: Capabilities,
    interactive: bool,
    agent_id: Option<String>,
    provider_id: Option<String>,
    model: Option<String>,
    context: ChatRunContext,
    stream_id: Option<String>,
) -> Result<ChatRun> {
    start_chat_with_stream_id_and_group_runtime(
        hub,
        conversation_id,
        user_text,
        content_parts,
        capabilities,
        interactive,
        agent_id,
        provider_id,
        model,
        context,
        stream_id,
        None,
    )
}

/// Start a caller-owned stream with an optional native group collaboration
/// runtime. This is separate from the public chat entrypoint so a normal run
/// cannot accidentally advertise group-only tools.
pub fn start_chat_with_stream_id_and_group_runtime(
    hub: Arc<Hub>,
    conversation_id: String,
    user_text: String,
    content_parts: Vec<ChatContentPart>,
    capabilities: Capabilities,
    interactive: bool,
    agent_id: Option<String>,
    provider_id: Option<String>,
    model: Option<String>,
    mut context: ChatRunContext,
    stream_id: Option<String>,
    group_collaboration: Option<Arc<dyn worldbase_tools::GroupCollaborationRuntime>>,
) -> Result<ChatRun> {
    if let Some(path) = context
        .workspace_root
        .as_deref()
        .filter(|path| !path.trim().is_empty())
    {
        let path = std::path::PathBuf::from(path)
            .canonicalize()
            .map_err(|error| anyhow::anyhow!("invalid folder workspace: {error}"))?;
        anyhow::ensure!(path.is_dir(), "folder workspace is not a directory");
        context.workspace_root = Some(path.to_string_lossy().into_owned());
    }
    let stream_id = stream_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let channel = hub.register_stream(&stream_id);
    let abort = CancellationToken::new();

    hub.runs.lock().unwrap().insert(
        stream_id.clone(),
        RunHandle {
            conversation_id: conversation_id.clone(),
            abort: abort.clone(),
            capabilities,
            interactive,
            agent_id,
            provider_id,
            model,
            context: context.clone(),
            group_collaboration,
        },
    );

    let conv_for_task = conversation_id.clone();
    tokio::spawn(run_chat(
        hub,
        stream_id.clone(),
        conv_for_task,
        user_text,
        content_parts,
        channel,
        abort,
    ));

    let _ = conversation_id;

    Ok(ChatRun {
        stream_id,
        conversation_id,
    })
}

/// 调度任务入口：独立会话运行任务文本。
pub async fn run_scheduled_task(
    hub: Arc<Hub>,
    schedule_id: &str,
    name: &str,
    task: &str,
) -> Result<()> {
    let conv = hub
        .store
        .create_conversation(&format!("[定时] {name}"), None)?;
    let stream_id = format!("schedule-{schedule_id}-{}", uuid::Uuid::new_v4());
    let channel = hub.register_stream(&stream_id);
    publish(
        &hub,
        &channel,
        &stream_id,
        EventKind::Notice {
            text: format!("定时任务触发：{name}"),
        },
    )
    .await;
    let user_msg = ChatMessage {
        id: 0,
        role: Role::User,
        content: task.to_string(),
        parts: vec![],
        tool_calls: vec![],
        tool_results: vec![],
        created_at: None,
    };
    hub.store.append_message(&conv.id, &user_msg)?;
    publish(
        &hub,
        &channel,
        &stream_id,
        EventKind::UserMessage {
            content: task.to_string(),
        },
    )
    .await;
    // Scheduled runs are created outside chat.send, so register a run handle
    // before entering the common loop.  This also keeps provider selection and
    // cancellation behavior consistent with interactive chats.
    hub.runs.lock().unwrap().insert(
        stream_id.clone(),
        RunHandle {
            conversation_id: conv.id.clone(),
            abort: CancellationToken::new(),
            capabilities: Capabilities::desktop(),
            interactive: false,
            agent_id: None,
            provider_id: None,
            model: None,
            context: ChatRunContext::default(),
            group_collaboration: None,
        },
    );
    let abort = hub
        .runs
        .lock()
        .unwrap()
        .get(&stream_id)
        .map(|run| run.abort.clone())
        .unwrap_or_else(CancellationToken::new);
    if let Err(error) =
        run_chat_inner(hub.clone(), stream_id.clone(), conv.id, channel, abort).await
    {
        hub.emit(
            &stream_id,
            EventKind::Error {
                message: error.to_string(),
            },
        )
        .await;
    }
    Ok(())
}

async fn run_chat(
    hub: Arc<Hub>,
    stream_id: String,
    conversation_id: String,
    user_text: String,
    content_parts: Vec<ChatContentPart>,
    channel: Arc<StreamChannel>,
    abort: CancellationToken,
) {
    // 用户消息落库 + 事件
    let user_msg = ChatMessage {
        id: 0,
        role: Role::User,
        content: user_text.clone(),
        parts: content_parts,
        tool_calls: vec![],
        tool_results: vec![],
        created_at: None,
    };
    if let Err(e) = hub.store.append_message(&conversation_id, &user_msg) {
        publish(
            &hub,
            &channel,
            &stream_id,
            EventKind::Error {
                message: format!("persist user message: {e}"),
            },
        )
        .await;
        cleanup(&hub, &stream_id);
        return;
    }
    publish(
        &hub,
        &channel,
        &stream_id,
        EventKind::UserMessage { content: user_text },
    )
    .await;

    if let Err(error) = run_chat_inner(
        hub.clone(),
        stream_id.clone(),
        conversation_id,
        channel.clone(),
        abort,
    )
    .await
    {
        publish(
            &hub,
            &channel,
            &stream_id,
            EventKind::Error {
                message: error.to_string(),
            },
        )
        .await;
        cleanup(&hub, &stream_id);
    }
}

async fn run_chat_inner(
    hub: Arc<Hub>,
    stream_id: String,
    conversation_id: String,
    channel: Arc<StreamChannel>,
    abort: CancellationToken,
) -> Result<String> {
    let (
        caps,
        interactive,
        req_agent_id,
        req_provider_id,
        req_model,
        mut context,
        group_collaboration,
    ) = hub
        .runs
        .lock()
        .unwrap()
        .get(&stream_id)
        .map(|run| {
            (
                run.capabilities.clone(),
                run.interactive,
                run.agent_id.clone(),
                run.provider_id.clone(),
                run.model.clone(),
                run.context.clone(),
                run.group_collaboration.clone(),
            )
        })
        .unwrap_or_else(|| {
            (
                Capabilities::desktop(),
                false,
                None,
                None,
                None,
                ChatRunContext::default(),
                None,
            )
        });

    // 会话绑定 agent：persona + provider/model override
    let conversation_agent_id = hub
        .store
        .get_conversation(&conversation_id)
        .ok()
        .flatten()
        .and_then(|conversation| conversation.agent_id);
    let agent_id = req_agent_id
        .as_deref()
        .map(str::trim)
        .filter(|agent_id| !agent_id.is_empty())
        .map(ToOwned::to_owned)
        .or(conversation_agent_id);
    let agent = agent_id.and_then(|agent_id| hub.store.get_agent(&agent_id).ok().flatten());
    apply_persisted_agent_context(&hub, &mut context, agent.as_ref());
    let tool_policy = run_tool_policy(&context, agent.as_ref());

    let (provider, provider_entry, model_override) =
        if req_provider_id.is_some() || req_model.is_some() {
            hub.provider_by_ids(req_provider_id.as_deref(), req_model.as_deref())?
        } else {
            match hub.provider_for_agent(agent.as_ref()) {
                Ok((p, entry, model)) => (p, entry, model),
                Err(e) => {
                    publish(
                        &hub,
                        &channel,
                        &stream_id,
                        EventKind::Error {
                            message: e.to_string(),
                        },
                    )
                    .await;
                    cleanup(&hub, &stream_id);
                    return Ok(format!("provider error: {e}"));
                }
            }
        };
    publish(
        &hub,
        &channel,
        &stream_id,
        EventKind::Start {
            model: model_override
                .clone()
                .unwrap_or_else(|| provider.model().to_string()),
        },
    )
    .await;

    let mut catalog_tools = platform_tools(hub.tools_for(&caps), &context);
    if group_collaboration.is_some() {
        catalog_tools.extend(worldbase_tools::group_collaboration_tools());
    }
    let folder_workspace = context
        .workspace_root
        .as_deref()
        .map(std::path::PathBuf::from);
    let mut services = hub.services_for_run(
        folder_workspace,
        context.target_project_id.clone(),
        context.allowed_mcp_server_ids.clone(),
    );
    services.group_collaboration = group_collaboration.clone();
    services.set_current_stream(&stream_id);
    if context.plan_mode_active {
        // The desktop UI may enter plan mode before this stream begins. Keep
        // the authoritative guard inside Rust rather than relying on a prompt
        // or an initial tool allow-list that an already-issued schema can
        // outlive.
        let _ = services.enter_plan_mode("Electron activated plan mode");
    }
    // MCP server configuration comes from Electron, but discovery and the
    // resulting call path are native to this Rust run. Dynamic names follow
    // Electron's historic mcp__... format so saved allow lists still apply.
    let allowed_mcp_servers = services.allowed_mcp_server_ids();
    let discovered_mcp_tools = worldbase_tools::dynamic_mcp_tools(
        hub.mcp.list_tools_for(allowed_mcp_servers.as_ref()).await,
    );
    catalog_tools.extend(platform_tools(discovered_mcp_tools, &context));
    let mut catalog_custom_tools = executable_custom_tools(&context.custom_tools, &catalog_tools);
    if group_collaboration.is_some() {
        // Native group collaboration is Rust-owned. Never let a same-named
        // Electron host override route one of these calls back into TS.
        catalog_custom_tools.retain(|tool| {
            !matches!(
                tool.name.as_str(),
                "message_agent" | "read_board" | "update_board" | "reply_to_user"
            )
        });
    }
    // A host override must replace, rather than merely supplement, a native
    // descriptor. This keeps the schema shown to the model and the execution
    // target aligned for Electron-owned project/workspace/image/group tools.
    let host_override_names: std::collections::HashSet<&str> = catalog_custom_tools
        .iter()
        .filter(|tool| tool.domain == "electron_host_override")
        .map(|tool| tool.name.as_str())
        .collect();
    catalog_tools.retain(|tool| !host_override_names.contains(tool.name()));
    let mut visible_tool_catalog = worldbase_tools::descriptors(&catalog_tools);
    visible_tool_catalog.extend(catalog_custom_tools.iter().cloned());
    visible_tool_catalog.sort_by(|left, right| left.name.cmp(&right.name));
    visible_tool_catalog.dedup_by(|left, right| left.name == right.name);
    services.visible_tool_catalog = Some(Arc::new(visible_tool_catalog));

    let tools = run_tools(catalog_tools, &context, &tool_policy);
    let custom_tools = run_custom_tools(catalog_custom_tools, &tool_policy);
    let mut tools_meta = llm_tools(&tools);
    tools_meta.extend(llm_custom_tools(&custom_tools));
    let system = system_prompt(&hub, agent.as_ref(), &context);

    let history = hub
        .store
        .list_messages(&conversation_id, 400)
        .unwrap_or_default();
    let mut llm_messages = to_llm_messages(&history);

    let mut result: std::result::Result<String, anyhow::Error> = Err(anyhow::anyhow!("no steps"));
    let mut terminal_emitted = false;
    let mut last_iteration_fingerprint: Option<String> = None;
    let mut duplicate_iterations = 0usize;
    let mut total_cost = 0.0f64;
    let mut total_input_tokens = 0u64;
    let mut total_output_tokens = 0u64;
    for _step in 0..MAX_STEPS {
        if abort.is_cancelled() {
            publish(
                &hub,
                &channel,
                &stream_id,
                EventKind::Notice {
                    text: "已中止".into(),
                },
            )
            .await;
            publish(
                &hub,
                &channel,
                &stream_id,
                EventKind::Done {
                    stop_reason: "aborted".into(),
                },
            )
            .await;
            terminal_emitted = true;
            result = Ok("aborted".into());
            break;
        }
        if let Some(limit) = context.budget_limit {
            if limit.is_finite() && limit > 0.0 && total_cost >= limit {
                let message = format!(
                    "预算上限已达到（已用 {total_cost:.6} / 上限 {limit:.6}），已停止下一轮模型调用。"
                );
                publish(
                    &hub,
                    &channel,
                    &stream_id,
                    EventKind::Notice {
                        text: message.clone(),
                    },
                )
                .await;
                publish(
                    &hub,
                    &channel,
                    &stream_id,
                    EventKind::Done {
                        stop_reason: "budget_exceeded".into(),
                    },
                )
                .await;
                terminal_emitted = true;
                result = Ok(message);
                break;
            }
        }

        let stream_result = tokio::select! {
            biased;
            _ = abort.cancelled() => None,
            result = provider.chat_stream(
                Some(&system),
                llm_messages.clone(),
                tools_meta.clone(),
                MAX_TOKENS,
                ChatOptions {
                    temperature: context
                        .temperature
                        .or_else(|| provider_entry.as_ref().and_then(|entry| entry.temperature)),
                    enable_thinking: context.enable_thinking.unwrap_or_else(|| {
                        provider_entry
                            .as_ref()
                            .map(|entry| entry.enable_thinking)
                            .unwrap_or(false)
                    }),
                    reasoning_effort: context.reasoning_effort.clone(),
                },
            ) => Some(result),
        };
        // Dropping the provider future also drops an in-flight request or
        // retry backoff. The next loop iteration emits the canonical aborted
        // terminal frames instead of waiting for the HTTP timeout budget.
        let Some(stream_result) = stream_result else {
            continue;
        };
        let mut stream = match stream_result {
            Ok(s) => s,
            Err(e) => {
                publish(
                    &hub,
                    &channel,
                    &stream_id,
                    EventKind::Error {
                        message: e.to_string(),
                    },
                )
                .await;
                cleanup(&hub, &stream_id);
                return Ok(format!("provider error: {e}"));
            }
        };

        let mut assistant: Option<LlmMessage> = None;
        let mut stop_reason = String::new();
        let mut stream_error: Option<String> = None;
        loop {
            let chunk = tokio::select! {
                biased;
                _ = abort.cancelled() => break,
                chunk = stream.next() => chunk,
            };
            let Some(chunk) = chunk else { break };
            match chunk {
                Ok(StreamChunk::TextDelta(text)) => {
                    publish(&hub, &channel, &stream_id, EventKind::Delta { text }).await;
                }
                Ok(StreamChunk::ThinkingDelta(text)) => {
                    publish(
                        &hub,
                        &channel,
                        &stream_id,
                        EventKind::ThinkingDelta { text },
                    )
                    .await;
                }
                Ok(StreamChunk::Completed {
                    stop_reason: reason,
                    assistant: msg,
                    usage,
                }) => {
                    stop_reason = reason;
                    // 用量记账（成本按供应商模型单价换算）
                    let model_name = model_override.as_deref().unwrap_or(provider.model());
                    let (pin, pout, pcache) = hub.model_prices(provider_entry.as_ref(), model_name);
                    let cost = usage.input_tokens as f64 / 1_000_000.0 * pin
                        + usage.output_tokens as f64 / 1_000_000.0 * pout
                        + usage.cache_read_tokens as f64 / 1_000_000.0 * pcache;
                    let _ = hub.store.record_usage(
                        Some(&conversation_id),
                        provider_entry.as_ref().map(|e| e.id.as_str()),
                        model_name,
                        usage.input_tokens,
                        usage.output_tokens,
                        cost,
                    );
                    total_cost += cost;
                    total_input_tokens += usage.input_tokens;
                    total_output_tokens += usage.output_tokens;
                    publish(
                        &hub,
                        &channel,
                        &stream_id,
                        EventKind::Usage {
                            provider_id: provider_entry.as_ref().map(|entry| entry.id.clone()),
                            provider_name: provider_entry
                                .as_ref()
                                .map(|entry| entry.name.clone())
                                .unwrap_or_else(|| provider.name().to_string()),
                            model: model_name.to_string(),
                            input_tokens: usage.input_tokens,
                            output_tokens: usage.output_tokens,
                            cache_read_tokens: usage.cache_read_tokens,
                            cache_creation_tokens: usage.cache_creation_tokens,
                            cost,
                            total_cost,
                            total_input_tokens,
                            total_output_tokens,
                        },
                    )
                    .await;
                    assistant = Some(msg);
                    break;
                }
                Err(e) => {
                    stream_error = Some(e.to_string());
                    break;
                }
            }
        }
        drop(stream);

        if let Some(err) = stream_error {
            publish(
                &hub,
                &channel,
                &stream_id,
                EventKind::Error {
                    message: err.clone(),
                },
            )
            .await;
            cleanup(&hub, &stream_id);
            return Ok(format!("stream error: {err}"));
        }
        if abort.is_cancelled() {
            publish(
                &hub,
                &channel,
                &stream_id,
                EventKind::Notice {
                    text: "已中止".into(),
                },
            )
            .await;
            publish(
                &hub,
                &channel,
                &stream_id,
                EventKind::Done {
                    stop_reason: "aborted".into(),
                },
            )
            .await;
            terminal_emitted = true;
            result = Ok("aborted".into());
            break;
        }
        let Some(assistant_msg) = assistant else {
            publish(
                &hub,
                &channel,
                &stream_id,
                EventKind::Error {
                    message: "provider ended without completion".into(),
                },
            )
            .await;
            cleanup(&hub, &stream_id);
            return Ok("no completion".into());
        };

        // 助手消息落库
        let tool_uses = assistant_msg.tool_uses();
        let tool_input_errors: std::collections::HashMap<String, String> = assistant_msg
            .content
            .iter()
            .filter_map(|block| match block {
                ContentBlock::ToolUse {
                    id,
                    input_error: Some(error),
                    ..
                } => Some((id.clone(), error.clone())),
                _ => None,
            })
            .collect();
        let assistant_content = assistant_msg.text_view();
        let assistant_parts = persisted_content_parts(&assistant_msg);
        let record = ChatMessage {
            id: 0,
            role: Role::Assistant,
            content: assistant_content.clone(),
            parts: assistant_parts.clone(),
            tool_calls: tool_uses
                .iter()
                .map(|(id, name, input)| ToolCallRecord {
                    id: id.clone(),
                    name: name.clone(),
                    args: input.clone(),
                })
                .collect(),
            tool_results: vec![],
            created_at: None,
        };
        let _ = hub.store.append_message(&conversation_id, &record);
        if !assistant_content.is_empty() || !assistant_parts.is_empty() {
            publish(
                &hub,
                &channel,
                &stream_id,
                EventKind::AssistantMessage {
                    content: assistant_content.clone(),
                    parts: assistant_parts,
                },
            )
            .await;
        }

        // 无工具调用 → 结束
        if tool_uses.is_empty() {
            publish(&hub, &channel, &stream_id, EventKind::Done { stop_reason }).await;
            terminal_emitted = true;
            result = Ok(assistant_content);
            break;
        }

        // 执行工具调用
        llm_messages.push(assistant_msg);
        let iteration_calls = tool_uses.clone();
        let mut tool_results_for_llm = Vec::new();
        for (call_id, name, input) in tool_uses {
            if abort.is_cancelled() {
                break;
            }
            publish(
                &hub,
                &channel,
                &stream_id,
                EventKind::ToolCall {
                    call_id: call_id.clone(),
                    name: name.clone(),
                    args: input.clone(),
                },
            )
            .await;

            let tool = tools.iter().find(|tool| tool.name() == name);
            let custom_tool = custom_tools.iter().find(|tool| tool.name == name);
            let exec_result = if let Some(error) = tool_input_errors.get(&call_id) {
                Err(anyhow::anyhow!(error.clone()))
            } else if !services.is_tool_allowed_in_plan_mode(&name) {
                Err(anyhow::anyhow!(
                    "当前处于规划模式，不允许执行写入操作 ({name})。请先退出规划模式。"
                ))
            } else {
                let policy = worldbase_policy_for(hub.store.as_ref(), tool, custom_tool, &name);
                let allowed = crate::permissions::check(
                    &hub,
                    &stream_id,
                    &policy,
                    &name,
                    &input,
                    interactive,
                    Some(&abort),
                )
                .await;
                if abort.is_cancelled() {
                    break;
                }
                if allowed {
                    match tool {
                        Some(tool) => {
                            tokio::select! {
                                biased;
                                _ = abort.cancelled() => {
                                    Err(anyhow::anyhow!("tool execution aborted: {name}"))
                                }
                                result = tool.execute(input.clone(), &services) => result,
                            }
                        }
                        None if custom_tool.is_some() => {
                            tokio::select! {
                                biased;
                                _ = abort.cancelled() => {
                                    Err(anyhow::anyhow!("Electron tool execution aborted: {name}"))
                                }
                                result = hub.host_request(
                                    &stream_id,
                                    "tool.execute",
                                    serde_json::json!({ "name": name, "args": input }),
                                    ELECTRON_HOST_TOOL_TIMEOUT,
                                ) => result,
                            }
                        }
                        None => Err(anyhow::anyhow!("unknown tool: {name}")),
                    }
                } else {
                    Err(anyhow::anyhow!("权限被拒绝：{name}"))
                }
            };

            let (content, is_error) = serialize_tool_result(exec_result);
            publish(
                &hub,
                &channel,
                &stream_id,
                EventKind::ToolResult {
                    call_id: call_id.clone(),
                    name: name.clone(),
                    content: content.clone(),
                    is_error,
                },
            )
            .await;
            tool_results_for_llm.push(ContentBlock::ToolResult {
                tool_use_id: call_id,
                content,
                is_error,
            });
        }

        // 工具结果作为 user 消息进历史（Anthropic 语义），并落库
        llm_messages.push(LlmMessage {
            role: LlmRole::User,
            content: tool_results_for_llm.clone(),
        });
        let tr_record = ChatMessage {
            id: 0,
            role: Role::User,
            content: String::new(),
            parts: vec![],
            tool_calls: vec![],
            tool_results: tool_results_for_llm
                .iter()
                .filter_map(|b| match b {
                    ContentBlock::ToolResult {
                        tool_use_id,
                        content,
                        is_error,
                    } => Some(ToolResultRecord {
                        tool_call_id: tool_use_id.clone(),
                        name: String::new(),
                        content: content.clone(),
                        is_error: *is_error,
                    }),
                    _ => None,
                })
                .collect(),
            created_at: None,
        };
        let _ = hub.store.append_message(&conversation_id, &tr_record);

        // Match Electron's loop detector: identical tool calls with identical
        // results for several consecutive turns indicate an agent loop rather
        // than useful progress.  Hashing is unnecessary here because the
        // serialized payload is bounded by the provider/tool result limits.
        let fingerprint =
            serde_json::to_string(&(iteration_calls, &tool_results_for_llm)).unwrap_or_default();
        if last_iteration_fingerprint.as_deref() == Some(fingerprint.as_str()) {
            duplicate_iterations += 1;
        } else {
            last_iteration_fingerprint = Some(fingerprint);
            duplicate_iterations = 1;
        }
        if duplicate_iterations >= MAX_DUPLICATE_ITERATIONS {
            let message = format!(
                "agent repeated the same tool calls and results for {duplicate_iterations} consecutive iterations"
            );
            publish(
                &hub,
                &channel,
                &stream_id,
                EventKind::Error {
                    message: message.clone(),
                },
            )
            .await;
            result = Ok(message);
            terminal_emitted = true;
            break;
        }
        result = Ok(String::new());
    }

    let final_text = match &result {
        Ok(text) => text.clone(),
        Err(e) => {
            publish(
                &hub,
                &channel,
                &stream_id,
                EventKind::Error {
                    message: e.to_string(),
                },
            )
            .await;
            terminal_emitted = true;
            String::new()
        }
    };
    // A stream must always have a terminal frame.  This is especially
    // important after exhausting MAX_STEPS: clients use Done/Error to release
    // their per-session state and otherwise would remain stuck indefinitely.
    if !terminal_emitted {
        // The normal no-tool path emits Done above.  For exhausted tool loops,
        // no terminal event has been published yet.
        publish(
            &hub,
            &channel,
            &stream_id,
            EventKind::Done {
                stop_reason: "max_steps".into(),
            },
        )
        .await;
    }
    cleanup(&hub, &stream_id);
    Ok(final_text)
}

fn worldbase_policy_for(
    store: &worldbase_memory::Store,
    tool: Option<&Arc<dyn worldbase_tools::Tool>>,
    custom_tool: Option<&ToolDescriptor>,
    name: &str,
) -> String {
    // settings.permissions = { tool_name: allow|ask|deny }
    if let Ok(Some(policy)) = store.get_setting("permissions") {
        if let Some(v) = policy.get(name).and_then(|v| v.as_str()) {
            return v.to_string();
        }
    }
    tool.map(|tool| tool.permission().to_string())
        .or_else(|| custom_tool.map(|tool| tool.permission.clone()))
        .unwrap_or_else(|| "allow".into())
}

async fn publish(hub: &Hub, channel: &StreamChannel, stream_id: &str, kind: EventKind) {
    let seq = channel.publish(stream_id, kind.clone()).await;
    let ts = worldbase_protocol::event::now_rfc3339();
    let frame = EventFrame {
        stream_id: stream_id.to_string(),
        seq,
        ts,
        kind,
    };
    let _ = hub.event_tx.send(frame);
}

fn cleanup(hub: &Hub, stream_id: &str) {
    hub.runs.lock().unwrap().remove(stream_id);
}
