//! Application capability providers and the executable `CapabilityTool`.
//!
//! Providers are intentionally narrow: the Rust catalog owns discovery,
//! schema, policy and routing; a provider only performs `health`,
//! `ensure_ready` and `invoke` for one already-authorized capability.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use async_trait::async_trait;
use serde_json::Value;
use worldbase_protocol::types::{
    error_code, AppHealth, ApplicationRecord, CallContext, CapabilityRecord, CapabilityResult,
    CapabilityRisk, CapabilityRuntimeInfo, RuntimeKind, RuntimeLease, ToolVisibility,
};

use crate::{Tool, ToolServices};

#[path = "builtin_apps.rs"]
pub mod builtin_apps;

pub use builtin_apps::builtin_application_manifests;

/// Hard upper bound for a provider payload. It matches the managed-app RPC
/// response limit so every runtime enforces the same trust boundary.
pub const MAX_CAPABILITY_OUTPUT_BYTES: usize = 2 * 1024 * 1024;

/// The only OS/UI capabilities the Electron host adapter may dispatch.
pub const HOST_CAPABILITY_IDS: [&str; 3] = [
    "host.fs.pick_file",
    "host.shell.open_external",
    "host.notification.show",
];

const DEFAULT_DEADLINE_MS: u64 = 60_000;

fn effective_deadline_ms(ctx: &CallContext) -> u64 {
    if ctx.deadline_ms == 0 {
        DEFAULT_DEADLINE_MS
    } else {
        ctx.deadline_ms
    }
}

fn deadline_duration(ctx: &CallContext) -> Duration {
    Duration::from_millis(effective_deadline_ms(ctx))
}

fn operation_ref(capability: &CapabilityRecord) -> &str {
    if capability.provider_ref.trim().is_empty() {
        capability.capability_id.as_str()
    } else {
        capability.provider_ref.as_str()
    }
}

fn validate_output(capability: &CapabilityRecord, value: &Value) -> Result<()> {
    if let Some(schema) = capability.output_schema.as_ref() {
        if let Some(expected) = schema.get("type").and_then(Value::as_str) {
            let matches = match expected {
                "object" => value.is_object(),
                "array" => value.is_array(),
                "string" => value.is_string(),
                "number" => value.is_number(),
                "integer" => value.is_i64() || value.is_u64(),
                "boolean" => value.is_boolean(),
                "null" => value.is_null(),
                _ => true,
            };
            anyhow::ensure!(
                matches,
                "{}: capability {} returned {expected}, got {}",
                error_code::OUTPUT_SCHEMA_INVALID,
                capability.capability_id,
                value_type_name(value)
            );
        }
    }
    let size = serde_json::to_vec(value)?.len();
    anyhow::ensure!(
        size <= MAX_CAPABILITY_OUTPUT_BYTES,
        "{}: capability {} output exceeds {} bytes",
        error_code::OUTPUT_SCHEMA_INVALID,
        capability.capability_id,
        MAX_CAPABILITY_OUTPUT_BYTES
    );
    Ok(())
}

fn value_type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn finish_result(capability: &CapabilityRecord, data: Value) -> Result<CapabilityResult> {
    validate_output(capability, &data)?;
    Ok(CapabilityResult::ok(data))
}

async fn run_with_deadline<T>(
    ctx: &CallContext,
    timeout_code: &str,
    future: impl std::future::Future<Output = Result<T>>,
) -> Result<T> {
    match tokio::time::timeout(deadline_duration(ctx), future).await {
        Ok(result) => result,
        Err(_) => anyhow::bail!("{timeout_code}: provider exceeded its deadline"),
    }
}

/// Unified application provider contract.
#[async_trait]
pub trait ApplicationCapabilityProvider: Send + Sync {
    fn provider_ref(&self) -> &str;

    async fn health(&self, app: &ApplicationRecord) -> Result<AppHealth>;

    async fn ensure_ready(
        &self,
        app: &ApplicationRecord,
        ctx: &CallContext,
    ) -> Result<RuntimeLease>;

    async fn invoke(
        &self,
        capability: &CapabilityRecord,
        input: Value,
        ctx: &CallContext,
        services: &ToolServices,
    ) -> Result<CapabilityResult>;
}

/// Executable tool for one application capability. The descriptor, handler and
/// version are committed together by the run catalog.
pub struct CapabilityTool {
    provider: Arc<dyn ApplicationCapabilityProvider>,
    app: ApplicationRecord,
    capability: CapabilityRecord,
    source: String,
}

impl CapabilityTool {
    pub fn new(
        provider: Arc<dyn ApplicationCapabilityProvider>,
        app: ApplicationRecord,
        capability: CapabilityRecord,
    ) -> Self {
        let source = format!("app:{}", app.app_id);
        Self {
            provider,
            app,
            capability,
            source,
        }
    }

    pub fn capability(&self) -> &CapabilityRecord {
        &self.capability
    }

    pub fn app(&self) -> &ApplicationRecord {
        &self.app
    }
}

#[async_trait]
impl Tool for CapabilityTool {
    fn name(&self) -> &str {
        &self.capability.tool_name
    }

    fn description(&self) -> &str {
        &self.capability.description
    }

    fn input_schema(&self) -> Value {
        self.capability.input_schema.clone()
    }

    fn output_schema(&self) -> Option<Value> {
        self.capability.output_schema.clone()
    }

    fn permission(&self) -> &str {
        self.capability.risk.default_permission()
    }

    fn electron_native(&self) -> bool {
        true
    }

    fn visibility(&self) -> ToolVisibility {
        ToolVisibility::Discoverable
    }

    fn source(&self) -> Option<&str> {
        Some(&self.source)
    }

    fn tags(&self) -> &[String] {
        &self.app.tags
    }

    fn risk(&self) -> Option<CapabilityRisk> {
        Some(self.capability.risk)
    }

    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        validate_schema_value(&self.capability.input_schema, &input, "$")?;
        let ctx = CallContext {
            call_id: uuid::Uuid::new_v4().to_string(),
            conversation_id: services.conversation_id.clone(),
            app_id: self.app.app_id.clone(),
            data_scope: self.capability.data_scopes.clone(),
            deadline_ms: self.capability.deadline_ms.unwrap_or(DEFAULT_DEADLINE_MS),
            idempotency_key: None,
        };
        let lease = run_with_deadline(
            &ctx,
            error_code::APP_START_FAILED,
            self.provider.ensure_ready(&self.app, &ctx),
        )
        .await?;
        let _ = lease;
        let result = run_with_deadline(
            &ctx,
            error_code::OPERATION_TIMEOUT,
            self.provider
                .invoke(&self.capability, input, &ctx, services),
        )
        .await?;
        if let Some(output_schema) = self.capability.output_schema.as_ref() {
            validate_schema_value(output_schema, &result.data, "$.data")?;
        }
        Ok(serde_json::to_value(result)?)
    }
}

/// First-party Rust tool exposed as an application capability. One provider
/// may route several capabilities belonging to the same application.
pub struct NativeToolCapabilityProvider {
    provider_ref: String,
    tools: HashMap<String, Arc<dyn Tool>>,
    single: Option<Arc<dyn Tool>>,
}

impl NativeToolCapabilityProvider {
    pub fn new(provider_ref: impl Into<String>, tool: Arc<dyn Tool>) -> Self {
        let name = tool.name().to_string();
        let mut tools = HashMap::new();
        tools.insert(name, tool.clone());
        Self {
            provider_ref: provider_ref.into(),
            tools,
            single: Some(tool),
        }
    }

    pub fn from_tools(
        provider_ref: impl Into<String>,
        tools: impl IntoIterator<Item = Arc<dyn Tool>>,
    ) -> Self {
        let mut map = HashMap::new();
        let mut single = None;
        for tool in tools {
            map.insert(tool.name().to_string(), tool.clone());
            single = Some(tool);
        }
        if map.len() != 1 {
            single = None;
        }
        Self {
            provider_ref: provider_ref.into(),
            tools: map,
            single,
        }
    }

    fn resolve_tool(&self, capability: &CapabilityRecord) -> Option<&Arc<dyn Tool>> {
        self.tools
            .get(operation_ref(capability))
            .or_else(|| self.tools.get(&capability.capability_id))
            .or(self.single.as_ref())
    }
}

#[async_trait]
impl ApplicationCapabilityProvider for NativeToolCapabilityProvider {
    fn provider_ref(&self) -> &str {
        &self.provider_ref
    }

    async fn health(&self, _app: &ApplicationRecord) -> Result<AppHealth> {
        if self.tools.is_empty() {
            return Ok(AppHealth {
                status: "unavailable".into(),
                detail: Some("no native tool registered".into()),
                checked_at: None,
            });
        }
        Ok(AppHealth::ready())
    }

    async fn ensure_ready(
        &self,
        app: &ApplicationRecord,
        _ctx: &CallContext,
    ) -> Result<RuntimeLease> {
        Ok(RuntimeLease {
            lease_id: uuid::Uuid::new_v4().to_string(),
            app_id: app.app_id.clone(),
            expires_at_ms: 0,
            runtime_kind: RuntimeKind::HostService,
        })
    }

    async fn invoke(
        &self,
        capability: &CapabilityRecord,
        input: Value,
        ctx: &CallContext,
        services: &ToolServices,
    ) -> Result<CapabilityResult> {
        let tool = self.resolve_tool(capability).ok_or_else(|| {
            anyhow::anyhow!(
                "{}: no native tool registered for operation {}",
                error_code::PROVIDER_UNAVAILABLE,
                operation_ref(capability)
            )
        })?;
        let data = run_with_deadline(
            ctx,
            error_code::OPERATION_TIMEOUT,
            tool.execute(input, services),
        )
        .await?;
        finish_result(capability, data)
    }
}

/// MCP server tool exposed as an application capability. The MCP transport is
/// reused; this adapter only adds catalog identity and result shaping.
pub struct McpCapabilityProvider {
    provider_ref: String,
    mcp: Arc<worldbase_mcp_client::McpManager>,
    server: String,
    remote_tool: String,
}

impl McpCapabilityProvider {
    pub fn new(
        provider_ref: impl Into<String>,
        mcp: Arc<worldbase_mcp_client::McpManager>,
        server: impl Into<String>,
        remote_tool: impl Into<String>,
    ) -> Self {
        Self {
            provider_ref: provider_ref.into(),
            mcp,
            server: server.into(),
            remote_tool: remote_tool.into(),
        }
    }
}

#[async_trait]
impl ApplicationCapabilityProvider for McpCapabilityProvider {
    fn provider_ref(&self) -> &str {
        &self.provider_ref
    }

    async fn health(&self, _app: &ApplicationRecord) -> Result<AppHealth> {
        let servers = self.mcp.server_names().await;
        if servers.iter().any(|server| server == &self.server) {
            Ok(AppHealth::ready())
        } else {
            Ok(AppHealth {
                status: "unavailable".into(),
                detail: Some(format!("MCP server {} is not connected", self.server)),
                checked_at: None,
            })
        }
    }

    async fn ensure_ready(
        &self,
        app: &ApplicationRecord,
        _ctx: &CallContext,
    ) -> Result<RuntimeLease> {
        Ok(RuntimeLease {
            lease_id: uuid::Uuid::new_v4().to_string(),
            app_id: app.app_id.clone(),
            expires_at_ms: 0,
            runtime_kind: RuntimeKind::McpServer,
        })
    }

    async fn invoke(
        &self,
        capability: &CapabilityRecord,
        input: Value,
        ctx: &CallContext,
        _services: &ToolServices,
    ) -> Result<CapabilityResult> {
        let data = run_with_deadline(
            ctx,
            error_code::OPERATION_TIMEOUT,
            self.mcp.call_tool(&self.server, &self.remote_tool, input),
        )
        .await?;
        finish_result(capability, data)
    }
}

/// Narrow Electron OS/UI capability. The transport remains the existing
/// HostBridge; only the envelope and allowlist are new.
pub struct ElectronHostCapabilityProvider {
    provider_ref: String,
}

impl ElectronHostCapabilityProvider {
    pub fn new(provider_ref: impl Into<String>) -> Self {
        Self {
            provider_ref: provider_ref.into(),
        }
    }

    pub fn allowed_capability_ids() -> &'static [&'static str] {
        &HOST_CAPABILITY_IDS
    }

    fn ensure_allowed(capability: &CapabilityRecord) -> Result<&str> {
        let operation = operation_ref(capability);
        anyhow::ensure!(
            HOST_CAPABILITY_IDS.contains(&operation),
            "{}: host capability is not registered: {operation}",
            error_code::PROVIDER_UNAVAILABLE
        );
        Ok(operation)
    }
}

#[async_trait]
impl ApplicationCapabilityProvider for ElectronHostCapabilityProvider {
    fn provider_ref(&self) -> &str {
        &self.provider_ref
    }

    async fn health(&self, _app: &ApplicationRecord) -> Result<AppHealth> {
        Ok(AppHealth::unknown())
    }

    async fn ensure_ready(
        &self,
        app: &ApplicationRecord,
        _ctx: &CallContext,
    ) -> Result<RuntimeLease> {
        Ok(RuntimeLease {
            lease_id: uuid::Uuid::new_v4().to_string(),
            app_id: app.app_id.clone(),
            expires_at_ms: 0,
            runtime_kind: RuntimeKind::ElectronHost,
        })
    }

    async fn invoke(
        &self,
        capability: &CapabilityRecord,
        input: Value,
        ctx: &CallContext,
        services: &ToolServices,
    ) -> Result<CapabilityResult> {
        let operation = Self::ensure_allowed(capability)?;
        let stream_id = services.current_stream.lock().unwrap().clone();
        anyhow::ensure!(
            !stream_id.trim().is_empty(),
            "{}: host capability requires a run stream",
            error_code::PROVIDER_UNAVAILABLE
        );
        let mut payload = serde_json::json!({
            "protocolVersion": 1,
            "registeredHostCapabilityId": operation,
            "callId": ctx.call_id,
            "deadline": effective_deadline_ms(ctx),
            "input": input,
        });
        if let Some(key) = ctx.idempotency_key.as_deref() {
            payload["idempotencyKey"] = Value::String(key.to_string());
        }
        let response = run_with_deadline(
            ctx,
            error_code::OPERATION_TIMEOUT,
            services.host.request(
                &stream_id,
                "application.host.capability.invoke",
                payload,
                deadline_duration(ctx),
            ),
        )
        .await?;

        let object = response.as_object().ok_or_else(|| {
            anyhow::anyhow!(
                "{}: host response must be an object",
                error_code::OUTPUT_SCHEMA_INVALID
            )
        })?;
        let status = match object.get("status") {
            None | Some(Value::Null) => "ok",
            Some(Value::String(status)) if status == "ok" || status == "error" => status,
            Some(_) => {
                anyhow::bail!(
                    "{}: host response has an invalid status",
                    error_code::OUTPUT_SCHEMA_INVALID
                )
            }
        };
        if status == "error" {
            let code = object
                .get("errorCode")
                .and_then(Value::as_str)
                .filter(|code| !code.trim().is_empty())
                .unwrap_or(error_code::PROVIDER_UNAVAILABLE);
            let message = object
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("host capability failed");
            anyhow::bail!("{code}: {message}");
        }
        let warnings = match object.get("warnings") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(items)) => items
                .iter()
                .map(|item| {
                    item.as_str().map(ToOwned::to_owned).ok_or_else(|| {
                        anyhow::anyhow!(
                            "{}: host response warnings must be strings",
                            error_code::OUTPUT_SCHEMA_INVALID
                        )
                    })
                })
                .collect::<Result<Vec<_>>>()?,
            Some(_) => anyhow::bail!(
                "{}: host response warnings must be an array",
                error_code::OUTPUT_SCHEMA_INVALID
            ),
        };
        let data = object
            .get("output")
            .or_else(|| object.get("data"))
            .cloned()
            .unwrap_or(Value::Null);
        validate_output(capability, &data)?;
        Ok(CapabilityResult {
            status: "ok".into(),
            data,
            app: None,
            runtime: Some(CapabilityRuntimeInfo {
                started_for_call: false,
            }),
            warnings,
        })
    }
}

/// Adapter for a managed project runtime. The runtime owns manifests, tokens,
/// loopback RPC, leases and health; this type only binds one project to the
/// catalog identity that was registered for it.
pub struct ManagedAppCapabilityProvider {
    runtime: Arc<worldbase_project_runtime::ProjectRuntime>,
    project_id: String,
    manifest_hash: String,
}

impl ManagedAppCapabilityProvider {
    pub fn new(
        runtime: Arc<worldbase_project_runtime::ProjectRuntime>,
        project_id: impl Into<String>,
        manifest_hash: impl Into<String>,
    ) -> Self {
        Self {
            runtime,
            project_id: project_id.into(),
            manifest_hash: manifest_hash.into(),
        }
    }

    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    pub fn manifest_hash(&self) -> &str {
        &self.manifest_hash
    }

    fn ensure_manifest_matches(&self, app: &ApplicationRecord) -> Result<()> {
        if app.manifest_hash.trim().is_empty() || self.manifest_hash.trim().is_empty() {
            return Ok(());
        }
        anyhow::ensure!(
            app.manifest_hash == self.manifest_hash,
            "{}: managed app manifest changed; re-register the provider",
            error_code::MANIFEST_INVALID
        );
        Ok(())
    }
}

#[async_trait]
impl ApplicationCapabilityProvider for ManagedAppCapabilityProvider {
    fn provider_ref(&self) -> &str {
        &self.project_id
    }

    async fn health(&self, app: &ApplicationRecord) -> Result<AppHealth> {
        self.ensure_manifest_matches(app)?;
        self.runtime
            .app_health(&self.project_id)
            .await
            .with_context(|| format!("{}: app health check failed", error_code::APP_UNHEALTHY))
    }

    async fn ensure_ready(
        &self,
        app: &ApplicationRecord,
        ctx: &CallContext,
    ) -> Result<RuntimeLease> {
        self.ensure_manifest_matches(app)?;
        run_with_deadline(
            ctx,
            error_code::APP_START_FAILED,
            self.runtime.ensure_app_ready(&self.project_id),
        )
        .await
    }

    async fn invoke(
        &self,
        capability: &CapabilityRecord,
        input: Value,
        ctx: &CallContext,
        _services: &ToolServices,
    ) -> Result<CapabilityResult> {
        let result = run_with_deadline(
            ctx,
            error_code::OPERATION_TIMEOUT,
            self.runtime.invoke_app_capability(
                &self.project_id,
                &capability.capability_id,
                input,
                ctx,
            ),
        )
        .await?;
        validate_output(capability, &result.data)?;
        Ok(result)
    }
}

/// Minimal, dependency-free JSON Schema subset used at the capability
/// boundary. Manifests already reject remote `$ref`; this validator enforces
/// the remaining structural constraints before a provider sees untrusted
/// model input and before a result reaches the model.
pub fn validate_schema_value(schema: &Value, value: &Value, path: &str) -> Result<()> {
    validate_schema_value_at(schema, value, path, 0)
}

fn validate_schema_value_at(schema: &Value, value: &Value, path: &str, depth: usize) -> Result<()> {
    anyhow::ensure!(
        depth <= 16,
        "input_schema_invalid: {path} nesting is too deep"
    );
    let Some(schema) = schema.as_object() else {
        return Ok(());
    };

    if let Some(enum_values) = schema.get("enum").and_then(Value::as_array) {
        anyhow::ensure!(
            enum_values.contains(value),
            "input_schema_invalid: {path} is not one of the allowed values"
        );
    }
    if let Some(any_of) = schema.get("anyOf").and_then(Value::as_array) {
        anyhow::ensure!(
            any_of.iter().any(|candidate| validate_schema_value_at(
                candidate,
                value,
                path,
                depth + 1
            )
            .is_ok()),
            "input_schema_invalid: {path} does not match any allowed schema"
        );
    }
    if let Some(one_of) = schema.get("oneOf").and_then(Value::as_array) {
        let matches = one_of
            .iter()
            .filter(|candidate| validate_schema_value_at(candidate, value, path, depth + 1).is_ok())
            .count();
        anyhow::ensure!(
            matches == 1,
            "input_schema_invalid: {path} must match exactly one schema"
        );
    }
    if let Some(all_of) = schema.get("allOf").and_then(Value::as_array) {
        for candidate in all_of {
            validate_schema_value_at(candidate, value, path, depth + 1)?;
        }
    }

    if let Some(type_value) = schema.get("type") {
        let types: Vec<&str> = match type_value {
            Value::String(kind) => vec![kind.as_str()],
            Value::Array(kinds) => kinds.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        };
        anyhow::ensure!(
            types.is_empty() || types.iter().any(|kind| value_matches_type(value, kind)),
            "input_schema_invalid: {path} must be {}",
            types.join(" or ")
        );
    }

    if let Some(object) = value.as_object() {
        if let Some(required) = schema.get("required").and_then(Value::as_array) {
            for key in required.iter().filter_map(Value::as_str) {
                anyhow::ensure!(
                    object.contains_key(key),
                    "input_schema_invalid: {path}.{key} is required"
                );
            }
        }
        if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
            for (key, property_schema) in properties {
                if let Some(property_value) = object.get(key) {
                    validate_schema_value_at(
                        property_schema,
                        property_value,
                        &format!("{path}.{key}"),
                        depth + 1,
                    )?;
                }
            }
        }
        if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
            if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
                for key in object.keys() {
                    anyhow::ensure!(
                        properties.contains_key(key),
                        "input_schema_invalid: {path}.{key} is not allowed"
                    );
                }
            }
        }
    }

    if let Some(items) = value.as_array() {
        if let Some(item_schema) = schema.get("items") {
            for (index, item) in items.iter().enumerate() {
                validate_schema_value_at(
                    item_schema,
                    item,
                    &format!("{path}[{index}]"),
                    depth + 1,
                )?;
            }
        }
    }

    if let Some(text) = value.as_str() {
        if let Some(min) = schema.get("minLength").and_then(Value::as_u64) {
            anyhow::ensure!(
                text.chars().count() as u64 >= min,
                "input_schema_invalid: {path} is shorter than {min}"
            );
        }
        if let Some(max) = schema.get("maxLength").and_then(Value::as_u64) {
            anyhow::ensure!(
                text.chars().count() as u64 <= max,
                "input_schema_invalid: {path} is longer than {max}"
            );
        }
    }

    if let Some(number) = value.as_f64() {
        if let Some(min) = schema.get("minimum").and_then(Value::as_f64) {
            anyhow::ensure!(
                number >= min,
                "input_schema_invalid: {path} must be >= {min}"
            );
        }
        if let Some(max) = schema.get("maximum").and_then(Value::as_f64) {
            anyhow::ensure!(
                number <= max,
                "input_schema_invalid: {path} must be <= {max}"
            );
        }
    }

    Ok(())
}

fn value_matches_type(value: &Value, kind: &str) -> bool {
    match kind {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "number" => value.is_number(),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        _ => true,
    }
}
