//! 技能工具：skill_list / skill_run。

use super::{Tool, ToolServices};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};

pub struct SkillListTool;

#[async_trait]
impl Tool for SkillListTool {
    fn name(&self) -> &str {
        "skill_list"
    }
    fn description(&self) -> &str {
        "列出可用的 YAML 技能"
    }
    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {} })
    }
    async fn execute(&self, _input: Value, services: &ToolServices) -> Result<Value> {
        let skills = services.skills.list()?;
        Ok(json!({ "skills": skills }))
    }
}

pub struct SkillRunTool;

#[async_trait]
impl Tool for SkillRunTool {
    fn name(&self) -> &str {
        "skill_run"
    }
    fn description(&self) -> &str {
        "加载技能指令（把 instructions 返回给模型按其执行）"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "name": { "type": "string" },
                "skill_name": { "type": "string" },
                "arguments": { "type": "object" }
            },
            "anyOf": [{ "required": ["name"] }, { "required": ["skill_name"] }]
        })
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let name = input
            .get("skill_name")
            .or_else(|| input.get("name"))
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("missing required string parameter: skill_name"))?;
        let skill = services
            .skills
            .get(name)?
            .ok_or_else(|| anyhow::anyhow!("skill not found: {name}"))?;
        Ok(json!({ "skill": skill, "note": "请按 instructions 执行任务" }))
    }
}
