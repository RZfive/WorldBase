use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tempfile::TempDir;
use worldbase_tools::coding_apply::CodingApplyTool;
use worldbase_tools::coding_diagnose::CodingDiagnoseTool;
use worldbase_tools::coding_edit::CodingEditTool;
use worldbase_tools::coding_fix::CodingFixDependenciesTool;
use worldbase_tools::coding_lsp::CodingLspTool;
use worldbase_tools::coding_project::CodingProjectTool;
use worldbase_tools::coding_verify::CodingVerifyTool;
use worldbase_tools::{HostBridge, Tool, ToolServices};

struct Fixture {
    _temp: TempDir,
    folder: PathBuf,
    services: ToolServices,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::Builder::new()
            .prefix("worldbase-coding-folder-")
            .tempdir()
            .expect("create temp root");
        let workspace = temp.path().join("workspace");
        let projects = temp.path().join("projects");
        let folder = workspace.clone();
        std::fs::create_dir_all(&folder).expect("create folder workspace");
        std::fs::create_dir_all(&projects).expect("create projects root");
        let workspace = workspace.canonicalize().expect("canonicalize workspace");
        let folder = folder.canonicalize().expect("canonicalize folder");
        let store = Arc::new(
            worldbase_memory::Store::open(&temp.path().join("store.sqlite"))
                .expect("open test store"),
        );
        let services = ToolServices {
            host: Arc::new(HostBridge::new()),
            current_stream: Arc::new(Mutex::new(String::new())),
            abort: None,
            workspace: workspace.clone(),
            folder_workspace: Some(folder.clone()),
            target_project_id: None,
            created_project_id: Arc::new(Mutex::new(None)),
            allowed_mcp_server_ids: None,
            plan_goal: Arc::new(Mutex::new(None)),
            todo_items: Arc::new(Mutex::new(Vec::new())),
            read_files: Arc::new(Mutex::new(std::collections::HashSet::new())),
            visible_tool_catalog: None,
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
            folder,
            services,
        }
    }

    fn write(&self, relative: &str, content: &str) -> PathBuf {
        let path = self.folder.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent");
        }
        std::fs::write(&path, content).expect("write fixture file");
        path
    }
}

#[tokio::test]
async fn coding_edit_writes_without_a_managed_project() {
    let fixture = Fixture::new();
    let file = fixture.write(
        "src/math.ts",
        "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    );

    let result = CodingEditTool
        .execute(
            json!({
                "file_path": "src/math.ts",
                "operation": "replace",
                "selector": { "kind": "function", "name": "add" },
                "replacement": "function add(a: number, b: number): number {\n  return a * b;\n}"
            }),
            &fixture.services,
        )
        .await
        .expect("coding_edit should use the folder workspace");

    assert_eq!(result["changed"], true);
    assert_eq!(result["filePath"], "src/math.ts");
    assert!(result["after"].as_str().unwrap().contains("a * b"));
    assert!(std::fs::read_to_string(file).unwrap().contains("a * b"));
}

#[tokio::test]
async fn coding_apply_writes_without_a_managed_project() {
    let fixture = Fixture::new();
    let file = fixture.write(
        "src/math.ts",
        "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    );

    let result = CodingApplyTool
        .execute(
            json!({
                "edits": [{
                    "file_path": "src/math.ts",
                    "operation": "replace",
                    "selector": { "kind": "function", "name": "add" },
                    "replacement": "function add(a: number, b: number): number {\n  return a - b;\n}"
                }]
            }),
            &fixture.services,
        )
        .await
        .expect("coding_apply should use the folder workspace");

    assert_eq!(result["applied"], true);
    assert!(std::fs::read_to_string(file).unwrap().contains("a - b"));
}

#[tokio::test]
async fn coding_verify_reads_the_folder_profile_without_a_project_id() {
    let fixture = Fixture::new();
    fixture.write("package.json", r#"{"name":"fixture","scripts":{"build":"node -e \"process.exit(0)\""}}"#);
    fixture.write("README.md", "# fixture\n");

    let result = CodingVerifyTool
        .execute(
            json!({ "changed_files": ["README.md"] }),
            &fixture.services,
        )
        .await
        .expect("coding_verify should detect the folder workspace profile");

    assert_eq!(result["passed"], true);
    assert_eq!(result["workspaceKind"], "folder");
    assert_eq!(result["projectId"], Value::Null);
    assert_eq!(result["profile"]["projectKind"], "frontendNode");
}

#[tokio::test]
async fn coding_diagnose_loads_the_folder_manifest() {
    let fixture = Fixture::new();
    fixture.write(
        "package.json",
        r#"{"name":"fixture","dependencies":{"left-pad":"^1.3.0"}}"#,
    );

    let result = CodingDiagnoseTool
        .execute(
            json!({
                "lsp_diagnostics": {
                    "uri": "file:///workspace/src/main.ts",
                    "diagnostics": [{
                        "range": {
                            "start": { "line": 0, "character": 0 },
                            "end": { "line": 0, "character": 10 }
                        },
                        "severity": 1,
                        "code": "TS2307",
                        "message": "Cannot find module 'missing-package'."
                    }]
                }
            }),
            &fixture.services,
        )
        .await
        .expect("coding_diagnose should read the folder manifest");

    assert!(!result["dependency"]["issues"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn coding_project_indexes_the_folder_workspace() {
    let fixture = Fixture::new();
    fixture.write(
        "src/a.ts",
        "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    );
    fixture.write(
        "src/b.ts",
        "export const value = 1;\n",
    );

    let result = CodingProjectTool
        .execute(
            json!({ "operation": "symbols", "name": "add" }),
            &fixture.services,
        )
        .await
        .expect("coding_project should index the folder workspace");

    assert_eq!(result["operation"], "symbols");
    assert_eq!(result["symbols"][0]["file"], "src/a.ts");
}

#[tokio::test]
async fn coding_lsp_resolves_a_folder_file_before_server_lookup() {
    let fixture = Fixture::new();
    fixture.write("src/main.rs", "fn main() {}\n");

    let result = CodingLspTool
        .execute(
            json!({
                "file_path": "src/main.rs",
                "server_program": "definitely-missing-worldbase-lsp-server"
            }),
            &fixture.services,
        )
        .await
        .expect("coding_lsp should use the folder workspace");

    assert_eq!(result["available"], false);
    assert_eq!(result["filePath"], "src/main.rs");
    assert_eq!(result["languageId"], "rust");
}

#[tokio::test]
async fn coding_fix_plans_without_a_managed_project() {
    let fixture = Fixture::new();
    fixture.write("package.json", r#"{"name":"fixture"}"#);

    let result = CodingFixDependenciesTool
        .execute(
            json!({
                "issues": [{
                    "kind": "missingPackage",
                    "package": "left-pad",
                    "message": "Cannot find module 'left-pad'.",
                    "confidence": 0.9,
                    "suggestedFix": {
                        "action": "install",
                        "package": "left-pad",
                        "version": null,
                        "command": "pnpm add left-pad",
                        "reason": "test"
                    }
                }],
                "dry_run": true
            }),
            &fixture.services,
        )
        .await
        .expect("coding_fix_dependencies should use the folder workspace");

    assert_eq!(result["workspaceKind"], "folder");
    assert_eq!(result["projectId"], Value::Null);
    assert_eq!(result["plannedCommands"], json!(["pnpm add left-pad"]));
}

#[tokio::test]
async fn coding_tools_reject_folder_path_escape() {
    let fixture = Fixture::new();
    fixture.write("outside.ts", "export const outside = true;\n");

    let error = CodingEditTool
        .execute(
            json!({
                "file_path": "../outside.ts",
                "operation": "replace",
                "selector": { "kind": "variable", "name": "outside" },
                "replacement": "export const outside = false;"
            }),
            &fixture.services,
        )
        .await
        .expect_err("folder escape must be rejected");

    assert!(error.to_string().contains("escape") || error.to_string().contains("unsupported"));
}
