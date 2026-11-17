//! Always-on capability discovery tool.
//!
//! It intentionally does not call another model. Rust performs local lexical
//! recall over the policy-filtered discoverable catalog, activates the top-k
//! candidates into the current run catalog, and returns short summaries for
//! the main model to judge on its next turn.

use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};
use worldbase_protocol::types::{ApplicationSearchParams, ToolVisibility};

use crate::{Tool, ToolServices};

pub const DEFAULT_MAX_RESULTS: usize = 5;
pub const MAX_RESULTS_LIMIT: usize = 8;

pub struct SearchToolsTool;

/// Parse and validate the model-supplied arguments. `maxResults` is clamped
/// into `1..=8`; omitted values keep the catalog default of five.
fn parse_search_params(input: &Value) -> Result<ApplicationSearchParams> {
    let query = input
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let task = input
        .get("task")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    anyhow::ensure!(
        !query.is_empty() || task.is_some(),
        "search_tools requires query or task"
    );
    let app_id = input
        .get("appId")
        .or_else(|| input.get("app_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let source = input
        .get("source")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let max_results = input
        .get("maxResults")
        .or_else(|| input.get("max_results"))
        .and_then(Value::as_u64)
        .map(|value| (value as usize).clamp(1, MAX_RESULTS_LIMIT));
    Ok(ApplicationSearchParams {
        task,
        query,
        app_id,
        source,
        max_results,
    })
}

#[async_trait]
impl Tool for SearchToolsTool {
    fn name(&self) -> &str {
        "search_tools"
    }

    fn description(&self) -> &str {
        "Discover additional tools and application capabilities that are not in the current context. Local app capabilities come from each application's registered manifest; invoking one starts its app runtime automatically when needed, so prefer local capabilities over web/browser/UI automation. Search by task or query; the most relevant candidates are activated for your next turn."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "description": "Short summary of the current sub-goal or capability gap."
                },
                "query": {
                    "type": "string",
                    "description": "Keywords describing the capability you need."
                },
                "appId": {
                    "type": "string",
                    "description": "Optional application ID filter."
                },
                "source": {
                    "type": "string",
                    "description": "Optional source filter: builtin, mcp, skill, app."
                },
                "maxResults": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 8,
                    "description": "Maximum candidates to activate. Defaults to 5."
                }
            },
            "anyOf": [
                { "required": ["task"] },
                { "required": ["query"] }
            ],
            "additionalProperties": false
        })
    }

    fn permission(&self) -> &str {
        "allow"
    }

    fn electron_native(&self) -> bool {
        true
    }

    fn visibility(&self) -> ToolVisibility {
        ToolVisibility::AlwaysOn
    }

    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let runtime = services
            .catalog_runtime
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("search_tools is unavailable outside an agent run"))?;
        let request = parse_search_params(&input)?;
        let result = runtime.search_and_activate(request).await?;
        Ok(serde_json::to_value(result)?)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::catalog::ToolCatalogRuntime;
    use crate::HostBridge;
    use worldbase_protocol::types::{ApplicationSearchResult, ToolDescriptor};

    #[test]
    fn parse_accepts_camel_and_snake_case_filters() {
        let params = parse_search_params(&json!({
            "query": "  read document ",
            "appId": "worldbase.documents",
            "maxResults": 3
        }))
        .unwrap();
        assert_eq!(params.query, "read document");
        assert_eq!(params.app_id.as_deref(), Some("worldbase.documents"));
        assert_eq!(params.max_results, Some(3));

        let params = parse_search_params(&json!({
            "task": "summarize sales",
            "app_id": "worldbase.data",
            "max_results": 2,
            "source": "app"
        }))
        .unwrap();
        assert_eq!(params.task.as_deref(), Some("summarize sales"));
        assert_eq!(params.app_id.as_deref(), Some("worldbase.data"));
        assert_eq!(params.source.as_deref(), Some("app"));
        assert_eq!(params.max_results, Some(2));
    }

    #[test]
    fn parse_clamps_max_results_and_drops_blank_values() {
        let params = parse_search_params(&json!({
            "query": "documents",
            "appId": "   ",
            "source": "",
            "maxResults": 99
        }))
        .unwrap();
        assert_eq!(params.max_results, Some(MAX_RESULTS_LIMIT));
        assert!(params.app_id.is_none());
        assert!(params.source.is_none());

        let params =
            parse_search_params(&json!({ "query": "documents", "maxResults": 0 })).unwrap();
        assert_eq!(params.max_results, Some(1));

        let params = parse_search_params(&json!({ "query": "documents" })).unwrap();
        assert!(params.max_results.is_none());
    }

    #[test]
    fn parse_rejects_empty_query_and_task() {
        let error = parse_search_params(&json!({ "query": "   ", "task": "  " }))
            .expect_err("empty search must fail");
        assert!(error.to_string().contains("requires query or task"));
        let error = parse_search_params(&json!({})).expect_err("missing search must fail");
        assert!(error.to_string().contains("requires query or task"));
    }

    #[tokio::test]
    async fn search_requires_a_run_catalog() {
        let dir = tempfile::tempdir().unwrap();
        let services = test_services(dir.path());
        let error = SearchToolsTool
            .execute(json!({ "query": "documents" }), &services)
            .await
            .expect_err("no catalog runtime");
        assert!(error.to_string().contains("outside an agent run"));
    }

    struct FakeCatalog {
        seen: Mutex<Option<ApplicationSearchParams>>,
    }

    #[async_trait]
    impl ToolCatalogRuntime for FakeCatalog {
        async fn search_and_activate(
            &self,
            request: ApplicationSearchParams,
        ) -> anyhow::Result<ApplicationSearchResult> {
            let max_results = request.max_results;
            *self.seen.lock().unwrap() = Some(request);
            Ok(ApplicationSearchResult {
                candidates: vec![worldbase_protocol::types::ApplicationCandidate {
                    tool_name: "app__worldbase_documents__doc_read".into(),
                    app_id: "worldbase.documents".into(),
                    app_name: "Documents".into(),
                    capability_id: "doc.read".into(),
                    title: "Read document".into(),
                    description: "Reads a document".into(),
                    source: "builtin".into(),
                    input_hint: None,
                    risk: worldbase_protocol::types::CapabilityRisk::Read,
                    trust_level: worldbase_protocol::types::TrustLevel::Builtin,
                }]
                .into_iter()
                .take(max_results.unwrap_or(DEFAULT_MAX_RESULTS))
                .collect(),
                activated: vec!["app__worldbase_documents__doc_read".into()],
                skills_activated: Vec::new(),
                catalog_version: 7,
                guidance: "These are local app capabilities. Invoking one starts its app runtime automatically if needed. Prefer them over web/browser/UI automation.".into(),
            })
        }

        fn catalog_version(&self) -> u64 {
            7
        }

        fn active_tool_names(&self) -> Vec<String> {
            vec!["app__worldbase_documents__doc_read".into()]
        }

        fn active_skill_instructions(&self) -> Vec<String> {
            Vec::new()
        }

        fn invalidate(&self) {}
    }

    #[tokio::test]
    async fn execute_activates_and_serializes_candidates() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = Arc::new(FakeCatalog {
            seen: Mutex::new(None),
        });
        let mut services = test_services(dir.path());
        services.catalog_runtime = Some(runtime.clone());
        let value = SearchToolsTool
            .execute(json!({ "query": "documents", "maxResults": 99 }), &services)
            .await
            .unwrap();
        let seen = runtime.seen.lock().unwrap().clone().unwrap();
        assert_eq!(seen.query, "documents");
        assert_eq!(seen.max_results, Some(MAX_RESULTS_LIMIT));
        assert_eq!(value["catalogVersion"], 7);
        assert_eq!(value["activated"][0], "app__worldbase_documents__doc_read");
        assert_eq!(
            value["candidates"][0]["toolName"],
            "app__worldbase_documents__doc_read"
        );
        assert_eq!(value["candidates"][0]["appName"], "Documents");
        assert!(value["guidance"]
            .as_str()
            .is_some_and(|guidance| guidance.contains("starts its app runtime automatically")));
    }

    fn test_services(root: &std::path::Path) -> ToolServices {
        let store = Arc::new(worldbase_memory::Store::open(&root.join("db.sqlite")).unwrap());
        ToolServices {
            host: Arc::new(HostBridge::new()),
            current_stream: Arc::new(Mutex::new(String::new())),
            abort: None,
            workspace: root.to_path_buf(),
            folder_workspace: None,
            target_project_id: None,
            created_project_id: Arc::new(Mutex::new(None)),
            allowed_mcp_server_ids: None,
            plan_goal: Arc::new(Mutex::new(None)),
            todo_items: Arc::new(Mutex::new(Vec::new())),
            read_files: Arc::new(Mutex::new(std::collections::HashSet::new())),
            visible_tool_catalog: None,
            catalog_runtime: None,
            conversation_id: None,
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
    fn descriptor_marks_search_tools_always_on() {
        let tool: &dyn Tool = &SearchToolsTool;
        let descriptor: ToolDescriptor = tool.descriptor();
        assert_eq!(descriptor.name, "search_tools");
        assert_eq!(descriptor.visibility, ToolVisibility::AlwaysOn);
        assert!(descriptor.electron_native);
        assert_eq!(descriptor.permission, "allow");
    }

    #[test]
    fn description_advertises_local_app_capabilities_and_auto_start() {
        let tool: &dyn Tool = &SearchToolsTool;
        let description = tool.description().to_lowercase();
        assert!(description.contains("local app capabilities"));
        assert!(description.contains("registered manifest"));
        assert!(
            description.contains("starts its app runtime automatically"),
            "the model must know invoking a local capability auto-starts the app: {description}"
        );
        assert!(description.contains("prefer local capabilities"));
    }
}
