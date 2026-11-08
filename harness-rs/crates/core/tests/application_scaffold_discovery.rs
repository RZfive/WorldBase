//! Discovery while stopped: a managed application is searchable as soon as its
//! manifest is registered and enabled. Neither registration nor search may
//! start the project runtime (no `ensure_ready`, no Next install).

use std::fs;
use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};
use worldbase_core::Hub;
use worldbase_memory::Store;
use worldbase_protocol::types::{ApplicationSearchParams, Capabilities};

const DEMO_PROJECT: &str = "proj_demo";
const CONTROL_PROJECT: &str = "proj_plain";
const DEMO_APP_ID: &str = "worldbase.local.proj_demo";
const CONTROL_APP_ID: &str = "worldbase.local.proj_plain";

fn write_manifest(projects_root: &Path, project_id: &str, manifest: &Value) {
    let manifest_dir = projects_root.join(project_id).join(".worldbase");
    fs::create_dir_all(&manifest_dir).expect("create .worldbase directory");
    fs::write(
        manifest_dir.join("app-capabilities.json"),
        serde_json::to_vec_pretty(manifest).expect("serialize manifest"),
    )
    .expect("write app-capabilities.json");
}

fn scaffold_manifest() -> Value {
    json!({
        "schemaVersion": 1,
        "app": {
            "id": DEMO_APP_ID,
            "name": "proj_demo",
            "version": "0.1.0",
            "description": "Scaffold-generated demo application",
            "tags": ["worldbase.scaffold", "github", "trending"],
            "platforms": ["desktop"],
            "trustLevel": "untrusted"
        },
        "runtime": {
            "kind": "managed_project",
            "activation": "on-demand",
            "healthCheck": "app.health"
        },
        "capabilities": [
            {
                "id": "app.health",
                "title": "Application health",
                "description": "Health check for the demo application.",
                "inputSchema": { "type": "object" },
                "operation": "app.health",
                "risk": "read"
            },
            {
                "id": "trending.list",
                "title": "List trending repositories",
                "description": "List GitHub trending repositories.",
                "inputSchema": {
                    "type": "object",
                    "properties": { "language": { "type": "string" } }
                },
                "operation": "trending.list",
                "risk": "read"
            }
        ]
    })
}

/// Control project: it exposes the same `trending.list` surface but carries no
/// `worldbase.scaffold` tag, so it must stay disabled and out of search.
fn control_manifest() -> Value {
    json!({
        "schemaVersion": 1,
        "app": {
            "id": CONTROL_APP_ID,
            "name": "proj_plain",
            "version": "0.1.0",
            "description": "Managed project without scaffold tags",
            "platforms": ["desktop"],
            "trustLevel": "untrusted"
        },
        "runtime": { "kind": "managed_project", "activation": "on-demand" },
        "capabilities": [{
            "id": "trending.list",
            "title": "List trending repositories",
            "description": "List GitHub trending repositories.",
            "inputSchema": { "type": "object" },
            "operation": "trending.list",
            "risk": "read"
        }]
    })
}

fn project_entries(projects_root: &Path, project_id: &str) -> Vec<String> {
    let mut entries = fs::read_dir(projects_root.join(project_id))
        .expect("read project directory")
        .map(|entry| {
            entry
                .expect("project entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect::<Vec<_>>();
    entries.sort();
    entries
}

async fn assert_project_stopped(hub: &Hub, project_id: &str, phase: &str) {
    let status = hub
        .projects
        .status(project_id)
        .await
        .expect("project status");
    let state = status["status"].as_str().expect("status field");
    assert!(
        matches!(state, "not_started" | "stopped"),
        "{phase}: {project_id} must not be started, got {status}"
    );
    assert_eq!(
        status["running"].as_bool(),
        Some(false),
        "{phase}: {project_id} must not be running"
    );
    assert_eq!(
        status["alive"].as_bool(),
        Some(false),
        "{phase}: {project_id} must not have a live runtime"
    );
}

#[tokio::test]
async fn scaffold_application_is_searchable_while_its_project_is_stopped() {
    let temp = tempfile::tempdir().expect("temp dir");
    let projects_root = temp.path().join("projects");
    fs::create_dir_all(&projects_root).expect("create projects root");
    write_manifest(&projects_root, DEMO_PROJECT, &scaffold_manifest());
    write_manifest(&projects_root, CONTROL_PROJECT, &control_manifest());

    let store = Arc::new(Store::open(&temp.path().join("app.sqlite")).expect("open store"));
    let hub = Hub::new(projects_root.clone(), store).expect("create hub");

    // Both manifests are on disk before the catalog is built, so `Hub::new`
    // registers them while scanning the projects root. Managed applications
    // default to disabled.
    let demo = hub
        .application_registry
        .get(DEMO_APP_ID)
        .expect("scaffold application registered");
    assert!(!demo.enabled, "managed applications start disabled");
    assert!(demo.tags.iter().any(|tag| tag == "worldbase.scaffold"));
    let control = hub
        .application_registry
        .get(CONTROL_APP_ID)
        .expect("control application registered");
    assert!(!control.enabled, "untagged applications stay disabled");

    assert_project_stopped(&hub, DEMO_PROJECT, "after registration").await;
    assert_eq!(
        project_entries(&projects_root, DEMO_PROJECT),
        vec![".worldbase".to_string()],
        "registration must not scaffold or install into the project"
    );

    assert!(
        hub.auto_enable_scaffold_application(DEMO_PROJECT),
        "the scaffold helper enables the tagged application"
    );

    assert!(
        hub.application_registry
            .get(DEMO_APP_ID)
            .expect("demo application")
            .enabled,
        "scaffold application is enabled"
    );
    assert!(
        !hub.application_registry
            .get(CONTROL_APP_ID)
            .expect("control application")
            .enabled,
        "control application remains disabled"
    );

    let caps = Capabilities::desktop();
    let params = ApplicationSearchParams {
        query: "trending".into(),
        ..Default::default()
    };
    let results = hub.application_registry.search(&params, &caps, &|_| true);
    let names = results
        .iter()
        .map(|candidate| candidate.tool_name.as_str())
        .collect::<Vec<_>>();
    assert!(
        names.contains(&"app__worldbase_local_proj_demo__trending_list"),
        "enabled scaffold capability is discoverable: {names:?}"
    );
    assert!(
        !names.contains(&"app__worldbase_local_proj_plain__trending_list"),
        "disabled control capability must not be discoverable: {names:?}"
    );
    assert!(
        results
            .iter()
            .all(|candidate| candidate.app_id == DEMO_APP_ID),
        "only the enabled scaffold application may surface: {results:?}"
    );

    assert_project_stopped(&hub, DEMO_PROJECT, "after search").await;
    assert_project_stopped(&hub, CONTROL_PROJECT, "after search").await;
    assert_eq!(
        project_entries(&projects_root, DEMO_PROJECT),
        vec![".worldbase".to_string()],
        "search must not install or start anything in the project"
    );
}
