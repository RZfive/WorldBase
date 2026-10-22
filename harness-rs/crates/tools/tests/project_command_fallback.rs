use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tempfile::TempDir;
use worldbase_tools::{
    HostBridge, Tool, ToolServices, WorkspaceCommandTool, WorkspaceShellCommandTool,
};

struct Fixture {
    _temp: TempDir,
    workspace: PathBuf,
    project: PathBuf,
    services: ToolServices,
}

impl Fixture {
    fn new(target_project_id: Option<&str>, with_folder_workspace: bool) -> Self {
        let temp = tempfile::Builder::new()
            .prefix("worldbase-project-command-fallback-")
            .tempdir()
            .expect("create temp root");
        let workspace = temp.path().join("workspace");
        let projects = temp.path().join("projects");
        let alpha = projects.join("alpha");
        let beta = projects.join("beta");
        std::fs::create_dir_all(&workspace).expect("create workspace");
        std::fs::create_dir_all(&alpha).expect("create alpha project");
        std::fs::create_dir_all(&beta).expect("create beta project");

        let workspace = workspace.canonicalize().expect("canonicalize workspace");
        let project = alpha.canonicalize().expect("canonicalize project");
        let store = Arc::new(
            worldbase_memory::Store::open(&temp.path().join("store.sqlite"))
                .expect("open test store"),
        );
        let mut services = ToolServices {
            host: Arc::new(HostBridge::new()),
            current_stream: Arc::new(Mutex::new(String::new())),
            abort: None,
            workspace: workspace.clone(),
            folder_workspace: None,
            target_project_id: target_project_id.map(ToOwned::to_owned),
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
        if with_folder_workspace {
            services.folder_workspace = Some(workspace.clone());
        }

        Self {
            _temp: temp,
            workspace,
            project,
            services,
        }
    }

    fn project_root(&self, project_id: &str) -> PathBuf {
        self.services
            .projects
            .project_root(project_id)
            .expect("resolve project root")
    }
}

fn cwd_probe() -> &'static str {
    if cfg!(windows) {
        "echo %CD%"
    } else {
        "pwd -P"
    }
}

fn result_cwd(result: &serde_json::Value) -> &Path {
    Path::new(
        result["cwd"]
            .as_str()
            .expect("command record should include cwd"),
    )
}

#[tokio::test]
async fn shell_command_falls_back_to_active_project_root() {
    let fixture = Fixture::new(Some("alpha"), false);
    let result = WorkspaceShellCommandTool
        .execute(json!({ "command": "echo ok" }), &fixture.services)
        .await
        .expect("shell command should run in the active project");

    assert_eq!(result["status"], "completed");
    assert_eq!(result["exitCode"], 0);
    assert!(result["stdout"]
        .as_str()
        .expect("stdout should be captured")
        .contains("ok"));
    assert_eq!(result["project_id"], "alpha");
    assert_eq!(result_cwd(&result), fixture.project.as_path());
    assert_ne!(result_cwd(&result), fixture.workspace.as_path());
}

#[tokio::test]
async fn workspace_command_falls_back_to_active_project_root() {
    let fixture = Fixture::new(Some("alpha"), false);
    let result = WorkspaceCommandTool
        .execute(json!({ "command": cwd_probe() }), &fixture.services)
        .await
        .expect("workspace command should run in the active project");

    assert_eq!(result["status"], "completed");
    assert_eq!(result["exitCode"], 0);
    assert_eq!(result["project_id"], "alpha");
    assert_eq!(result_cwd(&result), fixture.project.as_path());
    assert_eq!(
        Path::new(
            result["stdout"]
                .as_str()
                .expect("stdout should be captured")
                .trim()
        ),
        fixture.project.as_path(),
        "the command's real working directory must be the project root"
    );
}

#[tokio::test]
async fn explicit_folder_workspace_wins_over_active_project() {
    let fixture = Fixture::new(Some("alpha"), true);

    let shell = WorkspaceShellCommandTool
        .execute(json!({ "command": "echo ok" }), &fixture.services)
        .await
        .expect("shell command should run in the folder workspace");
    assert_eq!(result_cwd(&shell), fixture.workspace.as_path());
    assert!(shell.get("project_id").is_none());

    let workspace = WorkspaceCommandTool
        .execute(json!({ "command": cwd_probe() }), &fixture.services)
        .await
        .expect("workspace command should run in the folder workspace");
    assert_eq!(result_cwd(&workspace), fixture.workspace.as_path());
    assert!(workspace.get("project_id").is_none());
}

#[tokio::test]
async fn missing_folder_workspace_and_target_project_returns_original_error() {
    let fixture = Fixture::new(None, false);

    let shell = WorkspaceShellCommandTool
        .execute(json!({ "command": "echo ok" }), &fixture.services)
        .await
        .expect_err("shell command must not run without a workspace or project");
    assert_eq!(
        shell.to_string(),
        "no folder workspace is selected for this conversation"
    );

    let workspace = WorkspaceCommandTool
        .execute(json!({ "command": "echo ok" }), &fixture.services)
        .await
        .expect_err("workspace command must not run without a workspace or project");
    assert_eq!(
        workspace.to_string(),
        "no folder workspace is selected for this conversation"
    );
}

#[tokio::test]
async fn explicit_project_id_takes_precedence_over_active_project() {
    let fixture = Fixture::new(Some("alpha"), false);
    let beta = fixture.project_root("beta");

    let result = WorkspaceShellCommandTool
        .execute(
            json!({ "command": "echo ok", "project_id": "beta" }),
            &fixture.services,
        )
        .await
        .expect("explicit project command should run");

    assert_eq!(result["project_id"], "beta");
    assert_eq!(result_cwd(&result), beta.as_path());
    assert_ne!(result_cwd(&result), fixture.project.as_path());
}

#[tokio::test]
async fn project_fallback_keeps_project_command_policy() {
    let fixture = Fixture::new(Some("alpha"), false);

    let shell = WorkspaceShellCommandTool
        .execute(
            json!({ "command": "echo one && echo two" }),
            &fixture.services,
        )
        .await
        .expect("fallback shell commands keep normal shell semantics");
    let stdout = shell["stdout"].as_str().unwrap_or_default();
    assert!(stdout.contains("one"));
    assert!(stdout.contains("two"));

    let workspace = WorkspaceCommandTool
        .execute(json!({ "command": "npm i" }), &fixture.services)
        .await
        .expect_err("fallback workspace commands must use the project policy");
    assert!(workspace
        .to_string()
        .contains("npm command is not allowed here"));

    let escaped = WorkspaceShellCommandTool
        .execute(
            json!({ "command": "echo ok", "cwd": "../outside" }),
            &fixture.services,
        )
        .await
        .expect_err("cwd must stay inside the project root");
    assert!(escaped
        .to_string()
        .contains("project file path escapes project"));
}

#[test]
fn command_permission_and_plan_mode_behavior_is_unchanged() {
    assert_eq!(WorkspaceCommandTool.permission(), "ask");
    assert_eq!(WorkspaceShellCommandTool.permission(), "ask");
    assert!(WorkspaceCommandTool.electron_native());
    assert!(WorkspaceShellCommandTool.electron_native());

    let fixture = Fixture::new(Some("alpha"), false);
    assert!(fixture.services.enter_plan_mode("review"));
    assert!(!fixture
        .services
        .is_tool_allowed_in_plan_mode(WorkspaceShellCommandTool.name()));
}
