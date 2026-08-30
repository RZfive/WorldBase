//! 定时任务工具。

use super::{require_str, Tool, ToolServices};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};

pub struct ScheduleCreateTool;

#[async_trait]
impl Tool for ScheduleCreateTool {
    fn name(&self) -> &str {
        "schedule_create"
    }
    fn description(&self) -> &str {
        "创建定时任务（标准 5 段 cron，本地时区）"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "name": { "type": "string" },
                "cron": { "type": "string", "description": "如 0 9 * * 1-5" },
                "task": { "type": "string", "description": "到期时交给 agent 的任务描述" }
            },
            "required": ["name", "cron", "task"]
        })
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let name = require_str(&input, "name")?;
        let cron = require_str(&input, "cron")?;
        let task = require_str(&input, "task")?;
        let entry = services.scheduler.create(name, cron, task)?;
        Ok(json!({ "entry": entry }))
    }
}

pub struct ScheduleListTool;

#[async_trait]
impl Tool for ScheduleListTool {
    fn name(&self) -> &str {
        "schedule_list"
    }
    fn description(&self) -> &str {
        "列出全部定时任务"
    }
    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {} })
    }
    async fn execute(&self, _input: Value, services: &ToolServices) -> Result<Value> {
        let entries = services.scheduler.list()?;
        Ok(json!({ "schedules": entries }))
    }
}

pub struct ScheduleDeleteTool;

#[async_trait]
impl Tool for ScheduleDeleteTool {
    fn name(&self) -> &str {
        "schedule_delete"
    }
    fn description(&self) -> &str {
        "删除定时任务"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "id": { "type": "string" } },
            "required": ["id"]
        })
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let id = require_str(&input, "id")?;
        let deleted = services.scheduler.delete(id)?;
        Ok(json!({ "deleted": deleted }))
    }
}
