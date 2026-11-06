use crate::app_manifest::validate_manifest;
use crate::{normalize_project_id, unix_time_millis, ProjectRuntime};
use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use serde_json::{Map, Value};
use std::time::Duration;
use uuid::Uuid;
use worldbase_protocol::types::{
    error_code, AppHealth, AppManifest, CallContext, CapabilityAppRef, CapabilityResult,
    CapabilityRuntimeInfo, RuntimeKind, RuntimeLease,
};

pub const APP_RPC_INVOKE_PATH: &str = "/worldbase/capabilities/invoke";
pub const APP_RPC_DISCOVERY_PATH: &str = "/.well-known/worldbase/capabilities";
pub const MAX_APP_RPC_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

const DEFAULT_DEADLINE_MS: u64 = 30_000;
const HEALTH_DEADLINE_MS: u64 = 5_000;
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(5);
const READY_TIMEOUT: Duration = Duration::from_secs(45);
const READY_POLL_INTERVAL: Duration = Duration::from_millis(150);
const APP_LEASE_TTL_MS: u64 = 60_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InvokeEnvelope<'a> {
    protocol_version: u32,
    call_id: &'a str,
    capability_id: &'a str,
    deadline: u64,
    idempotency_key: Option<&'a str>,
    input: &'a Value,
}

fn invocation_timeout_ms(ctx: &CallContext) -> u64 {
    if ctx.deadline_ms == 0 {
        DEFAULT_DEADLINE_MS
    } else {
        ctx.deadline_ms.max(1)
    }
}

pub async fn invoke_at(
    port: u16,
    token: &str,
    manifest: &AppManifest,
    capability_id: &str,
    input: Value,
    ctx: &CallContext,
) -> Result<CapabilityResult> {
    invoke_with_runtime(port, token, manifest, capability_id, input, ctx, false).await
}

async fn invoke_with_runtime(
    port: u16,
    token: &str,
    manifest: &AppManifest,
    capability_id: &str,
    input: Value,
    ctx: &CallContext,
    started_for_call: bool,
) -> Result<CapabilityResult> {
    if !manifest
        .capabilities
        .iter()
        .any(|capability| capability.id == capability_id)
    {
        bail!(
            "{}: capability {capability_id} is not declared by {}",
            error_code::CAPABILITY_NOT_FOUND,
            manifest.app.id
        );
    }
    if token.trim().is_empty() {
        bail!("{}: app token is empty", error_code::PROVIDER_UNAVAILABLE);
    }
    if port == 0 {
        bail!(
            "{}: app runtime port is unavailable",
            error_code::APP_START_FAILED
        );
    }

    let timeout_ms = invocation_timeout_ms(ctx);
    let call_id = if ctx.call_id.trim().is_empty() {
        Uuid::new_v4().to_string()
    } else {
        ctx.call_id.clone()
    };
    let envelope = InvokeEnvelope {
        protocol_version: 1,
        call_id: &call_id,
        capability_id,
        deadline: unix_time_millis().saturating_add(timeout_ms),
        idempotency_key: ctx.idempotency_key.as_deref(),
        input: &input,
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .context("build app RPC client")?;
    let url = format!("http://127.0.0.1:{port}{APP_RPC_INVOKE_PATH}");
    let response = client
        .post(&url)
        .bearer_auth(token)
        .json(&envelope)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                anyhow!(
                    "{}: app capability invocation exceeded its deadline",
                    error_code::OPERATION_TIMEOUT
                )
            } else {
                anyhow!(
                    "{}: app RPC request failed: {error}",
                    error_code::PROVIDER_UNAVAILABLE
                )
            }
        })?;

    let http_status = response.status();
    if let Some(length) = response.content_length() {
        if length > MAX_APP_RPC_RESPONSE_BYTES as u64 {
            bail!(
                "{}: response_too_large ({length} bytes, limit {MAX_APP_RPC_RESPONSE_BYTES})",
                error_code::PROVIDER_UNAVAILABLE
            );
        }
    }
    let bytes = response.bytes().await.map_err(|error| {
        if error.is_timeout() {
            anyhow!(
                "{}: app capability response timed out",
                error_code::OPERATION_TIMEOUT
            )
        } else {
            anyhow!(
                "{}: unable to read app capability response: {error}",
                error_code::PROVIDER_UNAVAILABLE
            )
        }
    })?;
    if bytes.len() > MAX_APP_RPC_RESPONSE_BYTES {
        bail!(
            "{}: response_too_large ({} bytes, limit {MAX_APP_RPC_RESPONSE_BYTES})",
            error_code::PROVIDER_UNAVAILABLE,
            bytes.len()
        );
    }

    if !http_status.is_success() {
        if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
            if let Some(code) = value.get("errorCode").and_then(Value::as_str) {
                let message = value
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("application returned an error");
                bail!("{code}: {message}");
            }
        }
        match http_status.as_u16() {
            401 | 403 => bail!(
                "{}: app RPC authentication was rejected",
                error_code::PROVIDER_UNAVAILABLE
            ),
            404 => bail!(
                "{}: app RPC operation endpoint was not found",
                error_code::CAPABILITY_NOT_FOUND
            ),
            408 | 504 => bail!(
                "{}: app capability invocation timed out",
                error_code::OPERATION_TIMEOUT
            ),
            _ => bail!(
                "{}: app RPC returned HTTP {}",
                error_code::PROVIDER_UNAVAILABLE,
                http_status.as_u16()
            ),
        }
    }

    let value: Value = serde_json::from_slice(&bytes).context("parse app capability response")?;
    parse_capability_response(value, manifest, started_for_call)
}

fn parse_capability_response(
    value: Value,
    manifest: &AppManifest,
    started_for_call: bool,
) -> Result<CapabilityResult> {
    let status = value.get("status").and_then(Value::as_str).ok_or_else(|| {
        anyhow!(
            "{}: response is missing a string status",
            error_code::PROVIDER_UNAVAILABLE
        )
    })?;
    match status {
        "ok" => {
            let warnings = match value.get("warnings") {
                None | Some(Value::Null) => Vec::new(),
                Some(Value::Array(items)) => items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect(),
                Some(_) => bail!(
                    "{}: response warnings must be an array",
                    error_code::PROVIDER_UNAVAILABLE
                ),
            };
            Ok(CapabilityResult {
                status: "ok".into(),
                data: value.get("data").cloned().unwrap_or(Value::Null),
                app: Some(CapabilityAppRef {
                    id: manifest.app.id.clone(),
                    version: manifest.app.version.clone(),
                }),
                runtime: Some(CapabilityRuntimeInfo { started_for_call }),
                warnings,
            })
        }
        "error" => {
            let code = value
                .get("errorCode")
                .and_then(Value::as_str)
                .filter(|code| !code.trim().is_empty())
                .unwrap_or(error_code::PROVIDER_UNAVAILABLE);
            let message = value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("application returned an error");
            bail!("{code}: {message}")
        }
        other => bail!(
            "{}: unsupported response status {other}",
            error_code::PROVIDER_UNAVAILABLE
        ),
    }
}

pub async fn discover_at(port: u16, timeout: Duration) -> Result<Option<AppManifest>> {
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .context("build app discovery client")?;
    let url = format!("http://127.0.0.1:{port}{APP_RPC_DISCOVERY_PATH}");
    let response = client.get(&url).send().await.map_err(|error| {
        anyhow!(
            "{}: app capability discovery failed: {error}",
            error_code::PROVIDER_UNAVAILABLE
        )
    })?;
    if response.status().as_u16() == 404 {
        return Ok(None);
    }
    if !response.status().is_success() {
        bail!(
            "{}: app capability discovery returned HTTP {}",
            error_code::PROVIDER_UNAVAILABLE,
            response.status().as_u16()
        );
    }
    if let Some(length) = response.content_length() {
        if length > MAX_APP_RPC_RESPONSE_BYTES as u64 {
            bail!(
                "{}: discovery response_too_large ({length} bytes)",
                error_code::PROVIDER_UNAVAILABLE
            );
        }
    }
    let bytes = response.bytes().await.map_err(|error| {
        anyhow!(
            "{}: unable to read app capability discovery response: {error}",
            error_code::PROVIDER_UNAVAILABLE
        )
    })?;
    if bytes.len() > MAX_APP_RPC_RESPONSE_BYTES {
        bail!(
            "{}: discovery response_too_large ({} bytes)",
            error_code::PROVIDER_UNAVAILABLE,
            bytes.len()
        );
    }
    let manifest: AppManifest =
        serde_json::from_slice(&bytes).context("parse app capability discovery manifest")?;
    validate_manifest(&manifest)
        .map_err(|errors| anyhow!("manifest_invalid: {}", errors.join("; ")))?;
    Ok(Some(manifest))
}

impl ProjectRuntime {
    pub fn ensure_app_token(&self, project_id: &str) -> Result<String> {
        let project_id = normalize_project_id(project_id)?;
        let mut tokens = self.app_tokens.lock().expect("app token lock poisoned");
        if let Some(token) = tokens.get(project_id) {
            return Ok(token.clone());
        }
        let token = Uuid::new_v4().simple().to_string();
        tokens.insert(project_id.to_string(), token.clone());
        Ok(token)
    }

    pub fn app_token(&self, project_id: &str) -> Option<String> {
        self.app_tokens
            .lock()
            .expect("app token lock poisoned")
            .get(project_id.trim())
            .cloned()
    }

    pub async fn app_health(&self, project_id: &str) -> Result<AppHealth> {
        let checked_at = Some(worldbase_protocol::event::now_rfc3339());
        let manifest = match self.app_manifest(project_id) {
            Ok(Some(manifest)) => manifest,
            Ok(None) => {
                return Ok(AppHealth {
                    status: "unavailable".into(),
                    detail: Some("app manifest not found".into()),
                    checked_at,
                })
            }
            Err(error) => {
                return Ok(AppHealth {
                    status: "failed".into(),
                    detail: Some(error.to_string()),
                    checked_at,
                })
            }
        };
        let status = self.status(project_id).await?;
        let state = status
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("not_started");
        match state {
            "running" => {
                let Some(health_check) = manifest.runtime.health_check.as_deref() else {
                    return Ok(AppHealth {
                        status: "ready".into(),
                        detail: None,
                        checked_at,
                    });
                };
                let token = self.ensure_app_token(project_id)?;
                let Some(port) = status
                    .get("port")
                    .and_then(Value::as_u64)
                    .and_then(|port| u16::try_from(port).ok())
                else {
                    return Ok(AppHealth {
                        status: "failed".into(),
                        detail: Some("app runtime port is missing".into()),
                        checked_at,
                    });
                };
                let ctx = CallContext {
                    call_id: Uuid::new_v4().to_string(),
                    conversation_id: None,
                    app_id: manifest.app.id.clone(),
                    data_scope: Vec::new(),
                    deadline_ms: HEALTH_DEADLINE_MS,
                    idempotency_key: None,
                };
                match invoke_with_runtime(
                    port,
                    &token,
                    &manifest,
                    health_check,
                    Value::Object(Map::new()),
                    &ctx,
                    false,
                )
                .await
                {
                    Ok(result) if result.status == "ok" => Ok(AppHealth {
                        status: "ready".into(),
                        detail: None,
                        checked_at,
                    }),
                    Ok(result) => Ok(AppHealth {
                        status: "failed".into(),
                        detail: Some(format!("healthCheck returned status {}", result.status)),
                        checked_at,
                    }),
                    Err(error) => Ok(AppHealth {
                        status: "failed".into(),
                        detail: Some(error.to_string()),
                        checked_at,
                    }),
                }
            }
            "starting" => Ok(AppHealth {
                status: "starting".into(),
                detail: None,
                checked_at,
            }),
            "crashed" | "error" => Ok(AppHealth {
                status: "failed".into(),
                detail: status
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                checked_at,
            }),
            _ => Ok(AppHealth {
                status: "unavailable".into(),
                detail: None,
                checked_at,
            }),
        }
    }

    pub async fn ensure_app_ready(&self, project_id: &str) -> Result<RuntimeLease> {
        let project_id = normalize_project_id(project_id)?;
        let manifest = self
            .app_manifest(project_id)?
            .ok_or_else(|| anyhow!("manifest_invalid: app manifest not found"))?;
        if manifest.runtime.kind != RuntimeKind::ManagedProject {
            bail!(
                "{}: app {} is not a managed project runtime",
                error_code::PROVIDER_UNAVAILABLE,
                manifest.app.id
            );
        }
        self.ensure_app_token(project_id)?;
        self.prune_app_leases();

        let started_at = tokio::time::Instant::now();
        let mut start_attempted = false;
        loop {
            let status = self.status(project_id).await?;
            let state = status
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("not_started");
            match state {
                "running" => {
                    let health = self.app_health(project_id).await?;
                    match health.status.as_str() {
                        "ready" => break,
                        "failed" => bail!(
                            "{}: {}",
                            error_code::APP_UNHEALTHY,
                            health
                                .detail
                                .unwrap_or_else(|| "app health check failed".into())
                        ),
                        _ => {}
                    }
                }
                "starting" => {}
                "not_started" | "stopped" | "crashed" | "error" => {
                    if start_attempted {
                        let detail = status
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("app runtime is not ready");
                        bail!("{}: {detail}", error_code::APP_START_FAILED);
                    }
                    start_attempted = true;
                    self.start_dev(project_id)
                        .await
                        .map_err(|error| anyhow!("{}: {error}", error_code::APP_START_FAILED))?;
                }
                _ => {}
            }
            if started_at.elapsed() >= READY_TIMEOUT {
                bail!(
                    "{}: app runtime did not become ready within {} seconds",
                    error_code::APP_START_FAILED,
                    READY_TIMEOUT.as_secs()
                );
            }
            tokio::time::sleep(READY_POLL_INTERVAL).await;
        }

        let lease = RuntimeLease {
            lease_id: Uuid::new_v4().to_string(),
            app_id: manifest.app.id.clone(),
            expires_at_ms: unix_time_millis().saturating_add(APP_LEASE_TTL_MS),
            runtime_kind: manifest.runtime.kind,
        };
        self.app_leases
            .lock()
            .expect("app lease lock poisoned")
            .insert(project_id.to_string(), lease.clone());
        Ok(lease)
    }

    pub async fn invoke_app_capability(
        &self,
        project_id: &str,
        capability_id: &str,
        input: Value,
        ctx: &CallContext,
    ) -> Result<CapabilityResult> {
        let project_id = normalize_project_id(project_id)?;
        let manifest = self
            .app_manifest(project_id)?
            .ok_or_else(|| anyhow!("manifest_invalid: app manifest not found"))?;
        if !manifest
            .capabilities
            .iter()
            .any(|capability| capability.id == capability_id)
        {
            bail!(
                "{}: capability {capability_id} is not declared by {}",
                error_code::CAPABILITY_NOT_FOUND,
                manifest.app.id
            );
        }
        let token = self.ensure_app_token(project_id)?;
        self.ensure_app_ready(project_id).await?;
        let status = self.status(project_id).await?;
        let port = status
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|port| u16::try_from(port).ok())
            .ok_or_else(|| {
                anyhow!(
                    "{}: app runtime port is unavailable",
                    error_code::APP_START_FAILED
                )
            })?;
        invoke_with_runtime(port, &token, &manifest, capability_id, input, ctx, true).await
    }

    pub async fn discover_app_manifest(&self, project_id: &str) -> Result<Option<AppManifest>> {
        let status = self.status(project_id).await?;
        let Some(port) = status
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|port| u16::try_from(port).ok())
        else {
            return Ok(None);
        };
        let manifest = discover_at(port, DISCOVERY_TIMEOUT).await?;
        if let Some(manifest) = manifest.as_ref() {
            self.cache_app_manifest(normalize_project_id(project_id)?, manifest.clone());
        }
        Ok(manifest)
    }

    pub fn app_lease(&self, project_id: &str) -> Option<RuntimeLease> {
        self.app_leases
            .lock()
            .expect("app lease lock poisoned")
            .get(project_id.trim())
            .cloned()
    }

    fn prune_app_leases(&self) {
        let now = unix_time_millis();
        self.app_leases
            .lock()
            .expect("app lease lock poisoned")
            .retain(|_, lease| lease.expires_at_ms > now);
    }
}
