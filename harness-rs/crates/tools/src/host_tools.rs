//! 宿主域工具（domain="host"，需宿主声明 webview_automation/交互能力）：
//! - ask_user：向宿主弹问题（HITL）
//! - read_current_page：读取宿主 WebView 当前页面快照
//! - interact_current_page：对宿主 WebView 执行交互动作
//! （对齐桌面 tool-active-page 的移动端形态）

use super::host_bridge::HostBridge;
use super::{require_str, Tool, ToolServices};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

const ASK_TIMEOUT: Duration = Duration::from_secs(300);
const PAGE_TIMEOUT: Duration = Duration::from_secs(30);

fn tools_host_bridge(services: &ToolServices) -> Arc<HostBridge> {
    services.host.clone()
}

pub struct AskUserTool;

#[async_trait]
impl Tool for AskUserTool {
    fn name(&self) -> &str {
        "ask_user"
    }
    fn description(&self) -> &str {
        "向用户提问并等待回答（人机协作）"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "question": { "type": "string", "description": "要问用户的问题" },
                "choices": { "type": "array", "items": { "type": "string" }, "description": "可选选项" }
            },
            "required": ["question"]
        })
    }
    fn domain(&self) -> &str {
        "host"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let question = require_str(&input, "question")?;
        let stream = services.current_stream.lock().unwrap().clone();
        let answer = tools_host_bridge(services)
            .request(
                &stream,
                "ask_user",
                json!({
                    "question": question,
                    "choices": input.get("choices").cloned().unwrap_or(json!([])),
                }),
                ASK_TIMEOUT,
            )
            .await?;
        Ok(answer)
    }
}

pub struct ReadCurrentPageTool;

#[async_trait]
impl Tool for ReadCurrentPageTool {
    fn name(&self) -> &str {
        "read_current_page"
    }
    fn description(&self) -> &str {
        "读取宿主 WebView 当前页面快照（url/title/文本/可交互元素）"
    }
    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {} })
    }
    fn domain(&self) -> &str {
        "host"
    }
    async fn execute(&self, _input: Value, services: &ToolServices) -> Result<Value> {
        let stream = services.current_stream.lock().unwrap().clone();
        tools_host_bridge(services)
            .request(&stream, "page_automation", json!({ "action": "read" }), PAGE_TIMEOUT)
            .await
    }
}

pub struct InteractCurrentPageTool;

#[async_trait]
impl Tool for InteractCurrentPageTool {
    fn name(&self) -> &str {
        "interact_current_page"
    }
    fn description(&self) -> &str {
        "对宿主 WebView 执行交互动作（click/input/scroll/evaluate/press_key 等）"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "actions": {
                    "type": "array",
                    "description": "动作列表，如 [{\"type\":\"click\",\"selector\":\"#btn\"}]",
                    "items": { "type": "object" }
                }
            },
            "required": ["actions"]
        })
    }
    fn domain(&self) -> &str {
        "host"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let actions = input
            .get("actions")
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("missing actions"))?;
        let stream = services.current_stream.lock().unwrap().clone();
        tools_host_bridge(services)
            .request(
                &stream,
                "page_automation",
                json!({ "action": "interact", "actions": actions }),
                PAGE_TIMEOUT,
            )
            .await
    }
}
