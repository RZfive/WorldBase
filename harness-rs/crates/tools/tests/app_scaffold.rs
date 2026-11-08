use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tempfile::TempDir;
use worldbase_project_runtime::{load_manifest, validate_manifest};
use worldbase_tools::{HostBridge, ProjectCreateTool, ProjectUpgradeTool, Tool, ToolServices};

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
    assert_eq!(properties["ai_integration"]["type"], "boolean");
    assert!(properties["ai_integration"].get("enum").is_none());
}

#[test]
fn app_scaffold_schema_exposes_template_and_entities() {
    let schema = ProjectCreateTool.input_schema();
    let properties = schema["properties"].as_object().unwrap();
    for key in ["template", "entities", "features"] {
        assert!(
            properties.contains_key(key),
            "missing schema property {key}"
        );
    }
    let templates = properties["template"]["enum"]
        .as_array()
        .expect("template enum");
    for template in ["next-crud", "next-dashboard", "node-api", "blank"] {
        assert!(
            templates
                .iter()
                .any(|value| value.as_str() == Some(template)),
            "template enum must contain {template}"
        );
    }

    let upgrade = ProjectUpgradeTool.input_schema();
    let upgrade_properties = upgrade["properties"].as_object().unwrap();
    for key in ["project_id", "dry_run", "template", "features"] {
        assert!(
            upgrade_properties.contains_key(key),
            "missing upgrade schema property {key}"
        );
    }
    assert_eq!(upgrade["required"], json!(["project_id"]));
}

fn assert_generated_file(root: &std::path::Path, relative: &str) {
    assert!(
        root.join(relative).is_file(),
        "expected generated file {relative}"
    );
}

fn assert_list_contains(value: &Value, expected: &str, label: &str) {
    let entries = value
        .as_array()
        .unwrap_or_else(|| panic!("{label} must be an array, got {value}"));
    assert!(
        entries.iter().any(|entry| entry.as_str() == Some(expected)),
        "{label} must contain {expected}, got {value}"
    );
}

fn entity_expense_input() -> Value {
    json!([
        {
            "name": "expense",
            "table": "expenses",
            "fields": [
                { "name": "id", "type": "text", "primaryKey": true },
                { "name": "title", "type": "text", "required": true },
                { "name": "amount", "type": "number", "required": true },
                { "name": "created_at", "type": "text", "defaultSql": "CURRENT_TIMESTAMP" }
            ]
        }
    ])
}

#[tokio::test]
async fn app_scaffold_template_create_generates_contract_surface() {
    let fixture = Fixture::new();
    let (result, root) = fixture
        .create(json!({
            "name": "Expense App",
            "type": "fullstack",
            "development_mode": true,
            "build_and_start": false,
            "template": "next-crud",
            "entities": entity_expense_input(),
            "features": ["core", "data", "crud-ui", "ai", "search"]
        }))
        .await;
    assert_eq!(result["success"], true);

    for relative in [
        ".gitignore",
        ".worldbase/app-capabilities.json",
        "app/worldbase/capabilities/invoke/route.ts",
        "app/api/worldbase/capabilities/route.ts",
        "src/server/data/client.ts",
        "src/domain/expense-service.ts",
        "src/shared/schema.ts",
    ] {
        assert_generated_file(&root, relative);
    }

    let manifest = load_manifest(&root)
        .expect("load generated manifest")
        .expect("manifest exists");
    validate_manifest(&manifest).expect("generated manifest is valid");
    let capability_ids = manifest
        .capabilities
        .iter()
        .map(|capability| capability.id.as_str())
        .collect::<Vec<_>>();
    assert!(
        capability_ids.contains(&"expense.list"),
        "manifest must contain expense.list, got {capability_ids:?}"
    );
    assert!(
        capability_ids.contains(&"expense.create"),
        "manifest must contain expense.create, got {capability_ids:?}"
    );
    assert!(
        !capability_ids.contains(&"example.search"),
        "template manifest must not contain example.search, got {capability_ids:?}"
    );

    let meta: Value = serde_json::from_str(&read_text(&root, ".world-meta.json"))
        .expect("parse .world-meta.json");
    let tables = meta["dataSchema"]["tables"]
        .as_array()
        .expect(".world-meta.json dataSchema.tables must be an array");
    let expenses = tables
        .iter()
        .find(|table| table["name"] == "expenses")
        .expect(".world-meta.json must declare the expenses table");
    let column_names = expenses["columns"]
        .as_array()
        .expect("expenses columns must be an array")
        .iter()
        .filter_map(|column| column["name"].as_str())
        .collect::<Vec<_>>();
    for expected in ["id", "title", "amount"] {
        assert!(
            column_names.contains(&expected),
            "expenses columns must contain {expected}, got {column_names:?}"
        );
    }
}

#[tokio::test]
async fn app_scaffold_template_create_initializes_entity_database_schema() {
    let fixture = Fixture::new();
    let (_, root) = fixture
        .create(json!({
            "name": "Expense Database",
            "type": "fullstack",
            "development_mode": true,
            "build_and_start": false,
            "template": "next-crud",
            "entities": entity_expense_input(),
            "features": ["core", "data"]
        }))
        .await;

    let meta: Value = serde_json::from_str(&read_text(&root, ".world-meta.json"))
        .expect("parse .world-meta.json");
    let db_relative = meta["dataSchema"]["dbPath"]
        .as_str()
        .unwrap_or("data/app.sqlite");
    let db_path = root.join(db_relative);
    assert!(
        db_path.is_file(),
        "expected initialized database at {db_relative}"
    );

    let connection = rusqlite::Connection::open(&db_path).expect("open project database");
    let table_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='expenses'",
            [],
            |row| row.get(0),
        )
        .expect("query sqlite_master");
    assert_eq!(table_count, 1, "expenses table must exist in the database");

    let mut statement = connection
        .prepare("PRAGMA table_info('expenses')")
        .expect("prepare table_info");
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .expect("query table_info")
        .collect::<Result<Vec<_>, _>>()
        .expect("read table_info rows");
    assert!(
        columns.iter().any(|column| column == "title"),
        "expenses table must contain the title column, got {columns:?}"
    );
}

#[tokio::test]
async fn app_scaffold_template_create_keeps_caller_manifest_and_meta_overrides() {
    let fixture = Fixture::new();
    let custom_manifest = "{\"custom\":true}\n";
    let (_, root) = fixture
        .create(json!({
            "name": "Expense Override",
            "type": "fullstack",
            "development_mode": true,
            "build_and_start": false,
            "template": "next-crud",
            "entities": entity_expense_input(),
            "features": ["core", "data"],
            "files": {
                ".worldbase/app-capabilities.json": custom_manifest
            },
            "meta": {
                "name": "Caller Meta Name"
            }
        }))
        .await;

    assert_eq!(
        read_text(&root, ".worldbase/app-capabilities.json"),
        custom_manifest,
        "caller-provided manifest must win over the generated one"
    );
    assert_generated_file(&root, "app/worldbase/capabilities/invoke/route.ts");

    let meta: Value = serde_json::from_str(&read_text(&root, ".world-meta.json"))
        .expect("parse .world-meta.json");
    assert_eq!(
        meta["name"], "Caller Meta Name",
        "caller-provided top-level meta fields must win"
    );
    assert!(
        meta["dataSchema"]["tables"]
            .as_array()
            .is_some_and(|tables| tables.iter().any(|table| table["name"] == "expenses")),
        "scaffold meta must still contribute the expenses table"
    );
}

#[tokio::test]
async fn app_scaffold_upgrade_dry_run_reports_without_writing() {
    let fixture = Fixture::new();
    let (result, root) = fixture
        .create(json!({
            "name": "Expense Upgrade Dry Run",
            "type": "fullstack",
            "development_mode": true,
            "build_and_start": false,
            "template": "next-crud",
            "entities": entity_expense_input(),
            "features": ["core", "data"]
        }))
        .await;
    let project_id = result["projectId"]
        .as_str()
        .expect("project id")
        .to_string();

    let missing_file = "src/domain/expense-service.ts";
    let missing_path = root.join(missing_file);
    if missing_path.exists() {
        std::fs::remove_file(&missing_path).expect("remove scaffold file");
    }
    assert!(!missing_path.exists());

    let upgraded = ProjectUpgradeTool
        .execute(
            json!({
                "project_id": project_id,
                "dry_run": true,
                "template": "next-crud",
                "features": ["core", "data"]
            }),
            &fixture.services,
        )
        .await
        .expect("upgrade_project executes");

    assert_eq!(upgraded["success"], true, "upgrade failed: {upgraded}");
    assert_eq!(upgraded["projectId"], project_id);
    assert!(upgraded["warnings"].is_array(), "warnings must be an array");
    assert_list_contains(&upgraded["created"], missing_file, "created");
    assert!(
        !missing_path.exists(),
        "dry_run must not write {missing_file}"
    );
}

#[tokio::test]
async fn app_scaffold_upgrade_apply_only_fills_missing_files() {
    let fixture = Fixture::new();
    let (result, root) = fixture
        .create(json!({
            "name": "Expense Upgrade Apply",
            "type": "fullstack",
            "development_mode": true,
            "build_and_start": false,
            "template": "next-crud",
            "entities": entity_expense_input(),
            "features": ["core", "data"]
        }))
        .await;
    let project_id = result["projectId"]
        .as_str()
        .expect("project id")
        .to_string();

    let missing_file = "src/domain/expense-service.ts";
    let missing_path = root.join(missing_file);
    if missing_path.exists() {
        std::fs::remove_file(&missing_path).expect("remove scaffold file");
    }

    let custom_file = "src/shared/schema.ts";
    let custom_content = "// caller-owned schema\n";
    std::fs::write(root.join(custom_file), custom_content).expect("write custom file");

    let upgraded = ProjectUpgradeTool
        .execute(
            json!({
                "project_id": project_id,
                "dry_run": false,
                "template": "next-crud",
                "features": ["core", "data"]
            }),
            &fixture.services,
        )
        .await
        .expect("upgrade_project executes");

    assert_eq!(upgraded["success"], true, "upgrade failed: {upgraded}");
    assert_eq!(upgraded["projectId"], project_id);
    assert!(upgraded["warnings"].is_array(), "warnings must be an array");
    assert_list_contains(&upgraded["created"], missing_file, "created");
    assert_list_contains(&upgraded["skipped"], custom_file, "skipped");
    assert_list_contains(
        &upgraded["skipped"],
        ".worldbase/app-capabilities.json",
        "skipped",
    );
    assert!(
        missing_path.is_file(),
        "upgrade must restore {missing_file}"
    );
    assert_eq!(
        read_text(&root, custom_file),
        custom_content,
        "upgrade must not overwrite existing files"
    );
}

#[tokio::test]
async fn app_scaffold_upgrade_adds_soft_delete_column_to_legacy_schema() {
    let fixture = Fixture::new();
    let (result, root) = fixture
        .create(json!({
            "name": "Legacy Notes",
            "type": "fullstack",
            "development_mode": true,
            "build_and_start": false,
            "files": { "server.js": "console.log('ok')\n" },
            "meta": {
                "dataSchema": {
                    "database": "sqlite",
                    "dbPath": "data/legacy.sqlite",
                    "tables": [{
                        "name": "notes",
                        "columns": [
                            { "name": "id", "type": "TEXT", "primaryKey": true },
                            { "name": "body", "type": "TEXT" }
                        ]
                    }]
                }
            }
        }))
        .await;
    assert_eq!(result["success"], true);
    let project_id = result["projectId"]
        .as_str()
        .expect("project id")
        .to_string();

    let upgraded = ProjectUpgradeTool
        .execute(
            json!({
                "project_id": project_id,
                "template": "next-crud",
                "features": ["core", "data"]
            }),
            &fixture.services,
        )
        .await
        .expect("upgrade_project executes");
    assert_eq!(upgraded["success"], true, "upgrade failed: {upgraded}");

    let meta: Value =
        serde_json::from_str(&read_text(&root, ".world-meta.json")).expect("parse meta");
    let notes = meta["dataSchema"]["tables"]
        .as_array()
        .expect("tables")
        .iter()
        .find(|table| table["name"] == "notes")
        .expect("notes table");
    assert!(
        notes["columns"]
            .as_array()
            .expect("columns")
            .iter()
            .any(|column| column["name"] == "deleted_at"),
        "upgraded meta must declare deleted_at: {notes}"
    );

    let connection =
        rusqlite::Connection::open(root.join("data/legacy.sqlite")).expect("open legacy database");
    let mut statement = connection
        .prepare("PRAGMA table_info('notes')")
        .expect("prepare table_info");
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .expect("query table_info")
        .collect::<Result<Vec<_>, _>>()
        .expect("read table_info");
    assert!(
        columns.iter().any(|column| column == "deleted_at"),
        "upgraded database must contain deleted_at: {columns:?}"
    );
}

#[tokio::test]
async fn app_scaffold_template_with_ai_none_declares_no_capability() {
    let fixture = Fixture::new();
    let (result, root) = fixture
        .create(json!({
            "name": "Visual Only",
            "type": "frontend",
            "development_mode": true,
            "build_and_start": false,
            "template": "next-crud",
            "entities": entity_expense_input(),
            "features": ["core", "data", "crud-ui"],
            "ai_integration": false,
            "ai_integration_note": "纯展示应用"
        }))
        .await;
    assert_eq!(result["success"], true);

    let manifest: Value =
        serde_json::from_str(&read_text(&root, ".worldbase/app-capabilities.json"))
            .expect("parse manifest");
    assert_eq!(manifest["aiIntegration"], "none");
    assert!(manifest["capabilities"]
        .as_array()
        .is_some_and(|capabilities| capabilities.is_empty()));
    assert!(!root.join("src/ai/capabilities.ts").exists());
    assert!(!root
        .join("app/worldbase/capabilities/invoke/route.ts")
        .exists());
}

fn capability_ids(application: &Value) -> Vec<&str> {
    application["capabilities"]
        .as_array()
        .unwrap_or_else(|| panic!("application.capabilities must be an array: {application}"))
        .iter()
        .filter_map(Value::as_str)
        .collect()
}

#[tokio::test]
async fn app_scaffold_create_result_reports_application() {
    let fixture = Fixture::new();
    let (result, root) = fixture
        .create(json!({
            "name": "Expense Application",
            "type": "fullstack",
            "development_mode": true,
            "build_and_start": false,
            "template": "next-crud",
            "entities": entity_expense_input(),
            "features": ["core", "data", "crud-ui", "ai", "search"]
        }))
        .await;

    let project_id = result["projectId"].as_str().expect("project id");
    let application = &result["application"];
    let expected_app_id = format!("worldbase.local.{project_id}");
    assert_eq!(
        application["appId"].as_str(),
        Some(expected_app_id.as_str()),
        "create result must expose the WorldBase local app id"
    );
    assert_eq!(application["registered"], true);
    assert_eq!(application["enabled"], true);

    let ids = capability_ids(application);
    for expected in [
        "app.health",
        "expense.list",
        "expense.create",
        "expense.update",
        "expense.remove",
        "expense.search",
    ] {
        assert!(
            ids.contains(&expected),
            "missing capability {expected}: {ids:?}"
        );
    }

    let manifest: Value =
        serde_json::from_str(&read_text(&root, ".worldbase/app-capabilities.json"))
            .expect("parse manifest");
    assert!(
        manifest["app"]["tags"]
            .as_array()
            .is_some_and(|tags| tags.iter().any(|tag| tag == "worldbase.scaffold")),
        "generated manifest must carry the WorldBase scaffold tag"
    );
}

#[tokio::test]
async fn app_scaffold_create_result_reports_disabled_application_without_ai() {
    let fixture = Fixture::new();
    let (result, root) = fixture
        .create(json!({
            "name": "Visual Application",
            "type": "fullstack",
            "development_mode": true,
            "build_and_start": false,
            "template": "next-crud",
            "entities": entity_expense_input(),
            "features": ["core", "data", "crud-ui"],
            "ai_integration": false
        }))
        .await;

    let application = &result["application"];
    let project_id = result["projectId"].as_str().expect("project id");
    let expected_app_id = format!("worldbase.local.{project_id}");
    assert_eq!(
        application["appId"].as_str(),
        Some(expected_app_id.as_str())
    );
    assert_eq!(application["registered"], true);
    assert_eq!(
        application["enabled"], false,
        "AI-disabled apps must not report enabled capabilities"
    );
    assert_eq!(application["capabilities"], json!([]));
    assert!(root.join(".worldbase/app-capabilities.json").is_file());
}

#[tokio::test]
async fn app_scaffold_upgrade_result_reports_application() {
    let fixture = Fixture::new();
    let (created, _root) = fixture
        .create(json!({
            "name": "Expense Upgrade Application",
            "type": "fullstack",
            "development_mode": true,
            "build_and_start": false,
            "template": "next-crud",
            "entities": entity_expense_input(),
            "features": ["core", "data", "crud-ui", "ai", "search"]
        }))
        .await;
    let project_id = created["projectId"]
        .as_str()
        .expect("project id")
        .to_string();

    let upgraded = ProjectUpgradeTool
        .execute(json!({ "project_id": project_id }), &fixture.services)
        .await
        .expect("upgrade_project executes");

    assert_eq!(upgraded["success"], true, "upgrade failed: {upgraded}");
    let application = &upgraded["application"];
    let expected_app_id = format!("worldbase.local.{project_id}");
    assert_eq!(
        application["appId"].as_str(),
        Some(expected_app_id.as_str()),
        "upgrade result must expose the WorldBase local app id"
    );
    assert_eq!(application["registered"], true);
    assert_eq!(application["enabled"], true);

    let ids = capability_ids(application);
    for expected in ["app.health", "expense.list", "expense.create"] {
        assert!(
            ids.contains(&expected),
            "missing capability {expected}: {ids:?}"
        );
    }
}
