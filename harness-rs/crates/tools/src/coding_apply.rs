//! Batch semantic edit tool.
//!
//! The tool validates every edit in memory first, plans dependency-aware write
//! batches with `worldbase_coding::plan_write_batches`, then writes one batch at
//! a time. Files inside a batch are written concurrently; files sharing a path
//! or an edit dependency are serialized by the planner.

use crate::coding_edit::{build_proposal, parse_query, read_source_unchanged, EditOperation};
use crate::{require_str, Tool, ToolServices};
use anyhow::{Context, Result};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::path::{Component, Path, PathBuf};
use worldbase_coding::smart_editor::{parse_file, LanguageId, ParsedFile, SymbolQuery};
use worldbase_coding::{plan_write_batches, PlannedWrite};

const MAX_EDITS: usize = 32;

pub struct CodingApplyTool;

#[async_trait]
impl Tool for CodingApplyTool {
    fn name(&self) -> &str {
        "coding_apply"
    }

    fn description(&self) -> &str {
        "Apply one or more symbol-aware edits to JavaScript/TypeScript/TSX project files. All edits are validated before writing; independent files are written in parallel, while same-file and dependency-related edits are serialized."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_id": { "type": "string", "description": "Managed project ID." },
                "edits": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": MAX_EDITS,
                    "description": "Edits to validate and apply. At most 32 edits per call.",
                    "items": {
                        "type": "object",
                        "properties": {
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
                            },
                            "depends_on": {
                                "type": "array",
                                "items": { "type": "string" },
                                "description": "Optional project-relative files this edit depends on."
                            }
                        },
                        "required": ["file_path", "operation", "selector"]
                    }
                }
            },
            "required": ["project_id", "edits"]
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
        execute_apply(input, services, |_, _| {}).await
    }
}

struct PendingFile {
    file_path: PathBuf,
    full_path: PathBuf,
    edits: Vec<EditPlan>,
}

struct EditPlan {
    index: usize,
    input: Value,
    operation: EditOperation,
    query: SymbolQuery,
    depends_on: Vec<PathBuf>,
}

struct PreparedFile {
    file_path: PathBuf,
    full_path: PathBuf,
    original: String,
    edited: String,
    operation_count: usize,
    depends_on: BTreeSet<PathBuf>,
}

async fn execute_apply(
    input: Value,
    services: &ToolServices,
    mut before_batch: impl FnMut(usize, &[PathBuf]),
) -> Result<Value> {
    anyhow::ensure!(
        !services.plan_mode_active(),
        "coding_apply is disabled while plan mode is active"
    );

    let project_id = require_str(&input, "project_id")?.trim().to_string();
    anyhow::ensure!(!project_id.is_empty(), "project_id must not be empty");
    let edits = input
        .get("edits")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow::anyhow!("edits must be an array of edit objects"))?;
    anyhow::ensure!(!edits.is_empty(), "coding_apply requires at least one edit");
    anyhow::ensure!(
        edits.len() <= MAX_EDITS,
        "coding_apply supports at most {MAX_EDITS} edits, got {}",
        edits.len()
    );
    let total_edits = edits.len();

    let mut groups: Vec<PendingFile> = Vec::new();
    let mut group_by_path: HashMap<PathBuf, usize> = HashMap::new();

    for (index, edit) in edits.iter().enumerate() {
        anyhow::ensure!(edit.is_object(), "edits[{index}] must be an object");
        let file_path = require_str(edit, "file_path")?.trim();
        anyhow::ensure!(
            !file_path.is_empty(),
            "edits[{index}].file_path must not be empty"
        );
        let operation = EditOperation::parse(require_str(edit, "operation")?)?;
        let query = parse_query(edit)?;

        LanguageId::from_path(Path::new(file_path))?;
        let full_path = services.projects.project_path(&project_id, file_path)?;
        let normalized_path = normalize_project_path(Path::new(file_path))?;
        let depends_on = parse_dependencies(edit, index, &project_id, services)?;

        let group_index = match group_by_path.get(&normalized_path) {
            Some(index) => *index,
            None => {
                let index = groups.len();
                groups.push(PendingFile {
                    file_path: normalized_path.clone(),
                    full_path,
                    edits: Vec::new(),
                });
                group_by_path.insert(normalized_path, index);
                index
            }
        };
        groups[group_index].edits.push(EditPlan {
            index,
            input: edit.clone(),
            operation,
            query,
            depends_on,
        });
    }

    let mut prepared = HashMap::new();
    let mut planned = Vec::new();
    for group in groups {
        let prepared_file = prepare_file(group).await?;
        planned.push(PlannedWrite {
            file_path: prepared_file.file_path.clone(),
            depends_on: prepared_file.depends_on.iter().cloned().collect(),
        });
        prepared.insert(prepared_file.file_path.clone(), prepared_file);
    }
    let batches = plan_write_batches(planned);

    let batches_payload = batches
        .iter()
        .map(|batch| {
            batch
                .edits
                .iter()
                .map(|edit| edit.file_path.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();

    let mut committed_batches: Vec<Vec<PathBuf>> = Vec::new();
    let mut results = Vec::new();

    for (batch_index, batch) in batches.iter().enumerate() {
        let batch_paths = batch
            .edits
            .iter()
            .map(|edit| edit.file_path.clone())
            .collect::<Vec<_>>();
        let full_paths = batch_paths
            .iter()
            .map(|path| {
                prepared
                    .get(path)
                    .expect("planned file is prepared")
                    .full_path
                    .clone()
            })
            .collect::<Vec<_>>();
        before_batch(batch_index, &full_paths);

        for path in &batch_paths {
            let file = prepared.get(path).expect("planned file is prepared");
            let label = file.file_path.to_string_lossy().into_owned();
            if let Err(error) = read_source_unchanged(&file.full_path, &file.original, &label).await
            {
                return Err(anyhow::anyhow!(
                    "{}; committed batches: {}",
                    error,
                    committed_summary(&committed_batches, &[], batch_index + 1)
                ));
            }
        }

        let writes = batch.edits.iter().map(|planned| {
            let file = prepared
                .get(&planned.file_path)
                .expect("planned file is prepared");
            write_file(
                file.full_path.clone(),
                file.edited.clone().into_bytes(),
                file.file_path.clone(),
            )
        });
        let outcomes = futures::future::join_all(writes).await;

        let mut batch_error = None;
        let mut written_in_batch = Vec::new();
        for (planned, outcome) in batch.edits.iter().zip(outcomes) {
            match outcome {
                Ok(()) => {
                    let file = prepared
                        .get(&planned.file_path)
                        .expect("planned file is prepared");
                    services.mark_file_read(
                        &file
                            .full_path
                            .canonicalize()
                            .unwrap_or_else(|_| file.full_path.clone()),
                    );
                    results.push(json!({
                        "filePath": file.file_path.to_string_lossy(),
                        "operationCount": file.operation_count,
                        "bytesWritten": file.edited.len()
                    }));
                    written_in_batch.push(file.file_path.clone());
                }
                Err(error) => {
                    if batch_error.is_none() {
                        batch_error = Some(error);
                    }
                }
            }
        }

        if let Some(error) = batch_error {
            return Err(anyhow::anyhow!(
                "coding_apply failed writing batch {}: {}; committed batches: {}",
                batch_index + 1,
                error,
                committed_summary(&committed_batches, &written_in_batch, batch_index + 1)
            ));
        }

        committed_batches.push(batch_paths);
    }

    Ok(json!({
        "applied": true,
        "totalEdits": total_edits,
        "batches": batches_payload,
        "results": results
    }))
}

async fn prepare_file(group: PendingFile) -> Result<PreparedFile> {
    let original = tokio::fs::read_to_string(&group.full_path)
        .await
        .with_context(|| format!("read {}", group.full_path.display()))?;
    let mut parsed = parse_file(&group.full_path, &original)
        .with_context(|| format!("parse {}", group.full_path.display()))?;
    anyhow::ensure!(
        !parsed.has_syntax_errors(),
        "coding_apply rejected: {} already contains syntax errors",
        group.file_path.display()
    );

    let mut edited = original.clone();
    let mut depends_on = BTreeSet::new();
    for edit in &group.edits {
        let proposal =
            build_proposal(&parsed, edit.operation, &edit.query, &edit.input).map_err(|error| {
                anyhow::anyhow!(
                    "edit {} for {}: {error}",
                    edit.index,
                    group.file_path.display()
                )
            })?;
        edited = proposal.edited_source;
        parsed = reparse(&group.full_path, &edited)?;
        depends_on.extend(edit.depends_on.iter().cloned());
    }

    Ok(PreparedFile {
        file_path: group.file_path,
        full_path: group.full_path,
        original,
        edited,
        operation_count: group.edits.len(),
        depends_on,
    })
}

fn reparse(path: &Path, source: &str) -> Result<ParsedFile> {
    let parsed = parse_file(path, source)
        .with_context(|| format!("re-parse edited source for {}", path.display()))?;
    anyhow::ensure!(
        !parsed.has_syntax_errors(),
        "coding_apply rejected: edit introduces syntax errors in {}",
        path.display()
    );
    Ok(parsed)
}

async fn write_file(full_path: PathBuf, source: Vec<u8>, label: PathBuf) -> Result<()> {
    tokio::fs::write(&full_path, &source)
        .await
        .with_context(|| format!("write {}", label.display()))
}

fn parse_dependencies(
    edit: &Value,
    edit_index: usize,
    project_id: &str,
    services: &ToolServices,
) -> Result<Vec<PathBuf>> {
    let Some(raw) = edit.get("depends_on") else {
        return Ok(Vec::new());
    };
    let Some(entries) = raw.as_array() else {
        anyhow::bail!("edits[{edit_index}].depends_on must be an array of strings");
    };

    let mut dependencies = Vec::with_capacity(entries.len());
    for (dependency_index, entry) in entries.iter().enumerate() {
        let Some(value) = entry.as_str() else {
            anyhow::bail!("edits[{edit_index}].depends_on[{dependency_index}] must be a string");
        };
        let value = value.trim();
        anyhow::ensure!(
            !value.is_empty(),
            "edits[{edit_index}].depends_on[{dependency_index}] must not be empty"
        );
        services.projects.project_path(project_id, value)?;
        dependencies.push(normalize_project_path(Path::new(value))?);
    }
    Ok(dependencies)
}

fn normalize_project_path(path: &Path) -> Result<PathBuf> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => normalized.push(part),
            component => anyhow::bail!(
                "project file path contains an unsupported component: {}",
                component.as_os_str().to_string_lossy()
            ),
        }
    }
    anyhow::ensure!(
        !normalized.as_os_str().is_empty(),
        "file_path must not be empty"
    );
    Ok(normalized)
}

fn committed_summary(
    committed_batches: &[Vec<PathBuf>],
    partial_batch: &[PathBuf],
    current_batch: usize,
) -> String {
    let mut parts = committed_batches
        .iter()
        .enumerate()
        .map(|(index, batch)| format!("batch {} [{}]", index + 1, join_paths(batch)))
        .collect::<Vec<_>>();
    if !partial_batch.is_empty() {
        parts.push(format!(
            "partial batch {current_batch} [{}]",
            join_paths(partial_batch)
        ));
    }
    if parts.is_empty() {
        "none".to_string()
    } else {
        parts.join("; ")
    }
}

fn join_paths(paths: &[PathBuf]) -> String {
    paths
        .iter()
        .map(|path| path.to_string_lossy())
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;
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
        execute_apply(input, services, |_, _| {}).await
    }

    fn replace_edit(file_path: &str, name: &str, replacement: &str) -> Value {
        json!({
            "file_path": file_path,
            "operation": "replace",
            "selector": { "kind": "function", "name": name },
            "replacement": replacement
        })
    }

    fn batch_paths(result: &Value) -> Vec<Vec<&str>> {
        result["batches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|batch| {
                batch
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|path| path.as_str().unwrap())
                    .collect()
            })
            .collect()
    }

    #[test]
    fn coding_apply_descriptor_is_native_and_permissioned() {
        let tool = CodingApplyTool;
        assert_eq!(tool.name(), "coding_apply");
        assert!(tool.electron_native());
        assert_eq!(tool.domain(), "desktop");
        assert_eq!(tool.permission(), "ask");
        let schema = tool.input_schema();
        assert_eq!(schema["required"], json!(["project_id", "edits"]));
        assert_eq!(schema["properties"]["edits"]["maxItems"], json!(MAX_EDITS));
        assert_eq!(
            schema["properties"]["edits"]["items"]["properties"]["operation"]["enum"],
            json!(["replace", "insert_after", "delete", "rename"])
        );
    }

    #[tokio::test]
    async fn independent_files_execute_in_one_batch() {
        let temp = tempfile::tempdir().unwrap();
        let (services, project) = services(temp.path());
        std::fs::write(
            project.join("src/a.ts"),
            "export function a(): number {\n  return 1;\n}\n",
        )
        .unwrap();
        std::fs::write(
            project.join("src/b.ts"),
            "export function b(): number {\n  return 2;\n}\n",
        )
        .unwrap();

        let result = run(
            json!({
                "project_id": "alpha",
                "edits": [
                    replace_edit("src/b.ts", "b", "function b(): number {\n  return 20;\n}"),
                    replace_edit("src/a.ts", "a", "function a(): number {\n  return 10;\n}")
                ]
            }),
            &services,
        )
        .await
        .unwrap();

        assert_eq!(result["applied"], true);
        assert_eq!(result["totalEdits"], 2);
        assert_eq!(batch_paths(&result), vec![vec!["src/a.ts", "src/b.ts"]]);
        assert!(std::fs::read_to_string(project.join("src/a.ts"))
            .unwrap()
            .contains("return 10"));
        assert!(std::fs::read_to_string(project.join("src/b.ts"))
            .unwrap()
            .contains("return 20"));
        assert!(services.has_read_file(&project.join("src/a.ts").canonicalize().unwrap()));
        assert!(services.has_read_file(&project.join("src/b.ts").canonicalize().unwrap()));
    }

    #[tokio::test]
    async fn same_file_edits_apply_in_input_order() {
        let temp = tempfile::tempdir().unwrap();
        let (services, project) = services(temp.path());
        let file = project.join("src/counter.ts");
        std::fs::write(&file, "export function count(): number {\n  return 1;\n}\n").unwrap();

        let result = run(
            json!({
                "project_id": "alpha",
                "edits": [
                    replace_edit("src/counter.ts", "count", "function count(): number {\n  return 2;\n}"),
                    replace_edit("src/counter.ts", "count", "function count(): number {\n  return 3;\n}")
                ]
            }),
            &services,
        )
        .await
        .unwrap();

        assert_eq!(batch_paths(&result), vec![vec!["src/counter.ts"]]);
        assert_eq!(result["results"][0]["operationCount"], 2);
        assert!(std::fs::read_to_string(&file).unwrap().contains("return 3"));
    }

    #[tokio::test]
    async fn dependencies_force_a_later_batch() {
        let temp = tempfile::tempdir().unwrap();
        let (services, project) = services(temp.path());
        std::fs::write(
            project.join("src/lib.ts"),
            "export function lib(): number {\n  return 1;\n}\n",
        )
        .unwrap();
        std::fs::write(
            project.join("src/app.ts"),
            "export function app(): number {\n  return 1;\n}\n",
        )
        .unwrap();

        let mut app_edit = replace_edit(
            "src/app.ts",
            "app",
            "function app(): number {\n  return 2;\n}",
        );
        app_edit["depends_on"] = json!(["src/lib.ts"]);
        let result = run(
            json!({
                "project_id": "alpha",
                "edits": [
                    app_edit,
                    replace_edit("src/lib.ts", "lib", "function lib(): number {\n  return 2;\n}")
                ]
            }),
            &services,
        )
        .await
        .unwrap();

        assert_eq!(
            batch_paths(&result),
            vec![vec!["src/lib.ts"], vec!["src/app.ts"]]
        );
    }

    #[tokio::test]
    async fn unknown_dependencies_are_ignored_for_batching() {
        let temp = tempfile::tempdir().unwrap();
        let (services, project) = services(temp.path());
        std::fs::write(
            project.join("src/app.ts"),
            "export function app(): number {\n  return 1;\n}\n",
        )
        .unwrap();
        std::fs::write(
            project.join("src/lib.ts"),
            "export function lib(): number {\n  return 1;\n}\n",
        )
        .unwrap();

        let mut app_edit = replace_edit(
            "src/app.ts",
            "app",
            "function app(): number {\n  return 2;\n}",
        );
        app_edit["depends_on"] = json!(["src/missing.ts"]);
        let result = run(
            json!({
                "project_id": "alpha",
                "edits": [
                    app_edit,
                    replace_edit("src/lib.ts", "lib", "function lib(): number {\n  return 2;\n}")
                ]
            }),
            &services,
        )
        .await
        .unwrap();

        assert_eq!(batch_paths(&result), vec![vec!["src/app.ts", "src/lib.ts"]]);
    }

    #[tokio::test]
    async fn stale_file_rejects_before_any_write() {
        let temp = tempfile::tempdir().unwrap();
        let (services, project) = services(temp.path());
        let first = project.join("src/a.ts");
        let second = project.join("src/b.ts");
        std::fs::write(&first, "export function a(): number {\n  return 1;\n}\n").unwrap();
        std::fs::write(&second, "export function b(): number {\n  return 1;\n}\n").unwrap();
        let stale = second.clone();

        let error = execute_apply(
            json!({
                "project_id": "alpha",
                "edits": [
                    replace_edit("src/a.ts", "a", "function a(): number {\n  return 2;\n}"),
                    replace_edit("src/b.ts", "b", "function b(): number {\n  return 2;\n}")
                ]
            }),
            &services,
            move |batch_index, _| {
                if batch_index == 0 {
                    std::fs::write(&stale, "export function external() {}\n").unwrap();
                }
            },
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("stale file rejected"));
        assert!(std::fs::read_to_string(&first)
            .unwrap()
            .contains("return 1"));
        assert_eq!(
            std::fs::read_to_string(&second).unwrap(),
            "export function external() {}\n"
        );
    }

    #[tokio::test]
    async fn later_batch_stale_reports_committed_batches() {
        let temp = tempfile::tempdir().unwrap();
        let (services, project) = services(temp.path());
        let lib = project.join("src/lib.ts");
        let app = project.join("src/app.ts");
        std::fs::write(&lib, "export function lib(): number {\n  return 1;\n}\n").unwrap();
        std::fs::write(&app, "export function app(): number {\n  return 1;\n}\n").unwrap();
        let stale = app.clone();

        let mut app_edit = replace_edit(
            "src/app.ts",
            "app",
            "function app(): number {\n  return 2;\n}",
        );
        app_edit["depends_on"] = json!(["src/lib.ts"]);
        let error = execute_apply(
            json!({
                "project_id": "alpha",
                "edits": [
                    app_edit,
                    replace_edit("src/lib.ts", "lib", "function lib(): number {\n  return 2;\n}")
                ]
            }),
            &services,
            move |batch_index, _| {
                if batch_index == 1 {
                    std::fs::write(&stale, "export function external() {}\n").unwrap();
                }
            },
        )
        .await
        .unwrap_err();

        let message = error.to_string();
        assert!(message.contains("stale file rejected"));
        assert!(message.contains("committed batches: batch 1 [src/lib.ts]"));
        assert!(std::fs::read_to_string(&lib).unwrap().contains("return 2"));
        assert_eq!(
            std::fs::read_to_string(&app).unwrap(),
            "export function external() {}\n"
        );
    }

    #[tokio::test]
    async fn rejects_path_escape_and_unsupported_extensions() {
        let temp = tempfile::tempdir().unwrap();
        let (services, project) = services(temp.path());

        let escape = run(
            json!({
                "project_id": "alpha",
                "edits": [replace_edit("../outside.ts", "x", "function x() {}")]
            }),
            &services,
        )
        .await
        .unwrap_err();
        assert!(escape.to_string().contains("escapes project"));
        assert!(!project.parent().unwrap().join("outside.ts").exists());

        std::fs::write(project.join("README.md"), "# readme\n").unwrap();
        let unsupported = run(
            json!({
                "project_id": "alpha",
                "edits": [replace_edit("README.md", "x", "function x() {}")]
            }),
            &services,
        )
        .await
        .unwrap_err();
        assert!(unsupported
            .to_string()
            .contains("unsupported frontend source extension"));
    }

    #[tokio::test]
    async fn rejects_ambiguous_selectors_without_writing() {
        let temp = tempfile::tempdir().unwrap();
        let (services, project) = services(temp.path());
        let file = project.join("src/duplicate.ts");
        let source = "function duplicate() {}\nfunction duplicate() { return 1; }\n";
        std::fs::write(&file, source).unwrap();

        let error = run(
            json!({
                "project_id": "alpha",
                "edits": [{
                    "file_path": "src/duplicate.ts",
                    "operation": "delete",
                    "selector": { "kind": "function", "name": "duplicate" }
                }]
            }),
            &services,
        )
        .await
        .unwrap_err();
        assert!(
            error.to_string().contains("ambiguous symbol"),
            "unexpected error: {error}"
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), source);
    }

    #[tokio::test]
    async fn rejects_empty_and_oversized_edit_sets() {
        let temp = tempfile::tempdir().unwrap();
        let (services, _project) = services(temp.path());

        let empty = run(json!({ "project_id": "alpha", "edits": [] }), &services)
            .await
            .unwrap_err();
        assert!(empty.to_string().contains("at least one edit"));

        let edits = (0..=MAX_EDITS)
            .map(|index| {
                replace_edit(
                    "src/app.ts",
                    "app",
                    &format!("function app(): number {{ return {index}; }}"),
                )
            })
            .collect::<Vec<_>>();
        let oversized = run(json!({ "project_id": "alpha", "edits": edits }), &services)
            .await
            .unwrap_err();
        assert!(oversized.to_string().contains("at most 32 edits"));
    }

    #[tokio::test]
    async fn plan_mode_rejects_before_validation() {
        let temp = tempfile::tempdir().unwrap();
        let (services, project) = services(temp.path());
        std::fs::write(
            project.join("src/app.ts"),
            "export function app(): number {\n  return 1;\n}\n",
        )
        .unwrap();
        assert!(services.enter_plan_mode("plan first"));
        assert!(!services.is_tool_allowed_in_plan_mode("coding_apply"));

        let error = run(
            json!({
                "project_id": "alpha",
                "edits": [replace_edit("src/app.ts", "app", "function app(): number {\n  return 2;\n}")]
            }),
            &services,
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("disabled while plan mode"));
        assert!(std::fs::read_to_string(project.join("src/app.ts"))
            .unwrap()
            .contains("return 1"));
    }

    #[tokio::test]
    async fn result_payload_has_stable_counts_and_batch_order() {
        let temp = tempfile::tempdir().unwrap();
        let (services, project) = services(temp.path());
        for name in ["c", "a", "b"] {
            std::fs::write(
                project.join(format!("src/{name}.ts")),
                format!("export function {name}(): number {{\n  return 1;\n}}\n"),
            )
            .unwrap();
        }

        let result = run(
            json!({
                "project_id": "alpha",
                "edits": [
                    replace_edit("src/c.ts", "c", "function c(): number {\n  return 2;\n}"),
                    replace_edit("src/a.ts", "a", "function a(): number {\n  return 2;\n}"),
                    replace_edit("src/b.ts", "b", "function b(): number {\n  return 2;\n}")
                ]
            }),
            &services,
        )
        .await
        .unwrap();

        assert_eq!(result["totalEdits"], 3);
        assert_eq!(
            batch_paths(&result),
            vec![vec!["src/a.ts", "src/b.ts", "src/c.ts"]]
        );
        let results = result["results"].as_array().unwrap();
        assert_eq!(
            results
                .iter()
                .map(|entry| entry["filePath"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["src/a.ts", "src/b.ts", "src/c.ts"]
        );
        for entry in results {
            assert_eq!(entry["operationCount"], 1);
            let file = project.join(entry["filePath"].as_str().unwrap());
            assert_eq!(
                entry["bytesWritten"].as_u64().unwrap() as usize,
                std::fs::read_to_string(file).unwrap().len()
            );
        }
    }
}
