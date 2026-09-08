//! 内置 Agent 工具集（与 TS 版 1:1 能力对齐的平台子集）。
//!
//! 工具分域：`core` 全端可用；`desktop` 域（exec/project 等）在移动端握手时
//! 被能力协商过滤。

use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use worldbase_protocol::types::ToolDescriptor;

pub mod command;
pub mod compat_tools;
pub mod document;
pub mod document_artifacts;
mod electron_contract;
pub mod fs_tools;
pub mod group_tools;
pub mod host_bridge;
pub mod host_tools;
pub mod lightapp_tool;
pub mod mcp_tools;
pub mod memory_tools;
pub mod project_tools;
pub mod schedule_tools;
pub mod skill_tools;
pub mod subagent;
pub mod todo;
pub mod web;

pub use command::ExecuteCommandTool;
pub use compat_tools::{
    AnalyzeProjectDataTool, CallProjectApiTool, ClearProjectBuildFlagTool, CreateAgentGroupTool,
    CreateAgentTool, CreateScheduledTaskTool, DocumentListTool, DocumentReadTool, EditImageTool,
    EnterPlanModeTool, ExitPlanModeTool, FillCurrentPageFormTool, FinalizeProjectTool,
    GenerateImageTool, GetProjectCommandStatusTool, GetProjectLogsTool, GetTaskStatusTool,
    GetWorkspaceCommandStatusTool, GlobSearchTool, GrepSearchTool, InstallMcpServerTool,
    InstallSkillTool, ListAgentWorkspaceCatalogTool, ListScheduledTasksTool, LocalCommandTool,
    LocalReadFileTool, LocalWriteFileTool, ManageTodoListTool, OpenProjectAppTool,
    QueryProjectDatabaseTool, RebuildProjectTool, RunProjectCommandTool,
    SaveCurrentPageAsDocumentTool, SpawnSubagentsTool, StartAsyncTaskTool, WorkspaceCommandTool,
    WorkspaceDeleteFileTool, WorkspaceEditFileTool, WorkspaceGlobTool, WorkspaceGrepTool,
    WorkspaceListFilesTool, WorkspacePatchFileTool, WorkspaceReadFileTool, WorkspaceWriteFileTool,
};
pub use document::{DocParseTool, DocWriteTool};
pub use fs_tools::{
    DeleteFileTool, EditFileTool, ListDirTool, PatchFileTool, ProjectDeleteFileTool,
    ProjectEditFileTool, ProjectListFilesTool, ProjectPatchFileTool, ProjectReadFileTool,
    ProjectWriteFileTool, ReadFileTool, WriteFileTool,
};
pub use group_tools::{
    group_collaboration_tools, GroupCollaborationRuntime, MessageAgentTool, ReadBoardTool,
    ReplyToUserTool, UpdateBoardTool,
};
pub use host_bridge::HostBridge;
pub use host_tools::{AskUserTool, InteractCurrentPageTool, ReadCurrentPageTool};
pub use lightapp_tool::CreateLightAppTool;
pub use mcp_tools::{
    dynamic_mcp_tools, McpCallTool, McpGetPromptTool, McpListPromptsTool, McpListResourcesTool,
    McpListServersTool, McpReadResourceTool,
};
pub use memory_tools::{MemoryAddTool, MemoryDeleteTool, MemorySearchTool};
pub use project_tools::{
    ProjectCreateTool, ProjectDevRestartTool, ProjectDevStartTool, ProjectDevStopTool,
    ProjectListTool, ProjectStatusTool,
};
pub use schedule_tools::{ScheduleCreateTool, ScheduleDeleteTool, ScheduleListTool};
pub use skill_tools::{SkillListTool, SkillRunTool};
pub use subagent::{
    SubagentRunRequest, SubagentRunResponse, SubagentRuntime, SubagentTaskRequest,
    SubagentTaskResult, SubagentTaskStatus, SubagentTokenUsage,
};
pub use todo::{TodoReadTool, TodoWriteTool};
pub use web::{FetchWebpageTool, WebFetchTool, WebSearchTool};
pub use worldbase_search::{glob as search_glob, grep as search_grep, GrepHit};

/// 工具运行时依赖（由 core 注入）。
#[derive(Clone)]
pub struct ToolServices {
    /// 宿主通道（反向 RPC：ask_user / 页面自动化）。
    pub host: Arc<HostBridge>,
    /// 当前工具调用所属流（反向请求路由用）。
    pub current_stream: Arc<std::sync::Mutex<String>>,
    /// Cancellation for the owning chat run. Direct `tool.call` requests do
    /// not have a parent run and leave this unset.
    pub abort: Option<CancellationToken>,
    /// Agent 工作区根目录。
    pub workspace: PathBuf,
    /// Electron conversation's explicitly selected local folder. This is
    /// intentionally separate from `workspace`, which remains the managed
    /// projects root used by project tools.
    pub folder_workspace: Option<PathBuf>,
    /// Existing managed project selected by the conversation, if any.
    pub target_project_id: Option<String>,
    /// `None` permits every configured MCP server. Electron normalizes empty
    /// selections to the same unrestricted policy before constructing this.
    pub allowed_mcp_server_ids: Option<Arc<HashSet<String>>>,
    /// Plan state belongs to one agent run. Keeping it here avoids one
    /// conversation's planning mode affecting another concurrent stream.
    pub plan_goal: Arc<std::sync::Mutex<Option<String>>>,
    /// The TypeScript harness keeps todo items in the agent instance rather
    /// than on disk. Mirror that per-run lifetime here.
    pub todo_items: Arc<std::sync::Mutex<Vec<Value>>>,
    /// Files observed or written during this run. Exact-string editors use
    /// this to reject blind edits, matching Electron's ReadFileTracker.
    pub read_files: Arc<std::sync::Mutex<HashSet<PathBuf>>>,
    /// Tool catalog that is actually executable for this connection's
    /// platform before an Agent-specific allow/deny policy is applied.
    /// Agent Workspace uses it to avoid offering Electron-only tools on mobile.
    pub visible_tool_catalog: Option<Arc<Vec<ToolDescriptor>>>,
    pub store: Arc<worldbase_memory::Store>,
    pub skills: Arc<worldbase_skills::SkillRegistry>,
    pub scheduler: Arc<worldbase_scheduler::Scheduler>,
    pub mcp: Arc<worldbase_mcp_client::McpManager>,
    pub projects: Arc<worldbase_project_runtime::ProjectRuntime>,
    /// Present only for a Rust-native group member run. Keeping it optional
    /// makes group collaboration impossible to invoke from a normal chat.
    pub group_collaboration: Option<Arc<dyn GroupCollaborationRuntime>>,
    /// Per-run subagent executor supplied by core. It captures the parent
    /// cancellation/progress context and enforces the nesting limit.
    pub subagent_runtime: Option<Arc<dyn SubagentRuntime>>,
}

impl ToolServices {
    pub fn set_current_stream(&self, stream_id: &str) {
        *self.current_stream.lock().unwrap() = stream_id.to_string();
    }

    pub fn mark_file_read(&self, path: &Path) {
        self.read_files.lock().unwrap().insert(path.to_path_buf());
    }

    pub fn has_read_file(&self, path: &Path) -> bool {
        self.read_files.lock().unwrap().contains(path)
    }

    pub fn enter_plan_mode(&self, goal: &str) -> bool {
        let mut current = self.plan_goal.lock().unwrap();
        if current.is_some() {
            return false;
        }
        *current = Some(goal.to_string());
        true
    }

    pub fn exit_plan_mode(&self) -> bool {
        let mut current = self.plan_goal.lock().unwrap();
        if current.is_none() {
            return false;
        }
        *current = None;
        true
    }

    pub fn plan_mode_active(&self) -> bool {
        self.plan_goal.lock().unwrap().is_some()
    }

    pub fn is_mcp_server_allowed(&self, server_id: &str) -> bool {
        self.allowed_mcp_server_ids
            .as_ref()
            .map(|allowed| allowed.contains(server_id))
            .unwrap_or(true)
    }

    pub fn allowed_mcp_server_ids(&self) -> Option<std::collections::BTreeSet<String>> {
        self.allowed_mcp_server_ids
            .as_ref()
            .map(|allowed| allowed.iter().cloned().collect())
    }

    /// Keep the Electron plan-mode contract at the execution boundary. The
    /// model may still have an older tool list from before it entered planning
    /// mode, so hiding tools from a later prompt is not sufficient.
    pub fn is_tool_allowed_in_plan_mode(&self, tool_name: &str) -> bool {
        if !self.plan_mode_active() {
            return true;
        }
        if tool_name == "mcp_call" || tool_name.starts_with("mcp__") {
            return false;
        }
        !matches!(
            tool_name,
            "create_project"
                | "write_project_file"
                | "patch_project_file"
                | "delete_project_file"
                | "run_project_command"
                | "write_workspace_file"
                | "edit_workspace_file"
                | "patch_workspace_file"
                | "delete_workspace_file"
                | "run_workspace_command"
                | "install_dependencies"
                | "install_skill"
                | "install_mcp_server"
                | "rebuild_project"
                | "start_project_server"
                | "restart_project_server"
                | "clear_project_build_flag"
                // Rust-only legacy names are not visible in Electron's TS
                // agent, but must not bypass its plan-mode guarantees.
                | "write_file"
                | "edit_file"
                | "delete_file"
                | "patch_file"
                | "execute_command"
                | "project_dev_start"
                | "project_dev_stop"
                | "project_dev_restart"
        )
    }

    pub fn workspace_path(&self, rel: &str) -> PathBuf {
        let p = Path::new(rel);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            self.workspace.join(p)
        }
    }

    pub fn folder_workspace_root(&self) -> &Path {
        self.folder_workspace.as_deref().unwrap_or(&self.workspace)
    }

    pub fn folder_workspace_path(&self, rel: &str) -> PathBuf {
        let p = Path::new(rel);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            self.folder_workspace_root().join(p)
        }
    }

    pub fn ensure_folder_workspace_path(&self, path: &Path) -> Result<()> {
        self.ensure_path_within(self.folder_workspace_root(), path)
    }

    /// Verify a path after resolving symlinks and lexical `..` components.
    ///
    /// A plain `Path::starts_with` check is insufficient for a path such as
    /// `<workspace>/../outside/file` when the target does not exist yet (the
    /// lexical prefix still appears to be inside the workspace).  Resolve the
    /// nearest existing ancestor, then append missing components and compare
    /// against the canonical workspace root.
    pub fn ensure_workspace_path(&self, path: &Path) -> Result<()> {
        self.ensure_path_within(&self.workspace, path)
    }

    fn ensure_path_within(&self, root_path: &Path, path: &Path) -> Result<()> {
        let root = root_path
            .canonicalize()
            .unwrap_or_else(|_| root_path.to_path_buf());
        let mut existing = path.to_path_buf();
        let mut missing = Vec::new();
        while !existing.exists() {
            let Some(name) = existing.file_name().map(|name| name.to_os_string()) else {
                anyhow::bail!("invalid workspace path")
            };
            missing.push(name);
            let Some(parent) = existing.parent() else {
                anyhow::bail!("invalid workspace path")
            };
            existing = parent.to_path_buf();
        }
        let mut resolved = existing.canonicalize()?;
        for component in missing.iter().rev() {
            resolved.push(component);
        }
        anyhow::ensure!(resolved.starts_with(&root), "path escapes workspace");
        Ok(())
    }
}

/// 工具 trait：domain/permission 支持能力协商与权限引擎。
#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn input_schema(&self) -> Value;
    fn domain(&self) -> &str {
        "core"
    }
    fn permission(&self) -> &str {
        "allow"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value>;
}

/// An inexpensive compatibility wrapper for a tool whose operation is the
/// same but whose public Electron name differs.  Keeping this as a first-class
/// tool (rather than string rewriting in the agent loop) means direct
/// `tool.call` requests and LLM tool schemas stay in sync.
pub struct AliasTool {
    alias: String,
    description: String,
    schema: Value,
    inner: Arc<dyn Tool>,
}

impl AliasTool {
    pub fn new(alias: impl Into<String>, inner: Arc<dyn Tool>, schema: Value) -> Self {
        let alias = alias.into();
        let description = inner.description().to_string();
        Self {
            alias,
            description,
            schema,
            inner,
        }
    }
}

#[async_trait]
impl Tool for AliasTool {
    fn name(&self) -> &str {
        &self.alias
    }

    fn description(&self) -> &str {
        &self.description
    }

    fn input_schema(&self) -> Value {
        self.schema.clone()
    }

    fn domain(&self) -> &str {
        self.inner.domain()
    }

    fn permission(&self) -> &str {
        self.inner.permission()
    }

    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        self.inner.execute(input, services).await
    }
}

impl dyn Tool {
    pub fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: self.name().to_string(),
            description: self.description().to_string(),
            input_schema: self.input_schema(),
            domain: self.domain().to_string(),
            permission: self.permission().to_string(),
        }
    }
}

struct MobileInstallMcpServerTool {
    inner: Arc<dyn Tool>,
}

#[async_trait]
impl Tool for MobileInstallMcpServerTool {
    fn name(&self) -> &str {
        self.inner.name()
    }

    fn description(&self) -> &str {
        "Install or update a remote MCP server configuration. Mobile supports streamable HTTP and SSE transports only."
    }

    fn input_schema(&self) -> Value {
        let mut schema = self.inner.input_schema();
        if let Some(properties) = schema.get_mut("properties").and_then(Value::as_object_mut) {
            for unsupported in ["command", "args", "cwd", "env", "overwrite_existing"] {
                properties.remove(unsupported);
            }
            if let Some(transport) = properties
                .get_mut("transport")
                .and_then(Value::as_object_mut)
            {
                transport.insert("enum".into(), json!(["streamable-http", "sse"]));
                transport.insert(
                    "description".into(),
                    json!("Remote transport used by the MCP server. Mobile cannot launch stdio subprocesses."),
                );
            }
        }
        schema
    }

    fn domain(&self) -> &str {
        self.inner.domain()
    }

    fn permission(&self) -> &str {
        self.inner.permission()
    }

    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        ensure_mobile_mcp_transport(&input)?;
        self.inner.execute(input, services).await
    }
}

fn ensure_mobile_mcp_transport(input: &Value) -> Result<()> {
    let transport = require_str(input, "transport")?;
    anyhow::ensure!(
        matches!(transport, "streamable-http" | "sse"),
        "MCP transport `{transport}` is unavailable on mobile; use `streamable-http` or `sse`"
    );
    Ok(())
}

/// Mobile has no selected Electron folder/project runtime and cannot launch
/// subprocesses. Keep this an explicit allow-list so newly added desktop
/// compatibility tools do not silently leak into the mobile model contract.
fn mobile_tool_supported(name: &str) -> bool {
    name.starts_with("mcp__")
        || matches!(
            name,
            "read_file"
                | "write_file"
                | "edit_file"
                | "list_dir"
                | "delete_file"
                | "patch_file"
                | "glob"
                | "grep"
                | "web_search"
                | "web_fetch"
                | "fetch_webpage"
                | "todo_read"
                | "todo_write"
                | "doc_parse"
                | "doc_write"
                | "memory_add"
                | "memory_search"
                | "memory_delete"
                | "skill_list"
                | "skill_run"
                | "list_skills"
                | "run_skill"
                | "create_scheduled_task"
                | "schedule_create"
                | "schedule_list"
                | "schedule_delete"
                | "list_scheduled_tasks"
                | "mcp_call"
                | "mcp_list_servers"
                | "mcp_list_resources"
                | "mcp_read_resource"
                | "mcp_list_prompts"
                | "mcp_get_prompt"
                | "install_mcp_server"
                | "create_lightweight_app"
                | "ask_user"
                | "read_current_page"
                | "interact_current_page"
                | "fill_current_page_form"
                | "save_current_page_as_document"
                | "enter_plan_mode"
                | "exit_plan_mode"
                | "manage_todo_list"
                | "install_skill"
                | "list_agent_workspace_catalog"
                | "create_agent"
                | "create_agent_group"
                | "generate_image"
                | "edit_image"
                | "list_documents"
                | "read_document"
                | "spawn_subagents"
        )
}

/// 能力协商过滤：
/// - excludes 含 subprocess/port_binding → 隐藏 desktop 域
/// - ask_user 需要 interactive；其余 host 工具需要 webview_automation
/// - mobile 仅暴露当前进程内运行时能够完整执行的显式工具集
pub fn filter_tools<'a>(
    tools: &'a [Arc<dyn Tool>],
    caps: &worldbase_protocol::types::Capabilities,
) -> Vec<Arc<dyn Tool>> {
    let hide_desktop = caps
        .excludes
        .iter()
        .any(|e| e == "subprocess" || e == "port_binding");
    let has_webview = caps.features.iter().any(|f| f == "webview_automation");
    let is_mobile = caps.platform.starts_with("mobile");
    tools
        .iter()
        .filter_map(|tool| {
            if caps.platform == "electron" && !is_electron_tool_name(tool.name()) {
                return None;
            }
            if is_mobile && !mobile_tool_supported(tool.name()) {
                return None;
            }
            let domain_available = match tool.domain() {
                "desktop" => !hide_desktop,
                "host" if tool.name() == "ask_user" => caps.has("interactive"),
                "host" => has_webview,
                "electron_host" => caps.platform == "electron",
                _ => true,
            };
            if !domain_available {
                return None;
            }

            if is_mobile && tool.name() == "install_mcp_server" {
                return Some(Arc::new(MobileInstallMcpServerTool {
                    inner: tool.clone(),
                }) as Arc<dyn Tool>);
            }
            Some(tool.clone())
        })
        .collect()
}

/// Whether a tool belongs to Electron's generated canonical agent surface.
pub fn is_electron_tool_name(name: &str) -> bool {
    electron_contract::contains(name)
}

/// Sorted canonical tool names advertised during an Electron handshake.
pub fn electron_tool_names() -> Vec<String> {
    electron_contract::names()
}

pub fn descriptors(tools: &[Arc<dyn Tool>]) -> Vec<ToolDescriptor> {
    tools.iter().map(|t| t.descriptor()).collect()
}

fn arg_str<'a>(input: &'a Value, key: &str) -> Result<&'a str> {
    input
        .get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("missing required string parameter: {key}"))
}

pub(crate) use arg_str as require_str;

/// 注册全部内置工具。
pub fn builtin_tools() -> Vec<Arc<dyn Tool>> {
    let mut tools: Vec<Arc<dyn Tool>> = vec![
        Arc::new(ReadFileTool),
        Arc::new(WriteFileTool),
        Arc::new(EditFileTool),
        Arc::new(ListDirTool),
        Arc::new(DeleteFileTool),
        Arc::new(PatchFileTool),
        // Electron-compatible project file operations.  The active harness
        // workspace is treated as the project root by these wrappers.
        Arc::new(ProjectReadFileTool),
        Arc::new(ProjectWriteFileTool),
        Arc::new(ProjectEditFileTool),
        Arc::new(ProjectDeleteFileTool),
        Arc::new(ProjectPatchFileTool),
        Arc::new(ProjectListFilesTool),
        Arc::new(GlobTool),
        Arc::new(GrepTool),
        Arc::new(WebSearchTool),
        Arc::new(WebFetchTool),
        Arc::new(FetchWebpageTool),
        Arc::new(TodoReadTool),
        Arc::new(TodoWriteTool),
        Arc::new(DocParseTool),
        Arc::new(DocWriteTool),
        Arc::new(MemoryAddTool),
        Arc::new(MemorySearchTool),
        Arc::new(MemoryDeleteTool),
        Arc::new(SkillListTool),
        Arc::new(SkillRunTool),
        Arc::new(ScheduleCreateTool),
        Arc::new(ScheduleListTool),
        Arc::new(ScheduleDeleteTool),
        Arc::new(McpCallTool),
        Arc::new(McpListServersTool),
        Arc::new(McpListResourcesTool),
        Arc::new(McpReadResourceTool),
        Arc::new(McpListPromptsTool),
        Arc::new(McpGetPromptTool),
        Arc::new(CreateLightAppTool),
        Arc::new(AskUserTool),
        Arc::new(ReadCurrentPageTool),
        Arc::new(InteractCurrentPageTool),
        Arc::new(ProjectListTool),
        Arc::new(ProjectCreateTool),
        Arc::new(ProjectDevStartTool),
        Arc::new(ProjectDevStopTool),
        Arc::new(ProjectDevRestartTool),
        Arc::new(ProjectStatusTool),
        Arc::new(ExecuteCommandTool),
        Arc::new(WorkspaceListFilesTool),
        Arc::new(WorkspaceReadFileTool),
        Arc::new(WorkspaceWriteFileTool),
        Arc::new(WorkspaceEditFileTool),
        Arc::new(WorkspacePatchFileTool),
        Arc::new(WorkspaceDeleteFileTool),
        Arc::new(WorkspaceGlobTool),
        Arc::new(WorkspaceGrepTool),
        Arc::new(WorkspaceCommandTool),
        Arc::new(RunProjectCommandTool),
        Arc::new(GlobSearchTool),
        Arc::new(GrepSearchTool),
        Arc::new(GetProjectCommandStatusTool),
        Arc::new(GetWorkspaceCommandStatusTool),
        Arc::new(LocalReadFileTool),
        Arc::new(LocalWriteFileTool),
        Arc::new(LocalCommandTool),
        Arc::new(CallProjectApiTool),
        Arc::new(QueryProjectDatabaseTool),
        Arc::new(AnalyzeProjectDataTool),
        Arc::new(RebuildProjectTool),
        Arc::new(FinalizeProjectTool),
        Arc::new(ClearProjectBuildFlagTool),
        Arc::new(GetProjectLogsTool),
        Arc::new(OpenProjectAppTool),
        Arc::new(EnterPlanModeTool),
        Arc::new(ExitPlanModeTool),
        Arc::new(ManageTodoListTool),
        Arc::new(InstallSkillTool),
        Arc::new(InstallMcpServerTool),
        Arc::new(ListAgentWorkspaceCatalogTool),
        Arc::new(CreateAgentTool),
        Arc::new(CreateAgentGroupTool),
        Arc::new(StartAsyncTaskTool),
        Arc::new(GetTaskStatusTool),
        Arc::new(SpawnSubagentsTool),
        Arc::new(FillCurrentPageFormTool),
        Arc::new(SaveCurrentPageAsDocumentTool),
        Arc::new(GenerateImageTool),
        Arc::new(EditImageTool),
        Arc::new(DocumentListTool),
        Arc::new(DocumentReadTool),
        Arc::new(CreateScheduledTaskTool),
        Arc::new(ListScheduledTasksTool),
    ];

    // The Electron agent uses these names in prompts and persisted tool
    // calls.  Keep the original Rust names for backwards compatibility, but
    // expose the canonical names as aliases so either client can drive the
    // same harness binary.  Aliases deliberately share the inner tool's
    // schema/permission/domain; operations whose input contract differs are
    // implemented by dedicated wrappers in their source module above.
    for (alias, target) in [
        ("list_projects", "project_list"),
        ("start_project_server", "project_dev_start"),
        ("restart_project_server", "project_dev_restart"),
        ("fetch_webpage", "web_fetch"),
        ("list_skills", "skill_list"),
        ("run_skill", "skill_run"),
    ] {
        let Some(inner) = tools.iter().find(|tool| tool.name() == target).cloned() else {
            continue;
        };
        if tools.iter().any(|tool| tool.name() == alias) {
            continue;
        }
        let schema = match alias {
            "start_project_server" | "restart_project_server" => json!({
                "type": "object",
                "properties": {
                    "project_id": { "type": "string" }
                },
                "required": ["project_id"]
            }),
            "run_project_command" => json!({
                "type": "object",
                "properties": {
                    "project_id": { "type": "string" },
                    "command": { "type": "string" },
                    "cwd": { "type": "string" },
                    "timeout": { "type": "integer" }
                },
                "required": ["project_id", "command"]
            }),
            "glob_search" => json!({
                "type": "object",
                "properties": {
                    "project_id": { "type": "string" },
                    "pattern": { "type": "string" },
                    "dir_path": { "type": "string" },
                    "max_results": { "type": "integer" }
                },
                "required": ["project_id", "pattern"]
            }),
            "grep_search" => json!({
                "type": "object",
                "properties": {
                    "project_id": { "type": "string" },
                    "pattern": { "type": "string" },
                    "dir_path": { "type": "string" },
                    "is_regexp": { "type": "boolean" },
                    "case_sensitive": { "type": "boolean" },
                    "max_results": { "type": "integer" },
                    "context_lines": { "type": "integer" }
                },
                "required": ["project_id", "pattern"]
            }),
            _ => inner.input_schema(),
        };
        tools.push(Arc::new(AliasTool::new(alias, inner, schema)));
    }

    electron_contract::apply(tools)
}

// ---------- search-backed tools ----------

pub struct GlobTool;

#[async_trait]
impl Tool for GlobTool {
    fn name(&self) -> &str {
        "glob"
    }
    fn description(&self) -> &str {
        "按 glob 模式（如 **/*.rs）列出工作区文件"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "glob 模式" },
                "limit": { "type": "integer", "description": "最多返回数量，默认 100" }
            },
            "required": ["pattern"]
        })
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let pattern = require_str(&input, "pattern")?;
        let limit = input.get("limit").and_then(|v| v.as_u64()).unwrap_or(100) as usize;
        let files = search_glob(&services.workspace, pattern, limit)?;
        Ok(json!({
            "files": files.iter().map(|p| p.strip_prefix(&services.workspace).unwrap_or(&p).to_string_lossy()).collect::<Vec<_>>(),
        }))
    }
}

pub struct GrepTool;

#[async_trait]
impl Tool for GrepTool {
    fn name(&self) -> &str {
        "grep"
    }
    fn description(&self) -> &str {
        "在工作区文件内容中搜索（支持正则；literal=true 时按字面量）"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "搜索模式（正则）" },
                "literal": { "type": "boolean", "description": "按字面量搜索" },
                "limit": { "type": "integer", "description": "最多返回命中数，默认 50" }
            },
            "required": ["pattern"]
        })
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let pattern = require_str(&input, "pattern")?;
        let literal = input
            .get("literal")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let limit = input.get("limit").and_then(|v| v.as_u64()).unwrap_or(50) as usize;
        let hits = search_grep(&services.workspace, pattern, literal, limit)?;
        Ok(json!({
            "hits": hits.iter().map(|h| json!({
                "path": Path::new(&h.path)
                        .strip_prefix(&services.workspace)
                        .map(|p| p.to_string_lossy().into_owned())
                        .unwrap_or_else(|_| h.path.clone()),
                "line": h.line,
                "text": h.text,
            })).collect::<Vec<_>>(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_tool_names_unique() {
        let tools = builtin_tools();
        let mut names: Vec<_> = tools.iter().map(|t| t.name().to_string()).collect();
        let total = names.len();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), total, "tool names must be unique");
        assert!(total >= 20, "expected a full toolset, got {total}");
    }

    #[test]
    fn electron_tool_names_are_present() {
        // This is the public tool-name surface registered by Electron's
        // `registerAllTools`. Keep it explicit so a compatibility wrapper is
        // not accidentally implemented but omitted from builtin_tools().
        let electron_tools = [
            "analyze_project_data",
            "ask_user",
            "call_project_api",
            "clear_project_build_flag",
            "create_agent",
            "create_agent_group",
            "create_project",
            "create_scheduled_task",
            "delete_project_file",
            "delete_workspace_file",
            "edit_image",
            "edit_project_file",
            "edit_workspace_file",
            "enter_plan_mode",
            "exit_plan_mode",
            "fetch_webpage",
            "fill_current_page_form",
            "finalize_project",
            "generate_image",
            "get_project_command_status",
            "get_project_logs",
            "get_project_status",
            "get_task_status",
            "get_workspace_command_status",
            "glob_search",
            "glob_workspace",
            "grep_search",
            "grep_workspace",
            "install_mcp_server",
            "install_skill",
            "interact_current_page",
            "list_agent_workspace_catalog",
            "list_documents",
            "list_project_files",
            "list_projects",
            "list_scheduled_tasks",
            "list_skills",
            "list_workspace_files",
            "local_read_file",
            "local_run_command",
            "local_write_file",
            "manage_todo_list",
            "open_project_app",
            "patch_project_file",
            "patch_workspace_file",
            "query_project_database",
            "read_current_page",
            "read_document",
            "read_project_file",
            "read_workspace_file",
            "rebuild_project",
            "restart_project_server",
            "run_project_command",
            "run_skill",
            "run_workspace_command",
            "save_current_page_as_document",
            "start_async_task",
            "start_project_server",
            "web_search",
            "write_project_file",
            "write_workspace_file",
        ];
        let names: std::collections::HashSet<String> = builtin_tools()
            .iter()
            .map(|tool| tool.name().to_string())
            .collect();
        for name in electron_tools {
            assert!(names.contains(name), "missing Electron tool: {name}");
        }
    }

    #[test]
    fn electron_descriptors_exactly_match_every_generated_contract() {
        let capabilities = worldbase_protocol::types::Capabilities {
            platform: "electron".into(),
            features: worldbase_protocol::types::Capabilities::desktop().features,
            excludes: vec![],
        };
        let actual = descriptors(&filter_tools(&builtin_tools(), &capabilities));
        let contracts = electron_contract::all();

        assert_eq!(
            contracts.len(),
            68,
            "expected the exact Electron tool catalog"
        );
        assert_eq!(
            actual.len(),
            contracts.len(),
            "Rust must expose exactly the generated Electron catalog"
        );

        let mut actual_by_name = std::collections::HashMap::new();
        for descriptor in actual {
            let name = descriptor.name.clone();
            assert!(
                actual_by_name.insert(name.clone(), descriptor).is_none(),
                "duplicate Rust Electron descriptor: {name}"
            );
        }

        let mut contract_names = std::collections::HashSet::new();
        for contract in contracts {
            assert!(
                contract_names.insert(contract.name.clone()),
                "duplicate generated Electron contract: {}",
                contract.name
            );
            let descriptor = actual_by_name
                .get(&contract.name)
                .unwrap_or_else(|| panic!("missing Rust Electron descriptor: {}", contract.name));
            assert_eq!(descriptor.name, contract.name);
            assert_eq!(
                descriptor.description, contract.description,
                "description mismatch for {}",
                descriptor.name
            );
            assert_eq!(
                descriptor.input_schema, contract.parameters,
                "input schema mismatch for {}",
                descriptor.name
            );
        }
        assert_eq!(actual_by_name.len(), contract_names.len());
    }

    #[test]
    fn create_agent_schema_matches_electron_workspace_options() {
        let tool = builtin_tools()
            .into_iter()
            .find(|tool| tool.name() == "create_agent")
            .expect("create_agent tool");
        let schema = tool.input_schema();
        let properties = schema["properties"]
            .as_object()
            .expect("create_agent properties");
        for name in [
            "reasoning_strength",
            "allowed_tools",
            "denied_tools",
            "memory_scopes",
            "allow_user_traits",
            "allow_agent_skills",
            "allow_steps",
            "allow_knowledge",
            "auto_reply_enabled",
            "auto_reply_require_mention",
        ] {
            assert!(
                properties.contains_key(name),
                "missing create_agent field: {name}"
            );
        }
    }

    #[test]
    fn desktop_domain_filtered_by_capabilities() {
        let tools = builtin_tools();
        let mut mobile = worldbase_protocol::types::Capabilities::mobile("mobile-ios");
        let filtered = filter_tools(&tools, &mobile);
        assert!(filtered.iter().all(|t| t.domain() != "desktop"));
        assert!(filtered.iter().any(|t| t.name() == "read_file"));
        // 页面 host 工具需要 webview_automation，ask_user 只需要交互宿主。
        assert!(filtered.iter().any(|t| t.name() == "read_current_page"));

        mobile.features.retain(|f| f != "webview_automation");
        let no_webview = filter_tools(&tools, &mobile);
        assert!(no_webview.iter().any(|t| t.name() == "ask_user"));
        assert!(no_webview
            .iter()
            .filter(|t| t.domain() == "host")
            .all(|t| t.name() == "ask_user"));
        assert!(no_webview.iter().all(|t| t.domain() != "electron_host"));

        mobile.features.retain(|f| f != "interactive");
        let no_interactive = filter_tools(&tools, &mobile);
        assert!(no_interactive.iter().all(|t| t.name() != "ask_user"));

        for unavailable in ["open_project_app"] {
            assert!(
                filtered.iter().all(|tool| tool.name() != unavailable),
                "mobile must not advertise Electron-only host tool {unavailable}"
            );
        }

        let full = filter_tools(&tools, &worldbase_protocol::types::Capabilities::desktop());
        assert!(full.iter().any(|t| t.name() == "execute_command"));
    }

    #[test]
    fn mobile_advertises_only_its_executable_tool_contract() {
        let mobile_tools = filter_tools(
            &builtin_tools(),
            &worldbase_protocol::types::Capabilities::mobile("mobile-ios"),
        );
        let mut actual = mobile_tools
            .iter()
            .map(|tool| tool.name().to_string())
            .collect::<Vec<_>>();
        actual.sort();

        let mut expected = [
            "ask_user",
            "create_agent",
            "create_agent_group",
            "create_lightweight_app",
            "create_scheduled_task",
            "delete_file",
            "doc_parse",
            "doc_write",
            "edit_file",
            "edit_image",
            "enter_plan_mode",
            "exit_plan_mode",
            "fetch_webpage",
            "fill_current_page_form",
            "generate_image",
            "glob",
            "grep",
            "install_mcp_server",
            "install_skill",
            "interact_current_page",
            "list_agent_workspace_catalog",
            "list_dir",
            "list_documents",
            "list_scheduled_tasks",
            "list_skills",
            "manage_todo_list",
            "mcp_call",
            "mcp_get_prompt",
            "mcp_list_prompts",
            "mcp_list_resources",
            "mcp_list_servers",
            "mcp_read_resource",
            "memory_add",
            "memory_delete",
            "memory_search",
            "patch_file",
            "read_current_page",
            "read_document",
            "read_file",
            "run_skill",
            "schedule_create",
            "schedule_delete",
            "schedule_list",
            "save_current_page_as_document",
            "skill_list",
            "skill_run",
            "spawn_subagents",
            "todo_read",
            "todo_write",
            "web_fetch",
            "web_search",
            "write_file",
        ]
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
        expected.sort();

        assert_eq!(actual, expected);
        assert_eq!(
            mobile_tools
                .iter()
                .find(|tool| tool.name() == "interact_current_page")
                .expect("mobile page interaction tool")
                .permission(),
            "ask",
            "mobile page interaction must retain Electron's confirmation boundary"
        );
    }

    #[test]
    fn mobile_mcp_install_contract_is_remote_only() {
        let mobile_tools = filter_tools(
            &builtin_tools(),
            &worldbase_protocol::types::Capabilities::mobile("mobile-android"),
        );
        let install = mobile_tools
            .iter()
            .find(|tool| tool.name() == "install_mcp_server")
            .expect("mobile remote MCP installer");
        let schema = install.input_schema();

        assert_eq!(
            schema["properties"]["transport"]["enum"],
            json!(["streamable-http", "sse"])
        );
        for unsupported in ["command", "args", "cwd", "env", "overwrite_existing"] {
            assert!(schema["properties"].get(unsupported).is_none());
        }
        assert!(ensure_mobile_mcp_transport(&json!({
            "transport": "stdio"
        }))
        .unwrap_err()
        .to_string()
        .contains("unavailable on mobile"));
        assert!(ensure_mobile_mcp_transport(&json!({
            "transport": "streamable-http"
        }))
        .is_ok());
        assert!(ensure_mobile_mcp_transport(&json!({
            "transport": "sse"
        }))
        .is_ok());
    }

    #[test]
    fn electron_only_advertises_the_canonical_generated_catalog() {
        let tools = builtin_tools();
        let capabilities = worldbase_protocol::types::Capabilities {
            platform: "electron".into(),
            features: worldbase_protocol::types::Capabilities::desktop().features,
            excludes: vec![],
        };
        let filtered = filter_tools(&tools, &capabilities);
        let expected = electron_tool_names();
        let mut actual = filtered
            .iter()
            .map(|tool| tool.name().to_string())
            .collect::<Vec<_>>();
        actual.sort();

        assert_eq!(actual, expected);
        assert!(!actual.contains(&"web_fetch".to_string()));
        assert!(!actual.contains(&"project_dev_start".to_string()));
        assert!(actual.contains(&"fetch_webpage".to_string()));
        assert!(actual.contains(&"start_project_server".to_string()));
    }

    #[test]
    fn workspace_path_rejects_parent_escape() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        std::fs::create_dir_all(&root).unwrap();
        let store =
            std::sync::Arc::new(worldbase_memory::Store::open(&root.join("db.sqlite")).unwrap());
        let services = ToolServices {
            host: std::sync::Arc::new(HostBridge::new()),
            current_stream: std::sync::Arc::new(std::sync::Mutex::new(String::new())),
            abort: None,
            workspace: root.clone(),
            folder_workspace: None,
            target_project_id: None,
            allowed_mcp_server_ids: None,
            plan_goal: std::sync::Arc::new(std::sync::Mutex::new(None)),
            todo_items: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
            read_files: std::sync::Arc::new(
                std::sync::Mutex::new(std::collections::HashSet::new()),
            ),
            visible_tool_catalog: None,
            store,
            skills: std::sync::Arc::new(worldbase_skills::SkillRegistry::new(vec![])),
            scheduler: std::sync::Arc::new(worldbase_scheduler::Scheduler::new(
                std::sync::Arc::new(
                    worldbase_memory::Store::open(&root.join("sched.sqlite")).unwrap(),
                ),
            )),
            mcp: std::sync::Arc::new(worldbase_mcp_client::McpManager::default()),
            projects: std::sync::Arc::new(worldbase_project_runtime::ProjectRuntime::new(
                root.join("projects"),
            )),
            group_collaboration: None,
            subagent_runtime: None,
        };
        assert!(services
            .ensure_workspace_path(&services.workspace_path("../outside.txt"))
            .is_err());
        assert!(services
            .ensure_workspace_path(&services.workspace_path("new/file.txt"))
            .is_ok());
    }

    #[test]
    fn plan_mode_is_scoped_to_one_run_and_blocks_mutations() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        std::fs::create_dir_all(&root).unwrap();
        let store =
            std::sync::Arc::new(worldbase_memory::Store::open(&root.join("db.sqlite")).unwrap());
        let services = ToolServices {
            host: std::sync::Arc::new(HostBridge::new()),
            current_stream: std::sync::Arc::new(std::sync::Mutex::new(String::new())),
            abort: None,
            workspace: root.clone(),
            folder_workspace: None,
            target_project_id: None,
            allowed_mcp_server_ids: None,
            plan_goal: std::sync::Arc::new(std::sync::Mutex::new(None)),
            todo_items: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
            read_files: std::sync::Arc::new(
                std::sync::Mutex::new(std::collections::HashSet::new()),
            ),
            visible_tool_catalog: None,
            store,
            skills: std::sync::Arc::new(worldbase_skills::SkillRegistry::new(vec![])),
            scheduler: std::sync::Arc::new(worldbase_scheduler::Scheduler::new(
                std::sync::Arc::new(
                    worldbase_memory::Store::open(&root.join("sched.sqlite")).unwrap(),
                ),
            )),
            mcp: std::sync::Arc::new(worldbase_mcp_client::McpManager::default()),
            projects: std::sync::Arc::new(worldbase_project_runtime::ProjectRuntime::new(
                root.join("projects"),
            )),
            group_collaboration: None,
            subagent_runtime: None,
        };

        assert!(services.enter_plan_mode("inspect before editing"));
        assert!(services.plan_mode_active());
        assert!(services.is_tool_allowed_in_plan_mode("read_project_file"));
        assert!(!services.is_tool_allowed_in_plan_mode("write_project_file"));
        assert!(!services.is_tool_allowed_in_plan_mode("write_file"));
        assert!(!services.is_tool_allowed_in_plan_mode("mcp_call"));
        assert!(!services.is_tool_allowed_in_plan_mode("mcp__server__mutate"));

        let mut separate_run = services.clone();
        separate_run.plan_goal = std::sync::Arc::new(std::sync::Mutex::new(None));
        separate_run.todo_items = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        assert!(!separate_run.plan_mode_active());
        assert!(separate_run.is_tool_allowed_in_plan_mode("write_project_file"));

        assert!(services.exit_plan_mode());
        assert!(!services.plan_mode_active());
        assert!(services.is_tool_allowed_in_plan_mode("write_project_file"));
    }
}
