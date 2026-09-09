//! 轻应用工具：Agent 生成单页应用（HTML 单文件），移动端"应用"Tab 可直接打开。

use super::{require_str, Tool, ToolServices};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};

pub struct CreateLightAppTool;

#[async_trait]
impl Tool for CreateLightAppTool {
    fn name(&self) -> &str {
        "create_lightweight_app"
    }
    fn description(&self) -> &str {
        "创建一个单页轻应用（单个 HTML 文件，内联 CSS/JS）。生成移动端友好的完整页面，用户将在应用列表中打开它"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "description": "应用名称（展示用）" },
                "html": { "type": "string", "description": "完整的 HTML 文档（<!DOCTYPE html> 开头，内联样式与脚本）" }
            },
            "required": ["name", "html"]
        })
    }
    fn domain(&self) -> &str {
        "core"
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let name = require_str(&input, "name")?;
        let html = require_str(&input, "html")?;
        let id = uuid::Uuid::new_v4().to_string();
        let dir = worldbase_memory::Store::default_dir()
            .join("lightweight-apps")
            .join(&id);
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("index.html"), html)?;
        let app = worldbase_protocol::types::LightApp {
            id: id.clone(),
            name: name.to_string(),
            created_at: worldbase_protocol::event::now_rfc3339(),
        };
        services.store.add_lightapp(&id, name)?;
        Ok(json!({
            "app": app,
            "url": "/lightapp/".to_string() + id.as_str(),
            "note": "已创建，用户可在「应用」Tab 打开"
        }))
    }
}
