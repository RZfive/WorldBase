//! Hub：harness 全部服务的编排中心。一个进程一个 Hub；
//! stdio / WS / in-process transport 共享同一实例与同一 dispatcher。

use anyhow::Result;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use worldbase_mcp_client::McpManager;
use worldbase_memory::Store;
use worldbase_protocol::event::StreamChannel;
use worldbase_protocol::types::{Capabilities, ChatRunContext, ProviderConfig};
use worldbase_scheduler::Scheduler;
use worldbase_skills::SkillRegistry;
use worldbase_tools::{filter_tools, Tool, ToolServices};

static TOOL_RESULT_CLEANUP_ONCE: std::sync::Once = std::sync::Once::new();

/// 一次 chat 运行的句柄（用于 abort 与事件续传）。
pub struct RunHandle {
    pub conversation_id: String,
    pub abort: CancellationToken,
    pub capabilities: Capabilities,
    /// 宿主是否可应答权限询问（交互式宿主 = true）。
    pub interactive: bool,
    /// Explicit per-run Agent selection from `chat.send`. This takes
    /// precedence over the conversation's persisted default Agent.
    pub agent_id: Option<String>,
    /// 本轮对话的供应商/模型覆盖（客户端快速切换）。
    pub provider_id: Option<String>,
    pub model: Option<String>,
    /// Host-provided execution context for this stream. It must never bleed
    /// into a concurrent conversation, so it lives on the run handle instead
    /// of Hub-wide mutable state.
    pub context: ChatRunContext,
    /// Present only for a Rust-native group member. The collaboration tool
    /// implementations live in core, while tools only see this trait object.
    pub group_collaboration: Option<Arc<dyn worldbase_tools::GroupCollaborationRuntime>>,
    /// Internal depth for Rust-native `spawn_subagents` recursion. Root runs
    /// start at zero and spawned children are capped in core.
    pub subagent_nesting_depth: u8,
}

pub struct Hub {
    pub workspace: PathBuf,
    pub store: Arc<Store>,
    /// 共享记忆 embedding 队列（design §6.4）。配置由 chat 请求注入，
    /// 后台循环在此进程内消费共享的 `embedding_jobs` 表。
    pub memory_queue: Arc<worldbase_memory::MemoryEmbeddingQueue>,
    pub skills: Arc<SkillRegistry>,
    pub scheduler: Arc<Scheduler>,
    pub mcp: Arc<McpManager>,
    pub projects: Arc<worldbase_project_runtime::ProjectRuntime>,
    /// 全量工具集（按连接 capabilities 过滤后暴露）。
    pub tools: Vec<Arc<dyn Tool>>,
    /// stream_id → 事件通道（含 seq 缓冲，供 resume）。
    pub streams: std::sync::Mutex<HashMap<String, Arc<StreamChannel>>>,
    /// stream_id → 运行句柄。
    pub runs: std::sync::Mutex<HashMap<String, RunHandle>>,
    /// request_id → 权限应答 sender。
    pub pending_permissions: std::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>,
    /// group 会话（内存态；黑板/轮次见 group crate）。
    pub group_sessions:
        std::sync::Mutex<HashMap<String, worldbase_protocol::types::GroupSessionMeta>>,
    /// 全局事件广播（serve/app-server 向宿主转发）。
    pub event_tx: tokio::sync::broadcast::Sender<worldbase_protocol::event::EventFrame>,
    /// 直接注入的 provider（测试/特殊部署覆盖 settings 配置）。
    pub custom_provider:
        std::sync::Mutex<Option<std::sync::Arc<dyn worldbase_providers::Provider>>>,
    /// 宿主反向请求挂起表（host.request → host.respond）。
    pub pending_host_requests:
        std::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<serde_json::Value>>>,
}

struct PendingHostRequestGuard<'a> {
    pending: &'a std::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<serde_json::Value>>>,
    request_id: String,
}

impl Drop for PendingHostRequestGuard<'_> {
    fn drop(&mut self) {
        self.pending.lock().unwrap().remove(&self.request_id);
    }
}

impl Hub {
    pub fn new(workspace: PathBuf, store: Arc<Store>) -> Result<Arc<Self>> {
        TOOL_RESULT_CLEANUP_ONCE.call_once(|| {
            let storage_dir = Store::default_dir().join("tool-results");
            match crate::tool_results::cleanup_expired_tool_results(&storage_dir) {
                Ok(removed) if removed > 0 => {
                    tracing::info!(removed, "cleaned expired persisted tool results");
                }
                Ok(_) => {}
                Err(error) => {
                    tracing::warn!(%error, path = %storage_dir.display(), "failed to clean persisted tool results");
                }
            }
        });
        let (event_tx, _rx) = tokio::sync::broadcast::channel(4096);
        let skills = Arc::new(SkillRegistry::new(SkillRegistry::default_dirs(&workspace)));
        let scheduler = Arc::new(Scheduler::new(store.clone()));
        let memory_queue = worldbase_memory::MemoryEmbeddingQueue::new(store.clone());
        let hub = Arc::new(Self {
            workspace: workspace.clone(),
            store,
            memory_queue,
            skills,
            scheduler,
            mcp: Arc::new(McpManager::default()),
            // Electron starts the app-server with its actual `projects`
            // directory as the workspace. Project tools must use that same
            // root; resolving through Store::default_dir() would create a
            // second, invisible project catalog under WORLDBASE_HOME.
            projects: Arc::new(worldbase_project_runtime::ProjectRuntime::new(
                workspace.clone(),
            )),
            tools: worldbase_tools::builtin_tools(),
            streams: std::sync::Mutex::new(HashMap::new()),
            runs: std::sync::Mutex::new(HashMap::new()),
            pending_permissions: std::sync::Mutex::new(HashMap::new()),
            group_sessions: std::sync::Mutex::new(HashMap::new()),
            event_tx,
            custom_provider: std::sync::Mutex::new(None),
            pending_host_requests: std::sync::Mutex::new(HashMap::new()),
        });
        Ok(hub)
    }

    /// 发起宿主反向请求（ask_user / page_automation），等待 host.respond。
    pub async fn host_request(
        &self,
        stream_id: &str,
        kind: &str,
        payload: serde_json::Value,
        timeout: std::time::Duration,
    ) -> anyhow::Result<serde_json::Value> {
        use worldbase_protocol::event::EventKind;
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.pending_host_requests
            .lock()
            .unwrap()
            .insert(request_id.clone(), tx);
        // This future can be dropped when chat.abort wins a select in the
        // agent loop. Keep cleanup tied to the future's lifetime so cancelled
        // or timed-out Electron callbacks never remain in the pending map.
        let _pending_guard = PendingHostRequestGuard {
            pending: &self.pending_host_requests,
            request_id: request_id.clone(),
        };

        let frame_kind = EventKind::HostRequest {
            request_id: request_id.clone(),
            request_kind: kind.to_string(),
            payload: payload.clone(),
        };
        // Use the common publisher so direct `tool.call` host requests share
        // the same monotonic replay/deduplication contract as chat streams.
        self.emit(stream_id, frame_kind).await;

        let result = tokio::time::timeout(timeout, rx).await;
        match result {
            Ok(Ok(value)) => Ok(value),
            _ => anyhow::bail!("host request timeout or cancelled: {kind}"),
        }
    }

    /// 宿主应答入口（host.respond）。
    pub fn host_respond(&self, request_id: &str, result: serde_json::Value) -> bool {
        if let Some(tx) = self
            .pending_host_requests
            .lock()
            .unwrap()
            .remove(request_id)
        {
            let _ = tx.send(result);
            true
        } else {
            false
        }
    }

    /// 供应商集合（settings."providers"，缺省空配置）。
    pub fn providers_config(&self) -> worldbase_protocol::types::ProvidersConfig {
        self.store
            .get_setting("providers")
            .ok()
            .flatten()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default()
    }

    /// 解析当前生效的 provider 配置：active entry > 环境变量 > mock。
    pub fn active_provider_entry(&self) -> Option<worldbase_protocol::types::ProviderEntry> {
        let cfg = self.providers_config();
        let active_id = cfg.active_provider_id.clone();
        let found = cfg
            .providers
            .iter()
            .find(|p| Some(&p.id) == active_id.as_ref())
            .cloned();
        found.or_else(|| cfg.providers.into_iter().next())
    }

    /// 注入自定义 provider（优先生效）。
    pub fn set_custom_provider(&self, provider: std::sync::Arc<dyn worldbase_providers::Provider>) {
        *self.custom_provider.lock().unwrap() = Some(provider);
    }

    /// 解析当前生效的 provider。
    pub fn provider(&self) -> anyhow::Result<std::sync::Arc<dyn worldbase_providers::Provider>> {
        if let Some(p) = self.custom_provider.lock().unwrap().clone() {
            return Ok(p);
        }
        if let Some(entry) = self.active_provider_entry() {
            return worldbase_providers::create_provider_from_entry(&entry);
        }
        let cfg = self.provider_config();
        worldbase_providers::create_provider(&cfg)
    }

    /// 按显式 provider/model 解析（客户端快速切换优先级最高）。
    pub fn provider_by_ids(
        &self,
        provider_id: Option<&str>,
        model: Option<&str>,
    ) -> anyhow::Result<(
        std::sync::Arc<dyn worldbase_providers::Provider>,
        Option<worldbase_protocol::types::ProviderEntry>,
        Option<String>,
    )> {
        if provider_id.is_none() && model.is_none() {
            return self.provider_for_agent(None);
        }
        let providers = self.providers_config();
        let entry = provider_id
            .and_then(|pid| providers.providers.iter().find(|p| p.id == pid))
            .cloned()
            .or_else(|| self.active_provider_entry());
        match entry {
            Some(mut entry) => {
                if let Some(m) = model {
                    if !m.is_empty() {
                        entry.active_model = m.to_string();
                    }
                }
                let model = Some(entry.active_model.clone());
                Ok((
                    worldbase_providers::create_provider_from_entry(&entry)?,
                    Some(entry),
                    model,
                ))
            }
            None => {
                let (p, entry, model) = self.provider_for_agent(None)?;
                Ok((p, entry, model))
            }
        }
    }

    /// 按会话解析 provider（agent 绑定的供应商/模型优先）。返回 (provider, entry, model)。
    pub fn provider_for_agent(
        &self,
        agent: Option<&worldbase_protocol::types::AgentDefinition>,
    ) -> anyhow::Result<(
        std::sync::Arc<dyn worldbase_providers::Provider>,
        Option<worldbase_protocol::types::ProviderEntry>,
        Option<String>,
    )> {
        if let Some(p) = self.custom_provider.lock().unwrap().clone() {
            return Ok((p, None, agent.and_then(|a| a.model_id.clone())));
        }
        let providers = self.providers_config();
        if let Some(agent) = agent {
            if let Some(pid) = &agent.provider_id {
                if let Some(entry) = providers.providers.iter().find(|p| &p.id == pid) {
                    let mut entry = entry.clone();
                    if let Some(model) = &agent.model_id {
                        if !model.is_empty() {
                            entry.active_model = model.clone();
                        }
                    }
                    let model = Some(entry.active_model.clone());
                    return Ok((
                        worldbase_providers::create_provider_from_entry(&entry)?,
                        Some(entry),
                        model,
                    ));
                }
            }
        }
        let entry = self.active_provider_entry();
        let model = entry.as_ref().map(|e| e.active_model.clone());
        let provider = match &entry {
            Some(e) => worldbase_providers::create_provider_from_entry(e)?,
            None => {
                let cfg = self.provider_config();
                worldbase_providers::create_provider(&cfg)?
            }
        };
        Ok((provider, entry, model))
    }

    /// 模型单价（每 1M tokens）：输入、输出、缓存读取，按 entry 内模型匹配。
    pub fn model_prices(
        &self,
        entry: Option<&worldbase_protocol::types::ProviderEntry>,
        model: &str,
    ) -> (f64, f64, f64) {
        let Some(entry) = entry else {
            return (0.0, 0.0, 0.0);
        };
        for m in &entry.models {
            if m.id == model {
                return (m.input_price, m.output_price, m.cache_read_price);
            }
        }
        (0.0, 0.0, 0.0)
    }

    pub fn services(self: &Arc<Self>) -> ToolServices {
        let mut services = self.services_for_run(None, None, None);
        // Direct `tool.call` requests are outside an agent-run context. Give
        // them the same local-user memory scope as a normal default chat;
        // scoped chat runs replace this with their resolved policy.
        services.memory_scopes = vec![worldbase_protocol::types::MemorySearchScopeEntry {
            scope_type: "user".into(),
            scope_id: "local-user".into(),
        }];
        services
    }

    /// Build isolated tool services for a stream. The managed project catalog
    /// always remains rooted at `workspace`; Electron's folder workspace is a
    /// separate optional root used only by its `*_workspace_*` tool family.
    pub fn services_for_run(
        self: &Arc<Self>,
        folder_workspace: Option<std::path::PathBuf>,
        target_project_id: Option<String>,
        allowed_mcp_server_ids: Option<Vec<String>>,
    ) -> ToolServices {
        let host = worldbase_tools::HostBridge::new();
        let hub_arc: std::sync::Arc<Hub> = self.clone();
        let channel: std::sync::Arc<dyn worldbase_tools::host_bridge::HostChannel> = hub_arc;
        host.set(channel);
        // Electron treats an omitted selection and an empty selection as
        // unrestricted. Normalize here as well so direct app-server callers
        // cannot accidentally get a stricter MCP policy than the TS harness.
        let allowed_mcp_server_ids = allowed_mcp_server_ids.and_then(|server_ids| {
            let server_ids: std::collections::HashSet<String> = server_ids
                .into_iter()
                .map(|server_id| server_id.trim().to_string())
                .filter(|server_id| !server_id.is_empty())
                .collect();
            (!server_ids.is_empty()).then(|| std::sync::Arc::new(server_ids))
        });
        ToolServices {
            workspace: self.workspace.clone(),
            folder_workspace,
            target_project_id,
            allowed_mcp_server_ids,
            plan_goal: std::sync::Arc::new(std::sync::Mutex::new(None)),
            todo_items: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
            read_files: std::sync::Arc::new(
                std::sync::Mutex::new(std::collections::HashSet::new()),
            ),
            visible_tool_catalog: None,
            store: self.store.clone(),
            memory_queue: Some(self.memory_queue.clone()),
            memory_scopes: Vec::new(),
            skills: self.skills.clone(),
            scheduler: self.scheduler.clone(),
            mcp: self.mcp.clone(),
            projects: self.projects.clone(),
            group_collaboration: None,
            subagent_runtime: None,
            host: std::sync::Arc::new(host),
            current_stream: std::sync::Arc::new(std::sync::Mutex::new(String::new())),
            abort: None,
        }
    }

    /// 统一事件发布：写流通道（供 resume）+ 全局广播（供宿主转发）。
    pub async fn emit(&self, stream_id: &str, kind: worldbase_protocol::event::EventKind) {
        let channel = {
            let channels = self.streams.lock().unwrap();
            channels.get(stream_id).cloned()
        };
        let channel = match channel {
            Some(ch) => ch,
            None => self.register_stream(stream_id),
        };
        let seq = channel.publish(stream_id, kind.clone()).await;
        let _ = self.event_tx.send(worldbase_protocol::event::EventFrame {
            stream_id: stream_id.to_string(),
            seq,
            ts: worldbase_protocol::event::now_rfc3339(),
            kind,
        });
    }

    /// Register a stream, preserving an existing channel when nested work
    /// deliberately shares its parent's stream ID (for example a native group
    /// member). Replacing that channel loses subscribers and buffered events.
    pub fn register_stream(&self, stream_id: &str) -> Arc<StreamChannel> {
        let mut streams = self.streams.lock().unwrap();
        streams
            .entry(stream_id.to_string())
            .or_insert_with(|| Arc::new(StreamChannel::new()))
            .clone()
    }

    /// Remove a stream that was created for a one-shot request (for example a
    /// direct document host callback).  Chat/group streams intentionally stay
    /// registered so `chat.resume` can replay their buffered events.
    pub fn remove_stream(&self, stream_id: &str) -> bool {
        self.streams.lock().unwrap().remove(stream_id).is_some()
    }

    /// 解析当前 provider 配置：settings."provider" > 环境变量 > mock。
    pub fn provider_config(&self) -> ProviderConfig {
        if let Ok(Some(cfg)) = self.store.get_setting("provider") {
            if let Ok(cfg) = serde_json::from_value::<ProviderConfig>(cfg) {
                return cfg;
            }
        }
        // 环境变量便捷配置
        if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
            if !key.is_empty() {
                return ProviderConfig {
                    kind: "anthropic".into(),
                    model: std::env::var("WORLDBASE_MODEL")
                        .unwrap_or_else(|_| "claude-sonnet-4-20250514".into()),
                    api_key: key,
                    base_url: std::env::var("ANTHROPIC_BASE_URL").ok(),
                };
            }
        }
        if let Ok(key) = std::env::var("OPENAI_API_KEY") {
            if !key.is_empty() {
                return ProviderConfig {
                    kind: "openai".into(),
                    model: std::env::var("WORLDBASE_MODEL").unwrap_or_else(|_| "gpt-4o".into()),
                    api_key: key,
                    base_url: std::env::var("OPENAI_BASE_URL").ok(),
                };
            }
        }
        ProviderConfig::default()
    }

    /// 按 capabilities 过滤工具集。
    pub fn tools_for(&self, caps: &Capabilities) -> Vec<Arc<dyn Tool>> {
        filter_tools(&self.tools, caps)
    }

    /// 启动后台任务：scheduler 与项目网关循环。
    pub fn start_background(self: &Arc<Self>) {
        let hub = self.clone();
        tokio::spawn(async move {
            let hub_for_due = hub.clone();
            let on_due: worldbase_scheduler::OnDue = Arc::new(move |entry| {
                let hub = hub_for_due.clone();
                Box::pin(async move {
                    let active_skill_contents = entry
                        .selected_skill_ids
                        .iter()
                        .filter_map(|skill_id| hub.skills.get(skill_id).ok().flatten())
                        .map(|skill| skill.instructions)
                        .filter(|instructions| !instructions.trim().is_empty())
                        .collect();
                    let context = worldbase_protocol::types::ChatRunContext {
                        active_skill_contents,
                        // Electron treats an empty saved selection as the
                        // unrestricted default; a non-empty list narrows it.
                        allowed_mcp_server_ids: Some(entry.selected_mcp_server_ids.clone()),
                        ..Default::default()
                    };
                    crate::agent::run_scheduled_task_with_context(
                        hub,
                        &entry.id,
                        &entry.name,
                        &entry.task,
                        context,
                    )
                    .await
                })
            });
            if let Err(e) = hub.scheduler.run_loop(on_due).await {
                tracing::warn!(error = %e, "scheduler loop exited");
            }
        });

        // Project processes are Rust-owned while the Electron switch selects
        // this harness. Mirror AppGateway's 30-second recovery cadence here
        // instead of tying recovery to a renderer/system-status query.
        let hub = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            // `interval` ticks immediately; consume that first tick to match
            // Electron's setInterval behavior, whose first pass is delayed.
            interval.tick().await;
            loop {
                interval.tick().await;
                if let Err(error) = hub.projects.gateway_health_check_for_ui().await {
                    tracing::warn!(error = %error, "project gateway health check failed");
                }
            }
        });
    }
}

/// Hub → HostChannel：把反向请求桥给 tools 层。
#[async_trait::async_trait]
impl worldbase_tools::host_bridge::HostChannel for Hub {
    async fn request(
        &self,
        stream_id: &str,
        kind: &str,
        payload: serde_json::Value,
        timeout: std::time::Duration,
    ) -> anyhow::Result<serde_json::Value> {
        Hub::host_request(self, stream_id, kind, payload, timeout).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_server_selection_matches_node_empty_list_semantics() {
        let workspace = std::env::temp_dir().join(format!(
            "worldbase-hub-mcp-policy-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&workspace).unwrap();
        let store = Arc::new(
            Store::open(&workspace.join("app.sqlite")).expect("open MCP policy test store"),
        );
        let hub = Hub::new(workspace.clone(), store).expect("create MCP policy test hub");

        assert!(hub
            .services_for_run(None, None, None)
            .allowed_mcp_server_ids()
            .is_none());
        assert!(hub
            .services_for_run(None, None, Some(vec![]))
            .allowed_mcp_server_ids()
            .is_none());
        assert!(hub
            .services_for_run(None, None, Some(vec![" ".into(), "\t".into()]))
            .allowed_mcp_server_ids()
            .is_none());

        let restricted = hub
            .services_for_run(
                None,
                None,
                Some(vec![" docs ".into(), "search".into(), "docs".into()]),
            )
            .allowed_mcp_server_ids()
            .expect("non-empty selection must restrict MCP servers");
        assert_eq!(
            restricted,
            ["docs".to_string(), "search".to_string()]
                .into_iter()
                .collect()
        );

        drop(hub);
        let _ = std::fs::remove_dir_all(workspace);
    }
}
