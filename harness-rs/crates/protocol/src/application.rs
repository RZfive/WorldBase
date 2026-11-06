//! 应用能力平台协议 DTO。
//!
//! 这些类型是 Rust catalog、provider、Electron/Flutter 管理 UI 之间的稳定
//! wire contract。所有新增字段都必须是 `#[serde(default)]`，保持 1.x 兼容。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 工具在主模型上下文中的可见策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ToolVisibility {
    /// 常驻主模型上下文。
    #[default]
    AlwaysOn,
    /// 默认不进入上下文，由 `search_tools` 按需激活。
    Discoverable,
}

/// 应用 operation 的风险等级。默认按最保守的只读处理。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityRisk {
    #[default]
    Read,
    WriteReversible,
    WriteDestructive,
    ExternalEffect,
}

impl CapabilityRisk {
    pub fn default_permission(self) -> &'static str {
        match self {
            Self::Read => "allow",
            Self::WriteReversible | Self::WriteDestructive | Self::ExternalEffect => "ask",
        }
    }
}

/// 应用来源信任等级。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TrustLevel {
    /// 随 Harness 编译/内置。
    Builtin,
    /// 用户显式信任并固定 manifest hash 的来源。
    Verified,
    /// 本地社区/第三方来源，默认需要用户启用。
    Community,
    /// 未信任的托管项目 manifest。
    #[default]
    Untrusted,
}

/// 应用 runtime 类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeKind {
    /// 进程内 Rust service / 工具。
    #[default]
    HostService,
    /// 托管项目，通过认证 loopback RPC 调用。
    ManagedProject,
    /// MCP server 适配器。
    McpServer,
    /// Electron 窄平台能力。
    ElectronHost,
    /// 受信任插件（仍通过受控 provider 执行）。
    Plugin,
}

/// 能力当前可用状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityAvailability {
    #[default]
    Available,
    Disabled,
    Unavailable,
    Starting,
}

/// 应用声明文件。内置应用在代码中构造，托管项目读取
/// `.worldbase/app-capabilities.json`。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppManifest {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub app: AppManifestApp,
    #[serde(default)]
    pub runtime: AppRuntimeManifest,
    #[serde(default)]
    pub capabilities: Vec<AppCapabilityManifest>,
    /// `"none"` 表示纯展示应用，明确没有 AI operation。
    #[serde(default)]
    pub ai_integration: Option<String>,
}

fn default_schema_version() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppManifestApp {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub platforms: Vec<String>,
    #[serde(default)]
    pub required_features: Vec<String>,
    #[serde(default)]
    pub excluded_features: Vec<String>,
    #[serde(default)]
    pub trust_level: TrustLevel,
    /// 可选的 manifest 完整性/来源签名。受信任来源可固定该值。
    #[serde(default)]
    pub signature: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppRuntimeManifest {
    #[serde(default)]
    pub kind: RuntimeKind,
    /// `on-demand` / `always` / `manual`。
    #[serde(default = "default_activation")]
    pub activation: String,
    /// capability ID，例如 `tasks.health`。不能是任意 URL/命令。
    #[serde(default)]
    pub health_check: Option<String>,
}

impl Default for AppRuntimeManifest {
    fn default() -> Self {
        Self {
            kind: RuntimeKind::HostService,
            activation: default_activation(),
            health_check: None,
        }
    }
}

fn default_activation() -> String {
    "on-demand".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppCapabilityManifest {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_object_schema")]
    pub input_schema: Value,
    #[serde(default)]
    pub output_schema: Option<Value>,
    /// 应用内部 operation ID；只能引用受信任 provider 注册表。
    #[serde(default)]
    pub operation: String,
    #[serde(default)]
    pub risk: CapabilityRisk,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub data_scopes: Vec<String>,
    #[serde(default)]
    pub side_effects: bool,
    #[serde(default)]
    pub idempotent: bool,
    #[serde(default)]
    pub deadline_ms: Option<u64>,
}

fn default_object_schema() -> Value {
    serde_json::json!({ "type": "object" })
}

/// 规范化应用记录。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationRecord {
    pub source_id: String,
    pub app_id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub trust_level: TrustLevel,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub platforms: Vec<String>,
    #[serde(default)]
    pub runtime_kind: RuntimeKind,
    #[serde(default)]
    pub capabilities: Vec<CapabilityRecord>,
    #[serde(default)]
    pub health: AppHealth,
    #[serde(default)]
    pub last_seen_at: Option<String>,
    #[serde(default)]
    pub manifest_hash: String,
    #[serde(default)]
    pub ai_ready: bool,
}

/// 规范化能力记录。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityRecord {
    pub app_id: String,
    pub capability_id: String,
    pub tool_name: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_object_schema")]
    pub input_schema: Value,
    #[serde(default)]
    pub output_schema: Option<Value>,
    #[serde(default)]
    pub risk: CapabilityRisk,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub data_scopes: Vec<String>,
    #[serde(default)]
    pub provider_ref: String,
    #[serde(default)]
    pub availability: CapabilityAvailability,
    #[serde(default)]
    pub side_effects: bool,
    #[serde(default)]
    pub idempotent: bool,
    #[serde(default)]
    pub deadline_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppHealth {
    /// `unknown` / `ready` / `starting` / `failed` / `unavailable`.
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub checked_at: Option<String>,
}

impl AppHealth {
    pub fn ready() -> Self {
        Self {
            status: "ready".into(),
            detail: None,
            checked_at: None,
        }
    }

    pub fn unknown() -> Self {
        Self {
            status: "unknown".into(),
            detail: None,
            checked_at: None,
        }
    }
}

/// 用户授权记录。授权绑定 app + capability/permission + data scope。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationGrant {
    #[serde(default)]
    pub id: String,
    pub app_id: String,
    /// 精确 capability ID 或 `*` / `invoice.*` 形式。
    #[serde(default)]
    pub capability_pattern: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub data_scope: Vec<String>,
    /// `allow` / `ask` / `deny`。
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationCallAudit {
    pub call_id: String,
    #[serde(default)]
    pub conversation_id: Option<String>,
    pub app_id: String,
    pub capability_id: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub approval_id: Option<String>,
    #[serde(default)]
    pub created_at: String,
}

/// 宿主生成并绑定到认证通道的调用上下文。模型不能填写这些字段。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CallContext {
    pub call_id: String,
    #[serde(default)]
    pub conversation_id: Option<String>,
    pub app_id: String,
    #[serde(default)]
    pub data_scope: Vec<String>,
    #[serde(default)]
    pub deadline_ms: u64,
    #[serde(default)]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLease {
    pub lease_id: String,
    pub app_id: String,
    #[serde(default)]
    pub expires_at_ms: u64,
    #[serde(default)]
    pub runtime_kind: RuntimeKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityAppRef {
    pub id: String,
    #[serde(default)]
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityRuntimeInfo {
    #[serde(default)]
    pub started_for_call: bool,
}

/// Provider 统一返回形状。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityResult {
    #[serde(default = "default_ok_status")]
    pub status: String,
    #[serde(default)]
    pub data: Value,
    #[serde(default)]
    pub app: Option<CapabilityAppRef>,
    #[serde(default)]
    pub runtime: Option<CapabilityRuntimeInfo>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

fn default_ok_status() -> String {
    "ok".into()
}

impl CapabilityResult {
    pub fn ok(data: Value) -> Self {
        Self {
            status: "ok".into(),
            data,
            ..Self::default()
        }
    }
}

/// 检索请求。`task` 是当前子目标摘要，`query` 是检索词。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationSearchParams {
    #[serde(default)]
    pub task: Option<String>,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub app_id: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub max_results: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationCandidate {
    pub tool_name: String,
    pub app_id: String,
    pub capability_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub input_hint: Option<Value>,
    #[serde(default)]
    pub risk: CapabilityRisk,
    #[serde(default)]
    pub trust_level: TrustLevel,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationSearchResult {
    #[serde(default)]
    pub candidates: Vec<ApplicationCandidate>,
    #[serde(default)]
    pub activated: Vec<String>,
    #[serde(default)]
    pub skills_activated: Vec<String>,
    #[serde(default)]
    pub catalog_version: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationActivateParams {
    #[serde(default)]
    pub tool_names: Vec<String>,
    #[serde(default)]
    pub run_capability_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationActivationRejection {
    pub tool_name: String,
    #[serde(default)]
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationActivateResult {
    #[serde(default)]
    pub catalog_version: u64,
    #[serde(default)]
    pub activated: Vec<String>,
    #[serde(default)]
    pub rejected: Vec<ApplicationActivationRejection>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationHostStateChangedParams {
    pub host_capability_id: String,
    #[serde(default)]
    pub availability: CapabilityAvailability,
    #[serde(default)]
    pub state_version: u64,
}

/// 稳定的应用 provider 错误码。
pub mod error_code {
    pub const APP_NOT_ENABLED: &str = "app_not_enabled";
    pub const CAPABILITY_NOT_FOUND: &str = "capability_not_found";
    pub const PERMISSION_REQUIRED: &str = "permission_required";
    pub const APP_START_FAILED: &str = "app_start_failed";
    pub const APP_UNHEALTHY: &str = "app_unhealthy";
    pub const INPUT_SCHEMA_INVALID: &str = "input_schema_invalid";
    pub const OUTPUT_SCHEMA_INVALID: &str = "output_schema_invalid";
    pub const OPERATION_TIMEOUT: &str = "operation_timeout";
    pub const OPERATION_CANCELLED: &str = "operation_cancelled";
    pub const OPERATION_UNCERTAIN: &str = "operation_uncertain";
    pub const PROVIDER_UNAVAILABLE: &str = "provider_unavailable";
    pub const RUN_CAPABILITY_TOKEN_REQUIRED: &str = "run_capability_token_required";
    pub const RUN_CAPABILITY_TOKEN_INVALID: &str = "run_capability_token_invalid";
    pub const CAPABILITY_NOT_ACTIVE: &str = "capability_not_active";
    pub const TRUST_REQUIRED: &str = "trust_required";
    pub const MANIFEST_INVALID: &str = "manifest_invalid";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_round_trips_with_camel_case_and_defaults() {
        let manifest: AppManifest = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "app": {
                "id": "worldbase.tasks",
                "name": "Tasks",
                "version": "1.2.0",
                "description": "Manage tasks",
                "tags": ["tasks"],
                "platforms": ["desktop", "mobile"],
                "requiredFeatures": ["interactive"]
            },
            "runtime": { "kind": "host_service", "activation": "on-demand" },
            "capabilities": [{
                "id": "task.search",
                "title": "Search tasks",
                "description": "Find tasks",
                "inputSchema": { "type": "object" },
                "operation": "tasks.search",
                "risk": "read",
                "permissions": ["tasks.read"],
                "dataScopes": ["selected_workspace"]
            }]
        }))
        .expect("manifest");
        assert_eq!(manifest.schema_version, 1);
        assert_eq!(manifest.app.trust_level, TrustLevel::Untrusted);
        assert_eq!(manifest.runtime.kind, RuntimeKind::HostService);
        assert_eq!(manifest.capabilities[0].risk, CapabilityRisk::Read);
        let value = serde_json::to_value(&manifest).expect("serialize");
        assert_eq!(value["app"]["requiredFeatures"][0], "interactive");
    }

    #[test]
    fn tool_descriptor_defaults_preserve_legacy_shape() {
        let descriptor: crate::types::ToolDescriptor = serde_json::from_value(serde_json::json!({
            "name": "read_file",
            "description": "Read",
            "inputSchema": { "type": "object" }
        }))
        .expect("descriptor");
        assert_eq!(descriptor.visibility, ToolVisibility::AlwaysOn);
        assert!(descriptor.source.is_none());
        assert!(descriptor.tags.is_empty());
    }
}
