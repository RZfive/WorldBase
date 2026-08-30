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
            excludes: vec!["subprocess".into(), "port_binding".into(), "webhook_receiver".into()],
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCallRecord>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_results: Vec<ToolResultRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
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
        Self { kind: "mock".into(), model: "mock-1".into(), api_key: String::new(), base_url: None }
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
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
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
    pub folder: Option<String>,
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub search: Option<String>,
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
    pub tasks: Vec<String>,
    #[serde(default)]
    pub decisions: Vec<String>,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
    #[serde(default)]
    pub open_questions: Vec<String>,
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
    #[serde(default)]
    pub rounds: Vec<GroupRoundRecord>,
    /// 协调者成员名（默认第一个成员）。
    #[serde(default)]
    pub coordinator: Option<String>,
    /// HITL 注入队列（下一轮发言时进入上下文）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending_injections: Vec<String>,
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
