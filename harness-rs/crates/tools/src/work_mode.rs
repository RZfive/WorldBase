//! AI-selected work mode for a chat run.
//!
//! The renderer may pre-fill a hint, but the model owns the final decision:
//! coding, document, or chat. The core agent loop watches this tool call and
//! activates the coding gate for the remainder of the run when `coding` is
//! selected. The tool itself is intentionally side-effect free.

use crate::{require_str, Tool, ToolServices};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};

const CODING_GUIDANCE: &str = "Coding mode is active for the rest of this run. \
Use coding_edit / coding_apply for supported source edits, coding_verify for verification, \
and generic write/patch tools only for code or config types coding tools do not support. \
Never write Office/PDF documents directly; use doc_draft for documents.";

const DOCUMENT_GUIDANCE: &str = "Document mode is active for the rest of this run. \
Read documents with read_document/doc_parse and edit them only with doc_draft. \
Do not use coding_edit/coding_apply on document files.";

const CHAT_GUIDANCE: &str = "Chat mode is active. Do not modify files unless the user later asks for a concrete edit.";

pub struct SelectWorkModeTool;

#[async_trait]
impl Tool for SelectWorkModeTool {
    fn name(&self) -> &str {
        "select_work_mode"
    }

    fn description(&self) -> &str {
        "Choose the work mode for this run before making changes. Use coding when the task creates or changes an app, source code, config, scripts, or build output. Use document when the target is an Office/PDF/Markdown document. Use chat for questions and analysis that should not modify files. Selecting coding activates the coding verification gate and code-diff tracking for the rest of the run."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "mode": {
                    "type": "string",
                    "enum": ["coding", "document", "chat"],
                    "description": "Work mode for the rest of this run."
                },
                "reason": {
                    "type": "string",
                    "description": "Short reason for choosing this mode."
                }
            },
            "required": ["mode"]
        })
    }

    fn domain(&self) -> &str {
        "desktop"
    }

    fn permission(&self) -> &str {
        "allow"
    }

    fn electron_native(&self) -> bool {
        true
    }

    async fn execute(&self, input: Value, _services: &ToolServices) -> Result<Value> {
        let mode = require_str(&input, "mode")?.trim().to_ascii_lowercase();
        anyhow::ensure!(
            matches!(mode.as_str(), "coding" | "document" | "chat"),
            "mode must be coding, document, or chat"
        );
        let reason = input
            .get("reason")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let guidance = match mode.as_str() {
            "coding" => CODING_GUIDANCE,
            "document" => DOCUMENT_GUIDANCE,
            _ => CHAT_GUIDANCE,
        };
        Ok(json!({
            "mode": mode,
            "coding": mode == "coding",
            "acknowledged": true,
            "guidance": guidance,
            "reason": reason,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    struct Fixture {
        _temp: tempfile::TempDir,
        services: ToolServices,
    }

    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().expect("temp");
        let workspace = temp.path().join("workspace");
        let projects = temp.path().join("projects");
        std::fs::create_dir_all(&workspace).expect("workspace");
        std::fs::create_dir_all(&projects).expect("projects");
        let store = Arc::new(
            worldbase_memory::Store::open(&temp.path().join("store.sqlite")).expect("store"),
        );
        let services = ToolServices {
            host: Arc::new(crate::HostBridge::new()),
            current_stream: Arc::new(std::sync::Mutex::new(String::new())),
            abort: None,
            workspace,
            folder_workspace: None,
            target_project_id: None,
            created_project_id: Arc::new(std::sync::Mutex::new(None)),
            allowed_mcp_server_ids: None,
            plan_goal: Arc::new(std::sync::Mutex::new(None)),
            todo_items: Arc::new(std::sync::Mutex::new(Vec::new())),
            read_files: Arc::new(std::sync::Mutex::new(std::collections::HashSet::new())),
            visible_tool_catalog: None,
            store: store.clone(),
            memory_queue: None,
            memory_scopes: Vec::new(),
            skills: Arc::new(worldbase_skills::SkillRegistry::new(vec![])),
            scheduler: Arc::new(worldbase_scheduler::Scheduler::new(store)),
            mcp: Arc::new(worldbase_mcp_client::McpManager::default()),
            projects: Arc::new(worldbase_project_runtime::ProjectRuntime::new(projects)),
            group_collaboration: None,
            subagent_runtime: None,
        };
        Fixture { _temp: temp, services }
    }

    #[test]
    fn advertises_the_three_modes() {
        let schema = SelectWorkModeTool.input_schema();
        assert_eq!(
            schema["properties"]["mode"]["enum"],
            json!(["coding", "document", "chat"])
        );
        assert_eq!(schema["required"], json!(["mode"]));
    }

    #[tokio::test]
    async fn coding_selection_returns_activation_guidance() {
        let fixture = fixture();
        let result = SelectWorkModeTool
            .execute(
                json!({ "mode": "coding", "reason": "new app" }),
                &fixture.services,
            )
            .await
            .expect("select mode");
        assert_eq!(result["mode"], "coding");
        assert_eq!(result["coding"], true);
        assert_eq!(result["acknowledged"], true);
        assert!(result["guidance"].as_str().unwrap().contains("coding_edit"));
    }

    #[tokio::test]
    async fn rejects_unknown_modes() {
        let fixture = fixture();
        let error = SelectWorkModeTool
            .execute(json!({ "mode": "editing" }), &fixture.services)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("coding, document, or chat"));
    }
}
