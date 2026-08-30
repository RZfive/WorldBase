//! 内置 Agent 工具集（与 TS 版 1:1 能力对齐的平台子集）。
//!
//! 工具分域：`core` 全端可用；`desktop` 域（exec/project 等）在移动端握手时
//! 被能力协商过滤。

use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use worldbase_protocol::types::ToolDescriptor;

pub mod command;
pub mod document;
pub mod host_bridge;
pub mod host_tools;
pub mod lightapp_tool;
pub mod project_tools;
pub mod fs_tools;
pub mod memory_tools;
pub mod schedule_tools;
pub mod skill_tools;
pub mod todo;
pub mod web;

pub use command::ExecuteCommandTool;
pub use document::{DocParseTool, DocWriteTool};
pub use host_bridge::HostBridge;
pub use host_tools::{AskUserTool, InteractCurrentPageTool, ReadCurrentPageTool};
pub use lightapp_tool::CreateLightAppTool;
pub use project_tools::{ProjectCreateTool, ProjectDevStartTool, ProjectDevStopTool, ProjectListTool};
pub use fs_tools::{EditFileTool, ListDirTool, ReadFileTool, WriteFileTool};
pub use memory_tools::{MemoryAddTool, MemoryDeleteTool, MemorySearchTool};
pub use schedule_tools::{ScheduleCreateTool, ScheduleDeleteTool, ScheduleListTool};
pub use skill_tools::{SkillListTool, SkillRunTool};
pub use todo::{TodoReadTool, TodoWriteTool};
pub use web::{WebFetchTool, WebSearchTool};
pub use worldbase_search::{glob as search_glob, grep as search_grep, GrepHit};

/// 工具运行时依赖（由 core 注入）。
#[derive(Clone)]
pub struct ToolServices {
    /// 宿主通道（反向 RPC：ask_user / 页面自动化）。
    pub host: Arc<HostBridge>,
    /// 当前工具调用所属流（反向请求路由用）。
    pub current_stream: Arc<std::sync::Mutex<String>>,
    /// Agent 工作区根目录。
    pub workspace: PathBuf,
    pub store: Arc<worldbase_memory::Store>,
    pub skills: Arc<worldbase_skills::SkillRegistry>,
    pub scheduler: Arc<worldbase_scheduler::Scheduler>,
    pub mcp: Arc<worldbase_mcp_client::McpManager>,
    pub projects: Arc<worldbase_project_runtime::ProjectRuntime>,
}

impl ToolServices {
    pub fn set_current_stream(&self, stream_id: &str) {
        *self.current_stream.lock().unwrap() = stream_id.to_string();
    }

    pub fn workspace_path(&self, rel: &str) -> PathBuf {
        let p = Path::new(rel);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            self.workspace.join(p)
        }
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

/// 能力协商过滤：
/// - excludes 含 subprocess/port_binding → 隐藏 desktop 域
/// - features 缺 webview_automation → 隐藏 host 域（浏览器自动化/宿主交互）
pub fn filter_tools<'a>(tools: &'a [Arc<dyn Tool>], caps: &worldbase_protocol::types::Capabilities) -> Vec<Arc<dyn Tool>> {
    let hide_desktop = caps
        .excludes
        .iter()
        .any(|e| e == "subprocess" || e == "port_binding");
    let has_webview = caps.features.iter().any(|f| f == "webview_automation");
    tools
        .iter()
        .filter(|t| match t.domain() {
            "desktop" => !hide_desktop,
            "host" => has_webview,
            _ => true,
        })
        .cloned()
        .collect()
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
    vec![
        Arc::new(ReadFileTool),
        Arc::new(WriteFileTool),
        Arc::new(EditFileTool),
        Arc::new(ListDirTool),
        Arc::new(GlobTool),
        Arc::new(GrepTool),
        Arc::new(WebSearchTool),
        Arc::new(WebFetchTool),
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
        Arc::new(CreateLightAppTool),
        Arc::new(AskUserTool),
        Arc::new(ReadCurrentPageTool),
        Arc::new(InteractCurrentPageTool),
        Arc::new(ProjectListTool),
        Arc::new(ProjectCreateTool),
        Arc::new(ProjectDevStartTool),
        Arc::new(ProjectDevStopTool),
        Arc::new(ExecuteCommandTool),
    ]
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
        let literal = input.get("literal").and_then(|v| v.as_bool()).unwrap_or(false);
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

pub struct McpCallTool;

#[async_trait]
impl Tool for McpCallTool {
    fn name(&self) -> &str {
        "mcp_call"
    }
    fn description(&self) -> &str {
        "调用已连接 MCP server 的工具"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "server": { "type": "string" },
                "tool": { "type": "string" },
                "arguments": { "type": "object" }
            },
            "required": ["server", "tool"]
        })
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let server = require_str(&input, "server")?;
        let tool = require_str(&input, "tool")?;
        let args = input.get("arguments").cloned().unwrap_or(json!({}));
        services.mcp.call_tool(server, tool, args).await
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
    fn desktop_domain_filtered_by_capabilities() {
        let tools = builtin_tools();
        let mut mobile = worldbase_protocol::types::Capabilities::mobile("mobile-ios");
        let filtered = filter_tools(&tools, &mobile);
        assert!(filtered.iter().all(|t| t.domain() != "desktop"));
        assert!(filtered.iter().any(|t| t.name() == "read_file"));
        // host 域工具需要 webview_automation 能力
        assert!(filtered.iter().any(|t| t.name() == "read_current_page"));

        mobile.features.retain(|f| f != "webview_automation");
        let no_webview = filter_tools(&tools, &mobile);
        assert!(no_webview.iter().all(|t| t.domain() != "host"));

        let full = filter_tools(&tools, &worldbase_protocol::types::Capabilities::desktop());
        assert!(full.iter().any(|t| t.name() == "execute_command"));
    }
}
