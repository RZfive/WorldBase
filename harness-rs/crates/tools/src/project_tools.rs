//! 全栈项目工具（desktop 域）：create/dev_start/dev_stop/list/status。

use super::{require_str, Tool, ToolServices};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};

pub struct ProjectCreateTool;

#[async_trait]
impl Tool for ProjectCreateTool {
    fn name(&self) -> &str {
        "create_project"
    }
    fn description(&self) -> &str {
        "创建全栈 Next.js 项目（桌面/server 独有）"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "name": { "type": "string" } },
            "required": ["name"]
        })
    }
    fn domain(&self) -> &str {
        "desktop"
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let name = require_str(&input, "name")?;
        let info = services.projects.create_project(name).await?;
        Ok(serde_json::to_value(&info)?)
    }
}

pub struct ProjectListTool;

#[async_trait]
impl Tool for ProjectListTool {
    fn name(&self) -> &str {
        "project_list"
    }
    fn description(&self) -> &str {
        "列出全部全栈项目"
    }
    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {} })
    }
    fn domain(&self) -> &str {
        "desktop"
    }
    async fn execute(&self, _input: Value, services: &ToolServices) -> Result<Value> {
        let list = services.projects.list_projects()?;
        Ok(json!({ "projects": list }))
    }
}

pub struct ProjectDevStartTool;

#[async_trait]
impl Tool for ProjectDevStartTool {
    fn name(&self) -> &str {
        "project_dev_start"
    }
    fn description(&self) -> &str {
        "启动项目 dev server（pnpm install 后可用）"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project": { "type": "string" },
                "install": { "type": "boolean", "description": "先执行 pnpm install" }
            },
            "required": ["project"]
        })
    }
    fn domain(&self) -> &str {
        "desktop"
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let project = require_str(&input, "project")?;
        if input["install"].as_bool().unwrap_or(true) {
            let path = services.projects.list_projects()?;
            let found = path.iter().find(|p| p.id == project);
            if let Some(p) = found {
                let log = services
                    .projects
                    .install(std::path::Path::new(&p.path))
                    .await?;
                return Ok(json!({ "installLog": log, "note": "install 完成，请再次调用且 install=false 启动" }));
            }
        }
        let info = services.projects.start_dev(project).await?;
        Ok(serde_json::to_value(&info)?)
    }
}

pub struct ProjectDevStopTool;

#[async_trait]
impl Tool for ProjectDevStopTool {
    fn name(&self) -> &str {
        "project_dev_stop"
    }
    fn description(&self) -> &str {
        "停止项目 dev server"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "project": { "type": "string" } },
            "required": ["project"]
        })
    }
    fn domain(&self) -> &str {
        "desktop"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let project = require_str(&input, "project")?;
        let stopped = services.projects.stop_dev(project).await?;
        Ok(json!({ "stopped": stopped }))
    }
}
