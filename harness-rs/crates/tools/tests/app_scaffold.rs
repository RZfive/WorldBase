use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tempfile::TempDir;
use worldbase_project_runtime::{load_manifest, validate_manifest};
use worldbase_tools::{HostBridge, ProjectCreateTool, Tool, ToolServices};

struct Fixture {
    _temp: TempDir,
    services: ToolServices,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::Builder::new()
            .prefix("worldbase-app-scaffold-")
            .tempdir()
            .expect("create temp root");
        let workspace = temp.path().join("workspace");
        let projects = temp.path().join("projects");
        std::fs::create_dir_all(&workspace).expect("create workspace");
        std::fs::create_dir_all(&projects).expect("create projects");
        let store = Arc::new(
            worldbase_memory::Store::open(&temp.path().join("store.sqlite"))
                .expect("open test store"),
        );
        let services = ToolServices {
            host: Arc::new(HostBridge::new()),
            current_stream: Arc::new(Mutex::new(String::new())),
            abort: None,
            workspace,
            folder_workspace: None,
            target_project_id: None,
            created_project_id: Arc::new(Mutex::new(None)),
            allowed_mcp_server_ids: None,
            plan_goal: Arc::new(Mutex::new(None)),
            todo_items: Arc::new(Mutex::new(Vec::new())),
            read_files: Arc::new(Mutex::new(std::collections::HashSet::new())),
            visible_tool_catalog: None,
            catalog_runtime: None,
            conversation_id: None,
            store: store.clone(),
            memory_queue: None,
            memory_scopes: Vec::new(),
            skills: Arc::new(worldbase_skills::SkillRegistry::new(vec![])),
            scheduler: Arc::new(worldbase_scheduler::Scheduler::new(store)),
            mcp: Arc::new(worldbase_mcp_client::McpManager::default()),
            projects: Arc::new(worldbase_project_runtime::ProjectRuntime::new(projects)),
            group_collaboration: None,
            subagent_runtime: None,
        };
        Self {
            _temp: temp,
            services,
        }
    }

    async fn create(&self, input: Value) -> (Value, PathBuf) {
        let result = ProjectCreateTool
            .execute(input, &self.services)
            .await
            .expect("create_project executes");
        assert_eq!(result["success"], true, "create_project failed: {result}");
        let project_id = result["projectId"]
            .as_str()
            .expect("project id")
            .to_string();
        let root = self
            .services
            .projects
            .project_root(&project_id)
            .expect("project root");
        (result, root)
    }
}

fn read_text(root: &std::path::Path, relative: &str) -> String {
    std::fs::read_to_string(root.join(relative))
        .unwrap_or_else(|error| panic!("read {relative}: {error}"))
}

#[tokio::test]
async fn app_scaffold_default_generates_valid_ai_integration() {
    let fixture = Fixture::new();
    let (_, root) = fixture
        .create(json!({
            "name": "Scaffold Demo",
            "type": "frontend",
            "development_mode": true,
            "build_and_start": false,
            "files": { "src/app.ts": "export const app = true;\n" }
        }))
        .await;

    let manifest = load_manifest(&root)
        .expect("load generated manifest")
        .expect("manifest exists");
    validate_manifest(&manifest).expect("generated manifest is valid");
    assert_eq!(manifest.app.version, "0.1.0");
    assert_eq!(manifest.capabilities.len(), 1);
    assert_eq!(manifest.capabilities[0].id, "example.search");
    assert_eq!(manifest.capabilities[0].operation, "example.search");
    assert_eq!(
        manifest.runtime.kind,
        worldbase_protocol::types::RuntimeKind::ManagedProject
    );

    let raw: Value =
        serde_json::from_str(&read_text(&root, ".worldbase/app-capabilities.json")).unwrap();
    assert_eq!(raw["capabilities"][0]["risk"], "read");
    assert_eq!(raw["capabilities"][0]["sideEffects"], false);
    assert!(raw.get("aiIntegration").is_none());

    let documentation = read_text(&root, "AI_INTEGRATION.md");
    assert!(documentation.contains("自然语言用法"));
    assert!(documentation.contains("何时使用"));
    assert!(documentation.contains("前置条件"));
    assert!(documentation.contains("example.search"));

    let domain = read_text(&root, "src/domain/example-service.ts");
    assert!(domain.contains("export function searchExamples"));
    let adapter = read_text(&root, "src/ai/capabilities.ts");
    assert!(adapter.contains("from \"../domain/example-service\""));
    assert!(adapter.contains("example.search"));
    let contract = read_text(&root, "tests/capability_contract/example.test.mjs");
    assert!(contract.contains("example.search"));
    assert!(contract.contains("test.skip"));
}

#[tokio::test]
async fn app_scaffold_none_records_reason_and_declares_no_capability() {
    let fixture = Fixture::new();
    let (_, root) = fixture
        .create(json!({
            "name": "Purely Visual",
            "type": "frontend",
            "development_mode": true,
            "build_and_start": false,
            "ai_integration": "none",
            "ai_integration_note": "这个应用只展示静态海报，没有业务操作。"
        }))
        .await;

    let manifest = load_manifest(&root)
        .expect("load generated manifest")
        .expect("manifest exists");
    validate_manifest(&manifest).expect("aiIntegration none manifest is valid");
    assert!(manifest.capabilities.is_empty());
    assert_eq!(manifest.ai_integration.as_deref(), Some("none"));

    let documentation = read_text(&root, "AI_INTEGRATION.md");
    assert!(documentation.contains("这个应用只展示静态海报，没有业务操作。"));
    assert!(documentation.contains("aiIntegration: \"none\""));

    assert!(!root.join("src/domain/example-service.ts").exists());
    assert!(!root.join("src/ai/capabilities.ts").exists());
    assert!(!root
        .join("tests/capability_contract/example.test.mjs")
        .exists());
}

#[tokio::test]
async fn app_scaffold_javascript_projects_receive_javascript_stubs() {
    let fixture = Fixture::new();
    let (_, root) = fixture
        .create(json!({
            "name": "Plain Node",
            "type": "backend",
            "development_mode": true,
            "build_and_start": false,
            "files": {
                "package.json": "{\"name\":\"plain-node\"}",
                "server.js": "console.log('ready');\n"
            }
        }))
        .await;

    let domain = read_text(&root, "src/domain/example-service.js");
    assert!(domain.contains("module.exports"));
    let adapter = read_text(&root, "src/ai/capabilities.js");
    assert!(adapter.contains("require(\"../domain/example-service\")"));
    assert!(!root.join("src/domain/example-service.ts").exists());
}

#[tokio::test]
async fn app_scaffold_does_not_overwrite_caller_provided_files() {
    let fixture = Fixture::new();
    let (_, root) = fixture
        .create(json!({
            "name": "Custom Contract",
            "type": "fullstack",
            "development_mode": true,
            "build_and_start": false,
            "files": {
                ".worldbase/app-capabilities.json": "{\"custom\":true}\n",
                "AI_INTEGRATION.md": "# Custom integration\n"
            }
        }))
        .await;

    assert_eq!(
        read_text(&root, ".worldbase/app-capabilities.json"),
        "{\"custom\":true}\n"
    );
    assert_eq!(
        read_text(&root, "AI_INTEGRATION.md"),
        "# Custom integration\n"
    );
    assert!(root.join("src/ai/capabilities.ts").is_file());
}

#[test]
fn app_scaffold_schema_exposes_ai_integration_options() {
    let schema = ProjectCreateTool.input_schema();
    let properties = schema["properties"].as_object().unwrap();
    assert!(properties.contains_key("ai_integration"));
    assert!(properties.contains_key("ai_integration_note"));
}
