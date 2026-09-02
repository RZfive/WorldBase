//! 协议核心数据类型：能力协商、会话、消息、工具描述、设置。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 宿主握手声明。harness 据此过滤工具集与方法访问。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// 如 desktop / mobile-ios / mobile-android / cli / server。
    pub platform: String,
    /// 宿主提供的能力，如 subprocess / port_binding / webview / webhook_receiver。
    #[serde(default)]
    pub features: Vec<String>,
    /// 显式排除项（移动端在握手时排除 harness 中存在的桌面能力）。
    #[serde(default)]
    pub excludes: Vec<String>,
}

impl Capabilities {
    pub fn desktop() -> Self {
        Self {
            platform: "desktop".into(),
            features: vec![
                "subprocess".into(),
                "port_binding".into(),
                "webhook_receiver".into(),
                "webview_automation".into(),
                "interactive".into(),
            ],
            excludes: vec![],
        }
    }

    pub fn mobile(platform: &str) -> Self {
        Self {
            platform: platform.into(),
            features: vec![
                "lightweight_runtime".into(),
                "webview_automation".into(),
                // 移动端 UI 可应答权限询问 / ask_user / 页面自动化
                "interactive".into(),
            ],
            excludes: vec![
                "subprocess".into(),
                "port_binding".into(),
                "webhook_receiver".into(),
            ],
        }
    }

    pub fn cli() -> Self {
        Self::desktop()
    }

    pub fn has(&self, feature: &str) -> bool {
        self.features.iter().any(|f| f == feature)
    }

    pub fn excluded(&self, feature: &str) -> bool {
        self.excludes.iter().any(|f| f == feature)
    }
}

/// 握手请求参数。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    #[serde(default = "default_protocol_version")]
    pub protocol_version: String,
    pub capabilities: Capabilities,
}

fn default_protocol_version() -> String {
    crate::PROTOCOL_VERSION.into()
}

/// 握手响应。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub protocol_version: String,
    pub server_version: String,
    /// 能力协商后宿主可用的工具名。
    pub available_tools: Vec<ToolDescriptor>,
    /// 协商后宿主可用的方法域。
    pub available_domains: Vec<String>,
}

/// 工具描述（对齐 LLM function calling schema）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    /// 工具所属平台域：desktop 工具在移动端握手时被过滤。
    #[serde(default)]
    pub domain: String,
    /// 默认权限策略：allow / ask / deny。
    #[serde(default = "default_permission")]
    pub permission: String,
}

fn default_permission() -> String {
    "allow".into()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    /// 数据库行 id（分叉/编辑锚点；0 表示未落库）。
    #[serde(default)]
    pub id: i64,
    pub role: Role,
    /// 纯文本视图（渲染用）；工具调用见 `tool_calls` / `tool_results`。
    pub content: String,
    /// 原始多模态内容块。`content` 始终保留可检索的纯文本视图，`parts` 则保留
    /// 图片等提供商需要的 payload，避免 Electron -> Rust 同步时丢失附件。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<ChatContentPart>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCallRecord>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_results: Vec<ToolResultRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

/// 与 Electron 的 `MessageContent` 对齐的可持久化消息内容块。
///
/// 当前公开聊天协议支持文本和 data/HTTP image URL；未知块由 Electron 在发送前
/// 归一为文本附件摘要，确保旧客户端仍能与新 app-server 互通。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatContentPart {
    Text { text: String },
    ImageUrl { image_url: ImageUrl },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageUrl {
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallRecord {
    pub id: String,
    pub name: String,
    pub args: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultRecord {
    pub tool_call_id: String,
    pub name: String,
    pub content: String,
    #[serde(default)]
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMeta {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub message_count: i64,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forked_from_conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forked_from_message_id: Option<i64>,
    #[serde(default)]
    pub fork_depth: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationDetail {
    #[serde(flatten)]
    pub meta: ConversationMeta,
    pub messages: Vec<ChatMessage>,
}

/// Electron → Rust conversation history synchronization payload.
/// The current user turn is excluded so `chat.send` appends it exactly once.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSyncParams {
    pub id: String,
    #[serde(default = "default_conversation_title")]
    pub title: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub messages: Vec<ChatMessage>,
}

fn default_conversation_title() -> String {
    "新对话".into()
}

/// chat.send 参数。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSendParams {
    pub conversation_id: String,
    pub text: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    /// 本条消息使用的供应商覆盖（客户端快速切换）。
    #[serde(default)]
    pub provider_id: Option<String>,
    /// 本条消息使用的模型覆盖。
    #[serde(default)]
    pub model: Option<String>,
    /// Structured content for the pending user message. `text` remains the
    /// canonical plain-text projection for storage/search and old clients.
    #[serde(default)]
    pub content_parts: Vec<ChatContentPart>,
    #[serde(flatten)]
    pub context: ChatRunContext,
}

/// Ephemeral execution context passed by an Electron host for one agent run.
/// It is intentionally separate from the persisted conversation and agent
/// definition: settings, group state and a selected folder can change between
/// turns without mutating the reusable agent record.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChatRunContext {
    /// Per-run prompt additions supplied by Electron's agent/group/memory
    /// context. They are deliberately run-scoped and never persisted as an
    /// agent's base persona.
    #[serde(default)]
    pub system_prompt_sections: Vec<String>,
    #[serde(default)]
    pub active_skill_contents: Vec<String>,
    /// Electron agent policy. An empty allow list means all tools; deny always
    /// wins. Custom descriptors are host-executed domain tools.
    #[serde(default)]
    pub allowed_tool_names: Vec<String>,
    #[serde(default)]
    pub denied_tool_names: Vec<String>,
    #[serde(default)]
    pub custom_tools: Vec<ToolDescriptor>,
    /// The selected folder workspace only affects workspace tools. Managed
    /// project tools continue resolving `project_id` in the app project's root.
    #[serde(default)]
    pub workspace_root: Option<String>,
    #[serde(default)]
    pub target_project_id: Option<String>,
    /// Restricts this run to the Electron MCP server IDs explicitly selected
    /// by the caller. `None` means every enabled configured server; an
    /// explicit empty list deliberately exposes no MCP server.
    #[serde(default)]
    pub allowed_mcp_server_ids: Option<Vec<String>>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub temperature: Option<f32>,
    /// Electron can enable plan mode before a run starts. Rust owns the
    /// execution-time guard so stale tool schemas and MCP calls cannot bypass
    /// the plan restriction.
    #[serde(default)]
    pub plan_mode_active: bool,
    /// Per-run dollar (or configured currency) cap supplied by Electron.
    /// Rust checks this after every completed provider call before it starts
    /// another agent-loop iteration.
    #[serde(default)]
    pub budget_limit: Option<f64>,
    /// Rust-owned long-term memory scopes for this run.  Electron supplies
    /// the resolved IDs so Rust can build the prompt without consulting the
    /// TypeScript memory store.
    #[serde(default)]
    pub memory_scopes: Vec<MemoryScopeRef>,
    /// The current user message used for scoped memory retrieval.
    #[serde(default)]
    pub memory_query: Option<String>,
}

/// A concrete memory scope selected for one agent run.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MemoryScopeRef {
    pub scope_type: String,
    pub scope_id: String,
}

/// chat.send 返回：流 id，事件经通知下发。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSendResult {
    pub stream_id: String,
    /// 已落库的 user 消息 id（seq 0 事件）。
    pub user_message_seq: u64,
}

/// chat.resume 参数：断线重连后从 afterSeq 之后续传事件。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatResumeParams {
    pub stream_id: String,
    pub after_seq: i64,
}

/// chat.abort 参数。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAbortParams {
    #[serde(default)]
    pub stream_id: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<String>,
}

/// 权限询问请求（harness → 宿主 反向请求 params）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub request_id: String,
    pub tool_name: String,
    pub args_summary: String,
}

/// 宿主对权限询问的应答。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDecision {
    pub request_id: String,
    pub allow: bool,
}

/// 设置项（KV）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingEntry {
    pub key: String,
    pub value: Value,
}

/// provider 配置（settings 中 provider.* 键）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    /// anthropic / openai / mock（由 api_protocol 解析）。
    pub kind: String,
    pub model: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub base_url: Option<String>,
}

impl Default for ProviderConfig {
    fn default() -> Self {
        // 无 key 时用 mock provider，保证 harness 全链路可运行、可测试。
        Self {
            kind: "mock".into(),
            model: "mock-1".into(),
            api_key: String::new(),
            base_url: None,
        }
    }
}

/// 供应商条目（对齐桌面端 AIProvider，移动端"我的→供应商"管理）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    /// "" (auto) / "openai" / "anthropic"。auto：baseUrl 含 anthropic → anthropic 协议。
    #[serde(default)]
    pub api_protocol: String,
    #[serde(default)]
    pub models: Vec<ModelInfo>,
    #[serde(default)]
    pub active_model: String,
    /// 0.0–2.0，缺省由 provider 决定。
    #[serde(default)]
    pub temperature: Option<f32>,
    /// 生图能力（OpenAI images 接口）。
    #[serde(default)]
    pub image_generation: bool,
}

/// 模型信息（对齐桌面端模型设置：上下文窗口 + 单价）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    /// 上下文窗口（K tokens），0 表示未知。
    #[serde(default)]
    pub context_window_k: u32,
    /// 输入单价（元或美元 / 1M tokens）。
    #[serde(default)]
    pub input_price: f64,
    /// 输出单价（/ 1M tokens）。
    #[serde(default)]
    pub output_price: f64,
    /// Cached-input price (/ 1M tokens), when the provider reports it.
    #[serde(default)]
    pub cache_read_price: f64,
    /// 该模型支持图片生成（OpenAI images 接口）。
    #[serde(default)]
    pub image_generation: bool,
    /// 该模型支持图片编辑（参考图输入）。
    #[serde(default)]
    pub image_editing: bool,
}

/// 供应商集合（settings."providers"）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProvidersConfig {
    #[serde(default)]
    pub providers: Vec<ProviderEntry>,
    #[serde(default)]
    pub active_provider_id: Option<String>,
}

/// Agent 定义（对齐桌面 AgentDefinition 的移动子集）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinition {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub description: String,
    /// 人设/系统提示词。
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub model_id: Option<String>,
    #[serde(default)]
    pub skill_ids: Vec<String>,
    #[serde(default = "default_agent_reasoning_strength")]
    pub reasoning_strength: String,
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    #[serde(default)]
    pub denied_tools: Vec<String>,
    #[serde(default = "default_agent_memory_scopes")]
    pub memory_scopes: Vec<String>,
    #[serde(default)]
    pub memory_write_policy: AgentMemoryWritePolicy,
    #[serde(default)]
    pub auto_reply_policy: AgentAutoReplyPolicy,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

fn default_agent_reasoning_strength() -> String {
    "medium".into()
}

fn default_agent_memory_scopes() -> Vec<String> {
    vec!["user".into(), "agent".into(), "project".into()]
}

/// Memory write permissions attached to an Agent Workspace agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMemoryWritePolicy {
    #[serde(default = "default_true")]
    pub allow_user_traits: bool,
    #[serde(default = "default_true")]
    pub allow_agent_skills: bool,
    #[serde(default = "default_true")]
    pub allow_steps: bool,
    #[serde(default = "default_true")]
    pub allow_knowledge: bool,
}

impl Default for AgentMemoryWritePolicy {
    fn default() -> Self {
        Self {
            allow_user_traits: true,
            allow_agent_skills: true,
            allow_steps: true,
            allow_knowledge: true,
        }
    }
}

/// Auto-reply policy used by channel/group routing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAutoReplyPolicy {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub require_mention: bool,
}

impl Default for AgentAutoReplyPolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            require_mention: true,
        }
    }
}

fn default_true() -> bool {
    true
}

/// Durable Agent Workspace group definition.  This is intentionally kept
/// separate from [`GroupSessionMeta`], which represents a live collaboration
/// run.  The shape mirrors Electron's `AgentGroupDefinition` so the settings
/// IPC can switch ownership without converting through the session model.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGroupDefinition {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub coordinator_agent_id: String,
    #[serde(default)]
    pub member_agent_ids: Vec<String>,
    #[serde(default = "default_agent_group_max_rounds")]
    pub max_rounds: u32,
    #[serde(default = "default_agent_group_parallel_workers")]
    pub max_parallel_workers: u32,
    #[serde(default)]
    pub shared_memory_scopes: Vec<String>,
    #[serde(default = "default_agent_group_visibility")]
    pub visibility: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

fn default_agent_group_max_rounds() -> u32 {
    2
}

fn default_agent_group_parallel_workers() -> u32 {
    2
}

fn default_agent_group_visibility() -> String {
    "summary_only".to_string()
}

/// 会话分叉/编辑请求（对齐桌面 message-branching）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkParams {
    pub conversation_id: String,
    /// 锚点消息 id（user 消息）。
    pub message_id: i64,
    /// 编辑模式下的新文本。
    #[serde(default)]
    pub new_text: Option<String>,
    /// "fork"（默认，安全分叉）| "inplace"（截断原会话，破坏性）。
    #[serde(default)]
    pub mode: String,
}

/// 分叉结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkResult {
    /// fork 模式返回新会话 id；inplace 返回原会话 id。
    pub conversation_id: String,
    pub truncated: i64,
}

/// 图像生成任务/条目（对齐桌面 image-studio 精简版）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageEntry {
    pub id: String,
    pub prompt: String,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub model: String,
    /// 服务端文件名，GET /studio/{id} 取图。
    pub file: String,
    pub created_at: String,
    #[serde(default)]
    pub folder: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub meta: serde_json::Value,
}

/// 图库查询参数。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImageQuery {
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: Option<u32>,
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub tag: Option<String>,
    /// All requested tags must be present. `tag` is retained as the compact
    /// legacy spelling used by the original Studio RPC.
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub search: Option<String>,
}

/// Rust-owned paginated image-library result. The Electron renderer maps this
/// to its URL-bearing view type; byte serving remains a host protocol concern.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImagePage {
    pub images: Vec<ImageEntry>,
    pub total: u32,
    #[serde(default)]
    pub next_offset: Option<u32>,
}

/// Folder metadata including image IDs suitable for host-generated covers.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImageFolder {
    pub name: String,
    pub count: u32,
    #[serde(default)]
    pub cover_image_ids: Vec<String>,
}

/// 轻应用（Agent 生成的单页应用）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LightApp {
    pub id: String,
    pub name: String,
    pub created_at: String,
}

/// 用量统计条目。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageEntry {
    pub id: i64,
    pub ts: String,
    #[serde(default)]
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// 成本（与单价同币种）。
    pub cost: f64,
}

/// 用量汇总（对齐桌面 UsagePanel：按日 + 按模型）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub daily: Vec<DailyUsage>,
    pub by_model: Vec<ModelUsage>,
    pub total_cost: f64,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyUsage {
    pub day: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenerateParams {
    pub prompt: String,
    /// "generate"（默认）| "edit"（输入参考图）。
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub negative_prompt: Option<String>,
    /// "1:1" | "3:2" | "2:3" | "16:9" | "9:16" | "4:3" | "3:4"
    #[serde(default)]
    pub aspect: Option<String>,
    /// Explicit pixel size (for example 1024x1024), taking precedence over
    /// aspect/resolution exactly as Electron's Image Studio does.
    #[serde(default)]
    pub size: Option<String>,
    /// "1K"（默认）| "2K" | "4K"
    #[serde(default)]
    pub resolution: Option<String>,
    /// auto（默认）| low | medium | high
    #[serde(default)]
    pub quality: Option<String>,
    /// png（默认）| jpeg | webp
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub n: Option<u32>,
    #[serde(default)]
    pub provider_id: Option<String>,
    /// 使用的模型（缺省供应商 active_model）。
    #[serde(default)]
    pub model: Option<String>,
    /// edit 模式的参考图（base64，来自图库或上传）。
    #[serde(default)]
    pub input_image_b64: Option<String>,
    /// Image Studio's native data-URL list for multi-image edits.
    #[serde(default)]
    pub input_images: Vec<String>,
    /// Optional gallery folder for generated entries.
    #[serde(default)]
    pub folder: Option<String>,
    /// Optional gallery tags for generated entries.
    #[serde(default)]
    pub tags: Vec<String>,
}

/// 群组黑板（对齐桌面 SharedBoard 六字段）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GroupBoard {
    #[serde(default)]
    pub goal: String,
    #[serde(default)]
    pub assumptions: Vec<String>,
    #[serde(default)]
    pub tasks: Vec<GroupBoardTask>,
    #[serde(default)]
    pub decisions: Vec<String>,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
    #[serde(default)]
    pub open_questions: Vec<String>,
}

/// A structured shared-board task. Electron has always treated tasks
/// differently from the board's other string lists: ownership, lifecycle and
/// a short status summary are part of the native group contract.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GroupBoardTask {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_agent_id: Option<String>,
    #[serde(default = "default_group_task_status")]
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

fn default_group_task_status() -> String {
    "todo".into()
}

/// A field-level board mutation recorded by the Rust-owned group session.
/// Keeping the original JSON payload mirrors Electron's audit log and avoids
/// flattening task updates into lossy text.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupBoardUpdate {
    pub id: String,
    pub group_id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub field: String,
    pub op: String,
    pub payload: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub at: String,
}

/// A point-to-point group consultation. It is emitted twice, once while the
/// target is running and again with its terminal status, just like Electron's
/// GroupSession message bus.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupPeerMessage {
    pub id: String,
    pub group_id: String,
    pub from_agent_id: String,
    pub from_agent_name: String,
    pub to_agent_id: String,
    pub to_agent_name: String,
    pub request: String,
    #[serde(default)]
    pub response: String,
    pub status: String,
    pub round: u32,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A direct member reply to the end user, surfaced through the parent native
/// group stream rather than being relayed by Electron's TypeScript harness.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupDirectReply {
    pub id: String,
    pub group_id: String,
    pub group_name: String,
    pub agent_id: String,
    pub agent_name: String,
    pub content: String,
    pub round: u32,
    pub endorsed: bool,
    pub at: String,
}

/// 宿主反向请求帧（harness → 宿主，宿主以 host.respond 应答）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRequest {
    pub request_id: String,
    /// ask_user / page_automation / dialog
    pub kind: String,
    pub payload: serde_json::Value,
}

/// 记忆条目。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub id: i64,
    pub content: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub created_at: String,
    #[serde(default)]
    pub score: Option<f64>,
}

/// Electron Agent Workspace memory entry.  The legacy `MemoryEntry` above is
/// retained for the `memory.add/search` tool contract; this richer shape is
/// used by the `memory.list/save/...` RPCs and maps one-to-one to Electron's
/// `memory_entries` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMemoryEntry {
    #[serde(default)]
    pub id: String,
    #[serde(default = "default_memory_scope_type")]
    pub scope_type: String,
    #[serde(default)]
    pub scope_id: String,
    #[serde(default = "default_memory_type")]
    pub memory_type: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_session_id: Option<String>,
    #[serde(default)]
    pub source_message_ids: Vec<String>,
    #[serde(default = "default_memory_score")]
    pub importance: f64,
    #[serde(default = "default_memory_score")]
    pub confidence: f64,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

fn default_memory_scope_type() -> String {
    "user".into()
}

fn default_memory_type() -> String {
    "knowledge".into()
}

fn default_memory_score() -> f64 {
    0.5
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMemorySearchOptions {
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub scopes: Vec<MemorySearchScopeEntry>,
    #[serde(default)]
    pub memory_types: Vec<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearchScopeEntry {
    pub scope_type: String,
    pub scope_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCompactionPlan {
    #[serde(default)]
    pub delete_ids: Vec<String>,
    #[serde(default)]
    pub merge_groups: Vec<MemoryMergeGroup>,
    #[serde(default)]
    pub updates: Vec<MemoryUpdatePatch>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMergeGroup {
    #[serde(default)]
    pub ids: Vec<String>,
    #[serde(default)]
    pub target_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub details: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MemoryUpdatePatch {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub details: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub importance: Option<f64>,
    #[serde(default)]
    pub confidence: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCompactionGroupResult {
    pub target_id: String,
    pub merged_ids: Vec<String>,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCompactionResult {
    pub scanned: u32,
    pub deleted: u32,
    pub removed_useless: u32,
    pub merged: u32,
    pub updated: u32,
    pub retained: u32,
    pub groups: Vec<MemoryCompactionGroupResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCompactionStatus {
    pub id: Option<String>,
    pub status: String,
    pub stage: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub scanned: u32,
    pub total_chunks: u32,
    pub completed_chunks: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<MemoryCompactionResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 技能描述。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDescriptor {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub instructions: String,
    #[serde(default)]
    pub path: String,
}

/// 定时任务。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleEntry {
    pub id: String,
    pub name: String,
    /// 标准 5 段 cron 表达式（本地时区）。
    pub cron: String,
    pub task: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub last_run_at: Option<String>,
    #[serde(default)]
    pub next_run_at: Option<String>,
}

/// 群组协作模式（对齐桌面 AgentGroupCollaborationMode 5 模式）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GroupMode {
    /// 仅协调者。
    CoordinatorOnly,
    /// 定向（@成员直达）。
    Targeted,
    /// 全员讨论。
    Discussion,
    /// 协调者规划每轮成员。
    CoordinatorDecides,
    /// 被@成员自行决定拉人。
    MentionedAgentDecides,
}

/// 群组成员（一个独立 persona 的 agent 配置）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMember {
    pub name: String,
    pub persona: String,
    /// Durable Electron agent ID. When present, Rust resolves the member's
    /// persisted persona, provider/model selection, and tool policy itself.
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub allowed_tool_names: Vec<String>,
    #[serde(default)]
    pub denied_tool_names: Vec<String>,
    #[serde(default)]
    pub provider: Option<ProviderConfig>,
}

/// 群组会话。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupSessionMeta {
    pub id: String,
    pub topic: String,
    pub mode: GroupMode,
    pub members: Vec<GroupMember>,
    pub created_at: String,
    #[serde(default)]
    pub status: String,
    /// 黑板（六字段结构化）。
    #[serde(default)]
    pub board: GroupBoard,
    /// Latest first-class board mutations, oldest first. The renderer only
    /// needs a short tail, but retaining the session log makes native group
    /// state inspectable through `group.get` as well.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub board_updates: Vec<GroupBoardUpdate>,
    #[serde(default)]
    pub rounds: Vec<GroupRoundRecord>,
    /// 协调者成员名（默认第一个成员）。
    #[serde(default)]
    pub coordinator: Option<String>,
    /// Maximum number of members that may execute at once in a round. This
    /// mirrors Electron's group setting so the Rust route owns scheduling as
    /// well as the member/tool execution itself.
    #[serde(default = "default_group_max_parallel_workers")]
    pub max_parallel_workers: usize,
    /// HITL 注入队列（下一轮发言时进入上下文）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending_injections: Vec<GroupUserInjection>,
    /// Durable members whose current round has not been finalized. This is
    /// used to validate live HITL injection targets in the Rust control plane.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub active_member_ids: Vec<String>,
}

fn default_group_max_parallel_workers() -> usize {
    2
}

/// A live user clarification for a native group. An empty target list means
/// broadcast; otherwise only matching durable member IDs receive it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupUserInjection {
    #[serde(default)]
    pub id: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub target_agent_ids: Vec<String>,
    #[serde(default)]
    pub round: u32,
    #[serde(default)]
    pub created_at: String,
    /// Internal delivery acknowledgements. They let a late live injection
    /// survive into the next round instead of being discarded merely because
    /// its target completed before the local executor observed it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub delivered_to_agent_ids: Vec<String>,
}

/// 一轮发言记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupRoundRecord {
    pub member: String,
    pub content: String,
    pub round: u32,
    pub created_at: String,
}

/// 项目（全栈 Next.js 项目运行时）状态。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub dev_server: Option<DevServerInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevServerInfo {
    pub port: u16,
    pub url: String,
    pub status: String,
    pub pid: Option<u32>,
}

/// 文档解析结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedDocument {
    pub kind: String,
    pub text: String,
    #[serde(default)]
    pub meta: Value,
}
