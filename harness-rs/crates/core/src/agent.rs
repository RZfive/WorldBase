//! Agent 循环：流式事件发布、工具执行、权限询问、中止与断点续传。

use crate::hub::{Hub, RunHandle};
use anyhow::Result;
use futures::StreamExt;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use worldbase_protocol::event::{EventFrame, EventKind, StreamChannel};
use worldbase_protocol::types::{
    Capabilities, ChatContentPart, ChatMessage, ChatRunContext, Role, ToolCallRecord,
    ToolDescriptor, ToolResultRecord,
};
use worldbase_providers::{
    ChatOptions, ContentBlock, LlmMessage, LlmRole, LlmTool, Provider, StreamChunk,
};

/// 单轮/多轮工具循环的最大步数（防失控）。
// Keep the segment budget aligned with Electron's agent loop.  A terminal
// event is emitted when this guard is reached, so callers never wait forever
// for a stream that silently stopped after the last tool result.
const MAX_STEPS: usize = 128;
const MAX_DUPLICATE_ITERATIONS: usize = 6;
const MAX_TOKENS: u32 = 8192;

/// ChatMessage 历史 → LLM 消息历史。
pub fn to_llm_messages(messages: &[ChatMessage]) -> Vec<LlmMessage> {
    let mut out = Vec::new();
    for msg in messages {
        let mut blocks = Vec::new();
        match msg.role {
            Role::Assistant => {
                if !msg.content.is_empty() {
                    blocks.push(ContentBlock::Text {
                        text: msg.content.clone(),
                    });
                }
                for call in &msg.tool_calls {
                    blocks.push(ContentBlock::ToolUse {
                        id: call.id.clone(),
                        name: call.name.clone(),
                        input: call.args.clone(),
                    });
                }
            }
            Role::User | Role::System => {
                if msg.parts.is_empty() {
                    if !msg.content.is_empty() {
                        blocks.push(ContentBlock::Text {
                            text: msg.content.clone(),
                        });
                    }
                } else {
                    for part in &msg.parts {
                        match part {
                            ChatContentPart::Text { text } if !text.is_empty() => {
                                blocks.push(ContentBlock::Text { text: text.clone() });
                            }
                            ChatContentPart::ImageUrl { image_url }
                                if !image_url.url.is_empty() =>
                            {
                                blocks.push(ContentBlock::ImageUrl {
                                    url: image_url.url.clone(),
                                });
                            }
                            _ => {}
                        }
                    }
                }
                for result in &msg.tool_results {
                    blocks.push(ContentBlock::ToolResult {
                        tool_use_id: result.tool_call_id.clone(),
                        content: result.content.clone(),
                        is_error: result.is_error,
                    });
                }
            }
        }
        if blocks.is_empty() {
            continue;
        }
        let role = match msg.role {
            Role::Assistant => LlmRole::Assistant,
            _ => LlmRole::User,
        };
        out.push(LlmMessage {
            role,
            content: blocks,
        });
    }
    out
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
    prompt
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

fn run_tools(
    tools: Vec<Arc<dyn worldbase_tools::Tool>>,
    context: &ChatRunContext,
) -> Vec<Arc<dyn worldbase_tools::Tool>> {
    let allowed: std::collections::HashSet<&str> = context
        .allowed_tool_names
        .iter()
        .map(String::as_str)
        .filter(|name| !name.trim().is_empty())
        .collect();
    let denied: std::collections::HashSet<&str> = context
        .denied_tool_names
        .iter()
        .map(String::as_str)
        .filter(|name| !name.trim().is_empty())
        .collect();
    tools
        .into_iter()
        .filter(|tool| {
            (allowed.is_empty() || allowed.contains(tool.name())) && !denied.contains(tool.name())
        })
        .collect()
}

fn run_custom_tools(
    custom_tools: &[ToolDescriptor],
    builtin_tools: &[Arc<dyn worldbase_tools::Tool>],
    context: &ChatRunContext,
) -> Vec<ToolDescriptor> {
    let allowed: std::collections::HashSet<&str> = context
        .allowed_tool_names
        .iter()
        .map(String::as_str)
        .filter(|name| !name.trim().is_empty())
        .collect();
    let denied: std::collections::HashSet<&str> = context
        .denied_tool_names
        .iter()
        .map(String::as_str)
        .filter(|name| !name.trim().is_empty())
        .collect();
    let builtin_names: std::collections::HashSet<&str> =
        builtin_tools.iter().map(|tool| tool.name()).collect();
    let mut names = std::collections::HashSet::new();

    custom_tools
        .iter()
        .filter(|tool| {
            let name = tool.name.trim();
            let is_host_override = tool.domain == "electron_host_override";
            !name.is_empty()
                && (allowed.is_empty() || allowed.contains(name))
                && !denied.contains(name)
                // Electron can explicitly retain authority for an operation
                // whose data/runtime lives in the desktop host. Ordinary
                // custom tools still cannot shadow a native Rust builtin.
                && (is_host_override || !builtin_names.contains(name))
                && names.insert(name)
        })
        .cloned()
        .collect()
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
    provider_id: Option<String>,
    model: Option<String>,
    mut context: ChatRunContext,
    stream_id: Option<String>,
) -> Result<ChatRun> {
    start_chat_with_stream_id_and_group_runtime(
        hub,
        conversation_id,
        user_text,
        content_parts,
        capabilities,
        interactive,
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
    let (caps, interactive, req_provider_id, req_model, context, group_collaboration) = hub
        .runs
        .lock()
        .unwrap()
        .get(&stream_id)
        .map(|run| {
            (
                run.capabilities.clone(),
                run.interactive,
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
                ChatRunContext::default(),
                None,
            )
        });

    // 会话绑定 agent：persona + provider/model override
    let agent = hub
        .store
        .get_conversation(&conversation_id)
        .ok()
        .flatten()
        .and_then(|c| c.agent_id)
        .and_then(|aid| hub.store.get_agent(&aid).ok().flatten());

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

    let mut tools = run_tools(hub.tools_for(&caps), &context);
    if group_collaboration.is_some() {
        let denied: std::collections::HashSet<&str> = context
            .denied_tool_names
            .iter()
            .map(String::as_str)
            .collect();
        tools.extend(
            worldbase_tools::group_collaboration_tools()
                .into_iter()
                .filter(|tool| !denied.contains(tool.name())),
        );
    }
    let mut custom_tools = run_custom_tools(&context.custom_tools, &tools, &context);
    if group_collaboration.is_some() {
        // Native group collaboration is Rust-owned. Never let a same-named
        // Electron host override route one of these calls back into TS.
        custom_tools.retain(|tool| {
            !matches!(
                tool.name.as_str(),
                "message_agent" | "read_board" | "update_board" | "reply_to_user"
            )
        });
    }
    // A host override must replace, rather than merely supplement, a native
    // descriptor. This keeps the schema shown to the model and the execution
    // target aligned for Electron-owned project/workspace/image/group tools.
    let host_override_names: std::collections::HashSet<&str> = custom_tools
        .iter()
        .filter(|tool| tool.domain == "electron_host_override")
        .map(|tool| tool.name.as_str())
        .collect();
    tools.retain(|tool| !host_override_names.contains(tool.name()));
    let system = system_prompt(&hub, agent.as_ref(), &context);
    let folder_workspace = context
        .workspace_root
        .as_deref()
        .map(std::path::PathBuf::from);
    let mut services = hub.services_for_run(
        folder_workspace,
        context.target_project_id.clone(),
        context.allowed_mcp_server_ids.clone(),
    );
    services.group_collaboration = group_collaboration;
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
    tools.extend(run_tools(discovered_mcp_tools, &context));
    let mut tools_meta = llm_tools(&tools);
    tools_meta.extend(llm_custom_tools(&custom_tools));

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
            if limit.is_finite() && limit >= 0.0 && total_cost >= limit {
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

        let mut stream = match provider
            .chat_stream(
                Some(&system),
                llm_messages.clone(),
                tools_meta.clone(),
                MAX_TOKENS,
                ChatOptions {
                    temperature: context.temperature,
                    reasoning_effort: context.reasoning_effort.clone(),
                },
            )
            .await
        {
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
        while let Some(chunk) = stream.next().await {
            if abort.is_cancelled() {
                break;
            }
            match chunk {
                Ok(StreamChunk::TextDelta(text)) => {
                    publish(&hub, &channel, &stream_id, EventKind::Delta { text }).await;
                }
                Ok(StreamChunk::Completed {
                    stop_reason: reason,
                    assistant: msg,
                    usage,
                }) => {
                    stop_reason = reason;
                    assistant = Some(msg.clone());
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
        let assistant_content = assistant_msg.text_view();
        let record = ChatMessage {
            id: 0,
            role: Role::Assistant,
            content: assistant_content.clone(),
            parts: vec![],
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
        if !assistant_content.is_empty() {
            publish(
                &hub,
                &channel,
                &stream_id,
                EventKind::AssistantMessage {
                    content: assistant_content.clone(),
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
            let exec_result = if !services.is_tool_allowed_in_plan_mode(&name) {
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
                )
                .await;
                if allowed {
                    match tool {
                        Some(tool) => tool.execute(input.clone(), &services).await,
                        None if custom_tool.is_some() => {
                            hub.host_request(
                                &stream_id,
                                "tool.execute",
                                serde_json::json!({ "name": name, "args": input }),
                                std::time::Duration::from_secs(300),
                            )
                            .await
                        }
                        None => Err(anyhow::anyhow!("unknown tool: {name}")),
                    }
                } else {
                    Err(anyhow::anyhow!("权限被拒绝：{name}"))
                }
            };

            let (content, is_error) = match exec_result {
                Ok(value) => (serde_json::to_string(&value).unwrap_or_default(), false),
                Err(e) => (e.to_string(), true),
            };
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
