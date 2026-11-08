//! Scaffold-generated managed applications are enabled automatically so
//! `search_tools` can discover their capabilities without a manual toggle.
//! Enabling must never start the project runtime: capability invocation keeps
//! using the existing `ensure_ready` auto-start path.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use worldbase_core::Hub;
use worldbase_memory::Store;
use worldbase_protocol::types::CapabilityAvailability;

const PROJECT_ID: &str = "proj_scaffold";
const APP_ID: &str = "worldbase.local.proj_scaffold";

fn write_manifest(projects_root: &Path, project_id: &str, manifest: &Value) {
    let manifest_dir = projects_root.join(project_id).join(".worldbase");
    fs::create_dir_all(&manifest_dir).expect("create .worldbase directory");
    fs::write(
        manifest_dir.join("app-capabilities.json"),
        serde_json::to_vec_pretty(manifest).expect("serialize manifest"),
    )
    .expect("write app-capabilities.json");
}

/// Minimal valid managed-project manifest. `ai_integration = Some("none")`
/// mirrors a presentation-only scaffold: no capabilities and no health check.
fn manifest(project_id: &str, tags: &[&str], ai_integration: Option<&str>) -> Value {
    let ai_none = ai_integration == Some("none");
    let mut runtime = json!({
        "kind": "managed_project",
        "activation": "on-demand",
    });
    let capabilities = if ai_none {
        json!([])
    } else {
        runtime["healthCheck"] = json!("app.health");
        json!([{
            "id": "app.health",
            "title": "Application health",
            "description": "Health check for the scaffold application.",
            "inputSchema": { "type": "object", "additionalProperties": false },
            "operation": "app.health",
            "risk": "read",
            "permissions": [],
            "dataScopes": ["project"],
            "sideEffects": false,
            "idempotent": true,
            "deadlineMs": 5000
        }])
    };
    let mut manifest = json!({
        "schemaVersion": 1,
        "app": {
            "id": format!("worldbase.local.{project_id}"),
            "name": project_id,
            "version": "0.1.0",
            "description": "Scaffold-generated managed application.",
            "tags": tags,
            "platforms": ["desktop"],
            "trustLevel": "untrusted"
        },
        "runtime": runtime,
        "capabilities": capabilities,
    });
    if let Some(ai_integration) = ai_integration {
        manifest["aiIntegration"] = json!(ai_integration);
    }
    manifest
}

fn hub_with_manifest(
    temp: &tempfile::TempDir,
    project_id: &str,
    manifest: &Value,
) -> (Arc<Hub>, PathBuf) {
    let projects_root = temp.path().join("projects");
    fs::create_dir_all(&projects_root).expect("create projects root");
    write_manifest(&projects_root, project_id, manifest);
    let store = Arc::new(Store::open(&temp.path().join("app.sqlite")).expect("open store"));
    let hub = Hub::new(projects_root.clone(), store).expect("create hub");
    (hub, projects_root)
}

async fn assert_project_stopped(hub: &Hub, project_id: &str) {
    assert!(
        hub.projects.app_lease(project_id).is_none(),
        "auto-enable must not acquire an app runtime lease"
    );
    assert!(
        hub.projects.app_token(project_id).is_none(),
        "auto-enable must not create an app runtime token"
    );
    let status = hub
        .projects
        .status(project_id)
        .await
        .expect("project status");
    assert_eq!(status["status"], "not_started");
    assert_eq!(status["running"], false);
    assert_eq!(status["alive"], false);
}

#[tokio::test]
async fn auto_enables_tagged_scaffold_application() {
    let temp = tempfile::tempdir().expect("temp dir");
    let (hub, _) = hub_with_manifest(
        &temp,
        PROJECT_ID,
        &manifest(PROJECT_ID, &["worldbase.scaffold", "next-crud"], None),
    );

    let before = hub
        .application_registry
        .get(APP_ID)
        .expect("registered application");
    assert!(!before.enabled, "managed applications start disabled");
    assert!(before
        .capabilities
        .iter()
        .all(|capability| capability.availability == CapabilityAvailability::Disabled));

    assert!(hub.auto_enable_scaffold_application(PROJECT_ID));

    let app = hub
        .application_registry
        .get(APP_ID)
        .expect("registered application");
    assert!(app.enabled, "scaffold application must be enabled");
    assert!(app
        .capabilities
        .iter()
        .all(|capability| capability.availability == CapabilityAvailability::Available));
}

#[tokio::test]
async fn legacy_scaffold_manifest_with_template_tag_is_enabled() {
    let temp = tempfile::tempdir().expect("temp dir");
    let (hub, _) = hub_with_manifest(
        &temp,
        PROJECT_ID,
        &manifest(PROJECT_ID, &["next-crud", "fullstack"], None),
    );

    assert!(hub.auto_enable_scaffold_application(PROJECT_ID));
    assert!(
        hub.application_registry
            .get(APP_ID)
            .expect("registered application")
            .enabled
    );
}

#[tokio::test]
async fn manifest_without_scaffold_tag_stays_disabled() {
    let temp = tempfile::tempdir().expect("temp dir");
    let (hub, _) = hub_with_manifest(
        &temp,
        PROJECT_ID,
        &manifest(PROJECT_ID, &["inventory"], None),
    );

    assert!(!hub.auto_enable_scaffold_application(PROJECT_ID));
    assert!(
        !hub.application_registry
            .get(APP_ID)
            .expect("registered application")
            .enabled
    );
}

#[tokio::test]
async fn ai_integration_none_stays_disabled() {
    let temp = tempfile::tempdir().expect("temp dir");
    let (hub, _) = hub_with_manifest(
        &temp,
        PROJECT_ID,
        &manifest(PROJECT_ID, &["worldbase.scaffold"], Some("none")),
    );

    let before = hub
        .application_registry
        .get(APP_ID)
        .expect("registered application");
    assert!(!before.enabled);
    assert!(!hub.auto_enable_scaffold_application(PROJECT_ID));
    assert!(
        !hub.application_registry
            .get(APP_ID)
            .expect("registered application")
            .enabled
    );
}

#[tokio::test]
async fn auto_enable_does_not_start_or_touch_the_project() {
    let temp = tempfile::tempdir().expect("temp dir");
    let (hub, projects_root) = hub_with_manifest(
        &temp,
        PROJECT_ID,
        &manifest(PROJECT_ID, &["worldbase.scaffold", "next-crud"], None),
    );

    assert!(hub.auto_enable_scaffold_application(PROJECT_ID));
    assert_project_stopped(&hub, PROJECT_ID).await;

    let mut entries = fs::read_dir(projects_root.join(PROJECT_ID))
        .expect("read project directory")
        .map(|entry| {
            entry
                .expect("dir entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect::<Vec<_>>();
    entries.sort();
    assert_eq!(
        entries,
        vec![".worldbase".to_string()],
        "auto-enable must not scaffold, install into or otherwise write project files"
    );
}
