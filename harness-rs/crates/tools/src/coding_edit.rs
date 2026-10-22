//! Native symbol-aware coding edit tool.
//!
//! The coding crate produces an in-memory proposal after validating the edit
//! against a fresh syntax tree. This tool owns the project path boundary, the
//! stale-file check, and the single final write.

use crate::{require_str, Tool, ToolServices};
use anyhow::{Context, Result};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::Path;
use worldbase_coding::smart_editor::{
    delete_symbol, insert_after, parse_file, rename_symbol, replace_symbol, LanguageId,
    SemanticEdit, SymbolKind, SymbolQuery,
};

const PREVIEW_CHARS: usize = 400;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EditOperation {
    Replace,
    InsertAfter,
    Delete,
    Rename,
}

impl EditOperation {
    pub(crate) fn parse(value: &str) -> Result<Self> {
        match value.trim() {
            "replace" => Ok(Self::Replace),
            "insert_after" => Ok(Self::InsertAfter),
            "delete" => Ok(Self::Delete),
            "rename" => Ok(Self::Rename),
            other => anyhow::bail!(
                "unsupported operation `{other}`; expected `replace`, `insert_after`, `delete`, or `rename`"
            ),
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Replace => "replace",
            Self::InsertAfter => "insert_after",
            Self::Delete => "delete",
            Self::Rename => "rename",
        }
    }

    fn requires_replacement(self) -> bool {
        matches!(self, Self::Replace | Self::InsertAfter)
    }
}

pub struct CodingEditTool;

#[async_trait]
impl Tool for CodingEditTool {
    fn name(&self) -> &str {
        "coding_edit"
    }

    fn description(&self) -> &str {
        "Apply a symbol-aware edit (replace, insert_after, delete, rename) to a JavaScript/TypeScript/TSX project file. The edit is re-parsed before writing and rejected if the file changed since it was read."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_id": { "type": "string", "description": "Managed project ID." },
                "file_path": { "type": "string", "description": "File path relative to the project root." },
                "operation": {
                    "type": "string",
                    "enum": ["replace", "insert_after", "delete", "rename"],
                    "description": "Semantic edit operation."
                },
                "selector": {
                    "type": "object",
                    "description": "Indexed symbol selector.",
                    "properties": {
                        "kind": {
                            "type": "string",
                            "description": "Symbol kind: module, type, interface, function, method, variable, import, export, or unknown."
                        },
                        "name": { "type": "string", "description": "Declaration name." },
                        "parent": {
                            "type": "string",
                            "description": "Optional parent path, dotted or slash-separated (e.g. `Foo.bar`)."
                        }
                    },
                    "required": ["kind", "name"]
                },
                "replacement": {
                    "type": "string",
                    "description": "Replacement source text. Required for replace and insert_after."
                },
                "new_name": {
                    "type": "string",
                    "description": "New identifier. Required for rename."
                }
            },
            "required": ["project_id", "file_path", "operation", "selector"]
        })
    }

    fn domain(&self) -> &str {
        "desktop"
    }

    fn permission(&self) -> &str {
        "ask"
    }

    fn electron_native(&self) -> bool {
        true
    }

    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        execute_edit(input, services, || {}).await
    }
}

async fn execute_edit(
    input: Value,
    services: &ToolServices,
    before_write: impl FnOnce(),
) -> Result<Value> {
    anyhow::ensure!(
        !services.plan_mode_active(),
        "coding_edit is disabled while plan mode is active"
    );

    let project_id = require_str(&input, "project_id")?.trim().to_string();
    let file_path = require_str(&input, "file_path")?.trim().to_string();
    anyhow::ensure!(!file_path.is_empty(), "file_path must not be empty");
    let operation = EditOperation::parse(require_str(&input, "operation")?)?;
    let query = parse_query(&input)?;

    // Reject unsupported extensions before touching the filesystem.
    LanguageId::from_path(Path::new(&file_path))?;
    let full = services.projects.project_path(&project_id, &file_path)?;
    let original = tokio::fs::read_to_string(&full)
        .await
        .with_context(|| format!("read {}", full.display()))?;
    let parsed =
        parse_file(&full, &original).with_context(|| format!("parse {}", full.display()))?;
    anyhow::ensure!(
        !parsed.has_syntax_errors(),
        "coding_edit rejected: {} already contains syntax errors",
        file_path
    );

    let proposal = build_proposal(&parsed, operation, &query, &input)?;

    before_write();

    // Re-read immediately before the write so a concurrent edit is never
    // overwritten silently.
    read_source_unchanged(&full, &original, &file_path).await?;

    tokio::fs::write(&full, proposal.edited_source.as_bytes()).await?;
    services.mark_file_read(&full.canonicalize().unwrap_or_else(|_| full.clone()));

    Ok(json!({
        "changed": true,
        "operation": operation.as_str(),
        "filePath": file_path,
        "byteRange": {
            "start": proposal.byte_range.start,
            "end": proposal.byte_range.end
        },
        "bytesWritten": proposal.edited_source.len(),
        "preview": preview(&proposal.edited_source, proposal.byte_range.start),
        "before": proposal.original_snippet,
        "after": proposal.replacement
    }))
}

pub(crate) fn build_proposal(
    parsed: &worldbase_coding::smart_editor::ParsedFile,
    operation: EditOperation,
    query: &SymbolQuery,
    input: &Value,
) -> Result<SemanticEdit> {
    match operation {
        EditOperation::Replace => {
            let replacement = require_replacement(input, operation)?;
            replace_symbol(parsed, query, replacement)
        }
        EditOperation::InsertAfter => {
            let replacement = require_replacement(input, operation)?;
            insert_after(parsed, query, replacement)
        }
        EditOperation::Delete => delete_symbol(parsed, query),
        EditOperation::Rename => {
            let new_name = require_str(input, "new_name")?;
            rename_symbol(parsed, query, new_name)
        }
    }
}

pub(crate) async fn read_source_unchanged(
    full: &Path,
    original: &str,
    file_path: &str,
) -> Result<String> {
    let latest = tokio::fs::read_to_string(full)
        .await
        .with_context(|| format!("re-read {}", full.display()))?;
    anyhow::ensure!(
        latest == original,
        "stale file rejected: {file_path} changed on disk after it was read; re-read it and retry"
    );
    Ok(latest)
}

fn require_replacement(input: &Value, operation: EditOperation) -> Result<String> {
    debug_assert!(operation.requires_replacement());
    let replacement = require_str(input, "replacement")?;
    anyhow::ensure!(
        !replacement.trim().is_empty(),
        "replacement must not be empty for {}",
        operation.as_str()
    );
    Ok(replacement.to_string())
}

pub(crate) fn parse_query(input: &Value) -> Result<SymbolQuery> {
    let selector = input
        .get("selector")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow::anyhow!("selector must be an object with kind and name"))?;
    let kind = selector
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("selector.kind must be a string"))?
        .parse::<SymbolKind>()?;
    let name = selector
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| anyhow::anyhow!("selector.name must be a non-empty string"))?;

    let mut query = SymbolQuery::new(name).with_kind(kind);
    if let Some(parent) = selector.get("parent") {
        let parent = parent
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("selector.parent must be a string when provided"))?;
        query = query.with_parent(parent);
    }
    Ok(query)
}

fn preview(source: &str, offset: usize) -> String {
    let mut line_start = offset.min(source.len());
    while line_start > 0 && !source.is_char_boundary(line_start) {
        line_start -= 1;
    }
    let line_start = source[..line_start]
        .rfind('\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    let mut end = (line_start + PREVIEW_CHARS).min(source.len());
    while end > line_start && !source.is_char_boundary(end) {
        end -= 1;
    }
    if end < source.len() {
        format!("{}\n…", &source[line_start..end])
    } else {
        source[line_start..end].to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::Arc;

    fn services(root: &Path) -> (ToolServices, PathBuf) {
        let workspace = root.join("workspace");
        let projects = root.join("projects");
        let project = projects.join("alpha");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(project.join("src")).unwrap();
        let store = Arc::new(worldbase_memory::Store::open(&root.join("store.sqlite")).unwrap());
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
        (services, project)
    }

    async fn run(input: Value, services: &ToolServices) -> Result<Value> {
        execute_edit(input, services, || {}).await
    }

    #[test]
    fn coding_edit_descriptor_is_native_and_permissioned() {
        let tool = CodingEditTool;
        assert_eq!(tool.name(), "coding_edit");
        assert!(tool.electron_native());
        assert_eq!(tool.domain(), "desktop");
        assert_eq!(tool.permission(), "ask");
        let schema = tool.input_schema();
        assert_eq!(
            schema["required"],
            json!(["project_id", "file_path", "operation", "selector"])
        );
        assert_eq!(
            schema["properties"]["operation"]["enum"],
            json!(["replace", "insert_after", "delete", "rename"])
        );
    }

    #[tokio::test]
    async fn replaces_a_function_with_a_validated_proposal() {
        let temp = tempfile::tempdir().unwrap();
        let (service, project) = services(temp.path());
        let file = project.join("src/math.ts");
        std::fs::write(
            &file,
            "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
        )
        .unwrap();

        let result = run(
            json!({
                "project_id": "alpha",
                "file_path": "src/math.ts",
                "operation": "replace",
                "selector": { "kind": "function", "name": "add" },
                "replacement": "function add(a: number, b: number): number {\n  return a * b;\n}"
            }),
            &service,
        )
        .await
        .unwrap();

        assert_eq!(result["changed"], true);
        assert_eq!(result["operation"], "replace");
        assert_eq!(result["filePath"], "src/math.ts");
        assert!(result["byteRange"]["start"].as_u64().unwrap() > 0);
        assert!(result["before"].as_str().unwrap().contains("return a + b"));
        assert!(result["after"].as_str().unwrap().contains("return a * b"));
        let written = std::fs::read_to_string(&file).unwrap();
        assert_eq!(
            result["bytesWritten"].as_u64().unwrap() as usize,
            written.len()
        );
        assert!(result["preview"].as_str().unwrap().contains("a * b"));
        assert_eq!(
            written,
            "export function add(a: number, b: number): number {\n  return a * b;\n}\n"
        );
        assert!(service.has_read_file(&file.canonicalize().unwrap()));
    }

    #[tokio::test]
    async fn renames_a_symbol_and_its_references() {
        let temp = tempfile::tempdir().unwrap();
        let (service, project) = services(temp.path());
        let file = project.join("src/counter.ts");
        std::fs::write(
            &file,
            "const count = 1;\nexport function read() {\n  return count;\n}\n",
        )
        .unwrap();

        let result = run(
            json!({
                "project_id": "alpha",
                "file_path": "src/counter.ts",
                "operation": "rename",
                "selector": { "kind": "variable", "name": "count" },
                "new_name": "total"
            }),
            &service,
        )
        .await
        .unwrap();
        assert_eq!(result["operation"], "rename");
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "const total = 1;\nexport function read() {\n  return total;\n}\n"
        );
    }

    #[tokio::test]
    async fn inserts_after_and_deletes_symbols() {
        let temp = tempfile::tempdir().unwrap();
        let (service, project) = services(temp.path());
        let file = project.join("src/list.ts");
        std::fs::write(&file, "function first() {}\nfunction last() {}\n").unwrap();

        run(
            json!({
                "project_id": "alpha",
                "file_path": "src/list.ts",
                "operation": "insert_after",
                "selector": { "kind": "function", "name": "first" },
                "replacement": "function middle() {}"
            }),
            &service,
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "function first() {}\nfunction middle() {}\nfunction last() {}\n"
        );

        run(
            json!({
                "project_id": "alpha",
                "file_path": "src/list.ts",
                "operation": "delete",
                "selector": { "kind": "function", "name": "middle" }
            }),
            &service,
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "function first() {}\nfunction last() {}\n"
        );
    }

    #[tokio::test]
    async fn rejects_a_stale_file_without_overwriting_it() {
        let temp = tempfile::tempdir().unwrap();
        let (service, project) = services(temp.path());
        let file = project.join("src/stale.ts");
        std::fs::write(&file, "export function old() {}\n").unwrap();

        let stale_file = file.clone();
        let error = execute_edit(
            json!({
                "project_id": "alpha",
                "file_path": "src/stale.ts",
                "operation": "replace",
                "selector": { "kind": "function", "name": "old" },
                "replacement": "function old() { return 1; }"
            }),
            &service,
            move || {
                std::fs::write(&stale_file, "export function external() {}\n").unwrap();
            },
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("stale file rejected"));
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "export function external() {}\n"
        );
    }

    #[tokio::test]
    async fn rejects_path_escape_and_unsupported_extensions() {
        let temp = tempfile::tempdir().unwrap();
        let (service, project) = services(temp.path());

        let escape = run(
            json!({
                "project_id": "alpha",
                "file_path": "../outside.ts",
                "operation": "delete",
                "selector": { "kind": "function", "name": "x" }
            }),
            &service,
        )
        .await
        .unwrap_err();
        assert!(escape.to_string().contains("escapes project"));
        assert!(!project.parent().unwrap().join("outside.ts").exists());

        std::fs::write(project.join("README.md"), "# readme\n").unwrap();
        let unsupported = run(
            json!({
                "project_id": "alpha",
                "file_path": "README.md",
                "operation": "delete",
                "selector": { "kind": "function", "name": "x" }
            }),
            &service,
        )
        .await
        .unwrap_err();
        assert!(unsupported
            .to_string()
            .contains("unsupported source extension"));
    }

    #[tokio::test]
    async fn rejects_ambiguous_selectors_without_writing() {
        let temp = tempfile::tempdir().unwrap();
        let (service, project) = services(temp.path());
        let file = project.join("src/duplicate.ts");
        let source = "function duplicate() {}\nfunction duplicate() { return 1; }\n";
        std::fs::write(&file, source).unwrap();

        let error = run(
            json!({
                "project_id": "alpha",
                "file_path": "src/duplicate.ts",
                "operation": "delete",
                "selector": { "kind": "function", "name": "duplicate" }
            }),
            &service,
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("ambiguous symbol"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), source);
    }

    #[tokio::test]
    async fn requires_operation_specific_arguments() {
        let temp = tempfile::tempdir().unwrap();
        let (service, project) = services(temp.path());
        std::fs::write(project.join("src/app.ts"), "function app() {}\n").unwrap();

        let missing_replacement = run(
            json!({
                "project_id": "alpha",
                "file_path": "src/app.ts",
                "operation": "insert_after",
                "selector": { "kind": "function", "name": "app" }
            }),
            &service,
        )
        .await
        .unwrap_err();
        assert!(missing_replacement
            .to_string()
            .contains("missing required string parameter: replacement"));

        let missing_new_name = run(
            json!({
                "project_id": "alpha",
                "file_path": "src/app.ts",
                "operation": "rename",
                "selector": { "kind": "function", "name": "app" }
            }),
            &service,
        )
        .await
        .unwrap_err();
        assert!(missing_new_name
            .to_string()
            .contains("missing required string parameter: new_name"));
    }
}
