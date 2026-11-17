//! Application registry: validation, persistence, grants, audit and search.

use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};
use worldbase_core::application::ApplicationRegistry;
use worldbase_memory::Store;
use worldbase_protocol::types::{
    AppHealth, AppManifest, ApplicationCallAudit, ApplicationGrant, ApplicationRecord,
    ApplicationSearchParams, CallContext, Capabilities, CapabilityAvailability, CapabilityRecord,
    CapabilityResult, CapabilityRisk, RuntimeKind, RuntimeLease, TrustLevel,
};
use worldbase_tools::{ApplicationCapabilityProvider, Tool, ToolServices};

struct FakeProvider {
    provider_ref: String,
}

impl FakeProvider {
    fn new(name: &str) -> Arc<Self> {
        Arc::new(Self {
            provider_ref: name.into(),
        })
    }
}

#[async_trait]
impl ApplicationCapabilityProvider for FakeProvider {
    fn provider_ref(&self) -> &str {
        &self.provider_ref
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
            lease_id: "lease".into(),
            app_id: app.app_id.clone(),
            expires_at_ms: 0,
            runtime_kind: app.runtime_kind,
        })
    }

    async fn invoke(
        &self,
        capability: &CapabilityRecord,
        _input: Value,
        _ctx: &CallContext,
        _services: &ToolServices,
    ) -> anyhow::Result<CapabilityResult> {
        Ok(CapabilityResult::ok(json!({
            "provider": self.provider_ref,
            "capability": capability.capability_id
        })))
    }
}

struct FakeTool {
    name: String,
}

impl FakeTool {
    fn new(name: &str) -> Arc<Self> {
        Arc::new(Self { name: name.into() })
    }
}

#[async_trait]
impl Tool for FakeTool {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> &str {
        "fake builtin tool"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "query": { "type": "string" } }
        })
    }

    async fn execute(&self, _input: Value, _services: &ToolServices) -> anyhow::Result<Value> {
        Ok(json!({ "tool": self.name }))
    }
}

fn open_store(dir: &tempfile::TempDir) -> Arc<Store> {
    Arc::new(Store::open(&dir.path().join("registry.sqlite")).unwrap())
}

fn capability(app_id: &str, capability_id: &str, risk: CapabilityRisk) -> CapabilityRecord {
    CapabilityRecord {
        app_id: app_id.into(),
        capability_id: capability_id.into(),
        tool_name: String::new(),
        title: format!("Capability {capability_id}"),
        description: format!("Does {capability_id}"),
        input_schema: json!({
            "type": "object",
            "properties": { "query": { "type": "string" } }
        }),
        output_schema: None,
        risk,
        permissions: vec![risk.default_permission().into()],
        data_scopes: vec!["workspace".into()],
        provider_ref: capability_id.into(),
        availability: CapabilityAvailability::Available,
        side_effects: false,
        idempotent: true,
        deadline_ms: None,
    }
}

fn application(
    app_id: &str,
    platforms: &[&str],
    capabilities: Vec<CapabilityRecord>,
) -> ApplicationRecord {
    ApplicationRecord {
        source_id: "local".into(),
        app_id: app_id.into(),
        name: format!("App {app_id}"),
        version: "1.0.0".into(),
        description: "test application".into(),
        tags: vec!["test".into()],
        trust_level: TrustLevel::Community,
        enabled: true,
        platforms: platforms.iter().map(|value| (*value).to_string()).collect(),
        runtime_kind: RuntimeKind::ManagedProject,
        capabilities,
        health: AppHealth::unknown(),
        last_seen_at: None,
        manifest_hash: String::new(),
        ai_ready: true,
    }
}

fn manifest(app_id: &str, capability_ids: &[&str]) -> AppManifest {
    serde_json::from_value(json!({
        "schemaVersion": 1,
        "app": {
            "id": app_id,
            "name": app_id,
            "version": "1.0.0",
            "platforms": ["desktop"],
            "trustLevel": "community"
        },
        "runtime": { "kind": "managed_project" },
        "capabilities": capability_ids.iter().map(|id| json!({
            "id": id,
            "title": id,
            "description": id,
            "inputSchema": { "type": "object" },
            "operation": id,
            "risk": "read"
        })).collect::<Vec<_>>()
    }))
    .unwrap()
}

#[tokio::test]
async fn application_registry_register_list_enable_disable_and_reload() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(&dir);
    let registry = ApplicationRegistry::new(store.clone());

    let record = application(
        "worldbase.tasks",
        &["desktop"],
        vec![capability(
            "worldbase.tasks",
            "task.search",
            CapabilityRisk::Read,
        )],
    );
    registry
        .register(record, FakeProvider::new("first"))
        .unwrap();

    let loaded = registry.list();
    assert_eq!(loaded.len(), 1);
    assert!(!loaded[0].enabled, "managed applications default disabled");
    assert_eq!(loaded[0].manifest_hash.len(), 64);
    assert_eq!(
        loaded[0].capabilities[0].tool_name,
        "app__worldbase_tasks__task_search"
    );
    assert_eq!(
        registry.get("worldbase.tasks").unwrap().capabilities[0].availability,
        CapabilityAvailability::Disabled
    );
    assert!(registry
        .find_capability("app__worldbase_tasks__task_search")
        .is_some());

    let before = registry.version();
    registry.set_enabled("worldbase.tasks", true).unwrap();
    assert!(registry.version() > before);
    assert!(registry.get("worldbase.tasks").unwrap().enabled);
    assert_eq!(
        registry.get("worldbase.tasks").unwrap().capabilities[0].availability,
        CapabilityAvailability::Available
    );

    registry.replace_provider("worldbase.tasks", FakeProvider::new("second"));
    assert_eq!(
        registry
            .provider_for("worldbase.tasks")
            .unwrap()
            .provider_ref(),
        "second"
    );

    let reloaded = ApplicationRegistry::new(store);
    let app = reloaded.get("worldbase.tasks").unwrap();
    assert!(app.enabled, "enabled state must survive reload");
    assert_eq!(
        app.capabilities[0].availability,
        CapabilityAvailability::Available
    );

    reloaded.set_enabled("worldbase.tasks", false).unwrap();
    assert!(!reloaded.get("worldbase.tasks").unwrap().enabled);
    assert!(reloaded.set_enabled("missing.app", true).is_err());
}

#[tokio::test]
async fn application_registry_rejects_tool_name_collisions_and_invalid_manifests() {
    let dir = tempfile::tempdir().unwrap();
    let registry = ApplicationRegistry::new(open_store(&dir));

    registry
        .register(
            application(
                "app.one",
                &["desktop"],
                vec![capability("app.one", "thing.run", CapabilityRisk::Read)],
            ),
            FakeProvider::new("one"),
        )
        .unwrap();

    let collision = registry.register(
        application(
            "app-one",
            &["desktop"],
            vec![capability("app-one", "thing.run", CapabilityRisk::Read)],
        ),
        FakeProvider::new("two"),
    );
    assert!(collision.is_err(), "sanitized tool names collide");

    let mut reserved = HashSet::new();
    reserved.insert("app__app_three__thing_run".to_string());
    registry.set_reserved_tool_names(reserved);
    let reserved_error = registry.register(
        application(
            "app.three",
            &["desktop"],
            vec![capability("app.three", "thing.run", CapabilityRisk::Read)],
        ),
        FakeProvider::new("three"),
    );
    assert!(
        reserved_error.is_err(),
        "reserved builtin names are rejected"
    );

    let invalid = registry.register_from_manifest(
        manifest("../bad", &["thing.run"]),
        FakeProvider::new("invalid"),
    );
    assert!(invalid.is_err());
}

#[tokio::test]
async fn application_registry_grants_persist_and_revoke() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(&dir);
    let registry = ApplicationRegistry::new(store.clone());

    let saved = registry
        .save_grant(ApplicationGrant {
            app_id: "worldbase.tasks".into(),
            capability_pattern: "task.*".into(),
            permissions: vec!["allow".into()],
            data_scope: vec!["workspace".into()],
            mode: "allow".into(),
            ..Default::default()
        })
        .unwrap();
    assert!(!saved.id.is_empty());
    assert!(!saved.created_at.is_empty());

    assert_eq!(registry.list_grants(None).unwrap().len(), 1);
    assert_eq!(
        registry.list_grants(Some("worldbase.tasks")).unwrap()[0].id,
        saved.id
    );

    let reloaded = ApplicationRegistry::new(store);
    assert_eq!(reloaded.list_grants(None).unwrap().len(), 1);

    assert!(reloaded.revoke_grant(&saved.id).unwrap());
    assert!(reloaded.list_grants(None).unwrap().is_empty());
    assert!(!reloaded.revoke_grant(&saved.id).unwrap());
}

#[tokio::test]
async fn application_registry_audit_is_persisted_and_limited() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(&dir);
    let registry = ApplicationRegistry::new(store.clone());

    for index in 0..5 {
        registry
            .record_call(ApplicationCallAudit {
                call_id: format!("call-{index}"),
                conversation_id: Some("conversation".into()),
                app_id: "worldbase.tasks".into(),
                capability_id: "task.search".into(),
                status: "ok".into(),
                duration_ms: index,
                approval_id: None,
                created_at: format!("2026-01-01T00:00:0{index}Z"),
            })
            .unwrap();
    }

    let limited = registry.list_audit(None, 2).unwrap();
    assert_eq!(limited.len(), 2);
    assert_eq!(limited[0].call_id, "call-4");
    assert_eq!(limited[1].call_id, "call-3");

    let reloaded = ApplicationRegistry::new(store);
    assert_eq!(
        reloaded
            .list_audit(Some("worldbase.tasks"), 10)
            .unwrap()
            .len(),
        5
    );
}

#[tokio::test]
async fn application_registry_search_filters_platform_features_policy_and_enabled() {
    let dir = tempfile::tempdir().unwrap();
    let registry = ApplicationRegistry::new(open_store(&dir));

    registry
        .register(
            application(
                "app.desktop",
                &["desktop"],
                vec![capability(
                    "app.desktop",
                    "report.read",
                    CapabilityRisk::Read,
                )],
            ),
            FakeProvider::new("desktop"),
        )
        .unwrap();
    registry.set_enabled("app.desktop", true).unwrap();

    registry
        .register(
            application(
                "app.mobile",
                &["mobile"],
                vec![capability(
                    "app.mobile",
                    "report.read",
                    CapabilityRisk::Read,
                )],
            ),
            FakeProvider::new("mobile"),
        )
        .unwrap();
    registry.set_enabled("app.mobile", true).unwrap();

    registry
        .register(
            application(
                "app.disabled",
                &["desktop"],
                vec![capability(
                    "app.disabled",
                    "report.read",
                    CapabilityRisk::Read,
                )],
            ),
            FakeProvider::new("disabled"),
        )
        .unwrap();

    let params = ApplicationSearchParams {
        query: "report".into(),
        ..Default::default()
    };
    let desktop = registry.search(&params, &Capabilities::desktop(), &|_| true);
    let names = desktop
        .iter()
        .map(|candidate| candidate.tool_name.as_str())
        .collect::<Vec<_>>();
    assert!(names.contains(&"app__app_desktop__report_read"));
    assert!(!names.contains(&"app__app_mobile__report_read"));
    assert!(!names.contains(&"app__app_disabled__report_read"));

    let mobile = registry.search(&params, &Capabilities::mobile("mobile-ios"), &|_| true);
    let names = mobile
        .iter()
        .map(|candidate| candidate.tool_name.as_str())
        .collect::<Vec<_>>();
    assert!(names.contains(&"app__app_mobile__report_read"));
    assert!(!names.contains(&"app__app_desktop__report_read"));

    let denied = registry.search(&params, &Capabilities::desktop(), &|_| false);
    assert!(denied.is_empty());

    let feature_params = ApplicationSearchParams {
        query: "interactive".into(),
        ..Default::default()
    };
    let mut feature_manifest = manifest("app.feature", &["interactive.read"]);
    feature_manifest.app.required_features = vec!["interactive".into()];
    registry
        .register_from_manifest(feature_manifest, FakeProvider::new("feature"))
        .unwrap();
    registry.set_enabled("app.feature", true).unwrap();

    let without = registry.search(
        &feature_params,
        &Capabilities {
            platform: "desktop".into(),
            features: vec![],
            excludes: vec![],
        },
        &|_| true,
    );
    assert!(without.is_empty(), "required host feature is missing");
    let with = registry.search(&feature_params, &Capabilities::desktop(), &|_| true);
    assert!(with
        .iter()
        .any(|candidate| candidate.tool_name == "app__app_feature__interactive_read"));
}

#[tokio::test]
async fn application_registry_registers_builtin_apps() {
    let dir = tempfile::tempdir().unwrap();
    let registry = ApplicationRegistry::new(open_store(&dir));
    let tools: Vec<Arc<dyn Tool>> = [
        "list_documents",
        "read_document",
        "doc_draft",
        "project_list",
        "get_project_status",
        "query_project_database",
    ]
    .iter()
    .map(|name| FakeTool::new(name) as Arc<dyn Tool>)
    .collect();

    registry.register_builtin_apps(&tools, FakeProvider::new("host"));

    let documents = registry.get("worldbase.documents").unwrap();
    assert!(documents.enabled);
    assert_eq!(documents.runtime_kind, RuntimeKind::HostService);
    assert_eq!(documents.capabilities.len(), 3);
    assert_eq!(documents.manifest_hash.len(), 64);
    assert!(documents
        .capabilities
        .iter()
        .all(|capability| { capability.availability == CapabilityAvailability::Available }));

    assert_eq!(
        registry
            .get("worldbase.projects")
            .unwrap()
            .capabilities
            .len(),
        2
    );
    assert_eq!(
        registry.get("worldbase.data").unwrap().capabilities.len(),
        1
    );
    let host = registry.get("worldbase.host").unwrap();
    assert_eq!(host.runtime_kind, RuntimeKind::ElectronHost);
    assert_eq!(host.capabilities.len(), 3);
    assert!(
        registry
            .find_capability("app__worldbase_host__host_open_external")
            .unwrap()
            .1
            .side_effects
    );

    let search = registry.search(
        &ApplicationSearchParams {
            query: "documents".into(),
            ..Default::default()
        },
        &Capabilities::desktop(),
        &|_| true,
    );
    assert!(search
        .iter()
        .any(|candidate| candidate.app_id == "worldbase.documents"));

    registry
        .refresh_managed_projects(vec![(
            "app.managed".into(),
            manifest("app.managed", &["managed.read"]),
            FakeProvider::new("managed"),
        )])
        .unwrap();
    assert!(registry.get("app.managed").is_some());

    registry.refresh_managed_projects(Vec::new()).unwrap();
    assert!(registry.get("app.managed").is_none());
}

#[tokio::test]
async fn hub_registers_first_party_and_light_apps() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(&dir);
    store.add_lightapp("light-1", "Light app").unwrap();
    let hub = worldbase_core::Hub::new(dir.path().to_path_buf(), store).unwrap();

    assert!(hub
        .application_registry
        .get("worldbase.documents")
        .is_some());
    assert!(hub.application_registry.get("worldbase.projects").is_some());
    assert!(hub.application_registry.get("worldbase.data").is_some());
    assert!(hub.application_registry.get("worldbase.host").is_some());
    assert!(hub
        .application_registry
        .get("worldbase.lightapp.light-1")
        .is_some());
}
