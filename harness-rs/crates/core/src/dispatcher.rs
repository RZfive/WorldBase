//! JSON-RPC dispatcher：所有 transport（stdio/WS/in-process）共用。
//!
//! 方法访问受 capabilities 约束：desktop 域方法在 excludes 含
//! subprocess/port_binding 的连接上返回 method not found。

use crate::hub::{Hub, RunHandle};
use anyhow::Result;
use async_trait::async_trait;
use base64::Engine;
use futures::StreamExt;
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use worldbase_protocol::event::EventKind;
use worldbase_protocol::method::*;
use worldbase_protocol::rpc::ErrorObject;
use worldbase_protocol::types::*;

pub struct ConnectionContext {
    pub capabilities: Capabilities,
    /// 宿主能否应答权限询问。
    pub interactive: bool,
    /// Capabilities supplied by the initialize handshake.  The transport has
    /// a bootstrap value so requests can be dispatched before initialize,
    /// but all post-handshake behavior must use the negotiated value.
    negotiated_capabilities: std::sync::Mutex<Option<Capabilities>>,
}

impl ConnectionContext {
    pub fn new(capabilities: Capabilities) -> Self {
        // 宿主声明 interactive 特性即可应答权限询问 / ask_user（移动端 UI / 桌面端均可）
        let interactive = capabilities.features.iter().any(|f| f == "interactive");
        Self {
            capabilities,
            interactive,
            negotiated_capabilities: std::sync::Mutex::new(None),
        }
    }

    fn effective_capabilities(&self) -> Capabilities {
        self.negotiated_capabilities
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| self.capabilities.clone())
    }

    fn effective_interactive(&self) -> bool {
        self.effective_capabilities().has("interactive")
    }

    fn set_negotiated_capabilities(&self, capabilities: Capabilities) {
        *self.negotiated_capabilities.lock().unwrap() = Some(capabilities);
    }

    fn constrain_capabilities(&self, requested: Capabilities) -> Capabilities {
        let bootstrap = &self.capabilities;
        let mut excludes = bootstrap.excludes.clone();
        for excluded in requested.excludes {
            if !excludes.contains(&excluded) {
                excludes.push(excluded);
            }
        }

        let mut features = Vec::new();
        for feature in requested.features {
            if bootstrap.has(&feature)
                && !excludes.contains(&feature)
                && !features.contains(&feature)
            {
                features.push(feature);
            }
        }

        // The in-process mobile transport is the trust boundary. A peer may
        // identify a more specific mobile OS, but initialize cannot turn that
        // connection into a desktop/electron runtime. Desktop bootstraps still
        // accept a mobile platform request so clients can narrow themselves.
        let platform = if bootstrap.platform.starts_with("mobile")
            && !requested.platform.starts_with("mobile")
        {
            bootstrap.platform.clone()
        } else {
            requested.platform
        };

        Capabilities {
            platform,
            features,
            excludes,
        }
    }

    fn desktop_allowed(&self) -> bool {
        let capabilities = self.effective_capabilities();
        !capabilities.excluded("subprocess") && !capabilities.excluded("port_binding")
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
        CONVERSATION_ENSURE => conv_ensure(hub, params),
        CONVERSATION_SYNC => conv_sync(hub, params),
        CONVERSATION_LIST => conv_list(hub, params),
        CONVERSATION_MESSAGES => conv_messages(hub, params),
        CONVERSATION_DELETE => conv_delete(hub, params),
        CONVERSATION_RENAME => conv_rename(hub, params),

        CHAT_SEND => chat_send(hub, ctx, params),
        CHAT_RESUME => chat_resume(hub, params).await,
        CHAT_ABORT => chat_abort(hub, params),
        CHAT_RESPOND => chat_respond(hub, params),

        TOOL_LIST => Ok(json!({
            "tools": worldbase_tools::descriptors(&hub.tools_for(&ctx.effective_capabilities()))
        })),
        TOOL_CALL => tool_call(hub, ctx, params).await,

        SETTINGS_GET => settings_get(hub, params),
        SETTINGS_SET => settings_set(hub, params),

        MEMORY_SEARCH => memory_search(hub, params),
        MEMORY_ADD => memory_add(hub, params),
        MEMORY_DELETE => memory_delete(hub, params),
        MEMORY_INGEST => memory_ingest(hub, params),
        MEMORY_LIST => memory_list(hub, params),
        MEMORY_SAVE => memory_save(hub, params),
        MEMORY_PIN => memory_pin(hub, params),
        MEMORY_COMPACT => memory_compact(hub, params),
        MEMORY_COMPACT_STATUS => memory_compact_status(hub),

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

        MCP_LIST => Ok(
            json!({ "servers": hub.mcp.server_names().await, "tools": hub.mcp.list_tools().await }),
        ),
        MCP_CALL => mcp_call(hub, params).await,
        MCP_RELOAD => mcp_reload(hub, ctx, params).await,
        MCP_STATUS => Ok(serde_json::to_value(hub.mcp.state_snapshot().await).unwrap()),
        MCP_REFRESH => mcp_refresh(hub, params).await,
        MCP_DISCONNECT => mcp_disconnect(hub, params).await,

        DOC_PARSE => doc_parse(hub, params),
        DOC_WRITE => doc_write(hub, params),

        PROJECT_LIST => Ok(json!({ "projects": hub.projects.project_metas().map_err(internal)? })),
        PROJECT_CREATE => project_create(hub, params).await,
        PROJECT_DEV_START => project_dev_start(hub, params).await,
        PROJECT_DEV_STOP => project_dev_stop(hub, params).await,
        PROJECT_STATUS => project_status(hub, params).await,
        PROJECT_GET => project_get(hub, params),
        PROJECT_TREE => project_tree(hub, params),
        PROJECT_FILE_READ => project_file_read(hub, params),
        PROJECT_FILE_WRITE => project_file_write(hub, params),
        PROJECT_META_UPDATE => project_meta_update(hub, params),
        PROJECT_DELETE => project_delete(hub, params).await,
        PROJECT_BUILD_RUN => project_build_run(hub, params).await,
        PROJECT_BUILD_CLEANUP => project_build_cleanup(hub, params).await,
        PROJECT_BUILD_REBUILD => project_build_rebuild(hub, params).await,
        PROJECT_BUILD_NEEDS_REBUILD => project_build_needs_rebuild(hub, params),
        PROJECT_GATEWAY_SERVICE_MAP => project_gateway_service_map(hub).await,
        PROJECT_GATEWAY_START_ALL => project_gateway_start_all(hub).await,
        PROJECT_GATEWAY_STOP_ALL => project_gateway_stop_all(hub).await,
        PROJECT_GATEWAY_SET_RESTART_POLICY => project_gateway_set_restart_policy(hub, params),
        PROJECT_PROCESS_SNAPSHOT => project_process_snapshot(hub).await,
        PROJECT_PROCESS_RESTART => project_process_restart(hub, params).await,
        PROJECT_PROCESS_STOP => project_process_stop(hub, params).await,
        PROJECT_PROCESS_FORCE_KILL => project_process_force_kill(hub, params).await,
        PROJECT_PROCESS_KILL_ORPHAN => project_process_kill_orphan(hub, params).await,
        PROJECT_PROCESS_CLEANUP_ORPHANS => project_process_cleanup_orphans(hub).await,
        PROJECT_DATA_QUERY => project_data_query(hub, params),
        PROJECT_DATA_SUMMARY => project_data_summary(hub, params),
        PROJECT_DATA_LIST_ALL => project_data_list_all(hub),
        PROJECT_DATA_QUERY_TABLE => project_data_query_table(hub, params),
        PROJECT_DATA_SCHEMA => project_data_schema(hub, params),
        PROJECT_DATA_TABLES => project_data_tables(hub, params),
        PROJECT_DATA_RECORDS_QUERY => project_data_records_query(hub, params),
        PROJECT_DATA_RECORDS_SAVE => project_data_records_save(hub, params),
        PROJECT_LOGS => project_logs(hub, params).await,
        PROJECT_LOGS_APPEND => project_logs_append(hub, params).await,
        PROJECT_ANALYZE => project_analyze(hub, params),
        PROJECT_PACKAGE_EXPORT => project_package_export(hub, params),
        PROJECT_PACKAGE_IMPORT => project_package_import(hub, params),

        WORKSPACE_LIST => workspace_list(hub, params),
        WORKSPACE_READ => workspace_read(hub, params),

        EXEC_RUN => exec_run(hub, ctx, params).await,

        PROVIDER_LIST => Ok(json!({ "providers": hub.providers_config() })),
        PROVIDER_FETCH_MODELS => provider_fetch_models(params).await,
        PROVIDER_SAVE => provider_save(hub, params),
        PROVIDER_DELETE => provider_delete(hub, params),
        PROVIDER_SET_ACTIVE => provider_set_active(hub, params),

        AGENT_LIST => Ok(json!({ "agents": hub.store.list_agents().map_err(internal)? })),
        AGENT_GET => agent_get(hub, params),
        AGENT_SAVE => agent_save(hub, params),
        AGENT_DELETE => agent_delete(hub, params),
        AGENT_GROUP_LIST => agent_group_list(hub),
        AGENT_GROUP_GET => agent_group_get(hub, params),
        AGENT_GROUP_SAVE => agent_group_save(hub, params),
        AGENT_GROUP_DELETE => agent_group_delete(hub, params),

        STUDIO_GENERATE => studio_generate(hub, params),
        STUDIO_PROMPT_OPTIMIZE => studio_prompt_optimize(hub, params).await,
        STUDIO_LIST => studio_list(hub, params),
        STUDIO_DELETE => studio_delete(hub, params),
        STUDIO_TAG => studio_tag(hub, params),
        STUDIO_FOLDER => studio_folder(hub, params),
        STUDIO_LIBRARY_QUERY => studio_library_query(hub, params),
        STUDIO_LIBRARY_READ => studio_library_read(hub, params),
        STUDIO_LIBRARY_DELETE_MANY => studio_library_delete_many(hub, params),
        STUDIO_LIBRARY_SET_FOLDER => studio_library_set_folder(hub, params),
        STUDIO_LIBRARY_SET_TAGS => studio_library_set_tags(hub, params),
        STUDIO_LIBRARY_LIST_FOLDERS => studio_library_list_folders(hub),
        STUDIO_LIBRARY_CREATE_FOLDER => studio_library_create_folder(hub, params),
        STUDIO_LIBRARY_RENAME_FOLDER => studio_library_rename_folder(hub, params),
        STUDIO_LIBRARY_DELETE_FOLDER => studio_library_delete_folder(hub, params),
        STUDIO_LIBRARY_LIST_TAGS => studio_library_list_tags(hub),
        STUDIO_LIBRARY_EXPORT => studio_library_export(hub, params),
        STUDIO_TASKS_LOAD => studio_tasks_load(hub),
        STUDIO_TASKS_SAVE => studio_tasks_save(hub, params),
        STUDIO_TASKS_DRAIN => studio_tasks_drain(hub),

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
            let id = params["id"]
                .as_str()
                .ok_or_else(|| params_err("missing id"))?;
            let dir = crate::studio::StudioService::lightapp_dir().join(id);
            if dir.starts_with(crate::studio::StudioService::lightapp_dir()) {
                let _ = std::fs::remove_dir_all(dir);
            }
            let deleted = hub.store.delete_lightapp(id).map_err(internal)?;
            Ok(json!({ "deleted": deleted }))
        }

        CONVERSATION_FORK => conversation_fork(hub, params),

        GROUP_INJECT => group_inject(hub, params),
        GROUP_BOARD_UPDATE => group_board_update(hub, params).await,

        SKILL_SAVE => skill_save(hub, params),
        SKILL_DELETE => skill_delete(hub, params),

        HOST_RESPOND => {
            let request_id = params["requestId"]
                .as_str()
                .ok_or_else(|| params_err("missing requestId"))?;
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

fn initialize(
    hub: &Arc<Hub>,
    ctx: &ConnectionContext,
    params: Value,
) -> Result<Value, ErrorObject> {
    let init: InitializeParams =
        serde_json::from_value(params).map_err(|e| params_err(e.to_string()))?;
    if !init.protocol_version.starts_with("1.") {
        return Err(ErrorObject::new(
            worldbase_protocol::rpc::SERVER_ERROR,
            format!("unsupported protocol version: {}", init.protocol_version),
        ));
    }
    // A handshake may narrow the transport bootstrap, but it cannot grant
    // capabilities the transport did not start with. This is particularly
    // important for the in-process mobile transport: untrusted initialize
    // params must not recover subprocess or desktop access.
    let capabilities = ctx.constrain_capabilities(init.capabilities);
    ctx.set_negotiated_capabilities(capabilities.clone());
    // `available_domains` is capability metadata, not a duplicate method
    // catalog. Individual callable methods remain in `ALL_METHODS` and are
    // enforced by dispatch; report the literal domain names promised by the
    // protocol so hosts can make capability-level UI decisions.
    let available_domains = ["core", "desktop"]
        .into_iter()
        .filter(|domain| *domain != "desktop" || ctx.desktop_allowed())
        .map(str::to_string)
        .collect();
    Ok(serde_json::to_value(InitializeResult {
        protocol_version: worldbase_protocol::PROTOCOL_VERSION.into(),
        server_version: worldbase_protocol::SERVER_VERSION.into(),
        available_tools: worldbase_tools::descriptors(&hub.tools_for(&capabilities)),
        available_domains,
    })
    .unwrap())
}

// ---------- conversations ----------

fn conv_create(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let title = params["title"].as_str().unwrap_or("新对话");
    let agent_id = params["agentId"].as_str();
    let meta = hub
        .store
        .create_conversation(title, agent_id)
        .map_err(internal)?;
    Ok(serde_json::to_value(meta).unwrap())
}

fn conv_ensure(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let id = params["id"]
        .as_str()
        .ok_or_else(|| params_err("missing id"))?;
    let title = params["title"].as_str().unwrap_or("新对话");
    let agent_id = params["agentId"].as_str();
    let meta = hub
        .store
        .ensure_conversation(id, title, agent_id)
        .map_err(internal)?;
    Ok(serde_json::to_value(meta).unwrap())
}

fn conv_sync(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let sync: ConversationSyncParams =
        serde_json::from_value(params).map_err(|e| params_err(e.to_string()))?;
    if sync.id.trim().is_empty() {
        return Err(params_err("missing id"));
    }
    hub.store
        .ensure_conversation(&sync.id, &sync.title, sync.agent_id.as_deref())
        .map_err(internal)?;
    if sync.authoritative {
        // Electron's public chat model intentionally stores only visible
        // reasoning text. Rust's provider history may additionally contain
        // opaque Anthropic thinking signatures/redacted payloads. Preserve
        // those blocks when a restart re-syncs an otherwise identical host
        // snapshot, or the next tool continuation will fail signature
        // validation with a 400.
        let existing = hub
            .store
            .list_messages(&sync.id, 10_000)
            .map_err(internal)?;
        let messages = merge_provider_parts(&existing, &sync.messages);
        hub.store
            .replace_messages(&sync.id, &messages)
            .map_err(internal)?;
        return Ok(json!({
            "id": sync.id,
            "messageCount": messages.len(),
            "synced": true,
            "authoritative": true
        }));
    }
    let existing = hub
        .store
        .list_messages(&sync.id, 10_000)
        .map_err(internal)?;
    // Rust is the source of truth after a stream has started.  A renderer can
    // retry this bridge call or switch settings repeatedly, so only append a
    // missing host suffix; never duplicate or erase Rust tool history. Rust
    // may have extra empty tool-result rows not represented in Electron JSON.
    let mut host_index = 0usize;
    let mut diverged = false;
    for rust_message in &existing {
        if host_index < sync.messages.len() {
            let host_message = &sync.messages[host_index];
            if rust_message.role == host_message.role
                && rust_message.content == host_message.content
            {
                host_index += 1;
                continue;
            }
        }
        if rust_message.content.is_empty() && !rust_message.tool_results.is_empty() {
            continue;
        }
        diverged = true;
        break;
    }
    if diverged {
        return Ok(json!({
            "id": sync.id,
            "messageCount": existing.len(),
            "synced": false,
            "reason": "rust_history_is_newer_or_diverged"
        }));
    }
    if existing.is_empty() {
        hub.store
            .replace_messages(&sync.id, &sync.messages)
            .map_err(internal)?;
    } else {
        for message in sync.messages.iter().skip(host_index) {
            hub.store
                .append_message(&sync.id, message)
                .map_err(internal)?;
        }
    }
    let message_count = hub
        .store
        .get_conversation(&sync.id)
        .map_err(internal)?
        .map(|meta| meta.message_count)
        .unwrap_or(0);
    Ok(json!({
        "id": sync.id,
        "messageCount": message_count,
        "synced": true
    }))
}

/// Reattach provider-private content blocks that are absent from the host's
/// visible message snapshot. Electron can only round-trip text/images today,
/// while Anthropic requires a prior thinking signature (or redacted payload)
/// to be sent unchanged with a subsequent tool result. Matching the complete
/// visible message shape avoids carrying a signature across edits or forks.
fn merge_provider_parts(existing: &[ChatMessage], incoming: &[ChatMessage]) -> Vec<ChatMessage> {
    let mut last_existing_index = 0usize;
    let mut can_reuse_existing = true;
    let mut merged_messages = Vec::with_capacity(incoming.len());
    for message in incoming {
        // Host snapshots can omit system/developer rows or legacy tool result
        // rows, so positional matching is not stable across a restart. Find
        // the corresponding prior visible message instead.
        let previous_index = if can_reuse_existing {
            existing
                .iter()
                .enumerate()
                .skip(last_existing_index)
                .find_map(|(index, previous)| {
                    same_message_shape(previous, message).then_some(index)
                })
        } else {
            None
        };
        let Some(previous_index) = previous_index else {
            can_reuse_existing = false;
            merged_messages.push(message.clone());
            continue;
        };
        // The host omits Rust's hidden tool-call/result rows. Reinsert only
        // those rows between two matching visible messages; ordinary omitted
        // rows must remain omitted from an authoritative snapshot.
        merged_messages.extend(
            existing[last_existing_index..previous_index]
                .iter()
                .filter(|hidden| !hidden.tool_calls.is_empty() || !hidden.tool_results.is_empty())
                .cloned(),
        );
        last_existing_index = previous_index + 1;
        let previous = &existing[previous_index];

        let provider_parts: Vec<_> = previous
            .parts
            .iter()
            .filter(|part| {
                matches!(
                    part,
                    ChatContentPart::Thinking { .. } | ChatContentPart::RedactedThinking { .. }
                )
            })
            .cloned()
            .collect();
        if provider_parts.is_empty() {
            merged_messages.push(message.clone());
            continue;
        }

        let mut merged = message.clone();
        if merged.tool_calls.is_empty()
            && merged.tool_results.is_empty()
            && (!previous.tool_calls.is_empty() || !previous.tool_results.is_empty())
        {
            // Electron's renderer history intentionally carries only visible
            // content. Restore the old tool metadata when the visible message
            // is unchanged, otherwise the reinserted result row would have no
            // corresponding assistant tool call.
            merged.tool_calls = previous.tool_calls.clone();
            merged.tool_results = previous.tool_results.clone();
        }
        let has_provider_parts = merged.parts.iter().any(|part| {
            matches!(
                part,
                ChatContentPart::Thinking { .. } | ChatContentPart::RedactedThinking { .. }
            )
        });
        if !has_provider_parts {
            let old_visible_parts: Vec<_> = previous
                .parts
                .iter()
                .filter(|part| !is_provider_part(part))
                .collect();
            let mut incoming_visible_parts: Vec<ChatContentPart> = merged
                .parts
                .iter()
                .filter(|part| !is_provider_part(part))
                .cloned()
                .collect();
            // Legacy Electron snapshots carry the visible projection in
            // `content` and leave `parts` empty. Recreate that text slot
            // before comparing/rebuilding, otherwise provider blocks
            // would be retained while the assistant answer disappears.
            if incoming_visible_parts.is_empty() && !merged.content.is_empty() {
                incoming_visible_parts.push(ChatContentPart::Text {
                    text: merged.content.clone(),
                });
            }
            if serde_json::to_value(&old_visible_parts).ok()
                == serde_json::to_value(&incoming_visible_parts).ok()
            {
                // The host snapshot is an exact visible replay. Keep the
                // complete old order (thinking, text, images, ...) so
                // Anthropic receives the canonical block sequence.
                merged.parts = previous.parts.clone();
            } else {
                // Keep opaque blocks in their prior positions while
                // replacing only the host-visible slots. This handles
                // legacy text-only snapshots as well as newly attached
                // images without leaking stale visible attachments.
                let mut visible_index = 0usize;
                let mut parts = Vec::new();
                for previous_part in &previous.parts {
                    if is_provider_part(previous_part) {
                        parts.push(previous_part.clone());
                    } else if let Some(visible) = incoming_visible_parts.get(visible_index) {
                        parts.push(visible.clone());
                        visible_index += 1;
                    }
                }
                parts.extend(incoming_visible_parts.iter().skip(visible_index).cloned());
                merged.parts = parts;
            }
        }
        merged_messages.push(merged);
    }
    merged_messages
}

fn is_provider_part(part: &ChatContentPart) -> bool {
    matches!(
        part,
        ChatContentPart::Thinking { .. } | ChatContentPart::RedactedThinking { .. }
    )
}

/// Return the host-visible content projection used for authoritative history
/// matching. Older Electron snapshots sometimes carry text only in `content`
/// and leave `parts` empty; normalize that representation to the same text
/// block Rust stores so it can still reattach provider-private blocks.
fn visible_parts(message: &ChatMessage) -> Vec<ChatContentPart> {
    let mut parts = message
        .parts
        .iter()
        .filter(|part| !is_provider_part(part))
        .cloned()
        .collect::<Vec<_>>();
    if parts.is_empty() && !message.content.is_empty() {
        parts.push(ChatContentPart::Text {
            text: message.content.clone(),
        });
    }
    parts
}

fn same_message_shape(left: &ChatMessage, right: &ChatMessage) -> bool {
    if left.role != right.role {
        return false;
    }
    let visible_matches = serde_json::to_value(visible_parts(left)).ok()
        == serde_json::to_value(visible_parts(right)).ok();
    if !visible_matches {
        return false;
    }
    let metadata_matches = serde_json::to_value(&left.tool_calls).ok()
        == serde_json::to_value(&right.tool_calls).ok()
        && serde_json::to_value(&left.tool_results).ok()
            == serde_json::to_value(&right.tool_results).ok();
    metadata_matches || (right.tool_calls.is_empty() && right.tool_results.is_empty())
}

fn conv_list(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let limit = params["limit"].as_u64().unwrap_or(50) as u32;
    // Native group member runs need isolated histories for correct parallel
    // execution, but those implementation conversations must never appear as
    // separate chats in a client sidebar. The group page owns their shared,
    // user-visible transcript.
    let list = hub
        .store
        .list_conversations(limit.saturating_mul(4).max(limit))
        .map_err(internal)?
        .into_iter()
        .filter(|conversation| {
            !(conversation.id.starts_with("group-") && conversation.agent_id.is_some())
        })
        .take(limit as usize)
        .collect::<Vec<_>>();
    Ok(json!({ "conversations": list }))
}

fn conv_messages(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let id = params["id"]
        .as_str()
        .ok_or_else(|| params_err("missing id"))?;
    let limit = params["limit"].as_u64().unwrap_or(200) as u32;
    let messages = hub.store.list_messages(id, limit).map_err(internal)?;
    Ok(json!({ "messages": messages }))
}

fn conv_delete(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let id = params["id"]
        .as_str()
        .ok_or_else(|| params_err("missing id"))?;
    hub.store.delete_conversation(id).map_err(internal)?;
    Ok(json!({ "deleted": true }))
}

fn conv_rename(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let id = params["id"]
        .as_str()
        .ok_or_else(|| params_err("missing id"))?;
    let title = params["title"]
        .as_str()
        .ok_or_else(|| params_err("missing title"))?;
    hub.store.rename_conversation(id, title).map_err(internal)?;
    Ok(json!({ "renamed": true }))
}

// ---------- chat ----------

fn chat_send(hub: &Arc<Hub>, ctx: &ConnectionContext, params: Value) -> Result<Value, ErrorObject> {
    let p: ChatSendParams =
        serde_json::from_value(params).map_err(|e| params_err(e.to_string()))?;
    if hub
        .store
        .get_conversation(&p.conversation_id)
        .map_err(internal)?
        .is_none()
    {
        return Err(params_err("conversation not found"));
    }
    let run = crate::agent::start_chat(
        hub.clone(),
        p.conversation_id.clone(),
        p.text.clone(),
        p.content_parts.clone(),
        ctx.effective_capabilities(),
        ctx.effective_interactive(),
        p.agent_id.clone(),
        p.provider_id.clone(),
        p.model.clone(),
        p.context.clone(),
    )
    .map_err(internal)?;
    Ok(serde_json::to_value(ChatSendResult {
        stream_id: run.stream_id,
        user_message_seq: 0,
    })
    .unwrap())
}

async fn chat_resume(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let p: ChatResumeParams =
        serde_json::from_value(params).map_err(|e| params_err(e.to_string()))?;
    let channel = hub.streams.lock().unwrap().get(&p.stream_id).cloned();
    let Some(channel) = channel else {
        return Err(ErrorObject::new(
            worldbase_protocol::rpc::SERVER_ERROR,
            "stream not found or expired",
        ));
    };
    let frames = channel.replay(p.after_seq).await;
    Ok(json!({ "events": frames }))
}

fn chat_abort(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let p: ChatAbortParams =
        serde_json::from_value(params).map_err(|e| params_err(e.to_string()))?;
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
    let request_id = params["requestId"]
        .as_str()
        .ok_or_else(|| params_err("missing requestId"))?;
    let allow = params["allow"].as_bool().unwrap_or(false);
    let delivered = crate::permissions::respond(hub, request_id, allow);
    Ok(json!({ "delivered": delivered }))
}

// ---------- tools ----------

async fn tool_call(
    hub: &Arc<Hub>,
    ctx: &ConnectionContext,
    params: Value,
) -> Result<Value, ErrorObject> {
    // Accept the field spellings used by the Electron bridge, Flutter's
    // older client, and generic JSON-RPC callers.  The public contract is
    // still `{ name, args }`; aliases only keep existing clients from
    // silently turning their arguments into `{}` and producing misleading
    // "missing parameter" tool errors.
    let name = ["name", "tool", "toolName", "tool_name"]
        .into_iter()
        .find_map(|key| params.get(key).and_then(Value::as_str))
        .ok_or_else(|| params_err("missing name"))?;
    let raw_args = ["args", "arguments", "input", "parameters"]
        .into_iter()
        .find_map(|key| params.get(key).filter(|value| !value.is_null()))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let args = if let Some(serialized) = raw_args.as_str() {
        serde_json::from_str::<Value>(serialized)
            .map_err(|error| params_err(format!("tool arguments must be valid JSON: {error}")))?
    } else {
        raw_args
    };
    if !args.is_object() {
        return Err(params_err("tool arguments must be an object"));
    }
    let tools = hub.tools_for(&ctx.effective_capabilities());
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
    let allowed = crate::permissions::check(
        hub,
        "tool-call",
        &policy,
        name,
        &args,
        ctx.effective_interactive(),
        None,
    )
    .await;
    if !allowed {
        return Err(ErrorObject::new(
            worldbase_protocol::rpc::SERVER_ERROR,
            format!("permission denied: {name}"),
        ));
    }
    let mut services = hub.services();
    services.visible_tool_catalog = Some(Arc::new(worldbase_tools::descriptors(&tools)));
    services.set_current_stream("tool-call");
    let value = tool.execute(args, &services).await.map_err(internal)?;
    Ok(value)
}

// ---------- settings ----------

fn settings_get(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let key = params["key"]
        .as_str()
        .ok_or_else(|| params_err("missing key"))?;
    let value = hub.store.get_setting(key).map_err(internal)?;
    Ok(json!({ "key": key, "value": value }))
}

fn settings_set(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let key = params["key"]
        .as_str()
        .ok_or_else(|| params_err("missing key"))?;
    let value = params.get("value").cloned().unwrap_or(Value::Null);
    hub.store.set_setting(key, &value).map_err(internal)?;
    Ok(json!({ "ok": true }))
}

// ---------- memory ----------

fn memory_search(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let query = params["query"]
        .as_str()
        .ok_or_else(|| params_err("missing query"))?;
    let limit = params["limit"].as_u64().unwrap_or(10) as u32;
    let hits = hub.store.search_memories(query, limit).map_err(internal)?;
    Ok(json!({ "hits": hits }))
}

fn memory_add(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let content = params["content"]
        .as_str()
        .ok_or_else(|| params_err("missing content"))?;
    let tags: Vec<String> = params["tags"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let id = hub.store.add_memory(content, &tags).map_err(internal)?;
    Ok(json!({ "id": id }))
}

fn memory_delete(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    if let Some(id) = params["id"].as_str() {
        let deleted = hub.store.delete_workspace_memory(id).map_err(internal)?;
        return Ok(json!({ "deleted": deleted }));
    }
    let id = params["id"]
        .as_i64()
        .ok_or_else(|| params_err("missing id"))?;
    let deleted = hub.store.delete_memory(id).map_err(internal)?;
    Ok(json!({ "deleted": deleted }))
}

fn memory_list(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let options: WorkspaceMemorySearchOptions =
        serde_json::from_value(params).map_err(|error| params_err(error.to_string()))?;
    let entries = hub
        .store
        .search_workspace_memories(&options)
        .map_err(internal)?;
    Ok(json!({ "entries": entries }))
}

fn memory_save(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let raw = params.get("entry").cloned().unwrap_or(params);
    let entry: WorkspaceMemoryEntry =
        serde_json::from_value(raw).map_err(|error| params_err(error.to_string()))?;
    if entry.title.trim().is_empty() {
        return Err(params_err("memory title is required"));
    }
    if entry.summary.trim().is_empty() {
        return Err(params_err("memory summary is required"));
    }
    let saved = hub.store.save_workspace_memory(&entry).map_err(internal)?;
    Ok(json!({ "entry": saved }))
}

fn memory_pin(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let id = params["id"]
        .as_str()
        .ok_or_else(|| params_err("missing id"))?;
    let pinned = params["pinned"].as_bool().unwrap_or(false);
    let updated = hub
        .store
        .pin_workspace_memory(id, pinned)
        .map_err(internal)?;
    Ok(json!({ "updated": updated }))
}

fn memory_compact(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let raw = params.get("plan").cloned().unwrap_or(params);
    let plan: MemoryCompactionPlan =
        serde_json::from_value(raw).map_err(|error| params_err(error.to_string()))?;
    let result = hub
        .store
        .compact_workspace_memories(&plan)
        .map_err(internal)?;
    Ok(serde_json::to_value(result).unwrap_or_else(|_| json!({})))
}

fn memory_compact_status(hub: &Arc<Hub>) -> Result<Value, ErrorObject> {
    Ok(serde_json::to_value(hub.store.memory_compaction_status()).unwrap_or_else(|_| json!({})))
}

fn memory_ingest(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let entries = hub
        .store
        .ingest_workspace_memories(&params)
        .map_err(internal)?;
    Ok(json!({ "entries": entries }))
}

// ---------- skills ----------

fn skill_list(hub: &Arc<Hub>) -> Result<Value, ErrorObject> {
    let skills = hub.skills.list().map_err(internal)?;
    Ok(json!({ "skills": skills }))
}

fn skill_run(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let name = params["name"]
        .as_str()
        .ok_or_else(|| params_err("missing name"))?;
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
    let name = params["name"]
        .as_str()
        .ok_or_else(|| params_err("missing name"))?;
    let cron = params["cron"]
        .as_str()
        .ok_or_else(|| params_err("missing cron"))?;
    let task = params["task"]
        .as_str()
        .ok_or_else(|| params_err("missing task"))?;
    let entry = hub.scheduler.create(name, cron, task).map_err(internal)?;
    Ok(json!({ "entry": entry }))
}

fn schedule_delete(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let id = params["id"]
        .as_str()
        .ok_or_else(|| params_err("missing id"))?;
    let deleted = hub.scheduler.delete(id).map_err(internal)?;
    Ok(json!({ "deleted": deleted }))
}

fn schedule_run(
    hub: &Arc<Hub>,
    ctx: &ConnectionContext,
    params: Value,
) -> Result<Value, ErrorObject> {
    let task = params["task"]
        .as_str()
        .ok_or_else(|| params_err("missing task"))?;
    let conv = hub
        .store
        .create_conversation("[手动任务]", None)
        .map_err(internal)?;
    let run = crate::agent::start_chat(
        hub.clone(),
        conv.id.clone(),
        task.to_string(),
        vec![],
        ctx.effective_capabilities(),
        ctx.effective_interactive(),
        None,
        None,
        None,
        ChatRunContext::default(),
    )
    .map_err(internal)?;
    Ok(json!({ "streamId": run.stream_id, "conversationId": conv.id }))
}

// ---------- group ----------

const GROUP_MEMBER_HISTORY_PREFIX: &str = "[[worldbase-group-member]]";

fn group_conversation_id(group_id: &str) -> String {
    format!("group-{group_id}")
}

fn persist_group_user_message(hub: &Arc<Hub>, group_id: &str, content: String) -> Result<()> {
    hub.store.append_message(
        &group_conversation_id(group_id),
        &ChatMessage {
            id: 0,
            role: Role::User,
            content,
            parts: vec![],
            tool_calls: vec![],
            tool_results: vec![],
            created_at: None,
        },
    )?;
    Ok(())
}

fn persist_group_member_message(
    hub: &Arc<Hub>,
    group_id: &str,
    member: &str,
    content: &str,
) -> Result<()> {
    let header = serde_json::to_string(&json!({ "name": member }))?;
    hub.store.append_message(
        &group_conversation_id(group_id),
        &ChatMessage {
            id: 0,
            role: Role::Assistant,
            content: format!("{GROUP_MEMBER_HISTORY_PREFIX}{header}\n{content}"),
            parts: vec![],
            tool_calls: vec![],
            tool_results: vec![],
            created_at: None,
        },
    )?;
    Ok(())
}

fn group_create(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let topic = params["topic"]
        .as_str()
        .ok_or_else(|| params_err("missing topic"))?;
    let mode: GroupMode =
        serde_json::from_value(params.get("mode").cloned().unwrap_or(json!("discussion")))
            .unwrap_or(GroupMode::Discussion);
    let members: Vec<GroupMember> =
        serde_json::from_value(params.get("members").cloned().unwrap_or_else(|| {
            json!([
                { "name": "协调者", "persona": "统筹规划，收敛结论" },
                { "name": "工程师", "persona": "务实落地，关注实现细节" },
                { "name": "评审", "persona": "挑刺找风险，严苛审查" }
            ])
        }))
        .map_err(|e| params_err(e.to_string()))?;
    let coordinator = params["coordinator"].as_str().map(String::from);
    let max_parallel_workers = params
        .get("maxParallelWorkers")
        .or_else(|| params.get("max_parallel_workers"))
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(worldbase_group::GroupEngine::DEFAULT_MAX_PARALLEL_WORKERS);
    let mut session = worldbase_group::GroupEngine::create_with_max_parallel_workers(
        topic,
        mode,
        members,
        coordinator,
        max_parallel_workers,
    )
    .map_err(internal)?;
    if let Some(session_id) = params
        .get("sessionId")
        .or_else(|| params.get("session_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        session.id = session_id.to_string();
    }
    if let Some(existing) = hub.group_sessions.lock().unwrap().get(&session.id).cloned() {
        session.created_at = existing.created_at;
        session.board = existing.board;
        session.board_updates = existing.board_updates;
        session.rounds = existing.rounds;
        session.pending_injections = existing.pending_injections;
    }
    let conversation_id = group_conversation_id(&session.id);
    hub.store
        .ensure_conversation(&conversation_id, topic, None)
        .map_err(internal)?;
    hub.store
        .rename_conversation(&conversation_id, topic)
        .map_err(internal)?;
    hub.group_sessions
        .lock()
        .unwrap()
        .insert(session.id.clone(), session.clone());
    Ok(serde_json::to_value(&session).unwrap())
}

fn group_inject(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let id = params["id"]
        .as_str()
        .ok_or_else(|| params_err("missing id"))?;
    let content = params["content"]
        .as_str()
        .ok_or_else(|| params_err("missing content"))?;
    let mut target_agent_ids: Vec<String> = params["targetAgentIds"]
        .as_array()
        .map(|targets| {
            targets
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|target| !target.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let mut sessions = hub.group_sessions.lock().unwrap();
    let session = sessions
        .get_mut(id)
        .ok_or_else(|| ErrorObject::invalid_params("group session not found"))?;
    target_agent_ids.sort();
    target_agent_ids.dedup();
    let unknown_target = target_agent_ids.iter().find(|target| {
        !session
            .members
            .iter()
            .any(|member| group_member_id(member) == Some(target.as_str()))
    });
    if let Some(target) = unknown_target {
        return Err(ErrorObject::invalid_params(format!(
            "group injection target is not a member: {target}"
        )));
    }
    if session.status == "running" {
        if session.active_member_ids.is_empty() {
            return Err(ErrorObject::invalid_params(
                "group injection: no group member has a pending turn that can receive this clarification",
            ));
        }
        if let Some(target) = target_agent_ids
            .iter()
            .find(|target| !session.active_member_ids.contains(target))
        {
            return Err(ErrorObject::invalid_params(format!(
                "group injection: target agent has no pending turn in this session: {target}"
            )));
        }
        // Electron's empty target list means every active participant, not a
        // global broadcast that might accidentally leak into a later round.
        if target_agent_ids.is_empty() {
            target_agent_ids = session.active_member_ids.clone();
        }
    }
    persist_group_user_message(hub, id, format!("[补充说明] {content}")).map_err(internal)?;
    worldbase_group::GroupEngine::inject(session, content, target_agent_ids);
    if let Some(injection) = session.pending_injections.last_mut() {
        injection.round = params["round"].as_u64().unwrap_or(0) as u32;
    }
    Ok(json!({ "queued": session.pending_injections.len() }))
}

async fn group_board_update(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let id = params["id"]
        .as_str()
        .ok_or_else(|| params_err("missing id"))?;
    let field = params["field"]
        .as_str()
        .ok_or_else(|| params_err("missing field"))?;
    let op = params["op"]
        .as_str()
        .ok_or_else(|| params_err("missing op"))?;
    let payload = params.get("payload").cloned().unwrap_or_else(|| {
        legacy_group_board_payload(field, op, params["value"].as_str().unwrap_or(""))
    });
    let reason = params
        .get("reason")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let agent_id = params
        .get("agentId")
        .and_then(Value::as_str)
        .unwrap_or("user");
    let agent_name = params
        .get("agentName")
        .and_then(Value::as_str)
        .unwrap_or("User");
    let (board, update) =
        apply_group_board_update(hub, id, agent_id, agent_name, field, op, payload, reason)
            .map_err(internal)?;
    hub.emit(
        id,
        EventKind::BoardUpdate {
            board: board.clone(),
            update: Some(update.clone()),
        },
    )
    .await;
    Ok(json!({ "board": board, "update": update }))
}

/// Keep Electron's older `value: string` board RPC compatible with the
/// structured tool payload accepted by Rust-native group members.
fn legacy_group_board_payload(field: &str, op: &str, value: &str) -> Value {
    if field == "tasks" && op == "add" {
        json!({ "id": uuid::Uuid::new_v4().to_string(), "title": value, "status": "todo" })
    } else if field == "tasks" && op == "set" {
        json!([{
            "id": uuid::Uuid::new_v4().to_string(),
            "title": value,
            "status": "todo"
        }])
    } else if op == "set" && field != "goal" {
        json!([value])
    } else {
        json!(value)
    }
}

fn group_get(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let id = params["id"]
        .as_str()
        .ok_or_else(|| params_err("missing id"))?;
    let session = hub
        .group_sessions
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or_else(|| ErrorObject::invalid_params("group session not found"))?;
    Ok(serde_json::to_value(&session).unwrap())
}

fn apply_group_board_update(
    hub: &Arc<Hub>,
    group_id: &str,
    agent_id: &str,
    agent_name: &str,
    field: &str,
    op: &str,
    payload: Value,
    reason: Option<String>,
) -> anyhow::Result<(GroupBoard, GroupBoardUpdate)> {
    let mut sessions = hub.group_sessions.lock().unwrap();
    let session = sessions
        .get_mut(group_id)
        .ok_or_else(|| anyhow::anyhow!("group session not found"))?;
    worldbase_group::GroupEngine::board_update_value(session, field, op, payload.clone())?;
    let update = GroupBoardUpdate {
        id: uuid::Uuid::new_v4().to_string(),
        group_id: group_id.to_string(),
        agent_id: agent_id.to_string(),
        agent_name: agent_name.to_string(),
        field: field.to_string(),
        op: op.to_string(),
        payload,
        reason,
        at: worldbase_protocol::event::now_rfc3339(),
    };
    session.board_updates.push(update.clone());
    if session.board_updates.len() > 256 {
        let excess = session.board_updates.len() - 256;
        session.board_updates.drain(..excess);
    }
    Ok((session.board.clone(), update))
}

fn group_member_id(member: &GroupMember) -> Option<&str> {
    member
        .agent_id
        .as_deref()
        .map(str::trim)
        .filter(|agent_id| !agent_id.is_empty())
        .or_else(|| {
            let name = member.name.trim();
            (!name.is_empty()).then_some(name)
        })
}

fn mark_native_group_member_finished(hub: &Arc<Hub>, group_id: &str, member: &GroupMember) {
    let Some(agent_id) = group_member_id(member) else {
        return;
    };
    if let Some(session) = hub.group_sessions.lock().unwrap().get_mut(group_id) {
        session.active_member_ids.retain(|id| id != agent_id);
    }
}

fn finalize_native_group_session(
    hub: &Arc<Hub>,
    group_id: &str,
    local: &mut GroupSessionMeta,
) -> GroupBoard {
    let mut sessions = hub.group_sessions.lock().unwrap();
    if let Some(live) = sessions.get_mut(group_id) {
        // The live session owns mutations made by collaboration tools and
        // injections that raced a member's provider call. Never replace it
        // with the stale local executor snapshot.
        local
            .pending_injections
            .append(&mut live.pending_injections);
        local.board = live.board.clone();
        local.board_updates = live.board_updates.clone();
    }
    local.status = "open".into();
    local.active_member_ids.clear();
    let board = local.board.clone();
    sessions.insert(group_id.to_string(), local.clone());
    board
}

#[derive(Clone)]
struct NativeGroupCollaborationRuntime {
    hub: Arc<Hub>,
    group_id: String,
    member: GroupMember,
    round: u32,
    context: ChatRunContext,
    capabilities: Capabilities,
    interactive: bool,
    group_abort: CancellationToken,
    depth: usize,
    ancestry: Vec<String>,
}

impl NativeGroupCollaborationRuntime {
    const MAX_RECURSION_DEPTH: usize = 2;
    const PEER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

    fn member_id(&self) -> anyhow::Result<&str> {
        group_member_id(&self.member)
            .ok_or_else(|| anyhow::anyhow!("native group member has no identifier"))
    }

    fn next_for_member(&self, member: GroupMember) -> anyhow::Result<Self> {
        let agent_id = group_member_id(&member)
            .ok_or_else(|| anyhow::anyhow!("target member has no identifier"))?
            .to_string();
        let mut ancestry = self.ancestry.clone();
        ancestry.push(agent_id);
        Ok(Self {
            hub: self.hub.clone(),
            group_id: self.group_id.clone(),
            member,
            round: self.round,
            context: self.context.clone(),
            capabilities: self.capabilities.clone(),
            interactive: self.interactive,
            group_abort: self.group_abort.clone(),
            depth: self.depth + 1,
            ancestry,
        })
    }
}

#[async_trait]
impl worldbase_tools::GroupCollaborationRuntime for NativeGroupCollaborationRuntime {
    async fn message_agent(&self, target_agent_id: &str, request: &str) -> anyhow::Result<String> {
        if self.group_abort.is_cancelled() {
            anyhow::bail!("Group deliberation aborted.");
        }
        let from_agent_id = self.member_id()?.to_string();
        let target_agent_id = target_agent_id.trim();
        if target_agent_id == from_agent_id {
            anyhow::bail!("message_agent: an agent cannot send a peer message to itself.");
        }
        if self.depth >= Self::MAX_RECURSION_DEPTH {
            anyhow::bail!(
                "message_agent: recursion depth limit ({}) reached.",
                Self::MAX_RECURSION_DEPTH
            );
        }
        if self
            .ancestry
            .iter()
            .any(|agent_id| agent_id == target_agent_id)
        {
            anyhow::bail!("message_agent: deadlock detected in the peer consultation chain.");
        }

        let (target, group_name) = {
            let sessions = self.hub.group_sessions.lock().unwrap();
            let session = sessions
                .get(&self.group_id)
                .ok_or_else(|| anyhow::anyhow!("group session not found"))?;
            let target = session
                .members
                .iter()
                .find(|member| group_member_id(member) == Some(target_agent_id))
                .cloned()
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "message_agent: target agent \"{target_agent_id}\" is not a participant in this group."
                    )
                })?;
            (target, session.topic.clone())
        };

        let now = worldbase_protocol::event::now_rfc3339();
        let mut message = GroupPeerMessage {
            id: uuid::Uuid::new_v4().to_string(),
            group_id: self.group_id.clone(),
            from_agent_id: from_agent_id.clone(),
            from_agent_name: self.member.name.clone(),
            to_agent_id: target_agent_id.to_string(),
            to_agent_name: target.name.clone(),
            request: request.to_string(),
            response: String::new(),
            status: "pending".into(),
            round: self.round,
            created_at: now,
            resolved_at: None,
            error: None,
        };
        self.hub
            .emit(
                &self.group_id,
                EventKind::GroupPeerMessage {
                    message: message.clone(),
                },
            )
            .await;

        let peer_abort = self.group_abort.child_token();
        let peer_runtime = Arc::new(self.next_for_member(target.clone())?);
        let peer_prompt = format!(
            "## Peer consultation\nYou are {target_name}, a member of the Rust-native group \"{group_name}\".\n{from_name} asks:\n{request}\n\nReturn a concise, self-contained answer for the requesting member. Do not address the end user directly.",
            target_name = target.name,
            from_name = self.member.name,
            request = request,
        );
        let result = tokio::time::timeout(
            Self::PEER_TIMEOUT,
            run_native_group_member(
                self.hub.clone(),
                &self.group_id,
                target,
                peer_prompt,
                self.context.clone(),
                self.capabilities.clone(),
                self.interactive,
                peer_abort.clone(),
                Some(peer_runtime),
            ),
        )
        .await;

        match result {
            Ok(Ok(reply)) => {
                message.response = reply.clone();
                message.status = "completed".into();
                message.resolved_at = Some(worldbase_protocol::event::now_rfc3339());
                self.hub
                    .emit(
                        &self.group_id,
                        EventKind::GroupPeerMessage {
                            message: message.clone(),
                        },
                    )
                    .await;
                Ok(reply)
            }
            Ok(Err(error)) => {
                message.status = "failed".into();
                message.error = Some(error.to_string());
                message.resolved_at = Some(worldbase_protocol::event::now_rfc3339());
                self.hub
                    .emit(
                        &self.group_id,
                        EventKind::GroupPeerMessage {
                            message: message.clone(),
                        },
                    )
                    .await;
                Err(error)
            }
            Err(_) => {
                peer_abort.cancel();
                let error = anyhow::anyhow!(
                    "message_agent: timed out after {}ms waiting for \"{}\".",
                    Self::PEER_TIMEOUT.as_millis(),
                    message.to_agent_name
                );
                message.status = "timeout".into();
                message.error = Some(error.to_string());
                message.resolved_at = Some(worldbase_protocol::event::now_rfc3339());
                self.hub
                    .emit(
                        &self.group_id,
                        EventKind::GroupPeerMessage {
                            message: message.clone(),
                        },
                    )
                    .await;
                Err(error)
            }
        }
    }

    async fn read_board(&self) -> anyhow::Result<Value> {
        let board = self
            .hub
            .group_sessions
            .lock()
            .unwrap()
            .get(&self.group_id)
            .map(|session| session.board.clone())
            .ok_or_else(|| anyhow::anyhow!("group session not found"))?;
        Ok(serde_json::to_value(board)?)
    }

    async fn update_board(
        &self,
        field: &str,
        op: &str,
        payload: Value,
        reason: Option<&str>,
    ) -> anyhow::Result<Value> {
        let agent_id = self.member_id()?.to_string();
        let (board, update) = apply_group_board_update(
            &self.hub,
            &self.group_id,
            &agent_id,
            &self.member.name,
            field,
            op,
            payload,
            reason.map(ToOwned::to_owned),
        )?;
        self.hub
            .emit(
                &self.group_id,
                EventKind::BoardUpdate {
                    board,
                    update: Some(update.clone()),
                },
            )
            .await;
        Ok(serde_json::to_value(update)?)
    }

    async fn reply_to_user(&self, content: &str) -> anyhow::Result<Value> {
        let agent_id = self.member_id()?.to_string();
        let content = worldbase_group::GroupEngine::sanitize_member_output(content);
        anyhow::ensure!(!content.is_empty(), "reply_to_user content is empty");
        let group_name = self
            .hub
            .group_sessions
            .lock()
            .unwrap()
            .get(&self.group_id)
            .map(|session| session.topic.clone())
            .ok_or_else(|| anyhow::anyhow!("group session not found"))?;
        let reply = GroupDirectReply {
            id: uuid::Uuid::new_v4().to_string(),
            group_id: self.group_id.clone(),
            group_name,
            agent_id,
            agent_name: self.member.name.clone(),
            content: content.clone(),
            round: self.round,
            endorsed: false,
            at: worldbase_protocol::event::now_rfc3339(),
        };
        persist_group_member_message(&self.hub, &self.group_id, &self.member.name, &content)?;
        self.hub
            .emit(
                &self.group_id,
                EventKind::GroupDirectReply {
                    reply: reply.clone(),
                },
            )
            .await;
        Ok(serde_json::to_value(reply)?)
    }
}

/// Run one native group member through the same Rust agent loop used by an
/// ordinary Electron chat. Each member has an isolated child stream so its
/// run handle and terminal cleanup cannot overwrite the parent group run. The
/// Electron client recognizes the child-stream prefix and attaches those
/// events to the owning group session.
struct CancelRunOnDrop {
    hub: Arc<Hub>,
    stream_id: String,
}

impl Drop for CancelRunOnDrop {
    fn drop(&mut self) {
        if let Some(run) = self.hub.runs.lock().unwrap().get(&self.stream_id) {
            run.abort.cancel();
        }
    }
}

async fn run_native_group_member(
    hub: Arc<Hub>,
    group_id: &str,
    member: GroupMember,
    prompt: String,
    mut context: ChatRunContext,
    capabilities: Capabilities,
    interactive: bool,
    group_abort: CancellationToken,
    group_collaboration: Option<Arc<dyn worldbase_tools::GroupCollaborationRuntime>>,
) -> anyhow::Result<String> {
    let persisted_agent_id = member
        .agent_id
        .as_deref()
        .filter(|id| !id.trim().is_empty());
    let member_key = persisted_agent_id.unwrap_or(&member.name);
    let conversation_agent_id = persisted_agent_id
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("__group_adhoc__{group_id}:{member_key}"));
    let conversation_id = format!("group-{group_id}-{member_key}");
    hub.store.ensure_conversation(
        &conversation_id,
        &format!("Native group: {}", member.name),
        Some(&conversation_agent_id),
    )?;
    if context.allowed_tool_names.is_empty() {
        context.allowed_tool_names = member.allowed_tool_names.clone();
    }
    if context.denied_tool_names.is_empty() {
        context.denied_tool_names = member.denied_tool_names.clone();
    }
    context.system_prompt_sections.push(format!(
        "## Group member assignment\n- Group member: {}\n- Persona: {}\n- Return an internal working note for the coordinator.",
        member.name, member.persona
    ));

    let child_stream_id = format!(
        "{group_id}:member:{member_key}:{}",
        uuid::Uuid::new_v4().simple()
    );
    // Subscribe before creating the child so an instant mock/provider result
    // cannot be emitted before the waiter is installed.
    let channel = hub.register_stream(&child_stream_id);
    let mut receiver = channel.tx.subscribe();
    let mut after_seq = channel.latest_seq().await;

    let run = crate::agent::start_chat_with_stream_id_and_group_runtime(
        hub.clone(),
        conversation_id,
        prompt,
        vec![],
        capabilities,
        interactive,
        None,
        None,
        None,
        context,
        Some(child_stream_id.clone()),
        group_collaboration,
    )?;
    anyhow::ensure!(
        run.stream_id == child_stream_id,
        "native group member was assigned an unexpected stream"
    );
    // The caller may wrap this waiter in a timeout. The agent loop itself is a
    // spawned task, so dropping only the waiter would otherwise leave a live
    // child capable of executing tools and mutating the shared group board.
    let _cancel_on_drop = CancelRunOnDrop {
        hub: hub.clone(),
        stream_id: child_stream_id.clone(),
    };
    let mut last_assistant_message = String::new();

    loop {
        let replay = channel.replay(after_seq).await;
        for frame in replay {
            after_seq = after_seq.max(frame.seq as i64);
            match frame.kind {
                EventKind::AssistantMessage { content, .. } => {
                    last_assistant_message = content;
                }
                EventKind::Done { .. } => return Ok(last_assistant_message),
                EventKind::Error { message } => anyhow::bail!(message),
                _ => {}
            }
        }

        let received = tokio::select! {
            _ = group_abort.cancelled() => {
                if let Some(run) = hub.runs.lock().unwrap().get(&child_stream_id) {
                    run.abort.cancel();
                }
                anyhow::bail!("native group aborted")
            }
            received = receiver.recv() => received,
        };
        match received {
            Ok(frame) if frame.seq as i64 > after_seq => {
                after_seq = frame.seq as i64;
                match frame.kind {
                    EventKind::AssistantMessage { content, .. } => {
                        last_assistant_message = content;
                    }
                    EventKind::Done { .. } => return Ok(last_assistant_message),
                    EventKind::Error { message } => anyhow::bail!(message),
                    _ => {}
                }
            }
            Ok(_) => {}
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
            Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                anyhow::bail!("native group member stream closed unexpectedly")
            }
        }
    }
}

fn group_message(
    hub: &Arc<Hub>,
    ctx: &ConnectionContext,
    params: Value,
) -> Result<Value, ErrorObject> {
    let id = params["id"]
        .as_str()
        .ok_or_else(|| params_err("missing id"))?
        .to_string();
    let text = params["text"]
        .as_str()
        .ok_or_else(|| params_err("missing text"))?
        .to_string();
    let session_snapshot = hub
        .group_sessions
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| ErrorObject::invalid_params("group session not found"))?;
    let round = params["round"].as_u64().unwrap_or(
        (session_snapshot.rounds.len() / session_snapshot.members.len().max(1)) as u64 + 1,
    ) as u32;
    let max_parallel_workers = session_snapshot.max_parallel_workers;
    let selected_members: Vec<String> = params["memberIds"]
        .as_array()
        .map(|members| {
            members
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|member| !member.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let mut run_context: ChatRunContext = params
        .get("context")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| params_err(error.to_string()))?
        .unwrap_or_default();
    run_context
        .system_prompt_sections
        .push("## Native Rust group deliberation\n- You are producing an internal group note. Do not address the end user directly.\n- Use the shared board and the assigned group prompt. Keep the conclusion concise and concrete.".into());
    let capabilities = ctx.effective_capabilities();
    let interactive = ctx.effective_interactive();

    // Keep a parent cancellation handle under the public group stream ID.
    // Member agent loops use child streams, so `chat.abort(group_id)` cancels
    // the entire round without being overwritten by a member RunHandle.
    {
        let mut runs = hub.runs.lock().unwrap();
        if runs.contains_key(&id) {
            return Err(ErrorObject::invalid_params(
                "group session is already running",
            ));
        }
        runs.insert(
            id.clone(),
            RunHandle {
                conversation_id: format!("group-{id}"),
                abort: CancellationToken::new(),
                capabilities: capabilities.clone(),
                interactive,
                agent_id: None,
                provider_id: None,
                model: None,
                context: run_context.clone(),
                group_collaboration: None,
            },
        );
    }
    if let Err(error) = persist_group_user_message(hub, &id, text.clone()) {
        hub.runs.lock().unwrap().remove(&id);
        return Err(internal(error));
    }
    let group_abort = hub
        .runs
        .lock()
        .unwrap()
        .get(&id)
        .map(|run| run.abort.clone())
        .ok_or_else(|| internal("group run was not registered"))?;

    // The Hub copy is authoritative for live board writes and incoming HITL
    // injections. Give the local state machine its initial queue, then move
    // later arrivals in just before each member starts.
    let mut session = {
        let mut sessions = hub.group_sessions.lock().unwrap();
        let live = sessions
            .get_mut(&id)
            .ok_or_else(|| internal("group session disappeared before start"))?;
        let active_members = worldbase_group::GroupEngine::resolve_speakers(
            live,
            &text,
            (!selected_members.is_empty()).then_some(selected_members.as_slice()),
        );
        live.status = "running".into();
        live.active_member_ids = active_members
            .iter()
            .filter_map(group_member_id)
            .map(ToOwned::to_owned)
            .collect();
        let mut local = live.clone();
        local.pending_injections = std::mem::take(&mut live.pending_injections);
        local
    };

    // 事件流：stream_id = group 会话 id
    let hub2 = hub.clone();
    let id_for_task = id.clone();
    tokio::spawn(async move {
        let id = id_for_task;
        hub2.emit(
            &id,
            EventKind::Notice {
                text: format!("群组讨论：{text}"),
            },
        )
        .await;

        // Collect member notes in execution order. Board writes are emitted
        // immediately by the Rust collaboration runtime, not via this local
        // state-machine snapshot.
        let collected = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = collected.clone();
        let mut on_board = |_board: &worldbase_protocol::types::GroupBoard| {};
        let mut on_message_cb = |member: String, content: String, r: u32| {
            sink.lock().unwrap().push((member, content, r));
        };
        let selected_members_for_task = selected_members;
        let context_for_task = run_context;
        let group_abort_for_task = group_abort.clone();
        let result = worldbase_group::GroupEngine::run_round_with_executor_batched_and_hook(
            &mut session,
            &text,
            round,
            (!selected_members_for_task.is_empty()).then_some(selected_members_for_task.as_slice()),
            max_parallel_workers,
            |member, prompt| {
                let hub = hub2.clone();
                let hub_for_finish = hub2.clone();
                let group_id = id.clone();
                let context = context_for_task.clone();
                let capabilities = capabilities.clone();
                let group_abort = group_abort_for_task.clone();
                async move {
                    if group_abort.is_cancelled() {
                        anyhow::bail!("native group aborted");
                    }
                    let member_runtime = Arc::new(NativeGroupCollaborationRuntime {
                        hub: hub.clone(),
                        group_id: group_id.clone(),
                        ancestry: vec![member
                            .agent_id
                            .clone()
                            .filter(|agent_id| !agent_id.trim().is_empty())
                            .unwrap_or_else(|| member.name.clone())],
                        member: member.clone(),
                        round,
                        context: context.clone(),
                        capabilities: capabilities.clone(),
                        interactive,
                        group_abort: group_abort.clone(),
                        depth: 0,
                    })
                        as Arc<dyn worldbase_tools::GroupCollaborationRuntime>;
                    let result = run_native_group_member(
                        hub,
                        &group_id,
                        member.clone(),
                        prompt,
                        context,
                        capabilities,
                        interactive,
                        group_abort,
                        Some(member_runtime),
                    )
                    .await;
                    mark_native_group_member_finished(&hub_for_finish, &group_id, &member);
                    result
                }
            },
            |local, _member| {
                if let Some(live) = hub2.group_sessions.lock().unwrap().get_mut(&id) {
                    local.board = live.board.clone();
                    local.board_updates = live.board_updates.clone();
                    local
                        .pending_injections
                        .append(&mut live.pending_injections);
                }
            },
            false,
            &mut on_message_cb,
            &mut on_board,
        )
        .await;
        match result {
            Ok(_count) => {
                let final_board = finalize_native_group_session(&hub2, &id, &mut session);
                let drained: Vec<(String, String, u32)> =
                    collected.lock().unwrap().drain(..).collect();
                for (member, content, r) in drained {
                    if let Err(error) = persist_group_member_message(&hub2, &id, &member, &content)
                    {
                        hub2.emit(
                            &id,
                            EventKind::Notice {
                                text: format!("Persist group message failed: {error}"),
                            },
                        )
                        .await;
                    }
                    hub2.emit(
                        &id,
                        EventKind::GroupMessage {
                            member,
                            round: r,
                            content,
                        },
                    )
                    .await;
                }
                hub2.emit(
                    &id,
                    EventKind::BoardUpdate {
                        board: final_board,
                        update: None,
                    },
                )
                .await;
                hub2.emit(
                    &id,
                    EventKind::Done {
                        stop_reason: "group_complete".into(),
                    },
                )
                .await;
            }
            Err(e) => {
                finalize_native_group_session(&hub2, &id, &mut session);
                hub2.emit(
                    &id,
                    EventKind::Notice {
                        text: format!("Native group failed: {e}"),
                    },
                )
                .await;
                hub2.emit(
                    &id,
                    EventKind::Done {
                        stop_reason: "group_error".into(),
                    },
                )
                .await;
            }
        }
        hub2.runs.lock().unwrap().remove(&id);
    });
    Ok(json!({ "streamId": id, "round": round }))
}

fn group_blackboard_add(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let id = params["id"]
        .as_str()
        .ok_or_else(|| params_err("missing id"))?;
    let note = params["note"]
        .as_str()
        .ok_or_else(|| params_err("missing note"))?;
    let mut sessions = hub.group_sessions.lock().unwrap();
    let session = sessions
        .get_mut(id)
        .ok_or_else(|| ErrorObject::invalid_params("group session not found"))?;
    session.board.evidence_refs.push(note.to_string());
    Ok(json!({ "board": session.board }))
}

// ---------- mcp ----------

async fn mcp_call(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    // Keep the protocol tolerant of the same camelCase/snake_case spellings
    // accepted by direct `tool.call` requests. Electron's generic MCP tool
    // uses `server`/`tool`/`arguments`, while older mobile callers used the
    // durable `server_id` and `args` names.
    let server = ["server", "serverId", "server_id"]
        .into_iter()
        .find_map(|key| params.get(key).and_then(Value::as_str))
        .ok_or_else(|| params_err("missing server"))?;
    let tool = ["tool", "toolName", "tool_name"]
        .into_iter()
        .find_map(|key| params.get(key).and_then(Value::as_str))
        .ok_or_else(|| params_err("missing tool"))?;
    let args = ["args", "arguments", "input", "parameters"]
        .into_iter()
        .find_map(|key| params.get(key).filter(|value| !value.is_null()))
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !args.is_object() {
        return Err(params_err("MCP arguments must be an object"));
    }
    let result = hub
        .mcp
        .call_tool(server, tool, args)
        .await
        .map_err(internal)?;
    Ok(result)
}

async fn mcp_reload(
    hub: &Arc<Hub>,
    ctx: &ConnectionContext,
    params: Value,
) -> Result<Value, ErrorObject> {
    let mut configs: Vec<worldbase_mcp_client::McpServerConfig> =
        serde_json::from_value(params.get("servers").cloned().unwrap_or_else(|| json!([])))
            .map_err(|e| params_err(e.to_string()))?;
    let is_mobile = ctx.effective_capabilities().platform.starts_with("mobile");
    let mut ignored_unsupported = Vec::new();
    if is_mobile {
        configs.retain(|config| {
            let supported = matches!(
                config.transport.as_str(),
                "http" | "streamable-http" | "sse"
            );
            if !supported {
                ignored_unsupported.push(config.name.clone());
            }
            supported
        });
    }
    hub.mcp.configure(configs).await;
    let servers = hub.mcp.server_names().await;
    if is_mobile {
        Ok(json!({
            "servers": servers,
            "ignoredUnsupportedServers": ignored_unsupported
        }))
    } else {
        Ok(json!({ "servers": servers }))
    }
}

async fn mcp_refresh(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let server_id = params
        .get("serverId")
        .or_else(|| params.get("server_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if let Some(server_id) = server_id {
        let snapshot = hub.mcp.refresh_server(server_id).await.map_err(internal)?;
        return serde_json::to_value(snapshot).map_err(internal);
    }

    Ok(serde_json::to_value(hub.mcp.refresh_enabled().await).unwrap())
}

async fn mcp_disconnect(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let server_id = params
        .get("serverId")
        .or_else(|| params.get("server_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| params_err("missing serverId"))?;
    let snapshot = hub
        .mcp
        .disconnect_server(server_id)
        .await
        .map_err(internal)?;
    serde_json::to_value(snapshot).map_err(internal)
}

// ---------- docs ----------

fn doc_parse(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let path = params["path"]
        .as_str()
        .ok_or_else(|| params_err("missing path"))?;
    let full = hub.workspace.join(path);
    let parsed = worldbase_docs::parse_file(&full).map_err(internal)?;
    Ok(parsed)
}

fn doc_write(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let path = params["path"]
        .as_str()
        .ok_or_else(|| params_err("missing path"))?;
    let kind = params["kind"]
        .as_str()
        .ok_or_else(|| params_err("missing kind"))?;
    let full = hub.workspace.join(path);
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).map_err(internal)?;
    }
    match kind {
        "markdown" | "text" | "json" => {
            let content = params["content"]
                .as_str()
                .ok_or_else(|| params_err("missing content"))?;
            worldbase_docs::edit::write_text(&full, content).map_err(internal)?;
        }
        "csv" => {
            let header: Vec<String> = params["header"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|v| v.as_str().unwrap_or_default().into())
                        .collect()
                })
                .unwrap_or_default();
            let rows: Vec<Vec<String>> = params["rows"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|r| {
                            r.as_array()
                                .map(|c| c.iter().map(cell).collect())
                                .unwrap_or_default()
                        })
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
                            .map(|r| {
                                r.as_array()
                                    .map(|c| c.iter().map(cell).collect())
                                    .unwrap_or_default()
                            })
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
            "heading" => blocks.push(worldbase_docs::edit::DocBlock::Heading(
                text,
                b["level"].as_u64().unwrap_or(1) as u32,
            )),
            "bullet" => blocks.push(worldbase_docs::edit::DocBlock::Bullet(text)),
            _ => blocks.push(worldbase_docs::edit::DocBlock::Paragraph(text)),
        }
    }
    blocks
}

// ---------- providers（供应商管理，对齐桌面 settings:providers）----------

async fn provider_fetch_models(params: Value) -> Result<Value, ErrorObject> {
    let base_url = params["baseUrl"]
        .as_str()
        .ok_or_else(|| params_err("missing baseUrl"))?;
    let api_key = params["apiKey"]
        .as_str()
        .ok_or_else(|| params_err("missing apiKey"))?;
    let api_protocol = params["apiProtocol"].as_str().unwrap_or_default();
    let models = worldbase_providers::fetch_remote_models(base_url, api_key, api_protocol)
        .await
        .map_err(internal)?;
    Ok(json!({ "models": models }))
}

fn provider_save(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let entry: ProviderEntry =
        serde_json::from_value(params.get("provider").cloned().unwrap_or(Value::Null))
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
    hub.store
        .set_setting("providers", &serde_json::to_value(&cfg).unwrap())
        .map_err(internal)?;
    Ok(json!({ "providers": cfg }))
}

fn provider_delete(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let id = params["id"]
        .as_str()
        .ok_or_else(|| params_err("missing id"))?;
    let mut cfg = hub.providers_config();
    cfg.providers.retain(|p| p.id != id);
    if cfg.active_provider_id.as_deref() == Some(id) {
        cfg.active_provider_id = cfg.providers.first().map(|p| p.id.clone());
    }
    hub.store
        .set_setting("providers", &serde_json::to_value(&cfg).unwrap())
        .map_err(internal)?;
    Ok(json!({ "providers": cfg }))
}

fn provider_set_active(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let id = params["id"]
        .as_str()
        .ok_or_else(|| params_err("missing id"))?;
    let mut cfg = hub.providers_config();
    if !cfg.providers.iter().any(|p| p.id == id) {
        return Err(ErrorObject::invalid_params(format!(
            "provider not found: {id}"
        )));
    }
    cfg.active_provider_id = Some(id.to_string());
    hub.store
        .set_setting("providers", &serde_json::to_value(&cfg).unwrap())
        .map_err(internal)?;
    Ok(json!({ "providers": cfg }))
}

// ---------- agents ----------

fn agent_get(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let id = params["id"]
        .as_str()
        .ok_or_else(|| params_err("missing id"))?;
    let agent = hub
        .store
        .get_agent(&sanitize_agent_id(id))
        .map_err(internal)?;
    Ok(json!({ "agent": agent }))
}

fn agent_save(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let value = params
        .get("agent")
        .filter(|agent| agent.is_object())
        .ok_or_else(|| params_err("missing agent"))?;
    let requested_id = agent_string(value, "id");
    let existing = requested_id
        .as_deref()
        .map(sanitize_agent_id)
        .filter(|id| !id.is_empty())
        .map(|id| hub.store.get_agent(&id).map_err(internal))
        .transpose()?
        .flatten();
    let now = worldbase_protocol::event::now_rfc3339();
    let id = requested_id
        .as_deref()
        .map(sanitize_agent_id)
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| {
            create_agent_id(agent_string(value, "name").as_deref().unwrap_or("custom"))
        });
    let name = agent_string(value, "name")
        .or_else(|| existing.as_ref().map(|agent| agent.name.clone()))
        .or_else(|| params["fallbackName"].as_str().map(ToOwned::to_owned))
        .unwrap_or_else(|| "Untitled agent".into());
    let icon =
        agent_string(value, "icon").or_else(|| existing.as_ref().map(|agent| agent.icon.clone()));
    let description = if value.get("description").and_then(Value::as_str).is_some() {
        value["description"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_string()
    } else {
        existing
            .as_ref()
            .map(|agent| agent.description.clone())
            .unwrap_or_default()
    };
    let system_prompt = value
        .get("systemPrompt")
        .or_else(|| value.get("system_prompt"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| existing.as_ref().map(|agent| agent.system_prompt.clone()))
        .unwrap_or_default();
    let provider_id = agent_string_alias(value, "providerId", "provider_id").or_else(|| {
        existing
            .as_ref()
            .and_then(|agent| agent.provider_id.clone())
    });
    let model_id = agent_string_alias(value, "modelId", "model_id")
        .or_else(|| existing.as_ref().and_then(|agent| agent.model_id.clone()));
    let reasoning_strength = agent_string_alias(value, "reasoningStrength", "reasoning_strength")
        .filter(|strength| matches!(strength.as_str(), "low" | "medium" | "high" | "max"))
        .or_else(|| {
            existing
                .as_ref()
                .map(|agent| agent.reasoning_strength.clone())
        })
        .unwrap_or_else(|| "medium".into());
    let skill_ids = agent_string_array_alias(value, "skillIds", "skill_ids")
        .or_else(|| existing.as_ref().map(|agent| agent.skill_ids.clone()))
        .unwrap_or_default();
    let allowed_tools = agent_string_array_alias(value, "allowedTools", "allowed_tools")
        .or_else(|| existing.as_ref().map(|agent| agent.allowed_tools.clone()))
        .unwrap_or_default();
    let denied_tools = agent_string_array_alias(value, "deniedTools", "denied_tools")
        .or_else(|| existing.as_ref().map(|agent| agent.denied_tools.clone()))
        .unwrap_or_default();
    let memory_scopes = agent_string_array_alias(value, "memoryScopes", "memory_scopes")
        .map(|scopes| {
            scopes
                .into_iter()
                .filter(|scope| {
                    matches!(
                        scope.as_str(),
                        "user" | "agent" | "project" | "group" | "channel"
                    )
                })
                .collect()
        })
        .or_else(|| existing.as_ref().map(|agent| agent.memory_scopes.clone()))
        .unwrap_or_else(|| vec!["user".into(), "agent".into(), "project".into()]);
    let memory_write_policy = merge_agent_memory_write_policy(value, existing.as_ref());
    let auto_reply_policy = merge_agent_auto_reply_policy(value, existing.as_ref());
    let created_at = existing
        .as_ref()
        .map(|agent| agent.created_at.clone())
        .or_else(|| agent_string_alias(value, "createdAt", "created_at"))
        .unwrap_or_else(|| now.clone());
    let agent = AgentDefinition {
        id,
        name,
        icon: icon.unwrap_or_default(),
        description,
        system_prompt,
        provider_id,
        model_id,
        skill_ids,
        reasoning_strength,
        allowed_tools,
        denied_tools,
        memory_scopes,
        memory_write_policy,
        auto_reply_policy,
        created_at,
        updated_at: now,
    };
    hub.store.upsert_agent(&agent).map_err(internal)?;
    Ok(json!({ "agent": agent }))
}

fn agent_delete(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let id = params["id"]
        .as_str()
        .ok_or_else(|| params_err("missing id"))?;
    let sanitized_id = sanitize_agent_id(id);
    if sanitized_id == "agent_default" {
        return Ok(json!({ "deleted": false }));
    }
    let deleted = hub.store.delete_agent(&sanitized_id).map_err(internal)?;
    Ok(json!({ "deleted": deleted }))
}

fn sanitize_agent_id(value: &str) -> String {
    value
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || *character == '_' || *character == '-'
        })
        .collect()
}

fn create_agent_id(name: &str) -> String {
    let slug = group_slug(name);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    sanitize_agent_id(&format!(
        "agent_{}_{}",
        if slug.is_empty() { "custom" } else { &slug },
        base36(millis)
    ))
}

fn agent_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned)
}

fn agent_string_alias(value: &Value, camel: &str, snake: &str) -> Option<String> {
    agent_string(value, camel).or_else(|| agent_string(value, snake))
}

fn agent_string_array_alias(value: &Value, camel: &str, snake: &str) -> Option<Vec<String>> {
    let source = value
        .get(camel)
        .filter(|candidate| !candidate.is_null())
        .or_else(|| value.get(snake).filter(|candidate| !candidate.is_null()))?;
    let mut seen = std::collections::HashSet::new();
    Some(
        source
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                    .filter(|text| seen.insert((*text).to_string()))
                    .map(ToOwned::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
    )
}

fn merge_agent_memory_write_policy(
    value: &Value,
    existing: Option<&AgentDefinition>,
) -> AgentMemoryWritePolicy {
    let defaults = AgentMemoryWritePolicy::default();
    let prior = existing
        .map(|agent| agent.memory_write_policy.clone())
        .unwrap_or(defaults.clone());
    let source = value
        .get("memoryWritePolicy")
        .or_else(|| value.get("memory_write_policy"));
    let bool_field = |key: &str, fallback: bool| {
        source
            .and_then(|policy| policy.get(key))
            .and_then(Value::as_bool)
            .unwrap_or(fallback)
    };
    AgentMemoryWritePolicy {
        allow_user_traits: bool_field("allowUserTraits", prior.allow_user_traits),
        allow_agent_skills: bool_field("allowAgentSkills", prior.allow_agent_skills),
        allow_steps: bool_field("allowSteps", prior.allow_steps),
        allow_knowledge: bool_field("allowKnowledge", prior.allow_knowledge),
    }
}

fn merge_agent_auto_reply_policy(
    value: &Value,
    existing: Option<&AgentDefinition>,
) -> AgentAutoReplyPolicy {
    let prior = existing
        .map(|agent| agent.auto_reply_policy.clone())
        .unwrap_or_default();
    let source = value
        .get("autoReplyPolicy")
        .or_else(|| value.get("auto_reply_policy"));
    AgentAutoReplyPolicy {
        enabled: source
            .and_then(|policy| policy.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(prior.enabled),
        require_mention: source
            .and_then(|policy| policy.get("requireMention"))
            .and_then(Value::as_bool)
            .unwrap_or(prior.require_mention),
    }
}

// ---------- durable Agent Workspace group catalog ----------

fn group_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned)
}

fn sanitize_group_id(value: &str) -> String {
    // Keep this byte-for-byte compatible with AgentGroupStore.filePath():
    // IDs are deliberately restricted to the portable ASCII filename subset.
    value
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || *character == '_' || *character == '-'
        })
        .collect()
}

fn group_slug(value: &str) -> String {
    let mut slug = String::new();
    let mut pending_separator = false;
    for character in value.chars() {
        if character.is_ascii_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(&character) {
            if pending_separator && !slug.is_empty() {
                slug.push('_');
            }
            pending_separator = false;
            slug.push(character.to_ascii_lowercase());
        } else if !slug.is_empty() {
            pending_separator = true;
        }
        if slug.chars().count() >= 36 {
            break;
        }
    }
    while slug.ends_with('_') {
        slug.pop();
    }
    slug
}

fn base36(mut value: u128) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".into();
    }
    let mut output = Vec::new();
    while value > 0 {
        output.push(DIGITS[(value % 36) as usize] as char);
        value /= 36;
    }
    output.iter().rev().collect()
}

fn create_group_id(name: &str) -> String {
    let slug = group_slug(name);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!(
        "group_{}_{}",
        if slug.is_empty() { "team" } else { &slug },
        base36(millis)
    )
}

fn group_number(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(|value| {
        value.as_f64().or_else(|| {
            value
                .as_str()
                .and_then(|text| text.trim().parse::<f64>().ok())
        })
    })
}

fn group_source_value<'a>(
    value: &'a Value,
    existing: Option<&'a Value>,
    key: &str,
) -> Option<&'a Value> {
    value
        .get(key)
        .filter(|candidate| !candidate.is_null())
        .or_else(|| existing.and_then(|group| group.get(key)))
}

fn normalize_agent_group(value: &Value, existing: Option<&Value>, fallback_name: &str) -> Value {
    let now = worldbase_protocol::event::now_rfc3339();
    let requested_id = group_string(value, "id");
    let existing_id = existing.and_then(|group| group_string(group, "id"));
    let id = sanitize_group_id(
        requested_id
            .as_deref()
            .or(existing_id.as_deref())
            .unwrap_or_else(|| ""),
    );
    let id = if id.is_empty() {
        create_group_id(
            group_string(value, "name")
                .as_deref()
                .or(existing
                    .and_then(|group| group_string(group, "name"))
                    .as_deref())
                .unwrap_or("group"),
        )
    } else {
        id
    };

    let name = group_string(value, "name")
        .or_else(|| existing.and_then(|group| group_string(group, "name")))
        .unwrap_or_else(|| fallback_name.trim().to_string())
        .trim()
        .to_string();
    let icon = group_string(value, "icon")
        .or_else(|| existing.and_then(|group| group_string(group, "icon")));
    let description = if value.get("description").and_then(Value::as_str).is_some() {
        value["description"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_string()
    } else {
        existing
            .and_then(|group| group.get("description").and_then(Value::as_str))
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    let coordinator = if value
        .get("coordinatorAgentId")
        .and_then(Value::as_str)
        .is_some()
        || value
            .get("coordinator_agent_id")
            .and_then(Value::as_str)
            .is_some()
    {
        group_string(value, "coordinatorAgentId")
            .or_else(|| group_string(value, "coordinator_agent_id"))
            .unwrap_or_default()
    } else {
        group_string(value, "coordinatorAgentId")
            .or_else(|| existing.and_then(|group| group_string(group, "coordinatorAgentId")))
            .unwrap_or_default()
    };

    let member_value = group_source_value(value, existing, "memberAgentIds")
        .or_else(|| group_source_value(value, existing, "member_agent_ids"));
    let mut member_seen = std::collections::HashSet::new();
    let member_ids: Vec<String> = member_value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .filter(|text| member_seen.insert((*text).to_string()))
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default();

    let max_rounds = group_number(value, "maxRounds")
        .or_else(|| group_number(value, "max_rounds"))
        .or_else(|| {
            existing.and_then(|group| {
                group_number(group, "maxRounds").or_else(|| group_number(group, "max_rounds"))
            })
        })
        .filter(|number| number.is_finite() && *number != 0.0)
        .unwrap_or(2.0)
        .clamp(1.0, 5.0)
        .floor() as u32;
    let max_parallel_workers = group_number(value, "maxParallelWorkers")
        .or_else(|| group_number(value, "max_parallel_workers"))
        .or_else(|| {
            existing.and_then(|group| {
                group_number(group, "maxParallelWorkers")
                    .or_else(|| group_number(group, "max_parallel_workers"))
            })
        })
        .filter(|number| number.is_finite() && *number != 0.0)
        .unwrap_or(2.0)
        .clamp(1.0, 5.0)
        .floor() as u32;

    let scope_value = group_source_value(value, existing, "sharedMemoryScopes")
        .or_else(|| group_source_value(value, existing, "shared_memory_scopes"));
    let mut scope_seen = std::collections::HashSet::new();
    let mut scopes: Vec<String> = scope_value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|scope| matches!(*scope, "group" | "project" | "channel"))
                .filter(|scope| scope_seen.insert((*scope).to_string()))
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default();
    if scope_value.is_none() {
        scopes.push("group".into());
    }

    let visibility =
        if group_string(value, "visibility").as_deref() == Some("expandable_internal_transcript") {
            "expandable_internal_transcript".to_string()
        } else {
            existing
                .and_then(|group| group_string(group, "visibility"))
                .unwrap_or_else(|| "summary_only".into())
        };
    let created_at = group_string(value, "createdAt")
        .or_else(|| group_string(value, "created_at"))
        .or_else(|| {
            existing
                .and_then(|group| group_string(group, "createdAt"))
                .or_else(|| existing.and_then(|group| group_string(group, "created_at")))
        })
        .unwrap_or_else(|| now.clone());

    json!({
        "id": id,
        "name": name,
        "icon": icon,
        "description": description,
        "coordinatorAgentId": coordinator,
        "memberAgentIds": member_ids,
        "maxRounds": max_rounds,
        "maxParallelWorkers": max_parallel_workers,
        "sharedMemoryScopes": scopes,
        "visibility": visibility,
        "createdAt": created_at,
        "updatedAt": now
    })
}

fn agent_group_list(hub: &Arc<Hub>) -> Result<Value, ErrorObject> {
    let groups = hub
        .store
        .get_agent_groups_setting()
        .map_err(internal)?
        .into_iter()
        .map(|group| normalize_agent_group(&group, Some(&group), "Untitled group"))
        .filter_map(|group| serde_json::from_value::<AgentGroupDefinition>(group).ok())
        .collect::<Vec<_>>();
    let mut groups = groups;
    groups.sort_by(|left, right| left.created_at.cmp(&right.created_at));
    Ok(json!({ "groups": groups }))
}

fn agent_group_get(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let requested = params["id"]
        .as_str()
        .ok_or_else(|| params_err("missing id"))?;
    let id = sanitize_group_id(requested);
    let group = hub
        .store
        .get_agent_groups_setting()
        .map_err(internal)?
        .into_iter()
        .find(|group| group_string(group, "id").as_deref() == Some(id.as_str()))
        .map(|group| normalize_agent_group(&group, Some(&group), "Untitled group"))
        .and_then(|group| serde_json::from_value::<AgentGroupDefinition>(group).ok());
    Ok(json!({ "group": group }))
}

fn agent_group_save(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let value = params
        .get("group")
        .filter(|group| group.is_object())
        .ok_or_else(|| params_err("missing group"))?;
    let mut groups = hub.store.get_agent_groups_setting().map_err(internal)?;
    let requested_id = group_string(value, "id").map(|id| sanitize_group_id(&id));
    let existing_index = requested_id.as_deref().and_then(|id| {
        groups
            .iter()
            .position(|group| group_string(group, "id").as_deref() == Some(id))
    });
    let existing = existing_index.and_then(|index| groups.get(index));
    let fallback_name = params["fallbackName"].as_str().unwrap_or("Untitled group");
    let normalized = normalize_agent_group(value, existing, fallback_name);
    if let Some(index) = existing_index {
        groups[index] = normalized.clone();
    } else {
        groups.push(normalized.clone());
    }
    hub.store
        .set_agent_groups_setting(&groups)
        .map_err(internal)?;
    let group = serde_json::from_value::<AgentGroupDefinition>(normalized)
        .map_err(|error| internal(error.to_string()))?;
    Ok(json!({ "group": group }))
}

fn agent_group_delete(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let requested = params["id"]
        .as_str()
        .ok_or_else(|| params_err("missing id"))?;
    let id = sanitize_group_id(requested);
    let mut groups = hub.store.get_agent_groups_setting().map_err(internal)?;
    let original_len = groups.len();
    groups.retain(|group| group_string(group, "id").as_deref() != Some(id.as_str()));
    let deleted = groups.len() != original_len;
    if deleted {
        hub.store
            .set_agent_groups_setting(&groups)
            .map_err(internal)?;
    }
    Ok(json!({ "deleted": deleted }))
}

// ---------- studio（图像生成）----------

fn studio_generate(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    // A TS-selected session can have changed gallery metadata just before the
    // user switches engines. Reconcile before the asynchronous generator
    // writes its own folder mirror, otherwise an older Rust index could
    // overwrite those TS-side edits.
    studio_sync_legacy_mirror(hub)?;
    let mut p: ImageGenerateParams =
        serde_json::from_value(params.clone()).map_err(|e| params_err(e.to_string()))?;
    // 显式模型：与供应商解析一致（model 覆盖 active_model）
    if let Some(m) = params["model"].as_str() {
        p.model = Some(m.to_string());
    }
    let stream_id = crate::studio::StudioService::generate(hub.clone(), p).map_err(internal)?;
    Ok(json!({ "streamId": stream_id }))
}

fn prompt_optimization_text_model(
    entry: &worldbase_protocol::types::ProviderEntry,
    requested_model: Option<&str>,
) -> Option<String> {
    let supports_text = |model: &str| {
        entry
            .models
            .iter()
            .find(|candidate| candidate.id == model)
            .map(|candidate| !candidate.image_generation && !candidate.image_editing)
            .unwrap_or(true)
    };
    if let Some(model) = requested_model
        .map(str::trim)
        .filter(|model| !model.is_empty())
    {
        if supports_text(model) {
            return Some(model.to_string());
        }
    }
    let active = entry.active_model.trim();
    if !active.is_empty() && supports_text(active) {
        return Some(active.to_string());
    }
    entry
        .models
        .iter()
        .find(|model| !model.image_generation && !model.image_editing)
        .map(|model| model.id.clone())
}

fn prompt_optimization_provider(
    hub: &Hub,
    requested_provider: Option<&str>,
    requested_model: Option<&str>,
) -> Result<worldbase_protocol::types::ProviderEntry> {
    let config = hub.providers_config();
    let candidates: Vec<_> = if let Some(provider_id) = requested_provider
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        vec![config
            .providers
            .iter()
            .find(|provider| provider.id == provider_id)
            .ok_or_else(|| anyhow::anyhow!("provider not found: {provider_id}"))?
            .clone()]
    } else {
        let mut ordered = Vec::new();
        let active_id = config.active_provider_id.as_deref();
        if let Some(active) = config
            .providers
            .iter()
            .find(|provider| Some(provider.id.as_str()) == active_id)
        {
            ordered.push(active.clone());
        }
        ordered.extend(
            config
                .providers
                .iter()
                .filter(|provider| Some(provider.id.as_str()) != active_id)
                .cloned(),
        );
        ordered
    };

    for mut provider in candidates {
        if let Some(model) = prompt_optimization_text_model(&provider, requested_model) {
            provider.active_model = model;
            return Ok(provider);
        }
    }
    anyhow::bail!("no text model available for prompt optimization")
}

async fn studio_prompt_optimize(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let prompt = params["prompt"]
        .as_str()
        .map(str::trim)
        .filter(|prompt| !prompt.is_empty())
        .ok_or_else(|| params_err("missing prompt"))?;
    let is_negative = params["isNegative"].as_bool().unwrap_or(false);
    let provider_id = params["providerId"].as_str();
    let requested_model = params["model"].as_str();
    let entry = prompt_optimization_provider(hub, provider_id, requested_model)
        .map_err(|error| params_err(error.to_string()))?;
    let provider = worldbase_providers::create_provider_from_entry(&entry).map_err(internal)?;
    let system = if is_negative {
        "你是一个专业的AI绘画提示词优化专家。用户会给你一段负向提示词（negative prompt），请优化它使其更加专业、精确、有效。负向提示词用于描述不希望在图片中出现的元素。请直接返回优化后的负向提示词文本，不要添加任何解释或前缀。保持与用户输入相同的语言。"
    } else {
        "你是一个专业的AI绘画提示词优化专家。用户会给你一段图片生成提示词（prompt），请优化它使其更加专业、详细、生动，能够帮助AI模型生成更高质量的图片。请直接返回优化后的提示词文本，不要添加任何解释或前缀。保持与用户输入相同的语言。"
    };
    let mut stream = provider
        .chat_stream(
            Some(system),
            vec![worldbase_providers::LlmMessage::text(
                worldbase_providers::LlmRole::User,
                prompt,
            )],
            Vec::new(),
            1024,
            worldbase_providers::ChatOptions {
                temperature: Some(0.8),
                enable_thinking: false,
                reasoning_effort: None,
            },
        )
        .await
        .map_err(|error| internal(error.to_string()))?;
    let mut optimized = String::new();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(worldbase_providers::StreamChunk::TextDelta(text)) => optimized.push_str(&text),
            Ok(worldbase_providers::StreamChunk::ThinkingDelta(_)) => {}
            Ok(worldbase_providers::StreamChunk::Completed { assistant, .. }) => {
                optimized = assistant.text_view();
                break;
            }
            Err(error) => return Err(internal(error.to_string())),
        }
    }
    let optimized = optimized.trim();
    if optimized.is_empty() {
        return Err(params_err("prompt optimization returned an empty response"));
    }
    Ok(json!({ "ok": true, "optimizedPrompt": optimized }))
}

fn studio_library_dir() -> std::path::PathBuf {
    worldbase_memory::Store::default_dir().join("image-library")
}

fn studio_sync_legacy_mirror(hub: &Arc<Hub>) -> Result<(), ErrorObject> {
    hub.store
        .import_image_library_mirror(&studio_library_dir())
        .map(|_| ())
        .map_err(internal)
}

fn studio_write_image_mirror(entry: &ImageEntry) -> Result<(), ErrorObject> {
    worldbase_memory::Store::write_image_library_mirror(&studio_library_dir(), entry)
        .map_err(internal)
}

fn studio_write_image_mirrors<I, S>(hub: &Arc<Hub>, ids: I) -> Result<(), ErrorObject>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    for id in ids {
        if let Some(entry) = hub.store.get_image(id.as_ref()).map_err(internal)? {
            studio_write_image_mirror(&entry)?;
        }
    }
    Ok(())
}

fn studio_write_folder_mirror(hub: &Arc<Hub>) -> Result<(), ErrorObject> {
    let folders = hub.store.list_image_folders().map_err(internal)?;
    worldbase_memory::Store::write_image_folder_mirror(&studio_library_dir(), &folders)
        .map_err(internal)
}

fn normalized_string_array(params: &Value, key: &str) -> Vec<String> {
    params[key]
        .as_array()
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn studio_file_path(file_name: &str) -> Option<std::path::PathBuf> {
    let file_name = Path::new(file_name).file_name()?.to_str()?;
    if file_name.is_empty() {
        return None;
    }
    Some(studio_library_dir().join(file_name))
}

fn studio_mime(file_name: &str) -> &'static str {
    match Path::new(file_name)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        _ => "image/png",
    }
}

fn studio_data_url(file_name: &str) -> Result<Option<String>, ErrorObject> {
    let Some(path) = studio_file_path(file_name) else {
        return Ok(None);
    };
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path).map_err(internal)?;
    Ok(Some(format!(
        "data:{};base64,{}",
        studio_mime(file_name),
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )))
}

fn studio_thumbnail_file_name(entry: &ImageEntry) -> Option<String> {
    for key in ["thumbName", "thumb_name"] {
        let Some(value) = entry.meta.get(key).and_then(Value::as_str) else {
            continue;
        };
        let Some(file_name) = Path::new(value).file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if studio_file_path(file_name).is_some_and(|path| path.is_file()) {
            return Some(file_name.to_string());
        }
    }
    None
}

/// Backfill thumbnails for images created before Rust Studio owned that work.
/// Persisting the result through both stores preserves cross-engine switching
/// while keeping the image processing itself in Rust.
fn studio_ensure_thumbnail(
    hub: &Arc<Hub>,
    entry: &mut ImageEntry,
) -> Result<Option<String>, ErrorObject> {
    if let Some(name) = studio_thumbnail_file_name(entry) {
        return Ok(Some(name));
    }
    let Some(thumbnail) = worldbase_memory::Store::write_image_library_thumbnail(
        &studio_library_dir(),
        &entry.id,
        &entry.file,
    ) else {
        return Ok(None);
    };
    if !entry.meta.is_object() {
        entry.meta = json!({});
    }
    let metadata = entry
        .meta
        .as_object_mut()
        .expect("Studio metadata is always a JSON object after normalization");
    metadata.insert("thumbName".into(), thumbnail.name.clone().into());
    metadata.insert("width".into(), thumbnail.width.into());
    metadata.insert("height".into(), thumbnail.height.into());
    hub.store.add_image(entry).map_err(internal)?;
    studio_write_image_mirror(entry)?;
    Ok(Some(thumbnail.name))
}

fn source_image_file_names(entry: &ImageEntry) -> Vec<String> {
    let mut names = Vec::new();
    for key in ["sourceImageFileNames", "source_image_file_names"] {
        if let Some(values) = entry.meta.get(key).and_then(Value::as_array) {
            names.extend(
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToOwned::to_owned),
            );
        }
    }
    names
}

fn studio_delete_entry_files(entry: &ImageEntry) {
    let mut file_names = vec![
        entry.file.clone(),
        format!("{}.json", entry.id),
        format!("{}.thumb.webp", entry.id),
    ];
    for key in ["thumbName", "thumb_name"] {
        if let Some(name) = entry.meta.get(key).and_then(Value::as_str) {
            file_names.push(name.to_string());
        }
    }
    file_names.extend(source_image_file_names(entry));
    for file_name in file_names {
        if let Some(path) = studio_file_path(&file_name) {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn studio_query_page(
    hub: &Arc<Hub>,
    params: Value,
    legacy_list_defaults_to_all: bool,
) -> Result<ImagePage, ErrorObject> {
    studio_sync_legacy_mirror(hub)?;
    let query: ImageQuery =
        serde_json::from_value(params).map_err(|error| params_err(error.to_string()))?;
    let mut tags = query.tags;
    if let Some(tag) = query.tag {
        tags.push(tag);
    }
    let is_all_folders = query.folder.as_deref() == Some("*")
        || (legacy_list_defaults_to_all && query.folder.is_none());
    hub.store
        .query_image_page(
            query.folder.as_deref().filter(|folder| *folder != "*"),
            is_all_folders,
            &tags,
            query.search.as_deref(),
            query.limit.unwrap_or(60),
            query.offset.unwrap_or(0),
        )
        .map_err(internal)
}

fn studio_list(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let page = studio_query_page(hub, params, true)?;
    Ok(serde_json::to_value(page).unwrap())
}

fn studio_tag(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    studio_sync_legacy_mirror(hub)?;
    let id = params["id"]
        .as_str()
        .ok_or_else(|| params_err("missing id"))?;
    let tags = normalized_string_array(&params, "tags");
    let ok = hub.store.set_image_tags(id, &tags).map_err(internal)?;
    if let Some(folder) = params.get("folder").and_then(Value::as_str) {
        let _ = hub
            .store
            .set_image_folder(&[id.to_string()], Some(folder))
            .map_err(internal)?;
        studio_write_folder_mirror(hub)?;
    }
    studio_write_image_mirrors(hub, [id])?;
    Ok(json!({ "updated": ok }))
}

fn studio_delete(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    studio_sync_legacy_mirror(hub)?;
    let id = params["id"]
        .as_str()
        .ok_or_else(|| params_err("missing id"))?;
    if let Some(entry) = hub.store.get_image(id).map_err(internal)? {
        studio_delete_entry_files(&entry);
    }
    let deleted = hub.store.delete_image(id).map_err(internal)?;
    if deleted {
        studio_write_folder_mirror(hub)?;
    }
    Ok(json!({ "deleted": deleted }))
}

fn studio_folder(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let action = params["action"].as_str().unwrap_or("list");
    match action {
        "list" => studio_library_list_folders(hub),
        "create" => studio_library_create_folder(hub, params),
        "rename" => studio_library_rename_folder(hub, params),
        "delete" => studio_library_delete_folder(hub, params),
        "set" => studio_library_set_folder(hub, params),
        _ => Err(params_err("unsupported studio.folder action")),
    }
}

fn studio_library_query(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    Ok(serde_json::to_value(studio_query_page(hub, params, false)?).unwrap())
}

fn studio_library_read(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    studio_sync_legacy_mirror(hub)?;
    let id = params["id"]
        .as_str()
        .ok_or_else(|| params_err("missing id"))?;
    let variant = params
        .get("variant")
        .and_then(Value::as_str)
        .unwrap_or("full");
    if variant != "full" && variant != "thumb" {
        return Err(params_err("variant must be full or thumb"));
    }
    let mut entry = hub
        .store
        .get_image(id)
        .map_err(internal)?
        .ok_or_else(|| ErrorObject::invalid_params("image not found"))?;
    let file_name = if variant == "thumb" {
        studio_ensure_thumbnail(hub, &mut entry)?.unwrap_or_else(|| entry.file.clone())
    } else {
        entry.file.clone()
    };
    let data_url = studio_data_url(&file_name)?
        .ok_or_else(|| ErrorObject::invalid_params("image file not found"))?;
    let source_data_urls: Vec<String> = source_image_file_names(&entry)
        .into_iter()
        .filter_map(|file_name| studio_data_url(&file_name).transpose())
        .collect::<Result<_, _>>()?;
    Ok(json!({
        "dataUrl": data_url,
        "sourceDataUrls": source_data_urls,
        "entry": entry,
    }))
}

fn studio_library_delete_many(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    studio_sync_legacy_mirror(hub)?;
    let mut removed = 0u32;
    for id in normalized_string_array(&params, "ids") {
        if let Some(entry) = hub.store.get_image(&id).map_err(internal)? {
            studio_delete_entry_files(&entry);
            if hub.store.delete_image(&id).map_err(internal)? {
                removed = removed.saturating_add(1);
            }
        }
    }
    if removed > 0 {
        studio_write_folder_mirror(hub)?;
    }
    Ok(json!({ "removed": removed }))
}

fn studio_library_set_folder(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    studio_sync_legacy_mirror(hub)?;
    let folder = params.get("folder").and_then(Value::as_str);
    let ids = normalized_string_array(&params, "ids");
    let updated = hub.store.set_image_folder(&ids, folder).map_err(internal)?;
    if updated > 0 {
        studio_write_image_mirrors(hub, &ids)?;
        studio_write_folder_mirror(hub)?;
    }
    Ok(json!({ "updated": updated }))
}

fn studio_library_set_tags(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    studio_sync_legacy_mirror(hub)?;
    let id = params["id"]
        .as_str()
        .ok_or_else(|| params_err("missing id"))?;
    let updated = hub
        .store
        .set_image_tags(id, &normalized_string_array(&params, "tags"))
        .map_err(internal)?;
    if updated {
        studio_write_image_mirrors(hub, [id])?;
    }
    Ok(json!({ "updated": updated }))
}

fn studio_library_list_folders(hub: &Arc<Hub>) -> Result<Value, ErrorObject> {
    studio_sync_legacy_mirror(hub)?;
    let folders = hub.store.list_image_folders().map_err(internal)?;
    Ok(json!({ "folders": folders }))
}

fn studio_library_create_folder(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    studio_sync_legacy_mirror(hub)?;
    let name = params["name"]
        .as_str()
        .ok_or_else(|| params_err("missing name"))?;
    hub.store.create_image_folder(name).map_err(internal)?;
    studio_write_folder_mirror(hub)?;
    studio_library_list_folders(hub)
}

fn studio_library_rename_folder(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    studio_sync_legacy_mirror(hub)?;
    let old_name = params["oldName"]
        .as_str()
        .ok_or_else(|| params_err("missing oldName"))?;
    let new_name = params["newName"]
        .as_str()
        .ok_or_else(|| params_err("missing newName"))?;
    let affected_ids: Vec<String> = hub
        .store
        .image_entries_in_folder(old_name)
        .map_err(internal)?
        .into_iter()
        .map(|entry| entry.id)
        .collect();
    let updated = hub
        .store
        .rename_image_folder(old_name, new_name)
        .map_err(internal)?;
    studio_write_image_mirrors(hub, &affected_ids)?;
    studio_write_folder_mirror(hub)?;
    Ok(json!({ "updated": updated }))
}

fn studio_library_delete_folder(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    studio_sync_legacy_mirror(hub)?;
    let name = params
        .get("name")
        .or_else(|| params.get("folderName"))
        .and_then(Value::as_str)
        .ok_or_else(|| params_err("missing name"))?;
    let affected_ids: Vec<String> = hub
        .store
        .image_entries_in_folder(name)
        .map_err(internal)?
        .into_iter()
        .map(|entry| entry.id)
        .collect();
    let updated = hub.store.delete_image_folder(name).map_err(internal)?;
    studio_write_image_mirrors(hub, &affected_ids)?;
    studio_write_folder_mirror(hub)?;
    Ok(json!({ "updated": updated }))
}

fn studio_library_list_tags(hub: &Arc<Hub>) -> Result<Value, ErrorObject> {
    studio_sync_legacy_mirror(hub)?;
    Ok(json!({ "tags": hub.store.list_image_tags().map_err(internal)? }))
}

fn studio_library_export(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    studio_sync_legacy_mirror(hub)?;
    let folder = params["folder"].as_str().unwrap_or("");
    let destination = params["destination"]
        .as_str()
        .ok_or_else(|| params_err("missing destination"))?;
    let destination = Path::new(destination);
    if destination.as_os_str().is_empty() {
        return Err(params_err("missing destination"));
    }
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(internal)?;
    }
    let entries = hub
        .store
        .image_entries_in_folder(folder)
        .map_err(internal)?;
    let file = std::fs::File::create(destination).map_err(internal)?;
    let mut archive = zip::ZipWriter::new(file);
    let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
    let mut written = 0u32;
    let mut names = std::collections::HashSet::new();
    for entry in entries {
        let Some(path) = studio_file_path(&entry.file) else {
            continue;
        };
        if !path.is_file() {
            continue;
        }
        let original_name = Path::new(&entry.file)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("image");
        let mut archive_name = original_name.to_string();
        if !names.insert(archive_name.clone()) {
            archive_name = format!("{}-{}", entry.id, original_name);
            names.insert(archive_name.clone());
        }
        archive
            .start_file(archive_name, options)
            .map_err(internal)?;
        archive
            .write_all(&std::fs::read(path).map_err(internal)?)
            .map_err(internal)?;
        written = written.saturating_add(1);
    }
    archive.finish().map_err(internal)?;
    Ok(json!({ "filePath": destination, "count": written }))
}

fn studio_tasks_load(hub: &Arc<Hub>) -> Result<Value, ErrorObject> {
    let tasks = hub.store.load_studio_tasks().map_err(internal)?;
    Ok(json!({ "tasks": tasks }))
}

fn studio_tasks_save(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let tasks = params
        .get("tasks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    hub.store.save_studio_tasks(&tasks).map_err(internal)?;
    Ok(json!({ "ok": true, "count": tasks.len() }))
}

fn studio_tasks_drain(hub: &Arc<Hub>) -> Result<Value, ErrorObject> {
    let tasks = hub.store.drain_studio_pending_tasks().map_err(internal)?;
    Ok(json!({ "tasks": tasks }))
}

// ---------- conversation.fork（消息分叉/编辑重发）----------

fn conversation_fork(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let p: ForkParams = serde_json::from_value(params).map_err(|e| params_err(e.to_string()))?;
    let mode = if p.mode.is_empty() {
        "fork".to_string()
    } else {
        p.mode.clone()
    };
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
                    hub.store
                        .append_message(&new_conv.id, &msg)
                        .map_err(internal)?;
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

fn skill_save(_hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let name = params["name"]
        .as_str()
        .ok_or_else(|| params_err("missing name"))?;
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let description = params["description"].as_str().unwrap_or("");
    let instructions = params["instructions"]
        .as_str()
        .ok_or_else(|| params_err("missing instructions"))?;
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
    let name = params["name"]
        .as_str()
        .ok_or_else(|| params_err("missing name"))?;
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
    let name = params["name"]
        .as_str()
        .ok_or_else(|| params_err("missing name"))?;
    let info = hub.projects.create_project(name).await.map_err(internal)?;
    Ok(serde_json::to_value(&info).unwrap())
}

async fn project_dev_start(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let project = params["project"]
        .as_str()
        .or_else(|| params["projectId"].as_str())
        .ok_or_else(|| params_err("missing project"))?;
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
    let project = params["project"]
        .as_str()
        .or_else(|| params["projectId"].as_str())
        .ok_or_else(|| params_err("missing project"))?;
    let stopped = hub.projects.stop_dev(project).await.map_err(internal)?;
    Ok(json!({ "stopped": stopped }))
}

async fn project_status(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let project = params["project"]
        .as_str()
        .or_else(|| params["projectId"].as_str())
        .ok_or_else(|| params_err("missing project"))?;
    let status = hub.projects.status(project).await.map_err(internal)?;
    Ok(status)
}

fn project_id<'a>(params: &'a Value) -> Result<&'a str, ErrorObject> {
    params["projectId"]
        .as_str()
        .or_else(|| params["project"].as_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| params_err("missing projectId"))
}

fn project_get(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    hub.projects
        .project_meta(project_id(&params)?)
        .map_err(internal)
}

fn project_tree(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    Ok(serde_json::to_value(
        hub.projects
            .project_file_tree(project_id(&params)?)
            .map_err(internal)?,
    )
    .unwrap())
}

fn project_file_read(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let project = project_id(&params)?;
    let file_path = params["filePath"]
        .as_str()
        .or_else(|| params["file_path"].as_str())
        .ok_or_else(|| params_err("missing filePath"))?;
    let content = hub
        .projects
        .read_project_file_for_ui(project, file_path)
        .map_err(internal)?;
    Ok(json!({ "content": content }))
}

fn project_file_write(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let project = project_id(&params)?;
    let file_path = params["filePath"]
        .as_str()
        .or_else(|| params["file_path"].as_str())
        .ok_or_else(|| params_err("missing filePath"))?;
    let content = params["content"]
        .as_str()
        .ok_or_else(|| params_err("missing content"))?;
    hub.projects
        .write_project_file_for_ui(project, file_path, content)
        .map_err(internal)?;
    Ok(json!({ "success": true }))
}

fn project_meta_update(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let project = project_id(&params)?;
    let updates = params.get("updates").cloned().unwrap_or_else(|| json!({}));
    hub.projects
        .update_project_meta_for_ui(project, &updates)
        .map_err(internal)
}

async fn project_delete(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let stopped = hub
        .projects
        .delete_project_for_ui(project_id(&params)?)
        .await
        .map_err(internal)?;
    Ok(json!({ "success": true, "stopped": stopped }))
}

async fn project_build_run(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    hub.projects
        .build_project_for_ui(project_id(&params)?)
        .await
        .map_err(internal)
}

async fn project_build_cleanup(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let remove_node_modules = params["removeNodeModules"].as_bool().unwrap_or(true);
    let remove_build_cache = params["removeBuildCache"].as_bool().unwrap_or(true);
    hub.projects
        .cleanup_project_for_ui(
            project_id(&params)?,
            remove_node_modules,
            remove_build_cache,
        )
        .await
        .map_err(internal)
}

async fn project_build_rebuild(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    hub.projects
        .rebuild_project_for_ui(
            project_id(&params)?,
            params["cleanInstall"].as_bool().unwrap_or(false),
            params["cleanupDependenciesAfterSuccess"]
                .as_bool()
                .unwrap_or(false),
            params["cleanupBuildCacheAfterSuccess"]
                .as_bool()
                .unwrap_or(false),
        )
        .await
        .map_err(internal)
}

fn project_build_needs_rebuild(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    Ok(json!({
        "needsRebuild": hub.projects.project_needs_rebuild_for_ui(project_id(&params)?).map_err(internal)?
    }))
}

async fn project_gateway_service_map(hub: &Arc<Hub>) -> Result<Value, ErrorObject> {
    hub.projects
        .gateway_service_map_for_ui()
        .await
        .map_err(internal)
}

async fn project_gateway_start_all(hub: &Arc<Hub>) -> Result<Value, ErrorObject> {
    hub.projects
        .gateway_start_all_for_ui()
        .await
        .map_err(internal)
}

async fn project_gateway_stop_all(hub: &Arc<Hub>) -> Result<Value, ErrorObject> {
    hub.projects
        .gateway_stop_all_for_ui()
        .await
        .map_err(internal)?;
    Ok(json!({ "success": true }))
}

fn project_gateway_set_restart_policy(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let policy = params["policy"]
        .as_str()
        .ok_or_else(|| params_err("missing policy"))?;
    hub.projects
        .set_restart_policy_for_ui(project_id(&params)?, policy)
        .map_err(internal)?;
    Ok(json!({ "success": true }))
}

async fn project_process_snapshot(hub: &Arc<Hub>) -> Result<Value, ErrorObject> {
    hub.projects
        .project_process_snapshot_for_ui()
        .await
        .map_err(internal)
}

async fn project_process_restart(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    match hub
        .projects
        .restart_project_for_ui(project_id(&params)?)
        .await
    {
        Ok(_) => Ok(json!({ "success": true })),
        Err(error) => Ok(json!({ "success": false, "error": error.to_string() })),
    }
}

async fn project_process_stop(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    match hub.projects.stop_dev(project_id(&params)?).await {
        Ok(_) => Ok(json!({ "success": true })),
        Err(error) => Ok(json!({ "success": false, "error": error.to_string() })),
    }
}

async fn project_process_force_kill(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    match hub
        .projects
        .force_kill_project_for_ui(project_id(&params)?)
        .await
    {
        Ok(true) => Ok(json!({ "success": true })),
        Ok(false) => {
            Ok(json!({ "success": false, "error": "Process not found or already exited" }))
        }
        Err(error) => Ok(json!({ "success": false, "error": error.to_string() })),
    }
}

async fn project_process_kill_orphan(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let pid = params["pid"]
        .as_u64()
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| params_err("missing pid"))?;
    match hub.projects.kill_orphan_process_for_ui(pid).await {
        Ok(()) => Ok(json!({ "success": true })),
        Err(error) => Ok(json!({ "success": false, "error": error.to_string() })),
    }
}

async fn project_process_cleanup_orphans(hub: &Arc<Hub>) -> Result<Value, ErrorObject> {
    hub.projects
        .cleanup_orphan_processes_for_ui()
        .await
        .map_err(internal)
}

fn project_data_query(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let sql = params["sql"]
        .as_str()
        .ok_or_else(|| params_err("missing sql"))?;
    hub.projects
        .project_data_query_for_ui(project_id(&params)?, sql)
        .map_err(internal)
}

fn project_data_summary(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    hub.projects
        .project_data_summary_for_ui(project_id(&params)?)
        .map_err(internal)
}

fn project_data_list_all(hub: &Arc<Hub>) -> Result<Value, ErrorObject> {
    hub.projects
        .project_data_list_all_for_ui()
        .map_err(internal)
}

fn project_data_query_table(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let table = params["tableName"]
        .as_str()
        .ok_or_else(|| params_err("missing tableName"))?;
    hub.projects
        .project_data_query_table_for_ui(
            project_id(&params)?,
            table,
            params["page"].as_u64().unwrap_or(1),
            params["pageSize"].as_u64().unwrap_or(50),
        )
        .map_err(internal)
}

fn project_data_schema(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    hub.projects
        .project_data_schema_for_ui(project_id(&params)?)
        .map_err(internal)
}

fn project_data_tables(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    hub.projects
        .project_data_tables_for_ui(project_id(&params)?)
        .map_err(internal)
}

fn project_data_records_query(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let table = params["table"]
        .as_str()
        .ok_or_else(|| params_err("missing table"))?;
    hub.projects
        .project_data_read_records_for_ui(
            project_id(&params)?,
            table,
            params.get("filters").cloned(),
            params["limit"].as_u64(),
            params["offset"].as_u64(),
            params["orderBy"].as_str(),
            params["orderDirection"].as_str(),
            params.get("columns").cloned(),
        )
        .map_err(internal)
}

fn project_data_records_save(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let table = params["table"]
        .as_str()
        .ok_or_else(|| params_err("missing table"))?;
    let records = params
        .get("records")
        .or_else(|| params.get("record"))
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    hub.projects
        .project_data_save_records_for_ui(
            project_id(&params)?,
            table,
            &records,
            params["mode"].as_str(),
        )
        .map_err(internal)
}

async fn project_logs(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let lines = params["lines"].as_u64().unwrap_or(50).clamp(1, 500) as usize;
    let logs = hub.projects.logs(project_id(&params)?, lines).await;
    Ok(json!({ "logs": logs }))
}

async fn project_logs_append(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let port = params["port"]
        .as_u64()
        .filter(|port| (1..=u16::MAX as u64).contains(port))
        .ok_or_else(|| params_err("missing or invalid port"))? as u16;
    let kind = match params["type"].as_str() {
        Some("stdout") | Some("stderr") => params["type"].as_str().unwrap(),
        _ => return Err(params_err("type must be stdout or stderr")),
    };
    let text = params["text"]
        .as_str()
        .filter(|text| !text.is_empty())
        .ok_or_else(|| params_err("missing text"))?;
    let project_id = hub
        .projects
        .append_external_log_by_port(port, kind, text)
        .await
        .map_err(internal)?;
    Ok(json!({
        "appended": project_id.is_some(),
        "projectId": project_id,
    }))
}

fn project_analyze(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    hub.projects
        .analyze_project_for_ui(project_id(&params)?)
        .map_err(internal)
}

fn workspace_root(params: &Value) -> Result<PathBuf, ErrorObject> {
    let root = params["rootPath"]
        .as_str()
        .or_else(|| params["root_path"].as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| params_err("missing rootPath"))?;
    let root = PathBuf::from(root).canonicalize().map_err(internal)?;
    if !root.is_dir() {
        return Err(params_err("rootPath is not a directory"));
    }
    Ok(root)
}

fn workspace_list(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let root = workspace_root(&params)?;
    hub.projects
        .folder_workspace_list_for_ui(&root)
        .map_err(internal)
}

fn workspace_read(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let root = workspace_root(&params)?;
    let file_path = params["filePath"]
        .as_str()
        .or_else(|| params["file_path"].as_str())
        .ok_or_else(|| params_err("missing filePath"))?;
    hub.projects
        .folder_workspace_read_for_ui(&root, file_path)
        .map_err(internal)
}

fn project_package_export(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let output = params["filePath"]
        .as_str()
        .or_else(|| params["outputPath"].as_str())
        .ok_or_else(|| params_err("missing filePath"))?;
    hub.projects
        .export_project_package_for_ui(project_id(&params)?, std::path::Path::new(output))
        .map_err(internal)
}

fn project_package_import(hub: &Arc<Hub>, params: Value) -> Result<Value, ErrorObject> {
    let file = params["filePath"]
        .as_str()
        .ok_or_else(|| params_err("missing filePath"))?;
    hub.projects
        .import_project_package_for_ui(std::path::Path::new(file))
        .map_err(internal)
}

// ---------- exec ----------

async fn exec_run(
    hub: &Arc<Hub>,
    ctx: &ConnectionContext,
    params: Value,
) -> Result<Value, ErrorObject> {
    let program = params["program"]
        .as_str()
        .ok_or_else(|| params_err("missing program"))?;
    let args: Vec<String> = params["args"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let req = worldbase_exec::ExecRequest {
        program: program.into(),
        args,
        cwd: params["cwd"].as_str().map(String::from),
        env: Default::default(),
        timeout_secs: params["timeout_secs"].as_u64(),
        sandbox: params["sandbox"].as_bool().unwrap_or(true),
    };
    let allowed = crate::permissions::check(
        hub,
        "exec-run",
        "ask",
        "execute_command",
        &params,
        ctx.effective_interactive(),
        None,
    )
    .await;
    if !allowed {
        return Err(ErrorObject::new(
            worldbase_protocol::rpc::SERVER_ERROR,
            "permission denied: execute_command",
        ));
    }
    let result = worldbase_exec::run(&req, &hub.workspace)
        .await
        .map_err(internal)?;
    Ok(serde_json::to_value(&result).unwrap())
}

#[cfg(test)]
mod tests {
    use super::CancelRunOnDrop;
    use crate::hub::{Hub, RunHandle};
    use std::sync::Arc;
    use tokio_util::sync::CancellationToken;
    use worldbase_protocol::types::{
        Capabilities, ChatContentPart, ChatMessage, ChatRunContext, Role,
    };

    #[test]
    fn dropping_native_group_waiter_cancels_its_spawned_child_run() {
        let workspace = std::env::temp_dir().join(format!(
            "worldbase-group-drop-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let store = Arc::new(
            worldbase_memory::Store::open(&workspace.join("app.sqlite")).expect("open test store"),
        );
        let hub = Hub::new(workspace.clone(), store).expect("create test hub");
        let stream_id = "group:member:timed-out".to_string();
        let abort = CancellationToken::new();
        hub.runs.lock().unwrap().insert(
            stream_id.clone(),
            RunHandle {
                conversation_id: "group-child".into(),
                abort: abort.clone(),
                capabilities: Capabilities::desktop(),
                interactive: true,
                agent_id: None,
                provider_id: None,
                model: None,
                context: ChatRunContext::default(),
                group_collaboration: None,
            },
        );

        drop(CancelRunOnDrop { hub, stream_id });

        assert!(abort.is_cancelled());
        let _ = std::fs::remove_dir_all(workspace);
    }

    #[test]
    fn authoritative_sync_preserves_matching_anthropic_provider_parts() {
        let existing = vec![ChatMessage {
            id: 7,
            role: Role::Assistant,
            content: "I found it.".into(),
            parts: vec![
                ChatContentPart::Thinking {
                    thinking: "inspect the file".into(),
                    signature: "opaque-signature".into(),
                },
                ChatContentPart::Text {
                    text: "I found it.".into(),
                },
                ChatContentPart::RedactedThinking {
                    data: "opaque-redacted".into(),
                },
            ],
            tool_calls: vec![],
            tool_results: vec![],
            created_at: None,
        }];
        let incoming = vec![ChatMessage {
            id: 0,
            role: Role::Assistant,
            content: "I found it.".into(),
            parts: vec![ChatContentPart::Text {
                text: "I found it.".into(),
            }],
            tool_calls: vec![],
            tool_results: vec![],
            created_at: None,
        }];

        let merged = super::merge_provider_parts(&existing, &incoming);

        assert!(matches!(
            &merged[0].parts[..],
            [
                ChatContentPart::Thinking { signature, .. },
                ChatContentPart::Text { text },
                ChatContentPart::RedactedThinking { data }
            ] if signature == "opaque-signature"
                && text == "I found it."
                && data == "opaque-redacted"
        ));
    }

    #[test]
    fn authoritative_sync_rebuilds_legacy_text_around_provider_parts() {
        let existing = vec![ChatMessage {
            id: 7,
            role: Role::Assistant,
            content: "I found it.".into(),
            parts: vec![
                ChatContentPart::Thinking {
                    thinking: "inspect the file".into(),
                    signature: "opaque-signature".into(),
                },
                ChatContentPart::Text {
                    text: "I found it.".into(),
                },
                ChatContentPart::RedactedThinking {
                    data: "opaque-redacted".into(),
                },
            ],
            tool_calls: vec![],
            tool_results: vec![],
            created_at: None,
        }];
        let incoming = vec![ChatMessage {
            id: 0,
            role: Role::Assistant,
            content: "I found it.".into(),
            parts: vec![],
            tool_calls: vec![],
            tool_results: vec![],
            created_at: None,
        }];

        let merged = super::merge_provider_parts(&existing, &incoming);

        assert!(matches!(
            &merged[0].parts[..],
            [
                ChatContentPart::Thinking { signature, .. },
                ChatContentPart::Text { text },
                ChatContentPart::RedactedThinking { data }
            ] if signature == "opaque-signature"
                && text == "I found it."
                && data == "opaque-redacted"
        ));
    }

    #[test]
    fn authoritative_sync_restores_omitted_tool_metadata_between_visible_rows() {
        let existing = vec![
            ChatMessage {
                id: 1,
                role: Role::User,
                content: "look up the file".into(),
                parts: vec![],
                tool_calls: vec![],
                tool_results: vec![],
                created_at: None,
            },
            ChatMessage {
                id: 2,
                role: Role::Assistant,
                content: "I will inspect it".into(),
                parts: vec![ChatContentPart::Text {
                    text: "I will inspect it".into(),
                }],
                tool_calls: vec![worldbase_protocol::types::ToolCallRecord {
                    id: "call-1".into(),
                    name: "read_file".into(),
                    args: serde_json::json!({ "path": "a.txt" }),
                }],
                tool_results: vec![],
                created_at: None,
            },
            ChatMessage {
                id: 3,
                role: Role::User,
                content: String::new(),
                parts: vec![],
                tool_calls: vec![],
                tool_results: vec![worldbase_protocol::types::ToolResultRecord {
                    tool_call_id: "call-1".into(),
                    name: "read_file".into(),
                    content: "contents".into(),
                    is_error: false,
                }],
                created_at: None,
            },
            ChatMessage {
                id: 4,
                role: Role::Assistant,
                content: "The file says hello.".into(),
                parts: vec![ChatContentPart::Text {
                    text: "The file says hello.".into(),
                }],
                tool_calls: vec![],
                tool_results: vec![],
                created_at: None,
            },
        ];
        let incoming = vec![
            ChatMessage {
                id: 0,
                role: Role::User,
                content: "look up the file".into(),
                parts: vec![],
                tool_calls: vec![],
                tool_results: vec![],
                created_at: None,
            },
            ChatMessage {
                id: 0,
                role: Role::Assistant,
                content: "The file says hello.".into(),
                parts: vec![ChatContentPart::Text {
                    text: "The file says hello.".into(),
                }],
                tool_calls: vec![],
                tool_results: vec![],
                created_at: None,
            },
        ];

        let merged = super::merge_provider_parts(&existing, &incoming);

        assert_eq!(merged.len(), 4);
        assert_eq!(merged[1].tool_calls[0].id, "call-1");
        assert_eq!(merged[2].tool_results[0].tool_call_id, "call-1");
    }

    #[test]
    fn authoritative_sync_drops_provider_parts_after_an_assistant_edit() {
        let existing = vec![ChatMessage {
            id: 7,
            role: Role::Assistant,
            content: "old answer".into(),
            parts: vec![ChatContentPart::Thinking {
                thinking: "old reasoning".into(),
                signature: "old-signature".into(),
            }],
            tool_calls: vec![],
            tool_results: vec![],
            created_at: None,
        }];
        let incoming = vec![ChatMessage {
            id: 0,
            role: Role::Assistant,
            content: "edited answer".into(),
            parts: vec![],
            tool_calls: vec![],
            tool_results: vec![],
            created_at: None,
        }];

        let merged = super::merge_provider_parts(&existing, &incoming);

        assert!(merged[0].parts.is_empty());
    }

    #[test]
    fn authoritative_sync_matches_repeated_visible_messages_in_order() {
        let existing = vec![
            ChatMessage {
                id: 1,
                role: Role::User,
                content: "repeat".into(),
                parts: vec![ChatContentPart::Text {
                    text: "repeat".into(),
                }],
                tool_calls: vec![],
                tool_results: vec![],
                created_at: None,
            },
            ChatMessage {
                id: 2,
                role: Role::Assistant,
                content: "same answer".into(),
                parts: vec![
                    ChatContentPart::Thinking {
                        thinking: "first".into(),
                        signature: "sig-1".into(),
                    },
                    ChatContentPart::Text {
                        text: "same answer".into(),
                    },
                ],
                tool_calls: vec![],
                tool_results: vec![],
                created_at: None,
            },
            ChatMessage {
                id: 3,
                role: Role::User,
                content: "repeat".into(),
                parts: vec![ChatContentPart::Text {
                    text: "repeat".into(),
                }],
                tool_calls: vec![],
                tool_results: vec![],
                created_at: None,
            },
            ChatMessage {
                id: 4,
                role: Role::Assistant,
                content: "same answer".into(),
                parts: vec![
                    ChatContentPart::Thinking {
                        thinking: "second".into(),
                        signature: "sig-2".into(),
                    },
                    ChatContentPart::Text {
                        text: "same answer".into(),
                    },
                ],
                tool_calls: vec![],
                tool_results: vec![],
                created_at: None,
            },
        ];
        let incoming = existing
            .iter()
            .map(|message| ChatMessage {
                id: 0,
                role: message.role,
                content: message.content.clone(),
                parts: super::visible_parts(message),
                tool_calls: vec![],
                tool_results: vec![],
                created_at: None,
            })
            .collect::<Vec<_>>();

        let merged = super::merge_provider_parts(&existing, &incoming);

        assert!(matches!(
            &merged[1].parts[0],
            ChatContentPart::Thinking { signature, .. } if signature == "sig-1"
        ));
        assert!(matches!(
            &merged[3].parts[0],
            ChatContentPart::Thinking { signature, .. } if signature == "sig-2"
        ));
    }

    #[test]
    fn authoritative_sync_does_not_reuse_metadata_for_changed_visible_images() {
        let existing = vec![ChatMessage {
            id: 1,
            role: Role::Assistant,
            content: "image answer".into(),
            parts: vec![
                ChatContentPart::Thinking {
                    thinking: "old".into(),
                    signature: "old-signature".into(),
                },
                ChatContentPart::Text {
                    text: "image answer".into(),
                },
                ChatContentPart::ImageUrl {
                    image_url: worldbase_protocol::types::ImageUrl {
                        url: "data:image/png;base64,old".into(),
                    },
                },
            ],
            tool_calls: vec![],
            tool_results: vec![],
            created_at: None,
        }];
        let incoming = vec![ChatMessage {
            id: 0,
            role: Role::Assistant,
            content: "image answer".into(),
            parts: vec![
                ChatContentPart::Text {
                    text: "image answer".into(),
                },
                ChatContentPart::ImageUrl {
                    image_url: worldbase_protocol::types::ImageUrl {
                        url: "data:image/png;base64,new".into(),
                    },
                },
            ],
            tool_calls: vec![],
            tool_results: vec![],
            created_at: None,
        }];

        let merged = super::merge_provider_parts(&existing, &incoming);

        assert!(merged[0]
            .parts
            .iter()
            .all(|part| { !matches!(part, ChatContentPart::Thinking { .. }) }));
    }

    #[test]
    fn authoritative_sync_drops_trailing_hidden_tool_rows_after_a_branch_edit() {
        let existing = vec![
            ChatMessage {
                id: 1,
                role: Role::User,
                content: "question".into(),
                parts: vec![ChatContentPart::Text {
                    text: "question".into(),
                }],
                tool_calls: vec![],
                tool_results: vec![],
                created_at: None,
            },
            ChatMessage {
                id: 2,
                role: Role::Assistant,
                content: String::new(),
                parts: vec![],
                tool_calls: vec![worldbase_protocol::types::ToolCallRecord {
                    id: "call-1".into(),
                    name: "read_file".into(),
                    args: serde_json::json!({ "path": "a.txt" }),
                }],
                tool_results: vec![],
                created_at: None,
            },
            ChatMessage {
                id: 3,
                role: Role::User,
                content: String::new(),
                parts: vec![],
                tool_calls: vec![],
                tool_results: vec![worldbase_protocol::types::ToolResultRecord {
                    tool_call_id: "call-1".into(),
                    name: "read_file".into(),
                    content: "old result".into(),
                    is_error: false,
                }],
                created_at: None,
            },
        ];
        let incoming = vec![ChatMessage {
            id: 0,
            role: Role::User,
            content: "question".into(),
            parts: vec![ChatContentPart::Text {
                text: "question".into(),
            }],
            tool_calls: vec![],
            tool_results: vec![],
            created_at: None,
        }];

        let merged = super::merge_provider_parts(&existing, &incoming);

        assert_eq!(merged.len(), 1);
        assert!(merged[0].tool_calls.is_empty());
        assert!(merged[0].tool_results.is_empty());
    }
}
