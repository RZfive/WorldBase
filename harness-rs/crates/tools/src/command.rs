//! 命令执行工具（desktop 域，权限默认 ask）。

use super::{require_str, Tool, ToolServices};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};
use worldbase_exec::ExecRequest;

pub struct ExecuteCommandTool;

#[async_trait]
impl Tool for ExecuteCommandTool {
    fn name(&self) -> &str {
        "execute_command"
    }
    fn description(&self) -> &str {
        "在工作区内执行 shell 命令（argv 形式），受权限引擎管控"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "program": { "type": "string", "description": "可执行程序" },
                "args": { "type": "array", "items": { "type": "string" } },
                "timeout_secs": { "type": "integer" },
                "sandbox": { "type": "boolean", "description": "macOS Seatbelt 写限制沙箱" }
            },
            "required": ["program"]
        })
    }
    fn domain(&self) -> &str {
        "desktop"
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let program = require_str(&input, "program")?;
        let args: Vec<String> = input
            .get("args")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default();
        let req = ExecRequest {
            program: program.into(),
            args,
            cwd: None,
            env: Default::default(),
            timeout_secs: input.get("timeout_secs").and_then(|v| v.as_u64()),
            sandbox: input.get("sandbox").and_then(|v| v.as_bool()).unwrap_or(true),
        };
        let result = worldbase_exec::run(&req, &services.workspace).await?;
        Ok(serde_json::to_value(&result)?)
    }
}
