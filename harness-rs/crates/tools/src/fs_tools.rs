//! 文件系统工具：read/write/edit/list，均限制在工作区内。

use super::{require_str, Tool, ToolServices};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};

pub struct ReadFileTool;

#[async_trait]
impl Tool for ReadFileTool {
    fn name(&self) -> &str {
        "read_file"
    }
    fn description(&self) -> &str {
        "读取工作区内文本文件内容"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "path": { "type": "string" } },
            "required": ["path"]
        })
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let path = require_str(&input, "path")?;
        let full = services.workspace_path(path);
        anyhow::ensure!(
            full.starts_with(&services.workspace),
            "path escapes workspace"
        );
        let content = tokio::fs::read_to_string(&full).await?;
        Ok(json!({ "path": path, "content": content, "size": content.len() }))
    }
}

pub struct WriteFileTool;

#[async_trait]
impl Tool for WriteFileTool {
    fn name(&self) -> &str {
        "write_file"
    }
    fn description(&self) -> &str {
        "写入（创建或覆盖）工作区内文本文件"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "path": { "type": "string" }, "content": { "type": "string" } },
            "required": ["path", "content"]
        })
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let path = require_str(&input, "path")?;
        let content = require_str(&input, "content")?;
        let full = services.workspace_path(path);
        anyhow::ensure!(full.starts_with(&services.workspace), "path escapes workspace");
        if let Some(parent) = full.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&full, content).await?;
        Ok(json!({ "path": path, "bytes_written": content.len() }))
    }
}

pub struct EditFileTool;

#[async_trait]
impl Tool for EditFileTool {
    fn name(&self) -> &str {
        "edit_file"
    }
    fn description(&self) -> &str {
        "在工作区文件中做精确文本替换（old_string 必须唯一）"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" },
                "old_string": { "type": "string" },
                "new_string": { "type": "string" }
            },
            "required": ["path", "old_string", "new_string"]
        })
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let path = require_str(&input, "path")?;
        let old = require_str(&input, "old_string")?;
        let new = require_str(&input, "new_string")?;
        let full = services.workspace_path(path);
        anyhow::ensure!(full.starts_with(&services.workspace), "path escapes workspace");
        let content = tokio::fs::read_to_string(&full).await?;
        let count = content.matches(old).count();
        anyhow::ensure!(count == 1, "old_string matched {count} times, must be unique");
        let updated = content.replace(old, new);
        tokio::fs::write(&full, updated).await?;
        Ok(json!({ "path": path, "replaced": 1 }))
    }
}

pub struct ListDirTool;

#[async_trait]
impl Tool for ListDirTool {
    fn name(&self) -> &str {
        "list_dir"
    }
    fn description(&self) -> &str {
        "列出工作区内目录条目"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "path": { "type": "string", "description": "相对路径，默认 ." } }
        })
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let rel = input.get("path").and_then(|v| v.as_str()).unwrap_or(".");
        let full = services.workspace_path(rel);
        anyhow::ensure!(full.starts_with(&services.workspace), "path escapes workspace");
        let mut entries = Vec::new();
        let mut rd = tokio::fs::read_dir(&full).await?;
        while let Some(entry) = rd.next_entry().await? {
            let name = entry.file_name().to_string_lossy().into_owned();
            let is_dir = entry.file_type().await?.is_dir();
            entries.push(json!({ "name": name, "dir": is_dir }));
        }
        entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        Ok(json!({ "path": rel, "entries": entries }))
    }
}
