use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};
use tempfile::TempDir;
use worldbase_protocol::types::{
    ApplicationRecord, CallContext, CapabilityRecord, CapabilityRisk, RuntimeKind, TrustLevel,
};
use worldbase_tools::application::builtin_apps::{
    builtin_application_manifests, DATA_APP_ID, DOCUMENTS_APP_ID, HOST_APP_ID, PROJECTS_APP_ID,
};
use worldbase_tools::application::{
    ApplicationCapabilityProvider, CapabilityTool, ElectronHostCapabilityProvider,
    ManagedAppCapabilityProvider, NativeToolCapabilityProvider, MAX_CAPABILITY_OUTPUT_BYTES,
};
use worldbase_tools::host_bridge::HostChannel;
use worldbase_tools::{
    DocDraftTool, DocumentListTool, DocumentReadTool, HostBridge, ProjectListTool,
    ProjectStatusTool, QueryProjectDatabaseTool, Tool, ToolServices,
};

struct EchoTool {
    name: &'static str,
}

#[async_trait]
impl Tool for EchoTool {
    fn name(&self) -> &str {
        self.name
    }

    fn description(&self) -> &str {
        "Echo the input"
    }

    fn input_schema(&self) -> Value {
        json!({"type": "object"})
    }

    async fn execute(&self, input: Value, _services: &ToolServices) -> Result<Value> {
        Ok(json!({ "echo": input }))
    }
}

struct SlowTool;

#[async_trait]
impl Tool for SlowTool {
    fn name(&self) -> &str {
        "slow_tool"
    }

    fn description(&self) -> &str {
        "Sleep before returning"
    }

    fn input_schema(&self) -> Value {
        json!({"type": "object"})
    }

    async fn execute(&self, _input: Value, _services: &ToolServices) -> Result<Value> {
        tokio::time::sleep(Duration::from_millis(100)).await;
        Ok(json!({ "done": true }))
    }
}

struct HugeTool;

#[async_trait]
impl Tool for HugeTool {
    fn name(&self) -> &str {
        "huge_tool"
    }

    fn description(&self) -> &str {
        "Return a result larger than the provider bound"
    }

    fn input_schema(&self) -> Value {
        json!({"type": "object"})
    }

    async fn execute(&self, _input: Value, _services: &ToolServices) -> Result<Value> {
        Ok(json!({
            "payload": "x".repeat(MAX_CAPABILITY_OUTPUT_BYTES + 1)
        }))
    }
}

struct WrongShapeTool;

#[async_trait]
impl Tool for WrongShapeTool {
    fn name(&self) -> &str {
        "wrong_shape_tool"
    }

    fn description(&self) -> &str {
        "Return a string even though the capability declares an object"
    }

    fn input_schema(&self) -> Value {
        json!({"type": "object"})
    }

    async fn execute(&self, _input: Value, _services: &ToolServices) -> Result<Value> {
        Ok(json!("not-an-object"))
    }
}

struct FakeHostChannel {
    response: Value,
    delay: Duration,
    calls: Mutex<Vec<Value>>,
}

impl FakeHostChannel {
    fn new(response: Value) -> Self {
        Self {
            response,
            delay: Duration::ZERO,
            calls: Mutex::new(Vec::new()),
        }
    }

    fn with_delay(mut self, delay: Duration) -> Self {
        self.delay = delay;
        self
    }
}

#[async_trait]
impl HostChannel for FakeHostChannel {
    async fn request(
        &self,
        _stream_id: &str,
        _kind: &str,
        payload: Value,
        _timeout: Duration,
    ) -> Result<Value> {
        self.calls.lock().unwrap().push(payload);
        if !self.delay.is_zero() {
            tokio::time::sleep(self.delay).await;
        }
        Ok(self.response.clone())
    }
}

struct Fixture {
    _temp: TempDir,
    projects: PathBuf,
    services: ToolServices,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::Builder::new()
            .prefix("worldbase-application-providers-")
            .tempdir()
            .expect("create temp root");
        let workspace = temp.path().join("workspace");
        let projects = temp.path().join("projects");
        std::fs::create_dir_all(&workspace).expect("create workspace");
        std::fs::create_dir_all(&projects).expect("create projects root");
        let workspace = workspace.canonicalize().expect("canonicalize workspace");
        let projects = projects.canonicalize().expect("canonicalize projects");
        let store = Arc::new(
            worldbase_memory::Store::open(&temp.path().join("store.sqlite")).expect("open store"),
        );
        let services = ToolServices {
            host: Arc::new(HostBridge::new()),
            current_stream: Arc::new(Mutex::new(String::new())),
            abort: None,
            workspace: workspace.clone(),
            folder_workspace: None,
            target_project_id: None,
            created_project_id: Arc::new(Mutex::new(None)),
            allowed_mcp_server_ids: None,
            plan_goal: Arc::new(Mutex::new(None)),
            todo_items: Arc::new(Mutex::new(Vec::new())),
            read_files: Arc::new(Mutex::new(HashSet::new())),
            visible_tool_catalog: None,
            catalog_runtime: None,
            conversation_id: None,
            store: store.clone(),
            memory_queue: None,
            memory_scopes: Vec::new(),
            skills: Arc::new(worldbase_skills::SkillRegistry::new(vec![])),
            scheduler: Arc::new(worldbase_scheduler::Scheduler::new(store)),
            mcp: Arc::new(worldbase_mcp_client::McpManager::default()),
            projects: Arc::new(worldbase_project_runtime::ProjectRuntime::new(
                projects.clone(),
            )),
            group_collaboration: None,
            subagent_runtime: None,
        };
        Self {
            _temp: temp,
            projects,
            services,
        }
    }
}

fn context(deadline_ms: u64) -> CallContext {
    CallContext {
        call_id: "call-1".into(),
        conversation_id: Some("conversation-1".into()),
        app_id: "worldbase.test".into(),
        data_scope: Vec::new(),
        deadline_ms,
        idempotency_key: Some("idem-1".into()),
    }
}

fn app_record(app_id: &str) -> ApplicationRecord {
    ApplicationRecord {
        source_id: format!("test:{app_id}"),
        app_id: app_id.into(),
        name: app_id.into(),
        version: "1.0.0".into(),
        trust_level: TrustLevel::Builtin,
        enabled: true,
        runtime_kind: RuntimeKind::HostService,
        ..ApplicationRecord::default()
    }
}

fn capability(
    app_id: &str,
    capability_id: &str,
    provider_ref: &str,
    risk: CapabilityRisk,
) -> CapabilityRecord {
    CapabilityRecord {
        app_id: app_id.into(),
        capability_id: capability_id.into(),
        tool_name: format!("app__{app_id}__{capability_id}"),
        title: capability_id.into(),
        description: capability_id.into(),
        input_schema: json!({"type": "object"}),
        risk,
        provider_ref: provider_ref.into(),
        ..CapabilityRecord::default()
    }
}

fn find_manifest<'a>(
    manifests: &'a [(
        worldbase_protocol::types::AppManifest,
        Arc<dyn ApplicationCapabilityProvider>,
    )],
    app_id: &str,
) -> &'a (
    worldbase_protocol::types::AppManifest,
    Arc<dyn ApplicationCapabilityProvider>,
) {
    manifests
        .iter()
        .find(|(manifest, _)| manifest.app.id == app_id)
        .expect("application manifest")
}

#[tokio::test]
async fn native_provider_reports_health_ready_and_routes_by_operation() {
    let fixture = Fixture::new();
    let provider = NativeToolCapabilityProvider::from_tools(
        "native:test",
        vec![
            Arc::new(EchoTool {
                name: "list_documents",
            }) as Arc<dyn Tool>,
            Arc::new(EchoTool {
                name: "read_document",
            }) as Arc<dyn Tool>,
        ],
    );
    let app = app_record(DOCUMENTS_APP_ID);
    assert_eq!(provider.health(&app).await.unwrap().status, "ready");

    let lease = provider
        .ensure_ready(&app, &context(5_000))
        .await
        .expect("ensure_ready");
    assert_eq!(lease.app_id, app.app_id);
    assert_eq!(lease.runtime_kind, RuntimeKind::HostService);

    let cap = capability(
        DOCUMENTS_APP_ID,
        "doc.read",
        "read_document",
        CapabilityRisk::Read,
    );
    let result = provider
        .invoke(
            &cap,
            json!({"artifact_id": "a1"}),
            &context(5_000),
            &fixture.services,
        )
        .await
        .expect("invoke");
    assert_eq!(result.status, "ok");
    assert_eq!(result.data["echo"]["artifact_id"], "a1");
}

#[tokio::test]
async fn native_provider_honors_deadline() {
    let fixture = Fixture::new();
    let provider = NativeToolCapabilityProvider::new("native:slow", Arc::new(SlowTool));
    let cap = capability(
        "worldbase.test",
        "test.slow",
        "slow_tool",
        CapabilityRisk::Read,
    );
    let error = provider
        .invoke(&cap, json!({}), &context(10), &fixture.services)
        .await
        .expect_err("deadline must be enforced");
    assert!(error.to_string().contains("operation_timeout"), "{error}");
}

#[tokio::test]
async fn native_provider_bounds_output_and_validates_shape() {
    let fixture = Fixture::new();
    let huge = NativeToolCapabilityProvider::new("native:huge", Arc::new(HugeTool));
    let cap = capability(
        "worldbase.test",
        "test.huge",
        "huge_tool",
        CapabilityRisk::Read,
    );
    let error = huge
        .invoke(&cap, json!({}), &context(5_000), &fixture.services)
        .await
        .expect_err("oversized output must be rejected");
    assert!(
        error.to_string().contains("output_schema_invalid"),
        "{error}"
    );

    let wrong = NativeToolCapabilityProvider::new("native:wrong", Arc::new(WrongShapeTool));
    let mut cap = capability(
        "worldbase.test",
        "test.wrong",
        "wrong_shape_tool",
        CapabilityRisk::Read,
    );
    cap.output_schema = Some(json!({"type": "object"}));
    let error = wrong
        .invoke(&cap, json!({}), &context(5_000), &fixture.services)
        .await
        .expect_err("wrong output shape must be rejected");
    assert!(
        error.to_string().contains("output_schema_invalid"),
        "{error}"
    );
}

#[tokio::test]
async fn capability_tool_maps_risk_to_permission() {
    let provider: Arc<dyn ApplicationCapabilityProvider> = Arc::new(
        NativeToolCapabilityProvider::new("native:echo", Arc::new(EchoTool { name: "echo" })),
    );
    let app = app_record("worldbase.test");
    for (risk, expected) in [
        (CapabilityRisk::Read, "allow"),
        (CapabilityRisk::WriteReversible, "ask"),
        (CapabilityRisk::WriteDestructive, "ask"),
        (CapabilityRisk::ExternalEffect, "ask"),
    ] {
        let cap = capability("worldbase.test", "test.echo", "echo", risk);
        let tool = CapabilityTool::new(Arc::clone(&provider), app.clone(), cap.clone());
        assert_eq!(tool.name(), cap.tool_name);
        assert_eq!(tool.permission(), expected);
        assert_eq!(tool.risk(), Some(risk));
        assert!(tool.electron_native());
        assert_eq!(tool.source(), Some("app:worldbase.test"));
        assert_eq!(
            tool.visibility(),
            worldbase_protocol::types::ToolVisibility::Discoverable
        );
    }
}

#[tokio::test]
async fn builtin_manifests_cover_first_party_apps() {
    let tools: Vec<Arc<dyn Tool>> = vec![
        Arc::new(DocumentListTool),
        Arc::new(DocumentReadTool),
        Arc::new(DocDraftTool),
        Arc::new(ProjectListTool),
        Arc::new(ProjectStatusTool),
        Arc::new(QueryProjectDatabaseTool),
    ];
    let manifests = builtin_application_manifests(&tools);
    assert_eq!(manifests.len(), 4);

    let (documents, documents_provider) = find_manifest(&manifests, DOCUMENTS_APP_ID);
    assert_eq!(documents.app.trust_level, TrustLevel::Builtin);
    assert_eq!(documents.app.platforms, ["desktop", "cli", "mobile"]);
    assert_eq!(documents.runtime.kind, RuntimeKind::HostService);
    assert_eq!(
        documents
            .capabilities
            .iter()
            .map(|capability| capability.id.as_str())
            .collect::<Vec<_>>(),
        ["doc.list", "doc.read", "doc.draft"]
    );
    assert_eq!(
        documents.capabilities[2].risk,
        CapabilityRisk::WriteReversible
    );
    assert_eq!(
        documents_provider.provider_ref(),
        "native:worldbase.documents"
    );

    let (projects, _) = find_manifest(&manifests, PROJECTS_APP_ID);
    assert_eq!(
        projects
            .capabilities
            .iter()
            .map(|capability| capability.operation.as_str())
            .collect::<Vec<_>>(),
        ["project_list", "get_project_status"]
    );

    let (data, _) = find_manifest(&manifests, DATA_APP_ID);
    assert_eq!(data.capabilities.len(), 1);
    assert_eq!(data.capabilities[0].operation, "query_project_database");

    let (host, host_provider) = find_manifest(&manifests, HOST_APP_ID);
    assert_eq!(host.app.platforms, ["desktop"]);
    assert_eq!(host.runtime.kind, RuntimeKind::ElectronHost);
    assert_eq!(
        host.capabilities
            .iter()
            .map(|capability| capability.id.as_str())
            .collect::<Vec<_>>(),
        ["host.pick_file", "host.open_external", "host.notify"]
    );
    assert_eq!(
        host.capabilities
            .iter()
            .map(|capability| capability.operation.as_str())
            .collect::<Vec<_>>(),
        [
            "host.fs.pick_file",
            "host.shell.open_external",
            "host.notification.show"
        ]
    );
    assert_eq!(host.capabilities[1].risk, CapabilityRisk::ExternalEffect);
    assert!(host.capabilities[1].side_effects);
    assert_eq!(host_provider.provider_ref(), "electron:host");
}

#[tokio::test]
async fn builtin_manifests_skip_missing_tools() {
    let manifests = builtin_application_manifests(&[Arc::new(DocumentListTool)]);
    assert_eq!(manifests.len(), 2);
    let (documents, _) = find_manifest(&manifests, DOCUMENTS_APP_ID);
    assert_eq!(
        documents
            .capabilities
            .iter()
            .map(|capability| capability.id.as_str())
            .collect::<Vec<_>>(),
        ["doc.list"]
    );
    assert!(manifests
        .iter()
        .all(|(manifest, _)| manifest.app.id != PROJECTS_APP_ID));
    assert!(manifests
        .iter()
        .all(|(manifest, _)| manifest.app.id != DATA_APP_ID));
}

#[tokio::test]
async fn host_provider_rejects_unlisted_capability() {
    let fixture = Fixture::new();
    let provider = ElectronHostCapabilityProvider::new("electron:host");
    let cap = capability(
        HOST_APP_ID,
        "host.delete",
        "host.fs.delete_file",
        CapabilityRisk::WriteDestructive,
    );
    let error = provider
        .invoke(&cap, json!({}), &context(5_000), &fixture.services)
        .await
        .expect_err("host allowlist must reject unknown capabilities");
    assert!(
        error.to_string().contains("provider_unavailable"),
        "{error}"
    );
    assert_eq!(
        ElectronHostCapabilityProvider::allowed_capability_ids(),
        [
            "host.fs.pick_file",
            "host.shell.open_external",
            "host.notification.show"
        ]
    );
}

#[tokio::test]
async fn builtin_host_provider_uses_fixed_allowlist() {
    let fixture = Fixture::new();
    let manifests = builtin_application_manifests(&[]);
    let (_, provider) = find_manifest(&manifests, HOST_APP_ID);
    let cap = capability(
        HOST_APP_ID,
        "host.spawn_shell",
        "host.shell.spawn",
        CapabilityRisk::ExternalEffect,
    );
    let error = provider
        .invoke(&cap, json!({}), &context(5_000), &fixture.services)
        .await
        .expect_err("built-in host provider must reject unlisted capabilities");
    assert!(
        error.to_string().contains("provider_unavailable"),
        "{error}"
    );
}

#[tokio::test]
async fn host_provider_requires_stream_and_validates_response() {
    let fixture = Fixture::new();
    let channel = Arc::new(FakeHostChannel::new(json!({
        "status": "ok",
        "output": {"paths": ["/tmp/a.txt"]},
        "warnings": ["picked"]
    })));
    fixture.services.host.set(channel.clone());
    let provider = ElectronHostCapabilityProvider::new("electron:host");
    let cap = capability(
        HOST_APP_ID,
        "host.pick_file",
        "host.fs.pick_file",
        CapabilityRisk::Read,
    );

    let error = provider
        .invoke(&cap, json!({}), &context(5_000), &fixture.services)
        .await
        .expect_err("stream is required");
    assert!(
        error.to_string().contains("requires a run stream"),
        "{error}"
    );

    fixture.services.set_current_stream("stream-1");
    let result = provider
        .invoke(
            &cap,
            json!({"title": "Pick"}),
            &context(5_000),
            &fixture.services,
        )
        .await
        .expect("invoke host capability");
    assert_eq!(result.status, "ok");
    assert_eq!(result.data["paths"][0], "/tmp/a.txt");
    assert_eq!(result.warnings, ["picked"]);
    assert!(!result.runtime.expect("runtime info").started_for_call);
    let calls = channel.calls.lock().unwrap();
    assert_eq!(calls[0]["registeredHostCapabilityId"], "host.fs.pick_file");
    assert_eq!(calls[0]["callId"], "call-1");
}

#[tokio::test]
async fn host_provider_maps_error_response_and_deadline() {
    let fixture = Fixture::new();
    fixture.services.set_current_stream("stream-1");
    let provider = ElectronHostCapabilityProvider::new("electron:host");
    let cap = capability(
        HOST_APP_ID,
        "host.open_external",
        "host.shell.open_external",
        CapabilityRisk::ExternalEffect,
    );

    fixture
        .services
        .host
        .set(Arc::new(FakeHostChannel::new(json!({
            "status": "error",
            "errorCode": "operation_cancelled",
            "message": "user dismissed"
        }))));
    let error = provider
        .invoke(
            &cap,
            json!({"url": "https://example.com"}),
            &context(5_000),
            &fixture.services,
        )
        .await
        .expect_err("host error response");
    assert!(error.to_string().contains("operation_cancelled"), "{error}");

    fixture.services.host.set(Arc::new(
        FakeHostChannel::new(json!({"status": "ok", "output": {"opened": true}}))
            .with_delay(Duration::from_millis(100)),
    ));
    let error = provider
        .invoke(
            &cap,
            json!({"url": "https://example.com"}),
            &context(10),
            &fixture.services,
        )
        .await
        .expect_err("host deadline");
    assert!(error.to_string().contains("operation_timeout"), "{error}");
}

fn write_managed_project(projects: &Path, project_id: &str) {
    let root = projects.join(project_id).join(".worldbase");
    std::fs::create_dir_all(&root).expect("create manifest dir");
    let manifest = json!({
        "schemaVersion": 1,
        "app": {
            "id": "worldbase.managed.tasks",
            "name": "Tasks",
            "version": "1.0.0",
            "description": "Managed tasks",
            "tags": ["tasks"],
            "platforms": ["desktop"],
            "trustLevel": "community"
        },
        "runtime": { "kind": "managed_project", "activation": "on-demand" },
        "capabilities": [{
            "id": "tasks.list",
            "title": "List tasks",
            "description": "List tasks",
            "inputSchema": { "type": "object" },
            "operation": "tasks.list",
            "risk": "read"
        }]
    });
    std::fs::write(
        root.join("app-capabilities.json"),
        serde_json::to_vec(&manifest).expect("serialize manifest"),
    )
    .expect("write manifest");
}

#[tokio::test]
async fn managed_provider_delegates_health_and_rejects_undeclared_capability() {
    let fixture = Fixture::new();
    write_managed_project(&fixture.projects, "alpha");
    let runtime = Arc::clone(&fixture.services.projects);
    let provider = ManagedAppCapabilityProvider::new(runtime, "alpha", "manifest-hash");
    assert_eq!(provider.provider_ref(), "alpha");
    assert_eq!(provider.project_id(), "alpha");
    assert_eq!(provider.manifest_hash(), "manifest-hash");

    let mut app = app_record("worldbase.managed.tasks");
    app.manifest_hash = "manifest-hash".into();
    let health = provider.health(&app).await.expect("health");
    assert_eq!(health.status, "unavailable");

    let mut stale = app.clone();
    stale.manifest_hash = "other-hash".into();
    let error = provider
        .health(&stale)
        .await
        .expect_err("stale manifest hash must be rejected");
    assert!(error.to_string().contains("manifest_invalid"), "{error}");

    let cap = capability(
        "worldbase.managed.tasks",
        "tasks.missing",
        "tasks.missing",
        CapabilityRisk::Read,
    );
    let error = provider
        .invoke(&cap, json!({}), &context(5_000), &fixture.services)
        .await
        .expect_err("undeclared capability must be rejected");
    assert!(
        error.to_string().contains("capability_not_found"),
        "{error}"
    );
}

#[test]
fn capability_schema_validation_enforces_required_types_and_ranges() {
    let schema = json!({
        "type": "object",
        "properties": {
            "query": { "type": "string", "minLength": 2 },
            "limit": { "type": "integer", "minimum": 1, "maximum": 10 }
        },
        "required": ["query"],
        "additionalProperties": false
    });
    worldbase_tools::application::validate_schema_value(
        &schema,
        &json!({ "query": "ok", "limit": 3 }),
        "$",
    )
    .expect("valid input");

    for invalid in [
        json!({ "limit": 3 }),
        json!({ "query": "x" }),
        json!({ "query": "ok", "limit": 0 }),
        json!({ "query": "ok", "extra": true }),
        json!({ "query": "ok", "limit": "3" }),
    ] {
        assert!(
            worldbase_tools::application::validate_schema_value(&schema, &invalid, "$").is_err(),
            "invalid input was accepted: {invalid}"
        );
    }
}
