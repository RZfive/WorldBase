use super::Tool;
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::PathBuf;
use tokio::fs;

pub struct LocalFileTool {
    workspace_root: PathBuf,
}

impl LocalFileTool {
    pub fn new(workspace_root: PathBuf) -> Self {
        Self { workspace_root }
    }
}

#[async_trait]
impl Tool for LocalFileTool {
    fn name(&self) -> &str {
        "read_file"
    }

    fn description(&self) -> &str {
        "Read a file from the local filesystem"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "The file path relative to workspace root"
                }
            },
            "required": ["path"]
        })
    }

    async fn execute(&self, input: Value) -> Result<Value> {
        let path = input.get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("Missing path parameter"))?;

        let full_path = self.workspace_root.join(path);

        // Security check: prevent path traversal
        if !full_path.starts_with(&self.workspace_root) {
            anyhow::bail!("Path traversal detected");
        }

        let content = fs::read_to_string(&full_path).await?;

        Ok(json!({
            "path": path,
            "content": content,
            "size": content.len()
        }))
    }
}
