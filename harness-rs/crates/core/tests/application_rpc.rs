//! Direct `tool.call` and application management RPC coverage.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use worldbase_core::application::RunToolCatalog;
use worldbase_core::dispatcher::{dispatch, ConnectionContext};
use worldbase_core::hub::RunHandle;
use worldbase_core::Hub;
use worldbase_protocol::method;
use worldbase_protocol::rpc::{ErrorObject, METHOD_NOT_FOUND, SERVER_ERROR};
use worldbase_protocol::types::{
    error_code, AppHealth, ApplicationRecord, CallContext, Capabilities, CapabilityAvailability,
    CapabilityRecord, CapabilityResult, CapabilityRisk, ChatRunContext, RuntimeKind, RuntimeLease,
};
use worldbase_tools::{ApplicationCapabilityProvider, ToolServices};

struct EchoProvider;

#[async_trait]
impl ApplicationCapabilityProvider for EchoProvider {
    fn provider_ref(&self) -> &str {
        "test.echo"
    }

    async fn health(&self, _app: &ApplicationRecord) -> anyhow::Result<AppHealth> {
        Ok(AppHealth::ready())
    }

    async fn ensure_ready(
        &self,
        app: &ApplicationRecord,
        _ctx: &CallContext,
    ) -> anyhow::Result<RuntimeLease> {
        Ok(RuntimeLease {
            lease_id: "lease-test".into(),
            app_id: app.app_id.clone(),
            expires_at_ms: 0,
            runtime_kind: RuntimeKind::HostService,
        })
    }

    async fn invoke(
        &self,
        capability: &CapabilityRecord,
        input: Value,
        _ctx: &CallContext,
        _services: &ToolServices,
    ) -> anyhow::Result<CapabilityResult> {
        Ok(CapabilityResult::ok(json!({
            "capability": capability.capability_id,
            "input": input,
        })))
    }
}

fn setup() -> (Arc<Hub>, std::path::PathBuf) {
    let workspace = std::env::temp_dir().join(format!(
        "worldbase-application-rpc-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Arc::new(
        worldbase_memory::Store::open(&workspace.join("app.sqlite")).expect("open test store"),
    );
    let hub = Hub::new(workspace.clone(), store).expect("create test hub");
    (hub, workspace)
}

fn app_record(app_id: &str, capability_id: &str, risk: CapabilityRisk) -> ApplicationRecord {
    let tool_name = format!(
        "app__{}__{}",
        app_id.replace('.', "_"),
        capability_id.replace('.', "_")
    );
    ApplicationRecord {
        source_id: "test".into(),
        app_id: app_id.into(),
        name: app_id.into(),
        version: "1.0.0".into(),
        description: "test application".into(),
        tags: vec!["test".into()],
        trust_level: worldbase_protocol::types::TrustLevel::Builtin,
        enabled: true,
        platforms: Vec::new(),
        runtime_kind: RuntimeKind::HostService,
        capabilities: vec![CapabilityRecord {
            app_id: app_id.into(),
            capability_id: capability_id.into(),
            tool_name,
            title: capability_id.into(),
            description: "test capability".into(),
            input_schema: json!({ "type": "object" }),
            output_schema: None,
            risk,
            permissions: Vec::new(),
            data_scopes: Vec::new(),
            provider_ref: "test.echo".into(),
            availability: CapabilityAvailability::Available,
            side_effects: false,
            idempotent: true,
            deadline_ms: Some(5_000),
        }],
        health: AppHealth::ready(),
        last_seen_at: None,
        manifest_hash: "test-hash".into(),
        ai_ready: true,
    }
}

fn register_app(hub: &Arc<Hub>, app_id: &str, capability_id: &str, risk: CapabilityRisk) -> String {
    let record = app_record(app_id, capability_id, risk);
    let tool_name = record.capabilities[0].tool_name.clone();
    hub.application_registry
        .register(record, Arc::new(EchoProvider))
        .expect("register test application");
    tool_name
}

fn register_run(hub: &Arc<Hub>, token: &str, interactive: bool, auto_approve: bool) -> String {
    let stream_id = format!("stream-{}", uuid::Uuid::new_v4().simple());
    let catalog = RunToolCatalog::new(
        stream_id.clone(),
        token.to_string(),
        hub.application_registry.clone(),
        Vec::new(),
        Vec::new(),
        Capabilities::desktop(),
    );
    hub.register_run_catalog(&stream_id, token, catalog);
    hub.runs.lock().unwrap().insert(
        stream_id.clone(),
        RunHandle {
            conversation_id: "conversation-test".into(),
            abort: CancellationToken::new(),
            capabilities: Capabilities::desktop(),
            interactive,
            agent_id: None,
            provider_id: None,
            model: None,
            context: ChatRunContext {
                auto_approve_permissions: auto_approve,
                ..ChatRunContext::default()
            },
            group_collaboration: None,
            subagent_nesting_depth: 0,
        },
    );
    stream_id
}

async fn call(hub: &Arc<Hub>, method: &str, params: Value) -> Result<Value, ErrorObject> {
    let ctx = ConnectionContext::new(Capabilities::desktop());
    dispatch(hub, &ctx, method, params).await
}

fn error_code(error: &ErrorObject) -> Option<&str> {
    error
        .data
        .as_ref()
        .and_then(|data| data.get("code"))
        .and_then(Value::as_str)
}

#[tokio::test]
async fn direct_app_tool_call_requires_a_run_token() {
    let (hub, workspace) = setup();
    let tool_name = register_app(&hub, "test.echo", "echo.say", CapabilityRisk::Read);

    let error = call(
        &hub,
        method::TOOL_CALL,
        json!({ "name": tool_name, "args": {} }),
    )
    .await
    .expect_err("app tool without a run token must be rejected");
    assert_eq!(error.code, SERVER_ERROR);
    assert_eq!(
        error_code(&error),
        Some(error_code::RUN_CAPABILITY_TOKEN_REQUIRED)
    );

    let _ = std::fs::remove_dir_all(workspace);
}

#[tokio::test]
async fn direct_app_tool_call_rejects_invalid_tokens_and_inactive_capabilities() {
    let (hub, workspace) = setup();
    let tool_name = register_app(&hub, "test.echo", "echo.say", CapabilityRisk::Read);
    let token = "valid-token";
    register_run(&hub, token, true, false);

    let error = call(
        &hub,
        method::TOOL_CALL,
        json!({
            "name": tool_name,
            "args": {},
            "runCapabilityToken": "not-a-token",
        }),
    )
    .await
    .expect_err("invalid token must be rejected");
    assert_eq!(
        error_code(&error),
        Some(error_code::RUN_CAPABILITY_TOKEN_INVALID)
    );

    let error = call(
        &hub,
        method::TOOL_CALL,
        json!({
            "name": tool_name,
            "args": {},
            "run_capability_token": token,
        }),
    )
    .await
    .expect_err("inactive capability must be rejected");
    assert_eq!(error_code(&error), Some(error_code::CAPABILITY_NOT_ACTIVE));

    let _ = std::fs::remove_dir_all(workspace);
}

#[tokio::test]
async fn activated_app_tool_runs_with_a_valid_token_and_is_audited() {
    let (hub, workspace) = setup();
    let tool_name = register_app(&hub, "test.echo", "echo.say", CapabilityRisk::Read);
    let token = "run-token-success";
    register_run(&hub, token, true, false);

    let activation = call(
        &hub,
        method::APPLICATION_ACTIVATE,
        json!({
            "toolNames": [tool_name],
            "runCapabilityToken": token,
        }),
    )
    .await
    .expect("activate application capability");
    assert_eq!(activation["activated"], json!([tool_name]));

    let result = call(
        &hub,
        method::TOOL_CALL,
        json!({
            "name": tool_name,
            "args": { "message": "hello" },
            "runCapabilityToken": token,
        }),
    )
    .await
    .expect("direct tool.call with a valid token");
    assert_eq!(result["status"], "ok");
    assert_eq!(result["data"]["capability"], "echo.say");
    assert_eq!(result["data"]["input"]["message"], "hello");

    let audit = call(&hub, method::APPLICATION_AUDIT_LIST, json!({}))
        .await
        .expect("list audit");
    let audits = audit["audits"].as_array().expect("audit array");
    assert!(audits.iter().any(|entry| {
        entry["appId"] == "test.echo"
            && entry["capabilityId"] == "echo.say"
            && entry["status"] == "ok"
    }));

    let _ = std::fs::remove_dir_all(workspace);
}

#[tokio::test]
async fn application_management_rpcs_round_trip() {
    let (hub, workspace) = setup();
    register_app(&hub, "test.echo", "echo.say", CapabilityRisk::Read);

    let listed = call(&hub, method::APPLICATION_LIST, json!({}))
        .await
        .expect("application.list");
    let applications = listed["applications"].as_array().expect("applications");
    assert!(applications.iter().any(|app| app["appId"] == "test.echo"));

    let fetched = call(
        &hub,
        method::APPLICATION_GET,
        json!({ "appId": "test.echo" }),
    )
    .await
    .expect("application.get");
    assert_eq!(fetched["application"]["appId"], "test.echo");

    let disabled = call(
        &hub,
        method::APPLICATION_SET_ENABLED,
        json!({ "appId": "test.echo", "enabled": false }),
    )
    .await
    .expect("application.setEnabled");
    assert_eq!(disabled["application"]["enabled"], false);

    let grant = call(
        &hub,
        method::APPLICATION_GRANTS_SAVE,
        json!({
            "appId": "test.echo",
            "capabilityPattern": "echo.*",
            "permissions": ["echo.read"],
            "dataScope": ["workspace"],
            "mode": "allow",
        }),
    )
    .await
    .expect("application.grants.save");
    let grant_id = grant["grant"]["id"].as_str().expect("grant id").to_string();

    let grants = call(
        &hub,
        method::APPLICATION_GRANTS_LIST,
        json!({ "app_id": "test.echo" }),
    )
    .await
    .expect("application.grants.list");
    assert_eq!(grants["grants"][0]["id"], grant_id);

    let revoked = call(
        &hub,
        method::APPLICATION_GRANTS_REVOKE,
        json!({ "grantId": grant_id }),
    )
    .await
    .expect("application.grants.revoke");
    assert_eq!(revoked["revoked"], true);

    let refreshed = call(&hub, method::APPLICATION_REFRESH, json!({}))
        .await
        .expect("application.refresh");
    assert!(refreshed["catalogVersion"].as_u64().unwrap() > 0);

    let _ = std::fs::remove_dir_all(workspace);
}

#[tokio::test]
async fn application_search_activates_with_a_run_token() {
    let (hub, workspace) = setup();
    let tool_name = register_app(&hub, "test.echo", "echo.say", CapabilityRisk::Read);
    let token = "run-token-search";
    register_run(&hub, token, true, false);

    let result = call(
        &hub,
        method::APPLICATION_SEARCH,
        json!({ "query": tool_name, "runCapabilityToken": token }),
    )
    .await
    .expect("application.search");
    assert!(result["activated"]
        .as_array()
        .unwrap()
        .iter()
        .any(|name| name == &tool_name));

    let error = call(&hub, method::APPLICATION_SEARCH, json!({ "query": "echo" }))
        .await
        .expect_err("search without a token must be rejected");
    assert_eq!(
        error_code(&error),
        Some(error_code::RUN_CAPABILITY_TOKEN_REQUIRED)
    );

    let _ = std::fs::remove_dir_all(workspace);
}

#[tokio::test]
async fn unattended_risk_policy_never_auto_approves_destructive_capabilities() {
    let (hub, workspace) = setup();
    let destructive = register_app(
        &hub,
        "test.destructive",
        "destructive.run",
        CapabilityRisk::WriteDestructive,
    );
    let reversible = register_app(
        &hub,
        "test.reversible",
        "reversible.write",
        CapabilityRisk::WriteReversible,
    );
    let token = "run-token-unattended";
    register_run(&hub, token, false, true);

    call(
        &hub,
        method::APPLICATION_ACTIVATE,
        json!({
            "toolNames": [destructive, reversible],
            "runCapabilityToken": token,
        }),
    )
    .await
    .expect("activate risk test capabilities");

    let error = call(
        &hub,
        method::TOOL_CALL,
        json!({
            "name": destructive,
            "args": {},
            "runCapabilityToken": token,
        }),
    )
    .await
    .expect_err("destructive capability must not be auto-approved");
    assert_eq!(error_code(&error), Some(error_code::PERMISSION_REQUIRED));

    let result = call(
        &hub,
        method::TOOL_CALL,
        json!({
            "name": reversible,
            "args": {},
            "runCapabilityToken": token,
        }),
    )
    .await
    .expect("reversible capability is allowed by the saved task policy");
    assert_eq!(result["status"], "ok");

    let audit = call(
        &hub,
        method::APPLICATION_AUDIT_LIST,
        json!({ "appId": "test.destructive" }),
    )
    .await
    .expect("list denied audit");
    assert_eq!(audit["audits"][0]["status"], "denied");

    let _ = std::fs::remove_dir_all(workspace);
}

#[tokio::test]
async fn application_invoke_delegates_to_the_same_tool_path() {
    let (hub, workspace) = setup();
    register_app(&hub, "test.echo", "echo.say", CapabilityRisk::Read);
    let token = "run-token-invoke";
    register_run(&hub, token, true, false);

    call(
        &hub,
        method::APPLICATION_ACTIVATE,
        json!({
            "toolNames": ["app__test_echo__echo_say"],
            "runCapabilityToken": token,
        }),
    )
    .await
    .expect("activate for invoke");

    let result = call(
        &hub,
        method::APPLICATION_INVOKE,
        json!({
            "appId": "test.echo",
            "capabilityId": "echo.say",
            "input": { "value": 7 },
            "runCapabilityToken": token,
        }),
    )
    .await
    .expect("application.invoke");
    assert_eq!(result["status"], "ok");
    assert_eq!(result["data"]["input"]["value"], 7);

    let _ = std::fs::remove_dir_all(workspace);
}

#[tokio::test]
async fn application_host_state_changed_updates_capability_availability() {
    let (hub, workspace) = setup();
    register_app(&hub, "test.echo", "echo.say", CapabilityRisk::Read);
    let before = hub.application_registry.version();

    let result = call(
        &hub,
        method::APPLICATION_HOST_STATE_CHANGED,
        json!({
            "hostCapabilityId": "test.echo",
            "availability": "unavailable",
            "stateVersion": 3,
        }),
    )
    .await
    .expect("application.host.state.changed");
    assert_eq!(result["updated"], json!(["test.echo"]));
    assert!(hub.application_registry.version() > before);
    let capability = hub
        .application_registry
        .capabilities_for("test.echo")
        .into_iter()
        .next()
        .expect("capability");
    assert_eq!(capability.availability, CapabilityAvailability::Unavailable);

    let _ = std::fs::remove_dir_all(workspace);
}

#[tokio::test]
async fn unsupported_methods_still_return_method_not_found() {
    let (hub, workspace) = setup();
    let error = call(&hub, "application.unknown", json!({}))
        .await
        .expect_err("unsupported method");
    assert_eq!(error.code, METHOD_NOT_FOUND);
    let _ = std::fs::remove_dir_all(workspace);
}
