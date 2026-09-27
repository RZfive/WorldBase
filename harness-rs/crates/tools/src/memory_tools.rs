//! 长期记忆工具。
//!
//! 三个工具都读写共享的 Workspace 记忆库（`memory_entries` 表）——与
//! 自动召回、记忆设置面板、AI 整理使用同一个数据源；旧的 `memories`
//! FTS 表对模型不可见，因此不再作为工具的后端。

use super::{Tool, ToolServices};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};
use worldbase_protocol::types::{WorkspaceMemoryEntry, WorkspaceMemorySearchOptions};

/// 单次检索的默认与最大返回条数。
const DEFAULT_SEARCH_LIMIT: u64 = 10;
const MAX_SEARCH_LIMIT: u64 = 50;
/// 自动派生标题的最大字符数。
const TITLE_MAX_CHARS: usize = 60;

/// 从原文派生标题：取第一行非空文本并截断，保证召回展示有可读标题。
fn derive_memory_title(content: &str) -> String {
    let first_line = content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    let char_count = first_line.chars().count();
    let mut title: String = first_line.chars().take(TITLE_MAX_CHARS).collect();
    if char_count > TITLE_MAX_CHARS {
        title.push('…');
    }
    title
}

fn parse_tags(input: &Value) -> Vec<String> {
    input["tags"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|tag| tag.trim().to_string()))
                .filter(|tag| !tag.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

pub struct MemoryAddTool;

#[async_trait]
impl Tool for MemoryAddTool {
    fn name(&self) -> &str {
        "memory_add"
    }
    fn electron_native(&self) -> bool {
        true
    }
    fn description(&self) -> &str {
        "把值得长期记住的信息写入用户的共享记忆库（跨对话保留，之后可用 memory_search 检索）。适合记录用户明确表达的偏好、项目约定、重要事实；琐碎或临时内容不要写入。"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "content": { "type": "string", "description": "要记住的完整事实，一句话说清" },
                "tags": { "type": "array", "items": { "type": "string" } }
            },
            "required": ["content"]
        })
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let content = input["content"]
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow::anyhow!("missing required string parameter: content"))?
            .to_string();
        // Use the run's resolved user scope so writes land in the same scope
        // that this agent is allowed to read. Falling back to local-user here
        // would make memories silently invisible when the host uses another
        // local account ID.
        let user_scope = services
            .memory_scopes
            .iter()
            .find(|scope| scope.scope_type == "user" && !scope.scope_id.trim().is_empty())
            .ok_or_else(|| anyhow::anyhow!("user memory scope is not enabled for this run"))?;
        let now = worldbase_protocol::event::now_rfc3339();
        let saved = services
            .store
            .save_workspace_memory(&WorkspaceMemoryEntry {
                id: String::new(),
                scope_type: user_scope.scope_type.clone(),
                scope_id: user_scope.scope_id.clone(),
                memory_type: "knowledge".into(),
                title: derive_memory_title(&content),
                summary: content,
                details: None,
                tags: parse_tags(&input),
                source_conversation_id: None,
                source_session_id: None,
                source_message_ids: Vec::new(),
                importance: 0.5,
                confidence: 0.5,
                pinned: false,
                last_used_at: None,
                created_at: now.clone(),
                updated_at: now,
            })?;
        Ok(json!({ "id": saved.id, "stored": true }))
    }
}

pub struct MemorySearchTool;

#[async_trait]
impl Tool for MemorySearchTool {
    fn name(&self) -> &str {
        "memory_search"
    }
    fn electron_native(&self) -> bool {
        true
    }
    fn description(&self) -> &str {
        "从应用内共享记忆库检索用户偏好、项目知识和历史对话中保存的事实；不依赖 MCP 记忆服务器。当用户问“你还记得什么 / 还记得吗 / 我的偏好是什么”，或回答需要过往信息而上下文中没有时，应主动调用本工具。若关键词无命中，可传空 query 浏览当前授权范围内的重要记忆；工具会在关键词无命中时自动尝试此回退。"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "检索关键词；空字符串表示浏览最近的记忆" },
                "limit": { "type": "integer", "description": "返回条数，默认 10" }
            },
            "required": ["query"]
        })
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let query = input["query"].as_str().unwrap_or("").trim();
        let limit = input["limit"]
            .as_u64()
            .unwrap_or(DEFAULT_SEARCH_LIMIT)
            .clamp(1, MAX_SEARCH_LIMIT) as u32;
        // Empty scopes mean this run has no memory visibility. Direct
        // tool.call requests receive the local-user scope from Hub::services.
        let scopes: Vec<_> = services
            .memory_scopes
            .iter()
            .filter(|scope| {
                !scope.scope_type.trim().is_empty() && !scope.scope_id.trim().is_empty()
            })
            .cloned()
            .collect();
        if scopes.is_empty() {
            return Ok(json!({
                "hits": [],
                "search_mode": "no_scopes",
                "message": "No memory scopes are enabled for this run. This is a scope policy, not a missing MCP memory server."
            }));
        }
        let mut merged =
            services
                .store
                .search_workspace_memories(&WorkspaceMemorySearchOptions {
                    query: Some(query)
                        .filter(|value| !value.is_empty())
                        .map(String::from),
                    scopes: scopes.clone(),
                    memory_types: Vec::new(),
                    limit: Some(limit),
                })?;

        // 混合召回：关键词命中之外，再从共享向量索引取语义近邻（与自动召回
        // 的合并策略一致）。没有配置向量模型或没有 scope 时自然跳过。
        if !query.is_empty() {
            if let Some(queue) = &services.memory_queue {
                if let Some(config) = queue.config().await {
                    let scope_keys: Vec<String> = scopes
                        .iter()
                        .map(|scope| format!("{}:{}", scope.scope_type, scope.scope_id))
                        .collect();
                    if !scope_keys.is_empty() {
                        if let Ok(Some(generation)) = services.store.active_embedding_generation() {
                            if let Ok(semantic) = services
                                .store
                                .recall_semantic_entries(
                                    &*queue.provider_for(&config),
                                    &generation.id,
                                    query,
                                    &scope_keys,
                                    limit as usize,
                                )
                                .await
                            {
                                // 语义命中在前，关键词命中去重后补充在后。
                                let mut combined = semantic;
                                let seen: std::collections::HashSet<String> =
                                    combined.iter().map(|entry| entry.id.clone()).collect();
                                for entry in merged {
                                    if !seen.contains(&entry.id) {
                                        combined.push(entry);
                                    }
                                }
                                merged = combined;
                            }
                        }
                    }
                }
            }
        }

        // Chinese and other unspaced queries often do not overlap the FTS
        // tokenizer's terms even when useful memories exist. If exact keyword
        // and semantic recall both miss, return a small, scope-filtered set of
        // recent/high-importance memories for the model to inspect rather than
        // letting it conclude that no memory store is configured.
        let search_mode = if query.is_empty() {
            "browse"
        } else if merged.is_empty() {
            merged = services
                .store
                .search_workspace_memories(&WorkspaceMemorySearchOptions {
                    query: None,
                    scopes: scopes.clone(),
                    memory_types: Vec::new(),
                    limit: Some(limit),
                })?;
            if merged.is_empty() {
                "no_hits"
            } else {
                "browse_fallback"
            }
        } else {
            "keyword_or_semantic"
        };
        merged.truncate(limit as usize);

        Ok(json!({
            "search_mode": search_mode,
            "hits": merged.iter().map(|entry| json!({
                "id": entry.id,
                "type": entry.memory_type,
                "scope": format!("{}/{}", entry.scope_type, entry.scope_id),
                "title": entry.title,
                "summary": entry.summary,
                "details": entry.details,
                "tags": entry.tags,
                "pinned": entry.pinned,
            })).collect::<Vec<_>>()
        }))
    }
}

pub struct MemoryDeleteTool;

#[async_trait]
impl Tool for MemoryDeleteTool {
    fn name(&self) -> &str {
        "memory_delete"
    }
    fn electron_native(&self) -> bool {
        true
    }
    fn description(&self) -> &str {
        "按 id 从共享长期记忆中删除一条记忆（先用 memory_search 找到 id 再删除）。"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "id": { "type": "string", "description": "记忆条目 id，来自 memory_search 的命中结果" } },
            "required": ["id"]
        })
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let id = input["id"]
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow::anyhow!("missing required string parameter: id"))?;
        let scopes = &services.memory_scopes;
        let can_delete = if scopes.is_empty() {
            false
        } else {
            services
                .store
                .get_workspace_memory(id)?
                .is_some_and(|entry| {
                    scopes.iter().any(|scope| {
                        scope.scope_type == entry.scope_type && scope.scope_id == entry.scope_id
                    })
                })
        };
        if !can_delete {
            return Ok(json!({ "deleted": false }));
        }
        let deleted = services.store.delete_workspace_memory(id)?;
        Ok(json!({ "deleted": deleted }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry_fixture() -> WorkspaceMemoryEntry {
        WorkspaceMemoryEntry {
            id: String::new(),
            scope_type: "user".into(),
            scope_id: "local-user".into(),
            memory_type: "knowledge".into(),
            title: "偏好".into(),
            summary: "用户偏好深色主题".into(),
            details: None,
            tags: vec!["偏好".into()],
            source_conversation_id: None,
            source_session_id: None,
            source_message_ids: Vec::new(),
            importance: 0.5,
            confidence: 0.5,
            pinned: false,
            last_used_at: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn derive_memory_title_takes_first_line_and_caps_length() {
        assert_eq!(derive_memory_title("第一行\n第二行"), "第一行");
        let long = "长".repeat(100);
        let title = derive_memory_title(&long);
        assert_eq!(title.chars().count(), TITLE_MAX_CHARS + 1);
        assert!(title.ends_with('…'));
    }

    #[tokio::test]
    async fn memory_add_and_search_roundtrip_through_the_shared_store() {
        let workspace =
            std::env::temp_dir().join(format!("wb-memory-tools-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&workspace).unwrap();
        let store = std::sync::Arc::new(
            worldbase_memory::Store::open(&workspace.join("app.sqlite")).unwrap(),
        );
        let services = tool_services(
            store.clone(),
            vec![worldbase_protocol::types::MemorySearchScopeEntry {
                scope_type: "user".into(),
                scope_id: "account-42".into(),
            }],
        );
        let saved = MemoryAddTool
            .execute(
                serde_json::json!({ "content": "用户喜欢深色主题", "tags": ["偏好"] }),
                &services,
            )
            .await
            .unwrap();
        let id = saved["id"].as_str().unwrap();
        assert_eq!(
            store.get_workspace_memory(id).unwrap().unwrap().scope_id,
            "account-42"
        );

        // Natural-language Chinese query has no exact FTS substring match;
        // fallback browsing must still surface the scoped stored preference.
        let result = MemorySearchTool
            .execute(serde_json::json!({ "query": "我喜欢什么" }), &services)
            .await
            .unwrap();
        assert_eq!(result["search_mode"], "browse_fallback");
        assert_eq!(result["hits"][0]["summary"], "用户喜欢深色主题");
        assert_eq!(result["hits"][0]["scope"], "user/account-42");

        let deleted = store.delete_workspace_memory(id).unwrap();
        assert!(deleted);
        std::fs::remove_dir_all(&workspace).ok();
    }

    fn tool_services(
        store: std::sync::Arc<worldbase_memory::Store>,
        scopes: Vec<worldbase_protocol::types::MemorySearchScopeEntry>,
    ) -> ToolServices {
        ToolServices {
            host: std::sync::Arc::new(super::super::HostBridge::new()),
            current_stream: std::sync::Arc::new(std::sync::Mutex::new(String::new())),
            abort: None,
            workspace: std::env::temp_dir(),
            folder_workspace: None,
            target_project_id: None,
            allowed_mcp_server_ids: None,
            plan_goal: std::sync::Arc::new(std::sync::Mutex::new(None)),
            todo_items: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
            read_files: std::sync::Arc::new(
                std::sync::Mutex::new(std::collections::HashSet::new()),
            ),
            visible_tool_catalog: None,
            store,
            memory_queue: None,
            memory_scopes: scopes,
            skills: std::sync::Arc::new(worldbase_skills::SkillRegistry::new(vec![])),
            scheduler: std::sync::Arc::new(worldbase_scheduler::Scheduler::new(
                std::sync::Arc::new(
                    worldbase_memory::Store::open(
                        &std::env::temp_dir()
                            .join(format!("wb-sched-{}.sqlite", uuid::Uuid::new_v4())),
                    )
                    .unwrap(),
                ),
            )),
            mcp: std::sync::Arc::new(worldbase_mcp_client::McpManager::default()),
            projects: std::sync::Arc::new(worldbase_project_runtime::ProjectRuntime::new(
                std::env::temp_dir(),
            )),
            group_collaboration: None,
            subagent_runtime: None,
        }
    }

    #[tokio::test]
    async fn memory_search_tool_filters_by_run_scopes() {
        let workspace =
            std::env::temp_dir().join(format!("wb-memory-scope-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&workspace).unwrap();
        let store = std::sync::Arc::new(
            worldbase_memory::Store::open(&workspace.join("app.sqlite")).unwrap(),
        );
        let mut in_scope = entry_fixture();
        in_scope.scope_type = "user".into();
        in_scope.scope_id = "local-user".into();
        store.save_workspace_memory(&in_scope).unwrap();
        let mut other_scope = entry_fixture();
        other_scope.scope_type = "project".into();
        other_scope.scope_id = "project_other".into();
        store.save_workspace_memory(&other_scope).unwrap();

        let services = tool_services(
            store,
            vec![worldbase_protocol::types::MemorySearchScopeEntry {
                scope_type: "user".into(),
                scope_id: "local-user".into(),
            }],
        );
        let result = MemorySearchTool
            .execute(serde_json::json!({ "query": "深色" }), &services)
            .await
            .unwrap();
        let hits = result["hits"].as_array().unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["scope"], "user/local-user");
        std::fs::remove_dir_all(&workspace).ok();
    }

    #[tokio::test]
    async fn memory_search_does_not_treat_empty_scopes_as_unrestricted() {
        let workspace =
            std::env::temp_dir().join(format!("wb-memory-no-scope-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&workspace).unwrap();
        let store = std::sync::Arc::new(
            worldbase_memory::Store::open(&workspace.join("app.sqlite")).unwrap(),
        );
        store.save_workspace_memory(&entry_fixture()).unwrap();
        let services = tool_services(store.clone(), Vec::new());
        let result = MemorySearchTool
            .execute(serde_json::json!({ "query": "偏好" }), &services)
            .await
            .unwrap();
        assert_eq!(result["search_mode"], "no_scopes");
        assert!(result["hits"].as_array().unwrap().is_empty());
        let entry = store.save_workspace_memory(&entry_fixture()).unwrap();
        let deleted = MemoryDeleteTool
            .execute(serde_json::json!({ "id": entry.id }), &services)
            .await
            .unwrap();
        assert_eq!(deleted["deleted"], false);
        std::fs::remove_dir_all(&workspace).ok();
    }
}
