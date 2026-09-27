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
        let command = match input.get("command") {
            None => None,
            Some(Value::String(value)) if !value.trim().is_empty() => Some(value.as_str()),
            Some(Value::String(_)) => anyhow::bail!("command must not be empty"),
            Some(_) => anyhow::bail!("command must be a string"),
        };
        let program = match input.get("program") {
            None => None,
            Some(Value::String(value)) if !value.trim().is_empty() => Some(value.as_str()),
            Some(Value::String(_)) => anyhow::bail!("program must not be empty"),
            Some(_) => anyhow::bail!("program must be a string"),
        };
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
            let program = program
                .expect("program was checked above when command is absent")
                .to_string();
            let args: Vec<String> = match input.get("args") {
                None => Vec::new(),
                Some(Value::Array(values)) => values
                    .iter()
                    .enumerate()
                    .map(|(index, value)| {
                        value
                            .as_str()
                            .map(ToOwned::to_owned)
                            .ok_or_else(|| anyhow::anyhow!("args[{index}] must be a string"))
                    })
                    .collect::<Result<Vec<_>>>()?,
                Some(_) => anyhow::bail!("args must be an array of strings"),
            };
            (program, args)
        };
        let cwd = match input.get("cwd") {
            None => None,
            Some(Value::String(cwd)) => Some(services.workspace_path(cwd)),
            Some(_) => anyhow::bail!("cwd must be a string"),
        };
        if let Some(cwd) = &cwd {
            services.ensure_workspace_path(cwd)?;
        }
        let timeout_value =
            match input.get("timeout_secs").or_else(|| input.get("timeout")) {
                None => None,
                Some(value) => Some(value.as_u64().ok_or_else(|| {
                    anyhow::anyhow!("timeout_secs must be a non-negative integer")
                })?),
            };
        let sandbox = match input.get("sandbox") {
            None => true,
            Some(Value::Bool(value)) => *value,
            Some(_) => anyhow::bail!("sandbox must be a boolean"),
        };
        let req = ExecRequest {
            program,
            args,
            cwd: cwd.map(|p| p.display().to_string()),
            env: Default::default(),
            timeout_secs: timeout_value,
            sandbox,
        };
        let result = worldbase_exec::run(&req, &services.workspace).await?;
        Ok(serde_json::to_value(&result)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::sync::{Arc, Mutex};

    fn services(root: &Path) -> ToolServices {
        let workspace = root.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let store = Arc::new(worldbase_memory::Store::open(&root.join("store.sqlite")).unwrap());
        ToolServices {
            host: Arc::new(crate::HostBridge::new()),
            current_stream: Arc::new(Mutex::new(String::new())),
            abort: None,
            workspace,
            folder_workspace: None,
            target_project_id: None,
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
            projects: Arc::new(worldbase_project_runtime::ProjectRuntime::new(
                root.join("projects"),
            )),
            group_collaboration: None,
            subagent_runtime: None,
        }
    }

    #[test]
    fn schema_describes_argv_or_shell_command_and_typed_options() {
        let schema = ExecuteCommandTool.input_schema();
        assert_eq!(
            schema["anyOf"],
            json!([{ "required": ["program"] }, { "required": ["command"] }])
        );
        for field in ["program", "command", "cwd"] {
            assert_eq!(schema["properties"][field]["type"], "string");
        }
        assert_eq!(schema["properties"]["args"]["type"], "array");
        assert_eq!(schema["properties"]["args"]["items"]["type"], "string");
        assert_eq!(schema["properties"]["timeout_secs"]["type"], "integer");
        assert_eq!(schema["properties"]["sandbox"]["type"], "boolean");
    }

    #[tokio::test]
    async fn rejects_malformed_command_arguments_before_execution() {
        let temp = tempfile::tempdir().unwrap();
        let services = services(temp.path());
        // A nonexistent executable ensures a regression cannot execute a real
        // command. Matching the argument error also proves validation precedes
        // process creation instead of silently accepting or dropping the input.
        let program = "worldbase-test-command-that-does-not-exist";
        let cases = [
            (
                json!({}),
                "missing required string parameter: program or command",
            ),
            (json!({ "program": 42 }), "program must be a string"),
            (json!({ "program": null }), "program must be a string"),
            (json!({ "program": "  " }), "program must not be empty"),
            (json!({ "command": 42 }), "command must be a string"),
            (json!({ "command": null }), "command must be a string"),
            (json!({ "command": "  " }), "command must not be empty"),
            (
                json!({ "program": program, "args": "bad" }),
                "args must be an array of strings",
            ),
            (
                json!({ "program": program, "args": ["ok", 42] }),
                "args[1] must be a string",
            ),
            (
                json!({ "program": program, "args": [null] }),
                "args[0] must be a string",
            ),
            (
                json!({ "program": program, "cwd": 42 }),
                "cwd must be a string",
            ),
            (
                json!({ "program": program, "cwd": null }),
                "cwd must be a string",
            ),
            (
                json!({ "program": program, "timeout_secs": "30" }),
                "timeout_secs must be a non-negative integer",
            ),
            (
                json!({ "program": program, "timeout_secs": -1 }),
                "timeout_secs must be a non-negative integer",
            ),
            (
                json!({ "program": program, "timeout_secs": 1.5 }),
                "timeout_secs must be a non-negative integer",
            ),
            (
                json!({ "program": program, "timeout_secs": null }),
                "timeout_secs must be a non-negative integer",
            ),
            (
                json!({ "program": program, "timeout": "30" }),
                "timeout_secs must be a non-negative integer",
            ),
            (
                json!({ "program": program, "sandbox": "true" }),
                "sandbox must be a boolean",
            ),
            (
                json!({ "program": program, "sandbox": null }),
                "sandbox must be a boolean",
            ),
        ];
        for (input, expected) in cases {
            let error = ExecuteCommandTool
                .execute(input.clone(), &services)
                .await
                .expect_err("malformed command input must fail before execution");
            assert_eq!(error.to_string(), expected, "input: {input}");
        }
    }
}
