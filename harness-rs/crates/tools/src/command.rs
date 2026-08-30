//! 命令执行工具（desktop 域，权限默认 ask）。

use super::{Tool, ToolServices};
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
                "command": { "type": "string", "description": "可选 shell 命令（Electron run_project_command 兼容字段）" },
                "args": { "type": "array", "items": { "type": "string" } },
                "cwd": { "type": "string", "description": "工作区内相对目录" },
                "timeout_secs": { "type": "integer" },
                "sandbox": { "type": "boolean", "description": "macOS Seatbelt 写限制沙箱" }
            },
            "anyOf": [{ "required": ["program"] }, { "required": ["command"] }]
        })
    }
    fn domain(&self) -> &str {
        "desktop"
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let command = input.get("command").and_then(Value::as_str);
        let program = input.get("program").and_then(Value::as_str);
        anyhow::ensure!(
            program.is_some() || command.is_some(),
            "missing required string parameter: program or command"
        );
        // Electron's run_project_command accepts one shell command string;
        // execute it through the platform shell while retaining the same
        // timeout and Seatbelt controls as argv-based calls.
        let (program, args): (String, Vec<String>) = if let Some(command) = command {
            if cfg!(target_os = "windows") {
                ("cmd".into(), vec!["/C".into(), command.into()])
            } else {
                ("sh".into(), vec!["-c".into(), command.into()])
            }
        } else {
            let program = program.unwrap_or_default().to_string();
            let args: Vec<String> = input
                .get("args")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            (program, args)
        };
        let cwd = input
            .get("cwd")
            .and_then(Value::as_str)
            .map(|cwd| services.workspace_path(cwd));
        if let Some(cwd) = &cwd {
            services.ensure_workspace_path(cwd)?;
        }
        let req = ExecRequest {
            program,
            args,
            cwd: cwd.map(|p| p.display().to_string()),
            env: Default::default(),
            timeout_secs: input
                .get("timeout_secs")
                .or_else(|| input.get("timeout"))
                .and_then(|v| v.as_u64()),
            sandbox: input
                .get("sandbox")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
        };
        let result = worldbase_exec::run(&req, &services.workspace).await?;
        Ok(serde_json::to_value(&result)?)
    }
}
