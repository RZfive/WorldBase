//! First-party application manifests and their Rust providers.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::json;
use worldbase_protocol::types::{
    AppCapabilityManifest, AppManifest, AppManifestApp, AppRuntimeManifest, CapabilityRisk,
    RuntimeKind, TrustLevel,
};

use super::{
    ApplicationCapabilityProvider, ElectronHostCapabilityProvider, NativeToolCapabilityProvider,
};
use crate::Tool;

pub const DOCUMENTS_APP_ID: &str = "worldbase.documents";
pub const PROJECTS_APP_ID: &str = "worldbase.projects";
pub const DATA_APP_ID: &str = "worldbase.data";
pub const HOST_APP_ID: &str = "worldbase.host";

const NATIVE_PLATFORMS: [&str; 3] = ["desktop", "cli", "mobile"];
const HOST_PLATFORMS: [&str; 1] = ["desktop"];

struct CapabilitySpec {
    id: &'static str,
    tool: &'static str,
    title: &'static str,
    risk: CapabilityRisk,
    side_effects: bool,
    idempotent: bool,
    deadline_ms: Option<u64>,
}

const DOCUMENT_CAPABILITIES: [CapabilitySpec; 3] = [
    CapabilitySpec {
        id: "doc.list",
        tool: "list_documents",
        title: "List documents",
        risk: CapabilityRisk::Read,
        side_effects: false,
        idempotent: true,
        deadline_ms: Some(30_000),
    },
    CapabilitySpec {
        id: "doc.read",
        tool: "read_document",
        title: "Read document",
        risk: CapabilityRisk::Read,
        side_effects: false,
        idempotent: true,
        deadline_ms: Some(30_000),
    },
    CapabilitySpec {
        id: "doc.draft",
        tool: "doc_draft",
        title: "Draft document changes",
        risk: CapabilityRisk::WriteReversible,
        side_effects: true,
        idempotent: false,
        deadline_ms: Some(120_000),
    },
];

const PROJECT_CAPABILITIES: [CapabilitySpec; 2] = [
    CapabilitySpec {
        id: "project.list",
        tool: "project_list",
        title: "List projects",
        risk: CapabilityRisk::Read,
        side_effects: false,
        idempotent: true,
        deadline_ms: Some(30_000),
    },
    CapabilitySpec {
        id: "project.status",
        tool: "get_project_status",
        title: "Project status",
        risk: CapabilityRisk::Read,
        side_effects: false,
        idempotent: true,
        deadline_ms: Some(30_000),
    },
];

const DATA_CAPABILITIES: [CapabilitySpec; 1] = [CapabilitySpec {
    id: "project.query",
    tool: "query_project_database",
    title: "Query project database",
    risk: CapabilityRisk::Read,
    side_effects: false,
    idempotent: true,
    deadline_ms: Some(60_000),
}];

fn tool_index(tools: &[Arc<dyn Tool>]) -> HashMap<String, Arc<dyn Tool>> {
    tools
        .iter()
        .map(|tool| (tool.name().to_string(), Arc::clone(tool)))
        .collect()
}

fn manifest_app(
    id: &str,
    name: &str,
    description: &str,
    tags: &[&str],
    platforms: &[&str],
    trust_level: TrustLevel,
) -> AppManifestApp {
    AppManifestApp {
        id: id.to_string(),
        name: name.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        description: description.to_string(),
        tags: tags.iter().map(|tag| (*tag).to_string()).collect(),
        platforms: platforms.iter().map(|value| (*value).to_string()).collect(),
        required_features: Vec::new(),
        excluded_features: Vec::new(),
        trust_level,
        signature: None,
    }
}

fn manifest_from_capabilities(
    app: AppManifestApp,
    runtime_kind: RuntimeKind,
    capabilities: Vec<AppCapabilityManifest>,
) -> AppManifest {
    AppManifest {
        schema_version: 1,
        app,
        runtime: AppRuntimeManifest {
            kind: runtime_kind,
            activation: "on-demand".into(),
            health_check: None,
        },
        capabilities,
        ai_integration: None,
    }
}

fn capability_from_tool(tool: &Arc<dyn Tool>, spec: &CapabilitySpec) -> AppCapabilityManifest {
    AppCapabilityManifest {
        id: spec.id.to_string(),
        title: spec.title.to_string(),
        description: tool.description().to_string(),
        input_schema: tool.input_schema(),
        output_schema: tool.output_schema(),
        operation: spec.tool.to_string(),
        risk: spec.risk,
        permissions: Vec::new(),
        data_scopes: Vec::new(),
        side_effects: spec.side_effects,
        idempotent: spec.idempotent,
        deadline_ms: spec.deadline_ms,
    }
}

fn native_app(
    tools: &HashMap<String, Arc<dyn Tool>>,
    app: AppManifestApp,
    specs: &[CapabilitySpec],
) -> Option<(AppManifest, Arc<dyn ApplicationCapabilityProvider>)> {
    let mut capabilities = Vec::new();
    let mut providers = Vec::new();
    for spec in specs {
        let Some(tool) = tools.get(spec.tool) else {
            continue;
        };
        capabilities.push(capability_from_tool(tool, spec));
        providers.push(Arc::clone(tool));
    }
    if capabilities.is_empty() {
        return None;
    }
    let provider_ref = format!("native:{}", app.id);
    let provider: Arc<dyn ApplicationCapabilityProvider> = Arc::new(
        NativeToolCapabilityProvider::from_tools(provider_ref, providers),
    );
    Some((
        manifest_from_capabilities(app, RuntimeKind::HostService, capabilities),
        provider,
    ))
}

fn host_manifest() -> AppManifest {
    let capabilities = vec![
        AppCapabilityManifest {
            id: "host.pick_file".into(),
            title: "Pick a file".into(),
            description: "Open the native file picker and return the selected paths.".into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "defaultPath": { "type": "string" },
                    "filters": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": { "type": "string" },
                                "extensions": { "type": "array", "items": { "type": "string" } }
                            }
                        }
                    },
                    "multiple": { "type": "boolean" }
                }
            }),
            output_schema: Some(json!({
                "type": "object",
                "properties": {
                    "paths": { "type": "array", "items": { "type": "string" } },
                    "canceled": { "type": "boolean" }
                }
            })),
            operation: "host.fs.pick_file".into(),
            risk: CapabilityRisk::Read,
            permissions: Vec::new(),
            data_scopes: Vec::new(),
            side_effects: false,
            idempotent: false,
            deadline_ms: Some(120_000),
        },
        AppCapabilityManifest {
            id: "host.open_external".into(),
            title: "Open external link".into(),
            description: "Ask the desktop host to open a validated external URL.".into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string" }
                },
                "required": ["url"]
            }),
            output_schema: Some(json!({
                "type": "object",
                "properties": {
                    "opened": { "type": "boolean" }
                }
            })),
            operation: "host.shell.open_external".into(),
            risk: CapabilityRisk::ExternalEffect,
            permissions: Vec::new(),
            data_scopes: Vec::new(),
            side_effects: true,
            idempotent: false,
            deadline_ms: Some(15_000),
        },
        AppCapabilityManifest {
            id: "host.notify".into(),
            title: "Show notification".into(),
            description: "Show a desktop notification through the host UI.".into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "body": { "type": "string" },
                    "silent": { "type": "boolean" }
                },
                "required": ["title"]
            }),
            output_schema: Some(json!({
                "type": "object",
                "properties": {
                    "shown": { "type": "boolean" }
                }
            })),
            operation: "host.notification.show".into(),
            risk: CapabilityRisk::WriteReversible,
            permissions: Vec::new(),
            data_scopes: Vec::new(),
            side_effects: true,
            idempotent: true,
            deadline_ms: Some(15_000),
        },
    ];
    manifest_from_capabilities(
        manifest_app(
            HOST_APP_ID,
            "WorldBase Host",
            "Narrow desktop host capabilities for files, links and notifications.",
            &["host", "desktop", "os"],
            &HOST_PLATFORMS,
            TrustLevel::Builtin,
        ),
        RuntimeKind::ElectronHost,
        capabilities,
    )
}

/// Build the first-party application catalog from the tools that are actually
/// available in this harness build. Capabilities whose tool is missing are
/// skipped; applications with no remaining capability are omitted. The host
/// application is platform-gated by its manifest and always present because its
/// capabilities are served by Electron rather than by a Rust `Tool`.
pub fn builtin_application_manifests(
    tools: &[Arc<dyn Tool>],
) -> Vec<(AppManifest, Arc<dyn ApplicationCapabilityProvider>)> {
    let tools = tool_index(tools);
    let mut applications = Vec::new();

    if let Some(app) = native_app(
        &tools,
        manifest_app(
            DOCUMENTS_APP_ID,
            "Documents",
            "List, read and draft documents in the user's workspace.",
            &["documents", "docs", "files"],
            &NATIVE_PLATFORMS,
            TrustLevel::Builtin,
        ),
        &DOCUMENT_CAPABILITIES,
    ) {
        applications.push(app);
    }
    if let Some(app) = native_app(
        &tools,
        manifest_app(
            PROJECTS_APP_ID,
            "Projects",
            "Inspect managed projects and their runtime status.",
            &["projects", "status"],
            &NATIVE_PLATFORMS,
            TrustLevel::Builtin,
        ),
        &PROJECT_CAPABILITIES,
    ) {
        applications.push(app);
    }
    if let Some(app) = native_app(
        &tools,
        manifest_app(
            DATA_APP_ID,
            "Project Data",
            "Run read-only SQL queries against a managed project database.",
            &["data", "database", "sql"],
            &NATIVE_PLATFORMS,
            TrustLevel::Builtin,
        ),
        &DATA_CAPABILITIES,
    ) {
        applications.push(app);
    }

    let host_provider: Arc<dyn ApplicationCapabilityProvider> =
        Arc::new(ElectronHostCapabilityProvider::new("electron:host"));
    applications.push((host_manifest(), host_provider));
    applications
}
