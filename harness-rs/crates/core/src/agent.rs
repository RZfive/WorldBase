//! Agent 循环：流式事件发布、工具执行、权限询问、中止与断点续传。

use crate::hub::{Hub, RunHandle};
use anyhow::Result;
use futures::StreamExt;
use tokio_util::sync::CancellationToken;
use worldbase_protocol::event::{EventFrame, EventKind, StreamChannel};
use worldbase_protocol::types::{
    Capabilities, ChatMessage, Role, ToolCallRecord, ToolResultRecord,
};
use worldbase_providers::{ContentBlock, LlmMessage, LlmRole, LlmTool, Provider, StreamChunk};
use std::sync::Arc;

/// 单轮/多轮工具循环的最大步数（防失控）。
const MAX_STEPS: usize = 24;
const MAX_TOKENS: u32 = 8192;

/// ChatMessage 历史 → LLM 消息历史。
pub fn to_llm_messages(messages: &[ChatMessage]) -> Vec<LlmMessage> {
    let mut out = Vec::new();
    for msg in messages {
        let mut blocks = Vec::new();
        match msg.role {
            Role::Assistant => {
                if !msg.content.is_empty() {
                    blocks.push(ContentBlock::Text { text: msg.content.clone() });
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
                if !msg.content.is_empty() {
                    blocks.push(ContentBlock::Text { text: msg.content.clone() });
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
        out.push(LlmMessage { role, content: blocks });
    }
    out
}

fn system_prompt(hub: &Hub, agent: Option<&worldbase_protocol::types::AgentDefinition>) -> String {
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let base = format!(
        "今天是 {today}（UTC）。工作区目录：{}\n\
         你可以使用工具完成文件、搜索、文档、记忆、定时任务等操作。\n\
         需要长期记住的信息请调用 memory_add；回答保持精炼、结构清晰。",
        hub.workspace.display()
    );
    match agent {
        Some(a) if !a.system_prompt.trim().is_empty() => {
            format!("{}\n\n[Agent 人设：{}]\n{}", a.name, a.description, a.system_prompt)
                + "\n\n" + &base
        }
        _ => format!("你是 WorldBase 智能助手，运行在 Rust harness 内。\n{base}"),
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

pub struct ChatRun {
    pub stream_id: String,
    pub conversation_id: String,
}

/// 发起一次 chat：立即返回 stream_id，事件经 channel + hub.event_tx 下发。
pub fn start_chat(
    hub: Arc<Hub>,
    conversation_id: String,
    user_text: String,
    capabilities: Capabilities,
    interactive: bool,
    provider_id: Option<String>,
    model: Option<String>,
) -> Result<ChatRun> {
    let stream_id = uuid::Uuid::new_v4().to_string();
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
        },
    );

    let conv_for_task = conversation_id.clone();
    tokio::spawn(run_chat(
        hub,
        stream_id.clone(),
        conv_for_task,
        user_text,
        channel,
        abort,
    ));

    let _ = conversation_id;

    Ok(ChatRun { stream_id, conversation_id })
}

/// 调度任务入口：独立会话运行任务文本。
pub async fn run_scheduled_task(hub: Arc<Hub>, schedule_id: &str, name: &str, task: &str) -> Result<()> {
    let conv = hub.store.create_conversation(&format!("[定时] {name}"), None)?;
    let stream_id = format!("schedule-{schedule_id}-{}", uuid::Uuid::new_v4());
    let channel = hub.register_stream(&stream_id);
    let _ = channel.publish(&stream_id, EventKind::Notice { text: format!("定时任务触发：{name}") }).await;
    run_chat_inner(hub, stream_id, conv.id, channel, CancellationToken::new()).await;
    Ok(())
}

async fn run_chat(
    hub: Arc<Hub>,
    stream_id: String,
    conversation_id: String,
    user_text: String,
    channel: Arc<StreamChannel>,
    abort: CancellationToken,
) {
    // 用户消息落库 + 事件
    let user_msg = ChatMessage {
        id: 0,
        role: Role::User,
        content: user_text.clone(),
        tool_calls: vec![],
        tool_results: vec![],
        created_at: None,
    };
    if let Err(e) = hub.store.append_message(&conversation_id, &user_msg) {
        publish(&hub, &channel, &stream_id, EventKind::Error { message: format!("persist user message: {e}") }).await;
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

    run_chat_inner(hub, stream_id, conversation_id, channel, abort).await;
}

async fn run_chat_inner(
    hub: Arc<Hub>,
    stream_id: String,
    conversation_id: String,
    channel: Arc<StreamChannel>,
    abort: CancellationToken,
) -> Result<String> {
    let caps = hub
        .runs
        .lock()
        .unwrap()
        .get(&stream_id)
        .map(|r| r.capabilities.clone())
        .unwrap_or_else(Capabilities::desktop);
    let interactive = hub
        .runs
        .lock()
        .unwrap()
        .get(&stream_id)
        .map(|r| r.interactive)
        .unwrap_or(false);

    // 会话绑定 agent：persona + provider/model override
    let agent = hub
        .store
        .get_conversation(&conversation_id)
        .ok()
        .flatten()
        .and_then(|c| c.agent_id)
        .and_then(|aid| hub.store.get_agent(&aid).ok().flatten());

    let (req_provider_id, req_model) = hub
        .runs
        .lock()
        .unwrap()
        .get(&stream_id)
        .map(|r| (r.provider_id.clone(), r.model.clone()))
        .unwrap_or((None, None));
    let (provider, provider_entry, model_override) = if req_provider_id.is_some() || req_model.is_some() {
        hub.provider_by_ids(req_provider_id.as_deref(), req_model.as_deref())?
    } else {
        match hub.provider_for_agent(agent.as_ref()) {
            Ok((p, entry, model)) => (p, entry, model),
            Err(e) => {
                publish(&hub, &channel, &stream_id, EventKind::Error { message: e.to_string() }).await;
                cleanup(&hub, &stream_id);
                return Ok(format!("provider error: {e}"));
            }
        }
    };
    publish(&hub, &channel, &stream_id, EventKind::Start {
        model: model_override.clone().unwrap_or_else(|| provider.model().to_string()),
    }).await;

    let tools = hub.tools_for(&caps);
    let tools_meta = llm_tools(&tools);
    let system = system_prompt(&hub, agent.as_ref());

    let history = hub
        .store
        .list_messages(&conversation_id, 400)
        .unwrap_or_default();
    let mut llm_messages = to_llm_messages(&history);

    let mut result: std::result::Result<String, anyhow::Error> = Err(anyhow::anyhow!("no steps"));
    for _step in 0..MAX_STEPS {
        if abort.is_cancelled() {
            publish(&hub, &channel, &stream_id, EventKind::Notice { text: "已中止".into() }).await;
            result = Ok("aborted".into());
            break;
        }

        let mut stream = match provider
            .chat_stream(Some(&system), llm_messages.clone(), tools_meta.clone(), MAX_TOKENS)
            .await
        {
            Ok(s) => s,
            Err(e) => {
                publish(&hub, &channel, &stream_id, EventKind::Error { message: e.to_string() }).await;
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
                Ok(StreamChunk::Completed { stop_reason: reason, assistant: msg, usage }) => {
                    stop_reason = reason;
                    assistant = Some(msg.clone());
                    // 用量记账（成本按供应商模型单价换算）
                    let model_name = model_override.as_deref().unwrap_or(provider.model());
                    let (pin, pout) = hub.model_prices(provider_entry.as_ref(), model_name);
                    let cost = usage.input_tokens as f64 / 1_000_000.0 * pin
                        + usage.output_tokens as f64 / 1_000_000.0 * pout;
                    let _ = hub.store.record_usage(
                        Some(&conversation_id),
                        provider_entry.as_ref().map(|e| e.id.as_str()),
                        model_name,
                        usage.input_tokens,
                        usage.output_tokens,
                        cost,
                    );
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
            publish(&hub, &channel, &stream_id, EventKind::Error { message: err.clone() }).await;
            cleanup(&hub, &stream_id);
            return Ok(format!("stream error: {err}"));
        }
        if abort.is_cancelled() {
            publish(&hub, &channel, &stream_id, EventKind::Notice { text: "已中止".into() }).await;
            result = Ok("aborted".into());
            break;
        }
        let Some(assistant_msg) = assistant else {
            publish(&hub, &channel, &stream_id, EventKind::Error { message: "provider ended without completion".into() }).await;
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
            publish(&hub, &channel, &stream_id, EventKind::AssistantMessage { content: assistant_content.clone() }).await;
        }

        // 无工具调用 → 结束
        if tool_uses.is_empty() {
            publish(&hub, &channel, &stream_id, EventKind::Done { stop_reason }).await;
            result = Ok(assistant_content);
            break;
        }

        // 执行工具调用
        llm_messages.push(assistant_msg);
        let mut tool_results_for_llm = Vec::new();
        for (call_id, name, input) in tool_uses {
            if abort.is_cancelled() {
                break;
            }
            publish(
                &hub,
                &channel,
                &stream_id,
                EventKind::ToolCall { call_id: call_id.clone(), name: name.clone(), args: input.clone() },
            )
            .await;

            // 权限检查
            let tool = tools.iter().find(|t| t.name() == name);
            let policy = worldbase_policy_for(hub.store.as_ref(), tool, &name);
            let allowed = crate::permissions::check(
                &hub,
                &stream_id,
                &policy,
                &name,
                &input,
                interactive,
            )
            .await;

            let exec_result = if allowed {
                match tool {
                    Some(tool) => {
                        let services = hub.services();
                        services.set_current_stream(&stream_id);
                        tool.execute(input.clone(), &services).await
                    }
                    None => Err(anyhow::anyhow!("unknown tool: {name}")),
                }
            } else {
                Err(anyhow::anyhow!("权限被拒绝：{name}"))
            };

            let (content, is_error) = match exec_result {
                Ok(value) => (serde_json::to_string(&value).unwrap_or_default(), false),
                Err(e) => (e.to_string(), true),
            };
            publish(
                &hub,
                &channel,
                &stream_id,
                EventKind::ToolResult { call_id: call_id.clone(), name: name.clone(), content: content.clone(), is_error },
            )
            .await;
            tool_results_for_llm.push(ContentBlock::ToolResult { tool_use_id: call_id, content, is_error });
        }

        // 工具结果作为 user 消息进历史（Anthropic 语义），并落库
        llm_messages.push(LlmMessage { role: LlmRole::User, content: tool_results_for_llm.clone() });
        let tr_record = ChatMessage {
            id: 0,
            role: Role::User,
            content: String::new(),
            tool_calls: vec![],
            tool_results: tool_results_for_llm
                .iter()
                .filter_map(|b| match b {
                    ContentBlock::ToolResult { tool_use_id, content, is_error } => Some(ToolResultRecord {
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
        result = Ok(String::new());
    }

    let final_text = match result {
        Ok(text) => text,
        Err(e) => {
            publish(&hub, &channel, &stream_id, EventKind::Error { message: e.to_string() }).await;
            String::new()
        }
    };
    cleanup(&hub, &stream_id);
    Ok(final_text)
}

fn worldbase_policy_for(
    store: &worldbase_memory::Store,
    tool: Option<&Arc<dyn worldbase_tools::Tool>>,
    name: &str,
) -> String {
    // settings.permissions = { tool_name: allow|ask|deny }
    if let Ok(Some(policy)) = store.get_setting("permissions") {
        if let Some(v) = policy.get(name).and_then(|v| v.as_str()) {
            return v.to_string();
        }
    }
    tool.map(|t| t.permission().to_string()).unwrap_or_else(|| "allow".into())
}

async fn publish(hub: &Hub, channel: &StreamChannel, stream_id: &str, kind: EventKind) {
    let seq = channel.publish(stream_id, kind.clone()).await;
    let ts = worldbase_protocol::event::now_rfc3339();
    let frame = EventFrame { stream_id: stream_id.to_string(), seq, ts, kind };
    let _ = hub.event_tx.send(frame);
}

fn cleanup(hub: &Hub, stream_id: &str) {
    hub.runs.lock().unwrap().remove(stream_id);
}
