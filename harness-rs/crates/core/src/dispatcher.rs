//! JSON-RPC dispatcher：所有 transport（stdio/WS/in-process）共用。
//!
//! 方法访问受 capabilities 约束：desktop 域方法在 excludes 含
//! subprocess/port_binding 的连接上返回 method not found。

use crate::hub::Hub;
use anyhow::Result;
use serde_json::{json, Value};
use std::sync::Arc;
use worldbase_protocol::event::EventKind;
use worldbase_protocol::method::*;
use worldbase_protocol::rpc::ErrorObject;
use worldbase_protocol::types::*;

pub struct ConnectionContext {
    pub capabilities: Capabilities,
    /// 宿主能否应答权限询问。
    pub interactive: bool,
}

impl ConnectionContext {
    pub fn new(capabilities: Capabilities) -> Self {
        // 宿主声明 interactive 特性即可应答权限询问 / ask_user（移动端 UI / 桌面端均可）
        let interactive = capabilities.features.iter().any(|f| f == "interactive");
        Self { capabilities, interactive }
    }

    fn desktop_allowed(&self) -> bool {
        !self.capabilities.excluded("subprocess") && !self.capabilities.excluded("port_binding")
    }
}

pub async fn dispatch(
    hub: &Arc<Hub>,
    ctx: &ConnectionContext,
    method: &str,
    params: Value,
) -> std::result::Result<Value, ErrorObject> {
    // 域过滤
    if method_domain(method) == "desktop" && !ctx.desktop_allowed() {
        return Err(ErrorObject::method_not_found(method));
    }

    match method {
        INITIALIZE => initialize(hub, ctx, params),
        PING => Ok(json!({ "pong": true, "ts": worldbase_protocol::event::now_rfc3339() })),
        SHUTDOWN => Ok(json!({ "ok": true })),

        CONVERSATION_CREATE => conv_create(hub, params),
        CONVERSATION_LIST => conv_list(hub, params),
        CONVERSATION_MESSAGES => conv_messages(hub, params),
        CONVERSATION_DELETE => conv_delete(hub, params),
        CONVERSATION_RENAME => conv_rename(hub, params),

        CHAT_SEND => chat_send(hub, ctx, params),
        CHAT_RESUME => chat_resume(hub, params).await,
        CHAT_ABORT => chat_abort(hub, params),
        CHAT_RESPOND => chat_respond(hub, params),

        TOOL_LIST => Ok(json!({
            "tools": worldbase_tools::descriptors(&hub.tools_for(&ctx.capabilities))
        })),
        TOOL_CALL => tool_call(hub, ctx, params).await,

        SETTINGS_GET => settings_get(hub, params),
        SETTINGS_SET => settings_set(hub, params),

        MEMORY_SEARCH => memory_search(hub, params),
        MEMORY_ADD => memory_add(hub, params),
        MEMORY_DELETE => memory_delete(hub, params),

        SKILL_LIST => skill_list(hub),
        SKILL_RUN => skill_run(hub, params),

        SCHEDULE_LIST => schedule_list(hub),
        SCHEDULE_CREATE => schedule_create(hub, params),
        SCHEDULE_DELETE => schedule_delete(hub, params),
        SCHEDULE_RUN => schedule_run(hub, ctx, params),

        GROUP_CREATE => group_create(hub, params),
        GROUP_GET => group_get(hub, params),
        GROUP_MESSAGE => group_message(hub, ctx, params),
        GROUP_BLACKBOARD_ADD => group_blackboard_add(hub, params),

        MCP_LIST => Ok(json!({ "servers": hub.mcp.server_names().await, "tools": hub.mcp.list_tools().await })),
        MCP_CALL => mcp_call(hub, params).await,
        MCP_RELOAD => mcp_reload(hub, params).await,

        DOC_PARSE => doc_parse(hub, params),
        DOC_WRITE => doc_write(hub, params),

        PROJECT_LIST => Ok(json!({ "projects": hub.projects.list_projects().map_err(internal)? })),
        PROJECT_CREATE => project_create(hub, params).await,
        PROJECT_DEV_START => project_dev_start(hub, params).await,
        PROJECT_DEV_STOP => project_dev_stop(hub, params).await,
        PROJECT_STATUS => project_status(hub, params).await,

        EXEC_RUN => exec_run(hub, ctx, params).await,

        PROVIDER_LIST => Ok(json!({ "providers": hub.providers_config() })),
        PROVIDER_SAVE => provider_save(hub, params),
        PROVIDER_DELETE => provider_delete(hub, params),
        PROVIDER_SET_ACTIVE => provider_set_active(hub, params),

        AGENT_LIST => Ok(json!({ "agents": hub.store.list_agents().map_err(internal)? })),
        AGENT_GET => agent_get(hub, params),
        AGENT_SAVE => agent_save(hub, params),
        AGENT_DELETE => agent_delete(hub, params),

        STUDIO_GENERATE => studio_generate(hub, params),
        STUDIO_LIST => studio_list(hub, params),
        STUDIO_DELETE => studio_delete(hub, params),
        STUDIO_TAG => studio_tag(hub, params),

        USAGE_SUMMARY => {
            let days = params["days"].as_u64().unwrap_or(30) as u32;
            let summary = hub.store.usage_summary(days).map_err(internal)?;
            Ok(serde_json::to_value(&summary).unwrap())
        }

        LIGHTAPP_LIST => {
            let apps = hub.store.list_lightapps().map_err(internal)?;
            Ok(json!({ "apps": apps }))
        }
        LIGHTAPP_DELETE => {
            let id = params["id"].as_str().ok_or_else(|| params_err("missing id"))?;
            let dir = crate::studio::StudioService::lightapp_dir().join(id);
            if dir.starts_with(crate::studio::StudioService::lightapp_dir()) {
                let _ = std::fs::remove_dir_all(dir);
            }
            let deleted = hub.store.delete_lightapp(id).map_err(internal)?;
            Ok(json!({ "deleted": deleted }))
        }

        CONVERSATION_FORK => conversation_fork(hub, params),

        GROUP_INJECT => group_inject(hub, params),
        GROUP_BOARD_UPDATE => group_board_update(hub, params),

        SKILL_SAVE => skill_save(hub, params),
        SKILL_DELETE => skill_delete(hub, params),

        HOST_RESPOND => {
            let request_id = params["requestId"].as_str().ok_or_else(|| params_err("missing requestId"))?;
            let result = params.get("result").cloned().unwrap_or(Value::Null);
            Ok(json!({ "delivered": hub.host_respond(request_id, result) }))
        }

        _ => Err(ErrorObject::method_not_found(method)),
    }
}

fn internal(e: impl std::fmt::Display) -> ErrorObject {
    ErrorObject::internal(e.to_string())
}

fn params_err(msg: impl Into<String>) -> ErrorObject {
    ErrorObject::invalid_params(msg)
}

// ---------- initialize ----------

fn initialize(hub: &Arc<Hub>, ctx: &ConnectionContext, params: Value) -> Result<Value, ErrorObject> {
    let init: InitializeParams = serde_json::from_value(params).map_err(|e| params_err(e.to_string()))?;
    if !init.protocol_version.starts_with("1.") {
        return Err(ErrorObject::new(
            worldbase_protocol::rpc::SERVER_ERROR,
            format!("unsupported protocol version: {}", init.protocol_version),
        ));
    }
    let available_domains = ALL_METHODS
        .iter()
        .filter(|m| !(method_domain(m) == "desktop" && !ctx.desktop_allowed()))
        .map(|m| m.to_string())
        .collect();
    Ok(serde_json::to_value(InitializeResult {
        protocol_version: worldbase_protocol::PROTOCOL_VERSION.into(),
        server_version: worldbase_protocol::SERVER_VERSION.into(),
        available_tools: worldbase_tools::descriptors(&hub.tools_for(&init.capabilities)),
        available_domains,
    })
    .unwrap())
}

// ---------- conversations ----------

fn conv_create(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let title = params["title"].as_str().unwrap_or("新对话");
    let agent_id = params["agentId"].as_str();
    let meta = hub.store.create_conversation(title, agent_id).map_err(internal)?;
    Ok(serde_json::to_value(meta).unwrap())
}

fn conv_list(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let limit = params["limit"].as_u64().unwrap_or(50) as u32;
    let list = hub.store.list_conversations(limit).map_err(internal)?;
    Ok(json!({ "conversations": list }))
}

fn conv_messages(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let id = params["id"].as_str().ok_or_else(|| params_err("missing id"))?;
    let limit = params["limit"].as_u64().unwrap_or(200) as u32;
    let messages = hub.store.list_messages(id, limit).map_err(internal)?;
    Ok(json!({ "messages": messages }))
}

fn conv_delete(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let id = params["id"].as_str().ok_or_else(|| params_err("missing id"))?;
    hub.store.delete_conversation(id).map_err(internal)?;
    Ok(json!({ "deleted": true }))
}

fn conv_rename(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let id = params["id"].as_str().ok_or_else(|| params_err("missing id"))?;
    let title = params["title"].as_str().ok_or_else(|| params_err("missing title"))?;
    hub.store.rename_conversation(id, title).map_err(internal)?;
    Ok(json!({ "renamed": true }))
}

// ---------- chat ----------

fn chat_send(hub: &Arc<Hub>, ctx: &ConnectionContext, params: Value) -> Result<Value, ErrorObject> {
    let p: ChatSendParams = serde_json::from_value(params).map_err(|e| params_err(e.to_string()))?;
    if hub.store.get_conversation(&p.conversation_id).map_err(internal)?.is_none() {
        return Err(params_err("conversation not found"));
    }
    let run = crate::agent::start_chat(
        hub.clone(),
        p.conversation_id.clone(),
        p.text.clone(),
        ctx.capabilities.clone(),
        ctx.interactive,
        p.provider_id.clone(),
        p.model.clone(),
    )
    .map_err(internal)?;
    Ok(serde_json::to_value(ChatSendResult { stream_id: run.stream_id, user_message_seq: 0 }).unwrap())
}

async fn chat_resume(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let p: ChatResumeParams = serde_json::from_value(params).map_err(|e| params_err(e.to_string()))?;
    let channel = hub
        .streams
        .lock()
        .unwrap()
        .get(&p.stream_id)
        .cloned();
    let Some(channel) = channel else {
        return Err(ErrorObject::new(worldbase_protocol::rpc::SERVER_ERROR, "stream not found or expired"));
    };
    let frames = channel.replay(p.after_seq).await;
    Ok(json!({ "events": frames }))
}

fn chat_abort(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let p: ChatAbortParams = serde_json::from_value(params).map_err(|e| params_err(e.to_string()))?;
    let mut aborted = 0;
    for (stream_id, run) in hub.runs.lock().unwrap().iter() {
        let matches = p.stream_id.as_deref() == Some(stream_id.as_str())
            || p.conversation_id.as_deref() == Some(run.conversation_id.as_str());
        if matches {
            run.abort.cancel();
            aborted += 1;
        }
    }
    Ok(json!({ "aborted": aborted }))
}

fn chat_respond(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let request_id = params["requestId"].as_str().ok_or_else(|| params_err("missing requestId"))?;
    let allow = params["allow"].as_bool().unwrap_or(false);
    let delivered = crate::permissions::respond(hub, request_id, allow);
    Ok(json!({ "delivered": delivered }))
}

// ---------- tools ----------

async fn tool_call(hub: &Arc<Hub>, ctx: &ConnectionContext, params: Value) -> Result<Value, ErrorObject> {
    let name = params["name"].as_str().ok_or_else(|| params_err("missing name"))?;
    let args = params.get("args").cloned().unwrap_or(json!({}));
    let tools = hub.tools_for(&ctx.capabilities);
    let tool = tools
        .iter()
        .find(|t| t.name() == name)
        .ok_or_else(|| ErrorObject::invalid_params(format!("unknown tool: {name}")))?;

    let policy = hub
        .store
        .get_setting("permissions")
        .ok()
        .flatten()
        .and_then(|p| p.get(name).and_then(|v| v.as_str()).map(String::from))
        .unwrap_or_else(|| tool.permission().to_string());
    let allowed = crate::permissions::check(hub, "tool-call", &policy, name, &args, ctx.interactive).await;
    if !allowed {
        return Err(ErrorObject::new(worldbase_protocol::rpc::SERVER_ERROR, format!("permission denied: {name}")));
    }
    let services = hub.services();
    services.set_current_stream("tool-call");
    let value = tool.execute(args, &services).await.map_err(internal)?;
    Ok(value)
}

// ---------- settings ----------

fn settings_get(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let key = params["key"].as_str().ok_or_else(|| params_err("missing key"))?;
    let value = hub.store.get_setting(key).map_err(internal)?;
    Ok(json!({ "key": key, "value": value }))
}

fn settings_set(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let key = params["key"].as_str().ok_or_else(|| params_err("missing key"))?;
    let value = params.get("value").cloned().unwrap_or(Value::Null);
    hub.store.set_setting(key, &value).map_err(internal)?;
    Ok(json!({ "ok": true }))
}

// ---------- memory ----------

fn memory_search(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let query = params["query"].as_str().ok_or_else(|| params_err("missing query"))?;
    let limit = params["limit"].as_u64().unwrap_or(10) as u32;
    let hits = hub.store.search_memories(query, limit).map_err(internal)?;
    Ok(json!({ "hits": hits }))
}

fn memory_add(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let content = params["content"].as_str().ok_or_else(|| params_err("missing content"))?;
    let tags: Vec<String> = params["tags"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let id = hub.store.add_memory(content, &tags).map_err(internal)?;
    Ok(json!({ "id": id }))
}

fn memory_delete(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let id = params["id"].as_i64().ok_or_else(|| params_err("missing id"))?;
    let deleted = hub.store.delete_memory(id).map_err(internal)?;
    Ok(json!({ "deleted": deleted }))
}

// ---------- skills ----------

fn skill_list(hub: &Arc<Hub>) -> Result<Value, ErrorObject> {
    let skills = hub.skills.list().map_err(internal)?;
    Ok(json!({ "skills": skills }))
}

fn skill_run(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let name = params["name"].as_str().ok_or_else(|| params_err("missing name"))?;
    let skill = hub
        .skills
        .get(name)
        .map_err(internal)?
        .ok_or_else(|| ErrorObject::invalid_params(format!("skill not found: {name}")))?;
    Ok(json!({ "skill": skill, "note": "请按 instructions 执行任务" }))
}

// ---------- schedules ----------

fn schedule_list(hub: &Arc<Hub>) -> Result<Value, ErrorObject> {
    let schedules = hub.scheduler.list().map_err(internal)?;
    Ok(json!({ "schedules": schedules }))
}

fn schedule_create(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let name = params["name"].as_str().ok_or_else(|| params_err("missing name"))?;
    let cron = params["cron"].as_str().ok_or_else(|| params_err("missing cron"))?;
    let task = params["task"].as_str().ok_or_else(|| params_err("missing task"))?;
    let entry = hub.scheduler.create(name, cron, task).map_err(internal)?;
    Ok(json!({ "entry": entry }))
}

fn schedule_delete(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let id = params["id"].as_str().ok_or_else(|| params_err("missing id"))?;
    let deleted = hub.scheduler.delete(id).map_err(internal)?;
    Ok(json!({ "deleted": deleted }))
}

fn schedule_run(hub: &Arc<Hub>, ctx: &ConnectionContext, params: Value) -> Result<Value, ErrorObject> {
    let task = params["task"].as_str().ok_or_else(|| params_err("missing task"))?;
    let conv = hub.store.create_conversation("[手动任务]", None).map_err(internal)?;
    let run = crate::agent::start_chat(
        hub.clone(),
        conv.id.clone(),
        task.to_string(),
        ctx.capabilities.clone(),
        ctx.interactive,
        None,
        None,
    )
    .map_err(internal)?;
    Ok(json!({ "streamId": run.stream_id, "conversationId": conv.id }))
}

// ---------- group ----------

fn group_create(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let topic = params["topic"].as_str().ok_or_else(|| params_err("missing topic"))?;
    let mode: GroupMode =
        serde_json::from_value(params.get("mode").cloned().unwrap_or(json!("discussion")))
            .unwrap_or(GroupMode::Discussion);
    let members: Vec<GroupMember> = serde_json::from_value(
        params.get("members").cloned().unwrap_or_else(|| {
            json!([
                { "name": "协调者", "persona": "统筹规划，收敛结论" },
                { "name": "工程师", "persona": "务实落地，关注实现细节" },
                { "name": "评审", "persona": "挑刺找风险，严苛审查" }
            ])
        }),
    )
    .map_err(|e| params_err(e.to_string()))?;
    let coordinator = params["coordinator"].as_str().map(String::from);
    let session = worldbase_group::GroupEngine::create(topic, mode, members, coordinator)
        .map_err(internal)?;
    hub.group_sessions.lock().unwrap().insert(session.id.clone(), session.clone());
    Ok(serde_json::to_value(&session).unwrap())
}

fn group_inject(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let id = params["id"].as_str().ok_or_else(|| params_err("missing id"))?;
    let content = params["content"].as_str().ok_or_else(|| params_err("missing content"))?;
    let mut sessions = hub.group_sessions.lock().unwrap();
    let session = sessions.get_mut(id).ok_or_else(|| ErrorObject::invalid_params("group session not found"))?;
    worldbase_group::GroupEngine::inject(session, content);
    Ok(json!({ "queued": session.pending_injections.len() }))
}

fn group_board_update(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let id = params["id"].as_str().ok_or_else(|| params_err("missing id"))?;
    let field = params["field"].as_str().ok_or_else(|| params_err("missing field"))?;
    let op = params["op"].as_str().ok_or_else(|| params_err("missing op"))?;
    let value = params["value"].as_str().unwrap_or("");
    let mut sessions = hub.group_sessions.lock().unwrap();
    let session = sessions.get_mut(id).ok_or_else(|| ErrorObject::invalid_params("group session not found"))?;
    worldbase_group::GroupEngine::board_update(session, field, op, value).map_err(internal)?;
    Ok(json!({ "board": session.board }))
}

fn group_get(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let id = params["id"].as_str().ok_or_else(|| params_err("missing id"))?;
    let session = hub
        .group_sessions
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or_else(|| ErrorObject::invalid_params("group session not found"))?;
    Ok(serde_json::to_value(&session).unwrap())
}

fn group_message(hub: &Arc<Hub>, _ctx: &ConnectionContext, params: Value) -> Result<Value, ErrorObject> {
    let id = params["id"].as_str().ok_or_else(|| params_err("missing id"))?.to_string();
    let text = params["text"].as_str().ok_or_else(|| params_err("missing text"))?.to_string();
    let session = hub
        .group_sessions
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| ErrorObject::invalid_params("group session not found"))?;
    let round = params["round"].as_u64().unwrap_or((session.rounds.len() / session.members.len().max(1)) as u64 + 1) as u32;

    // 事件流：stream_id = group 会话 id
    let hub2 = hub.clone();
    let id_for_task = id.clone();
    tokio::spawn(async move {
        let id = id_for_task;
        let mut session = session;
        hub2.emit(&id, EventKind::Notice { text: format!("群组讨论：{text}") }).await;

        // 收集同步回调产物，按序发布
        let collected = Arc::new(std::sync::Mutex::new(Vec::new()));
        let boards = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = collected.clone();
        let board_sink = boards.clone();
        let mut on_board = |board: &worldbase_protocol::types::GroupBoard| {
            board_sink.lock().unwrap().push(board.clone());
        };
        let mut on_message_cb = |member: String, content: String, r: u32| {
            sink.lock().unwrap().push((member, content, r));
        };
        let result = worldbase_group::GroupEngine::run_round(
            &mut session, &text, round, &mut on_message_cb, &mut on_board,
        )
        .await;
        match result {
            Ok(_count) => {
                hub2.group_sessions.lock().unwrap().insert(id.clone(), session);
                let drained: Vec<(String, String, u32)> = collected.lock().unwrap().drain(..).collect();
                for (member, content, r) in drained {
                    hub2.emit(&id, EventKind::GroupMessage { member, round: r, content }).await;
                }
                let board_frames: Vec<worldbase_protocol::types::GroupBoard> =
                    boards.lock().unwrap().drain(..).collect();
                if let Some(board) = board_frames.last() {
                    hub2.emit(&id, EventKind::BoardUpdate { board: board.clone() }).await;
                }
                hub2.emit(&id, EventKind::Done { stop_reason: "round complete".into() }).await;
            }
            Err(e) => {
                hub2.emit(&id, EventKind::Error { message: e.to_string() }).await;
            }
        }
    });
    Ok(json!({ "streamId": id, "round": round }))
}

fn group_blackboard_add(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let id = params["id"].as_str().ok_or_else(|| params_err("missing id"))?;
    let note = params["note"].as_str().ok_or_else(|| params_err("missing note"))?;
    let mut sessions = hub.group_sessions.lock().unwrap();
    let session = sessions.get_mut(id).ok_or_else(|| ErrorObject::invalid_params("group session not found"))?;
    session.board.evidence_refs.push(note.to_string());
    Ok(json!({ "board": session.board }))
}

// ---------- mcp ----------

async fn mcp_call(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let server = params["server"].as_str().ok_or_else(|| params_err("missing server"))?;
    let tool = params["tool"].as_str().ok_or_else(|| params_err("missing tool"))?;
    let args = params.get("args").cloned().unwrap_or(json!({}));
    let result = hub.mcp.call_tool(server, tool, args).await.map_err(internal)?;
    Ok(result)
}

async fn mcp_reload(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let configs: Vec<worldbase_mcp_client::McpServerConfig> = serde_json::from_value(
        params.get("servers").cloned().unwrap_or_else(|| json!([])),
    )
    .map_err(|e| params_err(e.to_string()))?;
    hub.mcp.configure(configs).await;
    Ok(json!({ "servers": hub.mcp.server_names().await }))
}

// ---------- docs ----------

fn doc_parse(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let path = params["path"].as_str().ok_or_else(|| params_err("missing path"))?;
    let full = hub.workspace.join(path);
    let parsed = worldbase_docs::parse_file(&full).map_err(internal)?;
    Ok(parsed)
}

fn doc_write(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let path = params["path"].as_str().ok_or_else(|| params_err("missing path"))?;
    let kind = params["kind"].as_str().ok_or_else(|| params_err("missing kind"))?;
    let full = hub.workspace.join(path);
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).map_err(internal)?;
    }
    match kind {
        "markdown" | "text" | "json" => {
            let content = params["content"].as_str().ok_or_else(|| params_err("missing content"))?;
            worldbase_docs::edit::write_text(&full, content).map_err(internal)?;
        }
        "csv" => {
            let header: Vec<String> = params["header"]
                .as_array()
                .map(|a| a.iter().map(|v| v.as_str().unwrap_or_default().into()).collect())
                .unwrap_or_default();
            let rows: Vec<Vec<String>> = params["rows"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|r| r.as_array().map(|c| c.iter().map(cell).collect()).unwrap_or_default())
                        .collect()
                })
                .unwrap_or_default();
            worldbase_docs::edit::write_csv(&full, &header, &rows).map_err(internal)?;
        }
        "docx" => {
            let blocks = doc_blocks(&params);
            worldbase_docs::edit::write_docx(&full, &blocks).map_err(internal)?;
        }
        "xlsx" => {
            let sheets = vec![worldbase_docs::edit::Sheet {
                name: params["sheet_name"].as_str().unwrap_or("Sheet1").into(),
                rows: params["rows"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .map(|r| r.as_array().map(|c| c.iter().map(cell).collect()).unwrap_or_default())
                            .collect()
                    })
                    .unwrap_or_default(),
            }];
            worldbase_docs::edit::write_xlsx(&full, &sheets).map_err(internal)?;
        }
        other => return Err(params_err(format!("unsupported kind: {other}"))),
    }
    Ok(json!({ "path": path, "kind": kind, "written": true }))
}

fn cell(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn doc_blocks(params: &Value) -> Vec<worldbase_docs::edit::DocBlock> {
    let mut blocks = Vec::new();
    for b in params["blocks"].as_array().cloned().unwrap_or_default() {
        let text = b["text"].as_str().unwrap_or_default().into();
        match b["type"].as_str().unwrap_or("paragraph") {
            "heading" => blocks.push(worldbase_docs::edit::DocBlock::Heading(text, b["level"].as_u64().unwrap_or(1) as u32)),
            "bullet" => blocks.push(worldbase_docs::edit::DocBlock::Bullet(text)),
            _ => blocks.push(worldbase_docs::edit::DocBlock::Paragraph(text)),
        }
    }
    blocks
}


// ---------- providers（供应商管理，对齐桌面 settings:providers）----------

fn provider_save(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let entry: ProviderEntry = serde_json::from_value(
        params.get("provider").cloned().unwrap_or(Value::Null),
    )
    .map_err(|e| params_err(e.to_string()))?;
    let mut cfg = hub.providers_config();
    if let Some(existing) = cfg.providers.iter_mut().find(|p| p.id == entry.id) {
        *existing = entry.clone();
    } else {
        cfg.providers.push(entry.clone());
    }
    // 首个供应商自动激活
    if cfg.active_provider_id.is_none() {
        cfg.active_provider_id = Some(entry.id.clone());
    }
    hub.store.set_setting("providers", &serde_json::to_value(&cfg).unwrap()).map_err(internal)?;
    Ok(json!({ "providers": cfg }))
}

fn provider_delete(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let id = params["id"].as_str().ok_or_else(|| params_err("missing id"))?;
    let mut cfg = hub.providers_config();
    cfg.providers.retain(|p| p.id != id);
    if cfg.active_provider_id.as_deref() == Some(id) {
        cfg.active_provider_id = cfg.providers.first().map(|p| p.id.clone());
    }
    hub.store.set_setting("providers", &serde_json::to_value(&cfg).unwrap()).map_err(internal)?;
    Ok(json!({ "providers": cfg }))
}

fn provider_set_active(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let id = params["id"].as_str().ok_or_else(|| params_err("missing id"))?;
    let mut cfg = hub.providers_config();
    if !cfg.providers.iter().any(|p| p.id == id) {
        return Err(ErrorObject::invalid_params(format!("provider not found: {id}")));
    }
    cfg.active_provider_id = Some(id.to_string());
    hub.store.set_setting("providers", &serde_json::to_value(&cfg).unwrap()).map_err(internal)?;
    Ok(json!({ "providers": cfg }))
}

// ---------- agents ----------

fn agent_get(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let id = params["id"].as_str().ok_or_else(|| params_err("missing id"))?;
    let agent = hub.store.get_agent(id).map_err(internal)?;
    Ok(json!({ "agent": agent }))
}

fn agent_save(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let mut agent: AgentDefinition =
        serde_json::from_value(params.get("agent").cloned().unwrap_or(Value::Null))
            .map_err(|e| params_err(e.to_string()))?;
    let now = worldbase_protocol::event::now_rfc3339();
    if agent.id.is_empty() {
        agent.id = uuid::Uuid::new_v4().to_string();
        agent.created_at = now.clone();
    } else if let Some(existing) = hub.store.get_agent(&agent.id).map_err(internal)? {
        agent.created_at = existing.created_at;
    } else {
        agent.created_at = now.clone();
    }
    agent.updated_at = now;
    hub.store.upsert_agent(&agent).map_err(internal)?;
    Ok(json!({ "agent": agent }))
}

fn agent_delete(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let id = params["id"].as_str().ok_or_else(|| params_err("missing id"))?;
    let deleted = hub.store.delete_agent(id).map_err(internal)?;
    Ok(json!({ "deleted": deleted }))
}

// ---------- studio（图像生成）----------

fn studio_generate(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let mut p: ImageGenerateParams = serde_json::from_value(params.clone()).map_err(|e| params_err(e.to_string()))?;
    // 显式模型：与供应商解析一致（model 覆盖 active_model）
    if let Some(m) = params["model"].as_str() {
        p.model = Some(m.to_string());
    }
    let stream_id = crate::studio::StudioService::generate(hub.clone(), p).map_err(internal)?;
    Ok(json!({ "streamId": stream_id }))
}

fn studio_list(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let q: ImageQuery = serde_json::from_value(params).unwrap_or_default();
    let images = hub
        .store
        .query_images(
            q.folder.as_deref(),
            q.tag.as_deref(),
            q.search.as_deref(),
            q.limit.unwrap_or(60),
        )
        .map_err(internal)?;
    Ok(json!({ "images": images }))
}

fn studio_tag(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let id = params["id"].as_str().ok_or_else(|| params_err("missing id"))?;
    let folder = params["folder"].as_str().unwrap_or("");
    let tags: Vec<String> = params["tags"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let ok = hub.store.set_image_meta(id, folder, &tags).map_err(internal)?;
    Ok(json!({ "updated": ok }))
}

fn studio_delete(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let id = params["id"].as_str().ok_or_else(|| params_err("missing id"))?;
    // 删文件 + 删索引
    if let Ok(Some(entry)) = hub.store.get_image(id) {
        let path = worldbase_memory::Store::default_dir().join("image-library").join(&entry.file);
        let _ = std::fs::remove_file(path);
    }
    let deleted = hub.store.delete_image(id).map_err(internal)?;
    Ok(json!({ "deleted": deleted }))
}

// ---------- conversation.fork（消息分叉/编辑重发）----------

fn conversation_fork(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let p: ForkParams = serde_json::from_value(params).map_err(|e| params_err(e.to_string()))?;
    let mode = if p.mode.is_empty() { "fork".to_string() } else { p.mode.clone() };
    let source = hub
        .store
        .get_conversation(&p.conversation_id)
        .map_err(internal)?
        .ok_or_else(|| ErrorObject::invalid_params("conversation not found"))?;
    let anchor = hub
        .store
        .get_message(&p.conversation_id, p.message_id)
        .map_err(internal)?
        .ok_or_else(|| ErrorObject::invalid_params("message not found"))?;

    match mode.as_str() {
        "inplace" => {
            // 破坏性：截断 anchor 之后；若带 new_text 则覆写 anchor 内容
            let truncated = hub
                .store
                .truncate_after(&p.conversation_id, p.message_id)
                .map_err(internal)?;
            if let Some(text) = &p.new_text {
                hub.store
                    .update_message_content(p.message_id, text)
                    .map_err(internal)?;
            }
            Ok(serde_json::to_value(ForkResult {
                conversation_id: p.conversation_id.clone(),
                truncated,
            })
            .unwrap())
        }
        _ => {
            // fork 模式：复制前缀（anchor 含）到新会话
            let new_title = format!("{} · 分叉", source.title);
            let new_conv = hub
                .store
                .create_forked_conversation(&source, p.message_id, &new_title)
                .map_err(internal)?;
            let ids = hub
                .store
                .message_ids_up_to(&p.conversation_id, Some(p.message_id))
                .map_err(internal)?;
            let mut copied = 0i64;
            for mid in ids {
                if let Some(msg) = hub
                    .store
                    .get_message(&p.conversation_id, mid)
                    .map_err(internal)?
                {
                    hub.store.append_message(&new_conv.id, &msg).map_err(internal)?;
                    copied += 1;
                }
            }
            // drop 谱系中间态字段
            let _ = anchor;
            let _ = &source;
            Ok(serde_json::to_value(ForkResult {
                conversation_id: new_conv.id,
                truncated: copied,
            })
            .unwrap())
        }
    }
}

// ---------- skills（内容安装/删除）----------

fn skill_save(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let name = params["name"].as_str().ok_or_else(|| params_err("missing name"))?;
    let safe: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let description = params["description"].as_str().unwrap_or("");
    let instructions = params["instructions"].as_str().ok_or_else(|| params_err("missing instructions"))?;
    let dir = worldbase_skills::worldbase_default_skills_dir();
    std::fs::create_dir_all(&dir).map_err(internal)?;
    let yaml = format!(
        "name: {}\ndescription: {}\ninstructions: |\n{}\n",
        safe,
        description.replace('\n', "\n  "),
        instructions
            .lines()
            .map(|l| format!("  {l}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    let path = dir.join(format!("{safe}.yaml"));
    std::fs::write(&path, yaml).map_err(internal)?;
    Ok(json!({ "name": safe, "path": path.display().to_string() }))
}

fn skill_delete(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let name = params["name"].as_str().ok_or_else(|| params_err("missing name"))?;
    let skills = hub.skills.list().map_err(internal)?;
    let Some(skill) = skills.iter().find(|s| s.name == name) else {
        return Ok(json!({ "deleted": false }));
    };
    let path = std::path::Path::new(&skill.path);
    let deleted = std::fs::remove_file(path).is_ok();
    Ok(json!({ "deleted": deleted }))
}

// ---------- projects ----------

async fn project_create(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let name = params["name"].as_str().ok_or_else(|| params_err("missing name"))?;
    let info = hub.projects.create_project(name).await.map_err(internal)?;
    Ok(serde_json::to_value(&info).unwrap())
}

async fn project_dev_start(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let project = params["project"].as_str().ok_or_else(|| params_err("missing project"))?;
    if params["install"].as_bool().unwrap_or(false) {
        let projects = hub.projects.list_projects().map_err(internal)?;
        if let Some(p) = projects.iter().find(|p| p.id == project) {
            let log = hub
                .projects
                .install(std::path::Path::new(&p.path))
                .await
                .map_err(internal)?;
            return Ok(json!({ "installLog": log }));
        }
    }
    let info = hub.projects.start_dev(project).await.map_err(internal)?;
    Ok(serde_json::to_value(&info).unwrap())
}

async fn project_dev_stop(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let project = params["project"].as_str().ok_or_else(|| params_err("missing project"))?;
    let stopped = hub.projects.stop_dev(project).await.map_err(internal)?;
    Ok(json!({ "stopped": stopped }))
}

async fn project_status(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let project = params["project"].as_str().ok_or_else(|| params_err("missing project"))?;
    let status = hub.projects.status(project).await.map_err(internal)?;
    Ok(status)
}

// ---------- exec ----------

async fn exec_run(hub: &Arc<Hub>, ctx: &ConnectionContext, params: Value) -> Result<Value, ErrorObject> {
    let program = params["program"].as_str().ok_or_else(|| params_err("missing program"))?;
    let args: Vec<String> = params["args"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let req = worldbase_exec::ExecRequest {
        program: program.into(),
        args,
        cwd: params["cwd"].as_str().map(String::from),
        env: Default::default(),
        timeout_secs: params["timeout_secs"].as_u64(),
        sandbox: params["sandbox"].as_bool().unwrap_or(true),
    };
    let allowed =
        crate::permissions::check(hub, "exec-run", "ask", "execute_command", &params, ctx.interactive).await;
    if !allowed {
        return Err(ErrorObject::new(worldbase_protocol::rpc::SERVER_ERROR, "permission denied: execute_command"));
    }
    let result = worldbase_exec::run(&req, &hub.workspace).await.map_err(internal)?;
    Ok(serde_json::to_value(&result).unwrap())
}
