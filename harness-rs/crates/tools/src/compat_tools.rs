//! Electron tool-name compatibility layer.
//!
//! These tools preserve the public Electron contracts so prompts and persisted
//! tool calls continue to work while the underlying services migrate to Rust.

use crate::{require_str, EditFileTool, PatchFileTool, Tool, ToolServices, WriteFileTool};
use anyhow::{Context, Result};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_RETURN_CHARS: usize = 50_000;
const MAX_COMMAND_CHARS: usize = 20_000;
const MAX_WORKSPACE_TREE_ENTRIES: usize = 5_000;
const MAX_WORKSPACE_TREE_DEPTH: usize = 12;

fn sanitize_agent_group_id(value: &str) -> String {
    value
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || *character == '_' || *character == '-'
        })
        .collect()
}

fn agent_group_id_from_name(name: &str) -> String {
    let mut slug = String::new();
    let mut separator = false;
    for character in name.chars() {
        if character.is_ascii_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(&character) {
            if separator && !slug.is_empty() {
                slug.push('_');
            }
            separator = false;
            slug.push(character.to_ascii_lowercase());
        } else if !slug.is_empty() {
            separator = true;
        }
        if slug.chars().count() >= 36 {
            break;
        }
    }
    while slug.ends_with('_') {
        slug.pop();
    }
    let mut millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let mut suffix = String::new();
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if millis == 0 {
        suffix.push('0');
    } else {
        while millis > 0 {
            suffix.push(DIGITS[(millis % 36) as usize] as char);
            millis /= 36;
        }
        suffix = suffix.chars().rev().collect();
    }
    sanitize_agent_group_id(&format!(
        "group_{}_{}",
        if slug.is_empty() { "team" } else { &slug },
        suffix
    ))
}

fn is_ignored_workspace_dir(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | ".hg"
            | ".svn"
            | "node_modules"
            | ".next"
            | "dist"
            | "build"
            | "coverage"
            | ".cache"
            | ".turbo"
            | ".output"
            | "__pycache__"
            | ".venv"
            | "venv"
    )
}

fn list_workspace_tree(
    root: &Path,
    relative: &str,
    depth: usize,
    total: &mut usize,
    truncated: &mut bool,
) -> Result<Vec<Value>> {
    if *truncated || depth > MAX_WORKSPACE_TREE_DEPTH {
        return Ok(Vec::new());
    }
    let directory = if relative.is_empty() {
        root.to_path_buf()
    } else {
        root.join(relative)
    };
    let reader = match std::fs::read_dir(&directory) {
        Ok(reader) => reader,
        Err(_) => return Ok(Vec::new()),
    };
    let mut raw_entries = Vec::new();
    for entry in reader {
        if let Ok(entry) = entry {
            raw_entries.push(entry);
        }
    }
    raw_entries.sort_by(|left, right| {
        let left_dir = left.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        let right_dir = right.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        right_dir
            .cmp(&left_dir)
            .then_with(|| left.file_name().cmp(&right.file_name()))
    });

    let mut entries = Vec::new();
    for entry in raw_entries {
        if *truncated {
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let file_type = entry.file_type()?;
        if name.starts_with('.') && name != ".env" && name != ".gitignore" && file_type.is_dir() {
            continue;
        }
        if file_type.is_dir() && is_ignored_workspace_dir(&name) {
            continue;
        }
        *total += 1;
        if *total > MAX_WORKSPACE_TREE_ENTRIES {
            *truncated = true;
            break;
        }
        let path = if relative.is_empty() {
            name.clone()
        } else {
            format!("{relative}/{name}")
        };
        if file_type.is_dir() {
            let children = if depth < MAX_WORKSPACE_TREE_DEPTH {
                list_workspace_tree(root, &path, depth + 1, total, truncated)?
            } else {
                Vec::new()
            };
            entries.push(json!({
                "name": name,
                "path": path,
                "type": "directory",
                "children": children,
            }));
        } else {
            let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            entries.push(json!({
                "name": name,
                "path": path,
                "type": "file",
                "size": size,
            }));
        }
    }
    Ok(entries)
}

fn selected_folder_workspace(services: &ToolServices) -> Result<&Path> {
    services
        .folder_workspace
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("no folder workspace is selected for this conversation"))
}

fn folder_path_arg(input: &Value, key: &str, services: &ToolServices) -> Result<(String, PathBuf)> {
    let rel = require_str(input, key)?.to_string();
    let _ = selected_folder_workspace(services)?;
    let path = services.folder_workspace_path(&rel);
    services.ensure_folder_workspace_path(&path)?;
    Ok((rel, path))
}

fn folder_scoped_services(services: &ToolServices) -> Result<ToolServices> {
    let root = selected_folder_workspace(services)?.to_path_buf();
    let mut scoped = services.clone();
    scoped.workspace = root.clone();
    scoped.folder_workspace = Some(root);
    Ok(scoped)
}

fn project_path(input: &Value, services: &ToolServices) -> Result<(String, PathBuf)> {
    let id = input
        .get("project_id")
        .or_else(|| input.get("project"))
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("missing required string parameter: project_id"))?;
    let id = id.trim();
    let path = services.projects.project_root(id)?;
    Ok((id.to_string(), path))
}

fn project_relative_path(
    services: &ToolServices,
    project_id: &str,
    relative_path: &str,
) -> Result<PathBuf> {
    services.projects.project_path(project_id, relative_path)
}

fn shell_program(command: &str) -> (String, Vec<String>) {
    if cfg!(target_os = "windows") {
        ("cmd".into(), vec!["/C".into(), command.into()])
    } else {
        ("sh".into(), vec!["-c".into(), command.into()])
    }
}

async fn run_shell(command: &str, cwd: &Path, timeout: Option<u64>) -> Result<Value> {
    anyhow::ensure!(!command.trim().is_empty(), "command is required");
    anyhow::ensure!(command.len() <= MAX_COMMAND_CHARS, "command is too long");
    let (program, args) = shell_program(command);
    let req = worldbase_exec::ExecRequest {
        program,
        args,
        cwd: Some(cwd.display().to_string()),
        env: Default::default(),
        timeout_secs: Some(timeout.unwrap_or(90).clamp(1, 180)),
        sandbox: true,
    };
    Ok(serde_json::to_value(worldbase_exec::run(&req, cwd).await?)?)
}

// -------------------------------------------------------------------------
// Folder workspace and local filesystem tools

pub struct WorkspaceListFilesTool;
#[async_trait]
impl Tool for WorkspaceListFilesTool {
    fn name(&self) -> &str {
        "list_workspace_files"
    }
    fn description(&self) -> &str {
        "List files and folders in the selected conversation folder workspace."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"dir_path":{"type":"string"}}})
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let rel = input
            .get("dir_path")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .trim_matches('/')
            .to_string();
        let root = selected_folder_workspace(services)?;
        let directory = if rel.is_empty() {
            root.to_path_buf()
        } else {
            services.folder_workspace_path(&rel)
        };
        services.ensure_folder_workspace_path(&directory)?;
        let mut total = 0;
        let mut truncated = false;
        let full_tree = list_workspace_tree(root, "", 0, &mut total, &mut truncated)?;
        let mut entries = full_tree;
        if !rel.is_empty() {
            for segment in rel.split('/').filter(|segment| !segment.is_empty()) {
                let Some(entry) = entries.iter().find(|entry| {
                    entry["type"] == "directory" && entry["name"].as_str() == Some(segment)
                }) else {
                    entries = Vec::new();
                    break;
                };
                entries = entry["children"].as_array().cloned().unwrap_or_default();
            }
        }
        let root_name = root
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.display().to_string());
        let total_entries = if rel.is_empty() { total } else { entries.len() };
        Ok(json!({
            "rootPath": root,
            "rootName": root_name,
            "dir_path": rel,
            "entries": entries,
            "totalEntries": total_entries,
            "truncated": truncated,
        }))
    }
}

pub struct WorkspaceReadFileTool;
#[async_trait]
impl Tool for WorkspaceReadFileTool {
    fn name(&self) -> &str {
        "read_workspace_file"
    }
    fn description(&self) -> &str {
        "Read a file from the selected conversation folder workspace."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"file_path":{"type":"string"},"start_line":{"type":"integer"},"max_lines":{"type":"integer"}},"required":["file_path"]})
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let (rel, path) = folder_path_arg(&input, "file_path", services)?;
        let content = tokio::fs::read_to_string(&path).await?;
        services.mark_file_read(&path.canonicalize().unwrap_or(path.clone()));
        let lines: Vec<&str> = if content.is_empty() {
            Vec::new()
        } else {
            content.split('\n').collect()
        };
        let start = input
            .get("start_line")
            .and_then(Value::as_u64)
            .unwrap_or(1)
            .max(1) as usize;
        let max = input
            .get("max_lines")
            .and_then(Value::as_u64)
            .unwrap_or(lines.len().max(1) as u64)
            .clamp(1, 2000) as usize;
        let from = (start - 1).min(lines.len());
        let to = (from + max).min(lines.len());
        let numbered = lines[from..to]
            .iter()
            .enumerate()
            .map(|(i, line)| format!("{:>6}\t{}", from + i + 1, line))
            .collect::<Vec<_>>()
            .join("\n");
        let mut shown = numbered;
        let mut truncated = false;
        if shown.len() > MAX_RETURN_CHARS {
            let mut boundary = MAX_RETURN_CHARS;
            while boundary > 0 && !shown.is_char_boundary(boundary) {
                boundary -= 1;
            }
            shown.truncate(boundary);
            shown.push_str("\n...[truncated]");
            truncated = true;
        }
        Ok(
            json!({"file_path": rel, "content": shown, "total_chars": content.len(), "total_lines": lines.len(), "start_line": if lines.is_empty() { 0 } else { from + 1 }, "end_line": to, "has_more": to < lines.len() || truncated, "next_start_line": if to < lines.len() { Some(to + 1) } else { None }, "truncated": truncated}),
        )
    }
}

pub struct WorkspaceWriteFileTool;
#[async_trait]
impl Tool for WorkspaceWriteFileTool {
    fn name(&self) -> &str {
        "write_workspace_file"
    }
    fn description(&self) -> &str {
        "Create or rewrite a file in the selected folder workspace."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"file_path":{"type":"string"},"content":{"type":"string"}},"required":["file_path","content"]})
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let file_path = require_str(&input, "file_path")?.to_string();
        let content = require_str(&input, "content")?.to_string();
        let (_, full_path) = folder_path_arg(&input, "file_path", services)?;
        let overwritten = full_path.is_file();
        let scoped = folder_scoped_services(services)?;
        let mut translated = input;
        translated["path"] = json!(file_path);
        WriteFileTool.execute(translated, &scoped).await?;
        services.mark_file_read(&full_path.canonicalize().unwrap_or(full_path));
        Ok(
            json!({"success": true, "file_path": file_path, "bytes_written": content.len(), "overwritten": overwritten}),
        )
    }
}

pub struct WorkspaceEditFileTool;
#[async_trait]
impl Tool for WorkspaceEditFileTool {
    fn name(&self) -> &str {
        "edit_workspace_file"
    }
    fn description(&self) -> &str {
        "Apply an exact-string edit to a workspace file."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"file_path":{"type":"string"},"old_string":{"type":"string"},"new_string":{"type":"string"},"replace_all":{"type":"boolean"}},"required":["file_path","old_string","new_string"]})
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, mut input: Value, services: &ToolServices) -> Result<Value> {
        let path = require_str(&input, "file_path")?.to_string();
        let (_, full_path) = folder_path_arg(&input, "file_path", services)?;
        let tracked_path = full_path.canonicalize().unwrap_or(full_path.clone());
        anyhow::ensure!(
            services.has_read_file(&tracked_path),
            "You must read {path} with read_workspace_file before editing it."
        );
        let scoped = folder_scoped_services(services)?;
        input["path"] = json!(path.clone());
        EditFileTool.execute(input, &scoped).await.map(|value| {
            services.mark_file_read(&tracked_path);
            json!({"success": true, "file_path": path, "replaced": value["replaced"]})
        })
    }
}

pub struct WorkspacePatchFileTool;
#[async_trait]
impl Tool for WorkspacePatchFileTool {
    fn name(&self) -> &str {
        "patch_workspace_file"
    }
    fn description(&self) -> &str {
        "Apply line-range patches to a workspace file."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"file_path":{"type":"string"},"patches":{"type":"array","items":{"type":"object"}}},"required":["file_path","patches"]})
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, mut input: Value, services: &ToolServices) -> Result<Value> {
        let path = require_str(&input, "file_path")?.to_string();
        let (_, full_path) = folder_path_arg(&input, "file_path", services)?;
        let scoped = folder_scoped_services(services)?;
        input["path"] = json!(path.clone());
        PatchFileTool.execute(input, &scoped).await.map(|value| {
            services.mark_file_read(&full_path.canonicalize().unwrap_or(full_path));
            json!({"success": true, "file_path": path, "patches_applied": value["patches_applied"]})
        })
    }
}

pub struct WorkspaceDeleteFileTool;
#[async_trait]
impl Tool for WorkspaceDeleteFileTool {
    fn name(&self) -> &str {
        "delete_workspace_file"
    }
    fn description(&self) -> &str {
        "Delete a file from the selected folder workspace."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"file_path":{"type":"string"}},"required":["file_path"]})
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let (rel, path) = folder_path_arg(&input, "file_path", services)?;
        let existed = path.is_file();
        if existed {
            tokio::fs::remove_file(path).await?;
        }
        Ok(json!({"success": true, "file_path": rel, "deleted": existed}))
    }
}

pub struct WorkspaceGlobTool;
#[async_trait]
impl Tool for WorkspaceGlobTool {
    fn name(&self) -> &str {
        "glob_workspace"
    }
    fn description(&self) -> &str {
        "Search for files in the selected folder workspace using a glob pattern."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"pattern":{"type":"string"},"dir_path":{"type":"string"},"max_results":{"type":"integer"}},"required":["pattern"]})
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let pattern = require_str(&input, "pattern")?;
        let dir = input.get("dir_path").and_then(Value::as_str).unwrap_or("");
        let root = selected_folder_workspace(services)?;
        let base = if dir.is_empty() {
            root.to_path_buf()
        } else {
            services.folder_workspace_path(dir)
        };
        services.ensure_folder_workspace_path(&base)?;
        let limit = input
            .get("max_results")
            .and_then(Value::as_u64)
            .unwrap_or(100)
            .clamp(1, 500) as usize;
        let paths = worldbase_search::glob(&base, pattern, limit)?;
        let matches = paths.into_iter().map(|path| {
            let rel = path.strip_prefix(&base).unwrap_or(&path).to_string_lossy().replace('\\', "/");
            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            json!({"path": rel, "size": size, "type": if path.is_dir() { "directory" } else { "file" }})
        }).collect::<Vec<_>>();
        Ok(
            json!({"pattern": pattern, "dir_path": dir, "matches": matches, "total_matches": matches.len(), "truncated": matches.len() >= limit}),
        )
    }
}

pub struct WorkspaceGrepTool;
#[async_trait]
impl Tool for WorkspaceGrepTool {
    fn name(&self) -> &str {
        "grep_workspace"
    }
    fn description(&self) -> &str {
        "Search text or regular expressions inside the selected folder workspace."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"pattern":{"type":"string"},"dir_path":{"type":"string"},"include_pattern":{"type":"string"},"is_regexp":{"type":"boolean"},"case_sensitive":{"type":"boolean"},"max_results":{"type":"integer"},"context_lines":{"type":"integer"}},"required":["pattern"]})
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let pattern = require_str(&input, "pattern")?;
        let dir = input.get("dir_path").and_then(Value::as_str).unwrap_or("");
        let root = selected_folder_workspace(services)?;
        let base = if dir.is_empty() {
            root.to_path_buf()
        } else {
            services.folder_workspace_path(dir)
        };
        services.ensure_folder_workspace_path(&base)?;
        let literal = !input
            .get("is_regexp")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let limit = input
            .get("max_results")
            .and_then(Value::as_u64)
            .unwrap_or(50)
            .clamp(1, 200) as usize;
        let hits = worldbase_search::grep(&base, pattern, literal, limit)?;
        let matches = hits.into_iter().map(|hit| json!({"file": hit.path, "line": hit.line, "content": hit.text, "context_before": [], "context_after": []})).collect::<Vec<_>>();
        Ok(
            json!({"pattern": pattern, "dir_path": dir, "output_mode": "content", "case_sensitive": input.get("case_sensitive").and_then(Value::as_bool).unwrap_or(true), "matches": matches, "total_matches": matches.len(), "files_searched": 0, "files_matched": 0, "truncated": matches.len() >= limit}),
        )
    }
}

pub struct WorkspaceCommandTool;
#[async_trait]
impl Tool for WorkspaceCommandTool {
    fn name(&self) -> &str {
        "run_workspace_command"
    }
    fn description(&self) -> &str {
        "Run a short-lived command inside the selected folder workspace."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"command":{"type":"string"},"cwd":{"type":"string"},"timeout_seconds":{"type":"integer"}},"required":["command"]})
    }
    fn domain(&self) -> &str {
        "desktop"
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let command = require_str(&input, "command")?;
        let root = selected_folder_workspace(services)?;
        let cwd = input
            .get("cwd")
            .and_then(Value::as_str)
            .map(|value| services.folder_workspace_path(value))
            .unwrap_or_else(|| root.to_path_buf());
        services.ensure_folder_workspace_path(&cwd)?;
        run_shell(
            command,
            &cwd,
            input.get("timeout_seconds").and_then(Value::as_u64),
        )
        .await
    }
}

pub struct GetProjectCommandStatusTool;
#[async_trait]
impl Tool for GetProjectCommandStatusTool {
    fn name(&self) -> &str {
        "get_project_command_status"
    }
    fn description(&self) -> &str {
        "Get the latest status and output for a project command."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"command_id":{"type":"string"}},"required":["command_id"]})
    }
    async fn execute(&self, input: Value, _services: &ToolServices) -> Result<Value> {
        let id = require_str(&input, "command_id")?;
        Ok(command_history()
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .unwrap_or_else(|| json!({"error": "command not found", "command_id": id})))
    }
}

pub struct GetWorkspaceCommandStatusTool;
#[async_trait]
impl Tool for GetWorkspaceCommandStatusTool {
    fn name(&self) -> &str {
        "get_workspace_command_status"
    }
    fn description(&self) -> &str {
        "Get the latest status and output for a workspace command."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"command_id":{"type":"string"}},"required":["command_id"]})
    }
    async fn execute(&self, input: Value, _services: &ToolServices) -> Result<Value> {
        let id = require_str(&input, "command_id")?;
        Ok(command_history()
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .unwrap_or_else(|| json!({"error": "command not found", "command_id": id})))
    }
}

pub struct LocalReadFileTool;
#[async_trait]
impl Tool for LocalReadFileTool {
    fn name(&self) -> &str {
        "local_read_file"
    }
    fn description(&self) -> &str {
        "Read a file from the user's local computer."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"file_path":{"type":"string"},"encoding":{"type":"string"}},"required":["file_path"]})
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, _services: &ToolServices) -> Result<Value> {
        let path = PathBuf::from(require_str(&input, "file_path")?).canonicalize()?;
        let meta = tokio::fs::metadata(&path).await?;
        anyhow::ensure!(meta.is_file(), "path is not a file: {}", path.display());
        anyhow::ensure!(
            meta.len() <= MAX_FILE_BYTES,
            "file is too large (maximum 10 MB)"
        );
        let content = tokio::fs::read_to_string(&path).await?;
        let content: String = content.chars().take(100_000).collect();
        Ok(json!({"file_path": path, "size": meta.len(), "content": content}))
    }
}

pub struct LocalWriteFileTool;
#[async_trait]
impl Tool for LocalWriteFileTool {
    fn name(&self) -> &str {
        "local_write_file"
    }
    fn description(&self) -> &str {
        "Create or write a file on the user's local computer."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"file_path":{"type":"string"},"content":{"type":"string"},"office_data":{"type":"object"}},"required":["file_path"]})
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, _services: &ToolServices) -> Result<Value> {
        let path = PathBuf::from(require_str(&input, "file_path")?);
        let content = input
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "content is required; office_data is not supported by the Rust harness"
                )
            })?;
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&path, content).await?;
        Ok(json!({"success": true, "file_path": path, "size": content.len()}))
    }
}

pub struct LocalCommandTool;
#[async_trait]
impl Tool for LocalCommandTool {
    fn name(&self) -> &str {
        "local_run_command"
    }
    fn description(&self) -> &str {
        "Run a command on the local computer after user approval."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"command":{"type":"string"},"cwd":{"type":"string"},"timeout_seconds":{"type":"integer"}},"required":["command"]})
    }
    fn domain(&self) -> &str {
        "desktop"
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let cwd = input
            .get("cwd")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .unwrap_or_else(|| services.workspace.clone());
        run_shell(
            require_str(&input, "command")?,
            &cwd,
            input.get("timeout_seconds").and_then(Value::as_u64),
        )
        .await
    }
}

pub struct GlobSearchTool;
#[async_trait]
impl Tool for GlobSearchTool {
    fn name(&self) -> &str {
        "glob_search"
    }
    fn description(&self) -> &str {
        "Search for files in a managed project using glob patterns."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"project_id":{"type":"string"},"pattern":{"type":"string"},"dir_path":{"type":"string"},"max_results":{"type":"integer"}},"required":["project_id","pattern"]})
    }
    fn domain(&self) -> &str {
        "desktop"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let (id, root) = project_path(&input, services)?;
        let pattern = require_str(&input, "pattern")?;
        let base = input
            .get("dir_path")
            .and_then(Value::as_str)
            .map(|value| project_relative_path(services, &id, value))
            .transpose()?
            .unwrap_or(root.clone());
        let limit = input
            .get("max_results")
            .and_then(Value::as_u64)
            .unwrap_or(100)
            .clamp(1, 500) as usize;
        let paths = worldbase_search::glob(&base, pattern, limit)?;
        let matches = paths.into_iter().map(|path| json!({"path": path.strip_prefix(&root).unwrap_or(&path).to_string_lossy().replace('\\', "/"), "size": std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0), "type": "file"})).collect::<Vec<_>>();
        Ok(
            json!({"project_id": id, "pattern": pattern, "dir_path": input.get("dir_path").and_then(Value::as_str).unwrap_or("."), "matches": matches, "total_matches": matches.len(), "truncated": matches.len() >= limit}),
        )
    }
}

pub struct GrepSearchTool;
#[async_trait]
impl Tool for GrepSearchTool {
    fn name(&self) -> &str {
        "grep_search"
    }
    fn description(&self) -> &str {
        "Search text or regular expressions inside a managed project."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"project_id":{"type":"string"},"pattern":{"type":"string"},"dir_path":{"type":"string"},"is_regexp":{"type":"boolean"},"case_sensitive":{"type":"boolean"},"max_results":{"type":"integer"},"context_lines":{"type":"integer"}},"required":["project_id","pattern"]})
    }
    fn domain(&self) -> &str {
        "desktop"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let (id, root) = project_path(&input, services)?;
        let pattern = require_str(&input, "pattern")?;
        let base = input
            .get("dir_path")
            .and_then(Value::as_str)
            .map(|value| project_relative_path(services, &id, value))
            .transpose()?
            .unwrap_or(root.clone());
        let literal = !input
            .get("is_regexp")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let limit = input
            .get("max_results")
            .and_then(Value::as_u64)
            .unwrap_or(50)
            .clamp(1, 200) as usize;
        let hits = worldbase_search::grep(&base, pattern, literal, limit)?;
        let matches = hits.into_iter().map(|hit| json!({"file": Path::new(&hit.path).strip_prefix(&root).unwrap_or(Path::new(&hit.path)).to_string_lossy().replace('\\', "/"), "line": hit.line, "content": hit.text, "context_before": [], "context_after": []})).collect::<Vec<_>>();
        Ok(
            json!({"project_id": id, "pattern": pattern, "dir_path": input.get("dir_path").and_then(Value::as_str).unwrap_or("."), "output_mode": "content", "case_sensitive": input.get("case_sensitive").and_then(Value::as_bool).unwrap_or(true), "matches": matches, "total_matches": matches.len(), "files_searched": 0, "files_matched": 0, "truncated": matches.len() >= limit}),
        )
    }
}

pub struct RunProjectCommandTool;
#[async_trait]
impl Tool for RunProjectCommandTool {
    fn name(&self) -> &str {
        "run_project_command"
    }
    fn description(&self) -> &str {
        "Run a short-lived diagnostic command inside a managed project."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"project_id":{"type":"string"},"command":{"type":"string"},"cwd":{"type":"string"},"timeout":{"type":"integer"}},"required":["project_id","command"]})
    }
    fn domain(&self) -> &str {
        "desktop"
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let (id, root) = project_path(&input, services)?;
        let cwd = input
            .get("cwd")
            .and_then(Value::as_str)
            .map(|value| project_relative_path(services, &id, value))
            .transpose()?
            .unwrap_or(root.clone());
        let command = require_str(&input, "command")?;
        let result = run_shell(command, &cwd, input.get("timeout").and_then(Value::as_u64)).await?;
        let command_id = format!("project-command-{}", uuid::Uuid::new_v4());
        let mut output = result.clone();
        if let Value::Object(map) = &mut output {
            map.insert("project_id".into(), json!(id));
            map.insert("command_id".into(), json!(command_id));
            map.insert("command".into(), json!(command));
        }
        command_history()
            .lock()
            .unwrap()
            .insert(command_id, output.clone());
        Ok(output)
    }
}

// -------------------------------------------------------------------------
// Project APIs, database and lifecycle

pub struct CallProjectApiTool;
#[async_trait]
impl Tool for CallProjectApiTool {
    fn name(&self) -> &str {
        "call_project_api"
    }
    fn description(&self) -> &str {
        "Call a running HTTP API exposed by a project."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"project_id":{"type":"string"},"method":{"type":"string","enum":["GET","POST","PUT","DELETE"]},"path":{"type":"string"},"body":{"type":"object"}},"required":["project_id","method","path"]})
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let (id, _) = project_path(&input, services)?;
        let status = services.projects.status(&id).await?;
        let base = status
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("project server is not running"))?;
        let path = require_str(&input, "path")?;
        anyhow::ensure!(path.starts_with('/'), "path must start with '/'");
        let method = require_str(&input, "method")?.to_uppercase();
        let client = reqwest::Client::new();
        let mut request = match method.as_str() {
            "GET" => client.get(format!("{base}{path}")),
            "POST" => client.post(format!("{base}{path}")),
            "PUT" => client.put(format!("{base}{path}")),
            "DELETE" => client.delete(format!("{base}{path}")),
            _ => anyhow::bail!("unsupported method: {method}"),
        };
        if let Some(body) = input.get("body") {
            request = request.json(body);
        }
        let response = request.timeout(Duration::from_secs(30)).send().await?;
        let status_code = response.status().as_u16();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let text = response.text().await?;
        let body = if content_type.contains("json") {
            serde_json::from_str(&text).unwrap_or_else(|_| json!(text))
        } else {
            json!(text)
        };
        Ok(
            json!({"project_id": id, "status": status_code, "ok": (200..300).contains(&status_code), "body": body}),
        )
    }
}

fn find_database(
    services: &ToolServices,
    project_id: &str,
    requested: Option<&str>,
) -> Result<PathBuf> {
    if let Some(path) = requested {
        let path = project_relative_path(services, project_id, path)?;
        anyhow::ensure!(path.is_file(), "database file not found");
        return Ok(path);
    }
    for candidate in [
        "data.db",
        "database.sqlite",
        "data.sqlite",
        ".worldbase/data.db",
        ".worldbase/db.sqlite",
    ] {
        let path = project_relative_path(services, project_id, candidate)?;
        if path.is_file() {
            return Ok(path);
        }
    }
    anyhow::bail!("no project database found; pass database_path")
}

fn sqlite_value(value: rusqlite::types::ValueRef<'_>) -> Value {
    use rusqlite::types::ValueRef;
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(s) => Value::String(String::from_utf8_lossy(s).into_owned()),
        ValueRef::Blob(bytes) => Value::String(format!(
            "base64:{}",
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes)
        )),
    }
}

pub struct QueryProjectDatabaseTool;
#[async_trait]
impl Tool for QueryProjectDatabaseTool {
    fn name(&self) -> &str {
        "query_project_database"
    }
    fn description(&self) -> &str {
        "Run a read-only SQL query against a project database."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"project_id":{"type":"string"},"sql":{"type":"string"},"database_path":{"type":"string"}},"required":["project_id","sql"]})
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let (id, _root) = project_path(&input, services)?;
        let sql = require_str(&input, "sql")?.trim().to_string();
        let lower = sql.to_ascii_lowercase();
        anyhow::ensure!(
            lower.starts_with("select ")
                || lower.starts_with("select\n")
                || lower.starts_with("with ")
                || lower.starts_with("pragma ")
                || lower.starts_with("explain "),
            "only read-only SQL is allowed"
        );
        let db = find_database(
            services,
            &id,
            input.get("database_path").and_then(Value::as_str),
        )?;
        let conn =
            rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let mut stmt = conn.prepare(&sql)?;
        let names = stmt
            .column_names()
            .into_iter()
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        let mut rows = Vec::new();
        let mut query = stmt.query([])?;
        while let Some(row) = query.next()? {
            let mut object = serde_json::Map::new();
            for (index, name) in names.iter().enumerate() {
                object.insert(name.clone(), sqlite_value(row.get_ref(index)?));
            }
            rows.push(Value::Object(object));
            if rows.len() >= 1_000 {
                break;
            }
        }
        Ok(json!({"project_id": id, "rowCount": rows.len(), "rows": rows}))
    }
}

pub struct AnalyzeProjectDataTool;
#[async_trait]
impl Tool for AnalyzeProjectDataTool {
    fn name(&self) -> &str {
        "analyze_project_data"
    }
    fn description(&self) -> &str {
        "Inspect the schema and basic statistics of a project database."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"project_id":{"type":"string"},"analysis_type":{"type":"string"},"database_path":{"type":"string"}},"required":["project_id","analysis_type"]})
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let (id, _root) = project_path(&input, services)?;
        let db = find_database(
            services,
            &id,
            input.get("database_path").and_then(Value::as_str),
        )?;
        let conn =
            rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")?;
        let tables = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .filter_map(|v| v.ok())
            .collect::<Vec<_>>();
        let mut stats = Vec::new();
        for table in &tables {
            if !table.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                continue;
            }
            let sql = format!("SELECT COUNT(*) FROM \"{table}\"");
            let count: i64 = conn.query_row(&sql, [], |row| row.get(0)).unwrap_or(0);
            stats.push(json!({"table": table, "rowCount": count}));
        }
        Ok(
            json!({"project_id": id, "analysis_type": input["analysis_type"], "database": db, "tables": stats}),
        )
    }
}

async fn project_build(input: &Value, services: &ToolServices, finalize: bool) -> Result<Value> {
    let (id, root) = project_path(input, services)?;
    let clean = input
        .get("clean_install")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut commands = Vec::new();
    if clean {
        commands.push("rm -rf node_modules .next".to_string());
    }
    if clean || !root.join("node_modules").is_dir() {
        commands.push("npm install".to_string());
    }
    commands.push("npm run build".to_string());
    let mut results = Vec::new();
    for command in commands {
        results.push(
            json!({"command": command, "result": run_shell(&command, &root, Some(180)).await?}),
        );
    }
    let server = services.projects.start_dev(&id).await.ok();
    if finalize {
        if input
            .get("cleanup_dependencies")
            .and_then(Value::as_bool)
            .unwrap_or(true)
        {
            let _ = tokio::fs::remove_dir_all(root.join("node_modules")).await;
        }
        if input
            .get("cleanup_build_cache")
            .and_then(Value::as_bool)
            .unwrap_or(true)
        {
            let _ = tokio::fs::remove_dir_all(root.join(".next/cache")).await;
        }
    }
    Ok(
        json!({"success": true, "project_id": id, "commands": results, "runtime": server, "finalized": finalize}),
    )
}

pub struct RebuildProjectTool;
#[async_trait]
impl Tool for RebuildProjectTool {
    fn name(&self) -> &str {
        "rebuild_project"
    }
    fn description(&self) -> &str {
        "Rebuild and restart a project."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"project_id":{"type":"string"},"clean_install":{"type":"boolean"},"cleanup_dependencies_after_success":{"type":"boolean"},"cleanup_build_cache_after_success":{"type":"boolean"}},"required":["project_id"]})
    }
    fn domain(&self) -> &str {
        "desktop"
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        project_build(&input, services, false).await
    }
}

pub struct FinalizeProjectTool;
#[async_trait]
impl Tool for FinalizeProjectTool {
    fn name(&self) -> &str {
        "finalize_project"
    }
    fn description(&self) -> &str {
        "Rebuild a project and reclaim dependency/cache disk space."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"project_id":{"type":"string"},"clean_install":{"type":"boolean"},"cleanup_dependencies":{"type":"boolean"},"cleanup_build_cache":{"type":"boolean"}},"required":["project_id"]})
    }
    fn domain(&self) -> &str {
        "desktop"
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        project_build(&input, services, true).await
    }
}

pub struct ClearProjectBuildFlagTool;
#[async_trait]
impl Tool for ClearProjectBuildFlagTool {
    fn name(&self) -> &str {
        "clear_project_build_flag"
    }
    fn description(&self) -> &str {
        "Re-sync a project's build state from disk."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"project_id":{"type":"string"}},"required":["project_id"]})
    }
    fn domain(&self) -> &str {
        "desktop"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let (id, root) = project_path(&input, services)?;
        Ok(
            json!({"success": true, "project_id": id, "node_modules_present": root.join("node_modules").is_dir(), "build_present": root.join(".next").is_dir()}),
        )
    }
}

pub struct GetProjectLogsTool;

fn select_recent_project_logs(
    mut logs: Vec<worldbase_project_runtime::ProjectRuntimeLogEntry>,
    log_type: &str,
    requested_lines: usize,
) -> Vec<worldbase_project_runtime::ProjectRuntimeLogEntry> {
    if log_type != "all" {
        logs.retain(|entry| entry.kind == log_type);
    }
    let skip = logs.len().saturating_sub(requested_lines);
    logs.drain(..skip);
    logs
}

#[async_trait]
impl Tool for GetProjectLogsTool {
    fn name(&self) -> &str {
        "get_project_logs"
    }
    fn description(&self) -> &str {
        "Read recent project runtime logs."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"project_id":{"type":"string"},"lines":{"type":"integer"},"type":{"type":"string","enum":["stdout","stderr","all"]}},"required":["project_id"]})
    }
    fn domain(&self) -> &str {
        "desktop"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let (id, _) = project_path(&input, services)?;
        let requested_lines = input
            .get("lines")
            .and_then(Value::as_u64)
            .unwrap_or(50)
            .clamp(1, 200) as usize;
        let log_type = input.get("type").and_then(Value::as_str).unwrap_or("all");
        anyhow::ensure!(
            matches!(log_type, "stdout" | "stderr" | "all"),
            "type must be stdout, stderr, or all"
        );
        let candidate_entries = requested_lines * if log_type == "all" { 1 } else { 3 };
        let logs = select_recent_project_logs(
            services.projects.logs(&id, candidate_entries).await,
            log_type,
            requested_lines,
        );
        Ok(json!({
            "project_id": id,
            "type": log_type,
            "lines": requested_lines,
            "logs": logs,
        }))
    }
}

#[cfg(test)]
mod get_project_logs_tests {
    use super::*;
    use worldbase_project_runtime::ProjectRuntimeLogEntry;

    fn entry(kind: &str, text: &str, time: u64) -> ProjectRuntimeLogEntry {
        ProjectRuntimeLogEntry {
            kind: kind.into(),
            text: text.into(),
            time,
        }
    }

    #[test]
    fn filters_stdout_stderr_and_all_logs_like_electron() {
        let logs = vec![
            entry("stdout", "first stdout", 1),
            entry("stderr", "first stderr", 2),
            entry("stdout", "last stdout", 3),
            entry("stderr", "last stderr", 4),
        ];

        let stdout = select_recent_project_logs(logs.clone(), "stdout", 1);
        assert_eq!(stdout, vec![entry("stdout", "last stdout", 3)]);

        let stderr = select_recent_project_logs(logs.clone(), "stderr", 2);
        assert_eq!(
            stderr,
            vec![
                entry("stderr", "first stderr", 2),
                entry("stderr", "last stderr", 4),
            ]
        );

        let all = select_recent_project_logs(logs, "all", 2);
        assert_eq!(
            all,
            vec![
                entry("stdout", "last stdout", 3),
                entry("stderr", "last stderr", 4),
            ]
        );
    }
}

pub struct OpenProjectAppTool;
#[async_trait]
impl Tool for OpenProjectAppTool {
    fn name(&self) -> &str {
        "open_project_app"
    }
    fn description(&self) -> &str {
        "Open a managed project in the Electron shell."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"project_id":{"type":"string"}},"required":["project_id"]})
    }
    fn domain(&self) -> &str {
        "desktop"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let id = require_str(&input, "project_id")?;
        let stream = services.current_stream.lock().unwrap().clone();
        services
            .host
            .request(
                &stream,
                "open_project_app",
                json!({"projectId": id}),
                Duration::from_secs(30),
            )
            .await
    }
}

// -------------------------------------------------------------------------
// Plan, todo, skills, MCP and Agent Workspace

pub struct EnterPlanModeTool;
#[async_trait]
impl Tool for EnterPlanModeTool {
    fn name(&self) -> &str {
        "enter_plan_mode"
    }
    fn description(&self) -> &str {
        "Enter planning mode for a multi-step task."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"goal":{"type":"string"}},"required":["goal"]})
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let goal = require_str(&input, "goal")?;
        if !services.enter_plan_mode(goal) {
            return Ok(json!({
                "success": false,
                "planning": true,
                "message": "已经处于规划模式中。请先退出当前规划模式再重新进入。"
            }));
        }
        Ok(json!({
            "success": true,
            "planning": true,
            "goal": goal,
            "message": format!("已进入规划模式。目标: {goal}")
        }))
    }
}

pub struct ExitPlanModeTool;
#[async_trait]
impl Tool for ExitPlanModeTool {
    fn name(&self) -> &str {
        "exit_plan_mode"
    }
    fn description(&self) -> &str {
        "Exit planning mode and begin execution."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"plan_summary":{"type":"string"},"steps":{"type":"array","items":{"type":"object"}}},"required":["plan_summary","steps"]})
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let summary = require_str(&input, "plan_summary")?;
        let steps = input
            .get("steps")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow::anyhow!("steps must be an array"))?;
        anyhow::ensure!(!steps.is_empty(), "steps must contain at least one entry");
        if !services.exit_plan_mode() {
            return Ok(json!({
                "success": false,
                "planning": false,
                "message": "当前不在规划模式中。"
            }));
        }
        Ok(json!({
            "success": true,
            "planning": false,
            "plan_summary": summary,
            "steps": steps
        }))
    }
}

pub struct ManageTodoListTool;
#[async_trait]
impl Tool for ManageTodoListTool {
    fn name(&self) -> &str {
        "manage_todo_list"
    }
    fn description(&self) -> &str {
        "Create or replace the working todo list for the current task."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"items":{"type":"array","items":{"type":"object","properties":{"id":{"type":"integer"},"title":{"type":"string"},"status":{"type":"string","enum":["not-started","in-progress","completed"]}},"required":["id","title","status"]}}},"required":["items"]})
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let items = input
            .get("items")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow::anyhow!("items must be an array"))?;
        let mut seen = std::collections::HashSet::new();
        let mut active = 0;
        for item in items {
            let id = item
                .get("id")
                .and_then(Value::as_i64)
                .ok_or_else(|| anyhow::anyhow!("todo id must be an integer"))?;
            anyhow::ensure!(
                id > 0 && seen.insert(id),
                "todo ids must be unique positive integers"
            );
            anyhow::ensure!(
                item.get("title")
                    .and_then(Value::as_str)
                    .map(|s| !s.trim().is_empty())
                    .unwrap_or(false),
                "todo title is required"
            );
            match item.get("status").and_then(Value::as_str) {
                Some("not-started") | Some("completed") => {}
                Some("in-progress") => active += 1,
                _ => anyhow::bail!("invalid todo status"),
            }
        }
        anyhow::ensure!(active <= 1, "at most one todo item can be in-progress");
        *services.todo_items.lock().unwrap() = items.clone();
        let completed = items
            .iter()
            .filter(|item| item["status"] == "completed")
            .count();
        Ok(
            json!({"success": true, "items": items, "summary": format!("共 {} 项，已完成 {} 项，进行中 {} 项", items.len(), completed, active)}),
        )
    }
}

pub struct InstallSkillTool;
#[async_trait]
impl Tool for InstallSkillTool {
    fn name(&self) -> &str {
        "install_skill"
    }
    fn description(&self) -> &str {
        "Install a skill into the harness skill registry."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"name":{"type":"string"},"description":{"type":"string"},"content":{"type":"string"},"instructions":{"type":"string"}},"required":["name"]})
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, _services: &ToolServices) -> Result<Value> {
        let name = require_str(&input, "name")?;
        let safe: String = name
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '-'
                }
            })
            .collect();
        anyhow::ensure!(!safe.is_empty(), "name is required");
        let instructions = input
            .get("content")
            .or_else(|| input.get("instructions"))
            .and_then(Value::as_str)
            .unwrap_or("");
        anyhow::ensure!(
            !instructions.trim().is_empty(),
            "content or instructions is required"
        );
        let value = json!({"name": safe, "description": input.get("description").and_then(Value::as_str).unwrap_or(""), "instructions": instructions});
        let dir = worldbase_skills::worldbase_default_skills_dir();
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(format!("{safe}.yaml"));
        std::fs::write(&path, serde_yaml::to_string(&value)?)?;
        Ok(json!({"success": true, "skill": {"name": safe, "path": path}}))
    }
}

pub struct CreateScheduledTaskTool;
#[async_trait]
impl Tool for CreateScheduledTaskTool {
    fn name(&self) -> &str {
        "create_scheduled_task"
    }
    fn description(&self) -> &str {
        "Create a persistent scheduled AI task."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"title":{"type":"string"},"prompt":{"type":"string"},"schedule_kind":{"type":"string","enum":["once","interval","daily","weekly","dates"]},"run_at":{"type":"string"},"every_minutes":{"type":"integer"},"time_of_day":{"type":"string"},"weekdays":{"type":"array"},"dates":{"type":"array"},"enabled":{"type":"boolean"}},"required":["prompt","schedule_kind"]})
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let prompt = require_str(&input, "prompt")?;
        let kind = require_str(&input, "schedule_kind")?;
        let cron = match kind {
            "daily" => format!(
                "{} {} * * *",
                input
                    .get("time_of_day")
                    .and_then(Value::as_str)
                    .unwrap_or("09:00")
                    .split(':')
                    .nth(1)
                    .unwrap_or("00"),
                input
                    .get("time_of_day")
                    .and_then(Value::as_str)
                    .unwrap_or("09:00")
                    .split(':')
                    .next()
                    .unwrap_or("09")
            ),
            "weekly" => {
                let weekdays = input
                    .get("weekdays")
                    .and_then(Value::as_array)
                    .map(|v| {
                        v.iter()
                            .filter_map(Value::as_u64)
                            .map(|n| n.to_string())
                            .collect::<Vec<_>>()
                            .join(",")
                    })
                    .unwrap_or_else(|| "1".into());
                format!(
                    "{} {} * * {}",
                    input
                        .get("time_of_day")
                        .and_then(Value::as_str)
                        .unwrap_or("09:00")
                        .split(':')
                        .nth(1)
                        .unwrap_or("00"),
                    input
                        .get("time_of_day")
                        .and_then(Value::as_str)
                        .unwrap_or("09:00")
                        .split(':')
                        .next()
                        .unwrap_or("09"),
                    weekdays
                )
            }
            "interval" => format!(
                "*/{} * * * *",
                input
                    .get("every_minutes")
                    .and_then(Value::as_u64)
                    .unwrap_or(60)
                    .clamp(1, 59)
            ),
            _ => "0 9 * * *".into(),
        };
        let name = input
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("AI scheduled task");
        let entry = services.scheduler.create(name, &cron, prompt)?;
        Ok(json!({"success": true, "task": entry}))
    }
}

pub struct ListScheduledTasksTool;
#[async_trait]
impl Tool for ListScheduledTasksTool {
    fn name(&self) -> &str {
        "list_scheduled_tasks"
    }
    fn description(&self) -> &str {
        "List all saved scheduled AI tasks."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{}})
    }
    async fn execute(&self, _input: Value, services: &ToolServices) -> Result<Value> {
        Ok(json!({"tasks": services.scheduler.list()?}))
    }
}

pub struct InstallMcpServerTool;
#[async_trait]
impl Tool for InstallMcpServerTool {
    fn name(&self) -> &str {
        "install_mcp_server"
    }
    fn description(&self) -> &str {
        "Install or update an MCP server configuration."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"server_id":{"type":"string","description":"Electron durable MCP server ID. Falls back to name for compatibility."},"name":{"type":"string","description":"Human-facing MCP server name."},"display_name":{"type":"string"},"displayName":{"type":"string"},"enabled":{"type":"boolean"},"transport":{"type":"string","enum":["stdio","streamable-http","sse"]},"command":{"type":"string"},"args":{"type":"array","items":{"type":"string"}},"cwd":{"type":"string"},"env":{"type":"object"},"headers":{"type":"object"},"timeout_ms":{"type":"integer"},"timeoutMs":{"type":"integer"},"url":{"type":"string"}},"required":["name","transport"]})
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let display_name = require_str(&input, "name")?.to_string();
        // Electron uses an opaque durable ID to address MCP permissions and
        // dynamic tool names. Keep it as Rust's connection name, while the
        // user-facing `name` remains a display label.
        let server_id = input
            .get("server_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(&display_name)
            .to_string();
        let transport = require_str(&input, "transport")?;
        let target = if transport == "stdio" {
            require_str(&input, "command")?.to_string()
        } else {
            require_str(&input, "url")?.to_string()
        };
        let config = worldbase_mcp_client::McpServerConfig {
            name: server_id.clone(),
            display_name: input
                .get("display_name")
                .or_else(|| input.get("displayName"))
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(&display_name)
                .to_string(),
            transport: transport.into(),
            target,
            args: input
                .get("args")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(ToOwned::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
            cwd: input
                .get("cwd")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            env: input
                .get("env")
                .and_then(Value::as_object)
                .map(|map| {
                    map.iter()
                        .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string()))
                        .collect()
                })
                .unwrap_or_default(),
            headers: input
                .get("headers")
                .and_then(Value::as_object)
                .map(|map| {
                    map.iter()
                        .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string()))
                        .collect()
                })
                .unwrap_or_default(),
            timeout_ms: input
                .get("timeout_ms")
                .or_else(|| input.get("timeoutMs"))
                .and_then(Value::as_u64),
            enabled: input
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
        };
        let mut configs: Vec<worldbase_mcp_client::McpServerConfig> = services
            .store
            .get_setting("mcpServers")?
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default();
        configs.retain(|entry| entry.name != server_id);
        configs.push(config.clone());
        services
            .store
            .set_setting("mcpServers", &serde_json::to_value(&configs)?)?;
        services.mcp.configure(configs).await;
        Ok(json!({"success": true, "server_id": server_id, "server": config}))
    }
}

pub struct ListAgentWorkspaceCatalogTool;
#[async_trait]
impl Tool for ListAgentWorkspaceCatalogTool {
    fn name(&self) -> &str {
        "list_agent_workspace_catalog"
    }
    fn description(&self) -> &str {
        "List providers, skills, existing agents and existing agent groups before creating Agent Workspace entities."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{}})
    }
    async fn execute(&self, _input: Value, services: &ToolServices) -> Result<Value> {
        Ok(
            json!({"providers": services.store.get_setting("providers")?.unwrap_or_else(|| json!({"providers":[]})), "skills": services.skills.list()?, "agents": services.store.list_agents()?, "groups": services.store.get_setting("agent_groups")?.unwrap_or_else(|| json!([]))}),
        )
    }
}

pub struct CreateAgentTool;
#[async_trait]
impl Tool for CreateAgentTool {
    fn name(&self) -> &str {
        "create_agent"
    }
    fn description(&self) -> &str {
        "Create or update a custom Agent Workspace agent. Use list_agent_workspace_catalog first to choose valid provider, model and skill IDs."
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Optional existing agent ID to update."},
                "name": {"type": "string", "description": "Agent display name."},
                "description": {"type": "string", "description": "Short description of the agent role."},
                "system_prompt": {"type": "string", "description": "System prompt for the agent."},
                "provider_id": {"type": "string", "description": "Provider ID from list_agent_workspace_catalog."},
                "model_id": {"type": "string", "description": "Model ID under the selected provider."},
                "reasoning_strength": {"type": "string", "enum": ["low", "medium", "high", "max"]},
                "skill_ids": {"type": "array", "items": {"type": "string"}},
                "allowed_tools": {"type": "array", "items": {"type": "string"}},
                "denied_tools": {"type": "array", "items": {"type": "string"}},
                "memory_scopes": {
                    "type": "array",
                    "items": {"type": "string", "enum": ["user", "agent", "project", "group", "channel"]}
                },
                "allow_user_traits": {"type": "boolean"},
                "allow_agent_skills": {"type": "boolean"},
                "allow_steps": {"type": "boolean"},
                "allow_knowledge": {"type": "boolean"},
                "auto_reply_enabled": {"type": "boolean"},
                "auto_reply_require_mention": {"type": "boolean"}
            },
            "required": ["name", "system_prompt"],
            "additionalProperties": false
        })
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let now = worldbase_protocol::event::now_rfc3339();
        let id = input
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "")
            .to_string();
        let id = if id.is_empty() {
            uuid::Uuid::new_v4().to_string()
        } else {
            id
        };
        let existing = services.store.get_agent(&id)?;
        let agent = worldbase_protocol::types::AgentDefinition {
            id: id.clone(),
            name: require_str(&input, "name")?.to_string(),
            icon: input
                .get("icon")
                .and_then(Value::as_str)
                .unwrap_or("")
                .into(),
            description: input
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .into(),
            system_prompt: require_str(&input, "system_prompt")?.into(),
            provider_id: input
                .get("provider_id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            model_id: input
                .get("model_id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            skill_ids: input
                .get("skill_ids")
                .and_then(Value::as_array)
                .map(|v| {
                    v.iter()
                        .filter_map(Value::as_str)
                        .map(ToOwned::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
            reasoning_strength: input
                .get("reasoning_strength")
                .or_else(|| input.get("reasoningStrength"))
                .and_then(Value::as_str)
                .filter(|value| matches!(*value, "low" | "medium" | "high" | "max"))
                .unwrap_or("medium")
                .into(),
            allowed_tools: input
                .get("allowed_tools")
                .or_else(|| input.get("allowedTools"))
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(ToOwned::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
            denied_tools: input
                .get("denied_tools")
                .or_else(|| input.get("deniedTools"))
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(ToOwned::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
            memory_scopes: input
                .get("memory_scopes")
                .or_else(|| input.get("memoryScopes"))
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(ToOwned::to_owned)
                        .collect()
                })
                .unwrap_or_else(|| vec!["user".into(), "agent".into(), "project".into()]),
            memory_write_policy: input
                .get("memory_write_policy")
                .or_else(|| input.get("memoryWritePolicy"))
                .cloned()
                .and_then(|value| serde_json::from_value(value).ok())
                .unwrap_or_else(|| worldbase_protocol::types::AgentMemoryWritePolicy {
                    allow_user_traits: input
                        .get("allow_user_traits")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                    allow_agent_skills: input
                        .get("allow_agent_skills")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                    allow_steps: input
                        .get("allow_steps")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                    allow_knowledge: input
                        .get("allow_knowledge")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                }),
            auto_reply_policy: input
                .get("auto_reply_policy")
                .or_else(|| input.get("autoReplyPolicy"))
                .cloned()
                .and_then(|value| serde_json::from_value(value).ok())
                .unwrap_or_else(|| worldbase_protocol::types::AgentAutoReplyPolicy {
                    enabled: input
                        .get("auto_reply_enabled")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    require_mention: input
                        .get("auto_reply_require_mention")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                }),
            created_at: existing
                .as_ref()
                .map(|a| a.created_at.clone())
                .unwrap_or_else(|| now.clone()),
            updated_at: now,
        };
        services.store.upsert_agent(&agent)?;
        Ok(json!({"success": true, "agent": agent}))
    }
}

pub struct CreateAgentGroupTool;
#[async_trait]
impl Tool for CreateAgentGroupTool {
    fn name(&self) -> &str {
        "create_agent_group"
    }
    fn description(&self) -> &str {
        "Create or update an Agent Workspace group."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"id":{"type":"string"},"name":{"type":"string"},"description":{"type":"string"},"coordinator_agent_id":{"type":"string"},"member_agent_ids":{"type":"array","items":{"type":"string"}},"max_rounds":{"type":"integer"},"max_parallel_workers":{"type":"integer"},"shared_memory_scopes":{"type":"array","items":{"type":"string"}},"visibility":{"type":"string"}},"required":["name","coordinator_agent_id","member_agent_ids"]})
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let name = require_str(&input, "name")?.trim().to_string();
        let coordinator = require_str(&input, "coordinator_agent_id")?
            .trim()
            .to_string();
        let mut member_ids = Vec::new();
        let mut seen = std::collections::HashSet::new();
        if let Some(values) = input.get("member_agent_ids").and_then(Value::as_array) {
            for value in values {
                let Some(id) = value.as_str().map(str::trim).filter(|id| !id.is_empty()) else {
                    continue;
                };
                if seen.insert(id.to_string()) {
                    member_ids.push(id.to_string());
                }
            }
        }
        if name.is_empty() || coordinator.is_empty() || member_ids.is_empty() {
            return Ok(
                json!({"error": "name, coordinator_agent_id, and member_agent_ids are required."}),
            );
        }
        let known_agents: std::collections::HashSet<String> = services
            .store
            .list_agents()?
            .into_iter()
            .map(|agent| agent.id)
            .collect();
        if !known_agents.contains(&coordinator) {
            return Ok(json!({"error": format!("Unknown coordinator_agent_id: {coordinator}")}));
        }
        let invalid = member_ids
            .iter()
            .filter(|id| !known_agents.contains(*id))
            .cloned()
            .collect::<Vec<_>>();
        if !invalid.is_empty() {
            return Ok(
                json!({"error": format!("Unknown member_agent_ids: {}", invalid.join(", "))}),
            );
        }

        // Electron always includes the coordinator first and de-duplicates
        // the member list before handing it to AgentGroupStore.save().
        member_ids.retain(|id| id != &coordinator);
        member_ids.insert(0, coordinator.clone());
        let mut groups = services.store.get_agent_groups_setting()?;
        let requested_id = input
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(ToOwned::to_owned);
        let id = requested_id.unwrap_or_else(|| agent_group_id_from_name(&name));
        let id = sanitize_agent_group_id(&id);
        let id = if id.is_empty() {
            agent_group_id_from_name(&name)
        } else {
            id
        };
        let existing = groups
            .iter()
            .find(|group| group.get("id").and_then(Value::as_str) == Some(id.as_str()));
        let now = worldbase_protocol::event::now_rfc3339();
        let created_at = existing
            .and_then(|group| group.get("createdAt").and_then(Value::as_str))
            .unwrap_or(&now)
            .to_string();
        let max_rounds = input
            .get("max_rounds")
            .and_then(|value| value.as_f64())
            .or_else(|| existing.and_then(|group| group.get("maxRounds").and_then(Value::as_f64)))
            .filter(|value| value.is_finite() && *value != 0.0)
            .unwrap_or(2.0)
            .clamp(1.0, 5.0)
            .floor() as u32;
        let max_parallel_workers = input
            .get("max_parallel_workers")
            .and_then(|value| value.as_f64())
            .or_else(|| {
                existing.and_then(|group| group.get("maxParallelWorkers").and_then(Value::as_f64))
            })
            .filter(|value| value.is_finite() && *value != 0.0)
            .unwrap_or(2.0)
            .clamp(1.0, 5.0)
            .floor() as u32;
        let mut scopes = Vec::new();
        if let Some(values) = input.get("shared_memory_scopes").and_then(Value::as_array) {
            for value in values {
                let Some(scope) = value
                    .as_str()
                    .map(str::trim)
                    .filter(|scope| matches!(*scope, "group" | "project" | "channel"))
                else {
                    continue;
                };
                if !scopes.iter().any(|existing| existing == scope) {
                    scopes.push(scope.to_string());
                }
            }
        }
        if scopes.is_empty() {
            scopes = existing
                .and_then(|group| group.get("sharedMemoryScopes").and_then(Value::as_array))
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(ToOwned::to_owned)
                        .collect()
                })
                .unwrap_or_default();
        }
        if scopes.is_empty() {
            scopes.push("group".into());
        }
        let visibility = if input.get("visibility").and_then(Value::as_str)
            == Some("expandable_internal_transcript")
        {
            "expandable_internal_transcript"
        } else {
            existing
                .and_then(|group| group.get("visibility").and_then(Value::as_str))
                .unwrap_or("summary_only")
        };
        let description = input
            .get("description")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or_else(|| existing.and_then(|group| group.get("description").and_then(Value::as_str)))
            .unwrap_or_default();
        let group = json!({"id": id, "name": name, "description": description, "coordinatorAgentId": coordinator, "memberAgentIds": member_ids, "maxRounds": max_rounds, "maxParallelWorkers": max_parallel_workers, "sharedMemoryScopes": scopes, "visibility": visibility, "createdAt": created_at, "updatedAt": now});
        groups.retain(|item| item.get("id") != group.get("id"));
        groups.push(group.clone());
        services.store.set_agent_groups_setting(&groups)?;
        Ok(
            json!({"success": true, "group": group, "message": format!("Agent 群组 {} 已保存。", group["name"].as_str().unwrap_or_default())}),
        )
    }
}

// -------------------------------------------------------------------------
// Async tasks, host page helpers and image tools

static ASYNC_TASKS: OnceLock<Mutex<HashMap<String, Value>>> = OnceLock::new();
fn async_tasks() -> &'static Mutex<HashMap<String, Value>> {
    ASYNC_TASKS.get_or_init(|| Mutex::new(HashMap::new()))
}
static COMMAND_HISTORY: OnceLock<Mutex<HashMap<String, Value>>> = OnceLock::new();
fn command_history() -> &'static Mutex<HashMap<String, Value>> {
    COMMAND_HISTORY.get_or_init(|| Mutex::new(HashMap::new()))
}

pub struct StartAsyncTaskTool;
#[async_trait]
impl Tool for StartAsyncTaskTool {
    fn name(&self) -> &str {
        "start_async_task"
    }
    fn description(&self) -> &str {
        "Start a long-running async project task."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"project_id":{"type":"string"},"task":{"type":"string","enum":["rebuild"]}},"required":["project_id","task"]})
    }
    fn domain(&self) -> &str {
        "desktop"
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let project = require_str(&input, "project_id")?.to_string();
        anyhow::ensure!(
            input.get("task").and_then(Value::as_str) == Some("rebuild"),
            "only rebuild async task is supported"
        );
        let id = uuid::Uuid::new_v4().to_string();
        let snapshot = json!({"task_id": id, "project_id": project, "task": "rebuild", "status": "running", "progress": 0});
        async_tasks()
            .lock()
            .unwrap()
            .insert(id.clone(), snapshot.clone());
        let hub = services.projects.clone();
        let tasks = async_tasks();
        tokio::spawn(async move {
            let result = async {
                let projects = hub.list_projects()?;
                let p = projects
                    .iter()
                    .find(|p| p.id == project)
                    .context("project not found")?;
                let command = shell_program("npm run build");
                let req = worldbase_exec::ExecRequest {
                    program: command.0,
                    args: command.1,
                    cwd: Some(p.path.clone()),
                    env: Default::default(),
                    timeout_secs: Some(180),
                    sandbox: true,
                };
                worldbase_exec::run(&req, Path::new(&p.path))
                    .await
                    .map(|r| serde_json::to_value(r).unwrap())
                    .map_err(anyhow::Error::from)
            }
            .await;
            let mut map = tasks.lock().unwrap();
            if let Some(value) = map.get_mut(&id) {
                value["status"] = if result.is_ok() {
                    json!("completed")
                } else {
                    json!("failed")
                };
                value["progress"] = json!(100);
                value["result"] = result.unwrap_or_else(|e| json!({"error": e.to_string()}));
            }
        });
        Ok(snapshot)
    }
}

pub struct GetTaskStatusTool;
#[async_trait]
impl Tool for GetTaskStatusTool {
    fn name(&self) -> &str {
        "get_task_status"
    }
    fn description(&self) -> &str {
        "Get the status and result of an async task."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"task_id":{"type":"string"}},"required":["task_id"]})
    }
    async fn execute(&self, input: Value, _services: &ToolServices) -> Result<Value> {
        let id = require_str(&input, "task_id")?;
        Ok(async_tasks()
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .unwrap_or_else(|| json!({"error": "async task not found", "task_id": id})))
    }
}

pub struct SpawnSubagentsTool;
#[async_trait]
impl Tool for SpawnSubagentsTool {
    fn name(&self) -> &str {
        "spawn_subagents"
    }
    fn description(&self) -> &str {
        "Spawn independent subagents in parallel when the host provides a subagent service."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"tasks":{"type":"array","items":{"type":"object"}}},"required":["tasks"]})
    }
    async fn execute(&self, _input: Value, _services: &ToolServices) -> Result<Value> {
        Ok(json!({"error": "subagent service is not available in the Rust harness"}))
    }
}

pub struct FillCurrentPageFormTool;
#[async_trait]
impl Tool for FillCurrentPageFormTool {
    fn name(&self) -> &str {
        "fill_current_page_form"
    }
    fn description(&self) -> &str {
        "Batch-fill form fields on the active in-app browser page."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"fields":{"type":"array","items":{"type":"object"}}},"required":["fields"]})
    }
    fn domain(&self) -> &str {
        "host"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let fields = input
            .get("fields")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow::anyhow!("fields must be an array"))?;
        anyhow::ensure!(!fields.is_empty(), "at least one field is required");
        let stream = services.current_stream.lock().unwrap().clone();
        let result = services
            .host
            .request(
                &stream,
                "page_automation",
                json!({"action":"interact", "actions":[{"type":"batch_input", "fields": fields}]}),
                Duration::from_secs(30),
            )
            .await?;
        Ok(json!({"ok": true, "action_result": result}))
    }
}

pub struct SaveCurrentPageAsDocumentTool;
#[async_trait]
impl Tool for SaveCurrentPageAsDocumentTool {
    fn name(&self) -> &str {
        "save_current_page_as_document"
    }
    fn description(&self) -> &str {
        "Save the active page text as a local document."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"selector":{"type":"string"},"file_name":{"type":"string"}}})
    }
    fn domain(&self) -> &str {
        "host"
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let stream = services.current_stream.lock().unwrap().clone();
        let action = json!({"type":"extract", "selector": input.get("selector").cloned().unwrap_or(Value::Null), "maxChars": 0});
        let extracted = services
            .host
            .request(
                &stream,
                "page_automation",
                json!({"action":"interact", "actions":[action]}),
                Duration::from_secs(30),
            )
            .await?;
        let text = extracted
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("active page returned no text"))?;
        let name = input
            .get("file_name")
            .and_then(Value::as_str)
            .unwrap_or("current-page")
            .replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_");
        let path = services.workspace.join(format!("{name}.txt"));
        tokio::fs::write(&path, text).await?;
        Ok(
            json!({"ok": true, "file_name": format!("{name}.txt"), "file_path": path, "total_length": text.len()}),
        )
    }
}

pub struct DocumentListTool;
#[async_trait]
impl Tool for DocumentListTool {
    fn name(&self) -> &str {
        "list_documents"
    }
    fn description(&self) -> &str {
        "List imported document artifacts."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{}})
    }
    async fn execute(&self, _input: Value, _services: &ToolServices) -> Result<Value> {
        Ok(
            json!({"documents": [], "note": "Electron document artifact store is not persisted by the Rust harness"}),
        )
    }
}

pub struct DocumentReadTool;
#[async_trait]
impl Tool for DocumentReadTool {
    fn name(&self) -> &str {
        "read_document"
    }
    fn description(&self) -> &str {
        "Read an imported document artifact."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"artifact_id":{"type":"string"},"offset":{"type":"integer"},"max_chars":{"type":"integer"}},"required":["artifact_id"]})
    }
    async fn execute(&self, input: Value, _services: &ToolServices) -> Result<Value> {
        Ok(
            json!({"error": "document artifact not found", "artifact_id": input.get("artifact_id").cloned().unwrap_or(Value::Null)}),
        )
    }
}

fn image_file_dir() -> PathBuf {
    worldbase_memory::Store::default_dir().join("image-library")
}

const MAX_IMAGE_INPUTS: usize = 4;

fn image_mime_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        _ => "image/png",
    }
}

fn image_mime_for_data_url(value: &str) -> &'static str {
    value
        .strip_prefix("data:")
        .and_then(|value| value.split_once(';').map(|(mime, _)| mime))
        .filter(|mime| mime.starts_with("image/"))
        .map(|mime| match mime {
            "image/jpeg" | "image/jpg" => "image/jpeg",
            "image/webp" => "image/webp",
            "image/gif" => "image/gif",
            "image/svg+xml" => "image/svg+xml",
            _ => "image/png",
        })
        .unwrap_or("image/png")
}

#[cfg(test)]
fn image_extension_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/svg+xml" => "svg",
        _ => "png",
    }
}

/// Keep the concrete edit inputs with the generated result. The image bytes
/// are already normalized to base64 for provider execution, so this covers
/// library IDs, local paths, and data-URL inputs with one durable path.
#[cfg(test)]
fn write_edit_source_images(
    directory: &Path,
    id: &str,
    images: &[String],
    mimes: &[String],
) -> Vec<String> {
    use base64::Engine;

    let mut names = Vec::new();
    for (index, image) in images.iter().take(MAX_IMAGE_INPUTS).enumerate() {
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(image.trim()) else {
            continue;
        };
        let mime = mimes.get(index).map(String::as_str).unwrap_or("image/png");
        let name = format!("{id}-src{}.{}", names.len(), image_extension_for_mime(mime));
        if std::fs::write(directory.join(&name), bytes).is_ok() {
            names.push(name);
        }
    }
    names
}

#[cfg(test)]
mod image_source_tests {
    use super::*;

    #[test]
    fn agent_edit_sources_are_mirrored_for_the_ts_gallery() {
        let directory =
            std::env::temp_dir().join(format!("worldbase-tool-source-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let names = write_edit_source_images(
            &directory,
            "output",
            &["aGVsbG8=".into(), "d29ybGQ=".into()],
            &["image/png".into(), "image/webp".into()],
        );

        assert_eq!(names, vec!["output-src0.png", "output-src1.webp"]);
        assert_eq!(std::fs::read(directory.join(&names[0])).unwrap(), b"hello");
        assert_eq!(std::fs::read(directory.join(&names[1])).unwrap(), b"world");
        let _ = std::fs::remove_dir_all(directory);
    }
}

fn strip_data_url(value: &str) -> &str {
    value
        .split_once(',')
        .map(|(_, payload)| payload)
        .unwrap_or(value)
}

fn push_edit_input(
    images: &mut Vec<String>,
    mimes: &mut Vec<String>,
    base64: String,
    mime: String,
) {
    if images.len() < MAX_IMAGE_INPUTS {
        images.push(base64);
        mimes.push(mime);
    }
}

fn encode_image_file(path: &Path) -> Result<(String, String)> {
    use base64::Engine;
    let bytes =
        std::fs::read(path).with_context(|| format!("read input image {}", path.display()))?;
    anyhow::ensure!(
        bytes.len() <= MAX_FILE_BYTES as usize,
        "input image is too large (max {} bytes)",
        MAX_FILE_BYTES
    );
    Ok((
        base64::engine::general_purpose::STANDARD.encode(bytes),
        image_mime_for_path(path).to_string(),
    ))
}

/// Resolve an image-library ID from either Rust's SQLite index or Electron's
/// durable `<id>.json` mirror. The two indexes can briefly be out of sync
/// while a Rust tool result is being imported, so both are intentionally read.
fn resolve_library_image(id: &str, services: &ToolServices) -> Result<Option<(String, String)>> {
    let id = id.trim();
    if id.is_empty() {
        return Ok(None);
    }
    anyhow::ensure!(
        id.len() <= 128
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'),
        "invalid image library id"
    );
    if let Some(entry) = services.store.get_image(id)? {
        let path = image_file_dir().join(&entry.file);
        if path.is_file() {
            return Ok(Some(encode_image_file(&path)?));
        }
    }

    let metadata_path = image_file_dir().join(format!("{id}.json"));
    if metadata_path.is_file() {
        let metadata: Value = serde_json::from_str(&std::fs::read_to_string(&metadata_path)?)?;
        let file_name = metadata
            .get("fileName")
            .or_else(|| metadata.get("file"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !file_name.is_empty() {
            let path = image_file_dir().join(Path::new(file_name).file_name().unwrap_or_default());
            if path.is_file() {
                return Ok(Some(encode_image_file(&path)?));
            }
        }
    }
    Ok(None)
}

/// Resolve all Electron-compatible edit input spellings.
async fn resolve_edit_inputs(
    input: &Value,
    services: &ToolServices,
) -> Result<(Vec<String>, Vec<String>)> {
    use base64::Engine;
    let mut images = Vec::new();
    let mut mimes = Vec::new();

    let ids = input
        .get("input_image_ids")
        .or_else(|| input.get("inputImageIds"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for id in ids.iter().filter_map(Value::as_str) {
        if images.len() >= MAX_IMAGE_INPUTS {
            break;
        }
        if let Some((base64, mime)) = resolve_library_image(id, services)? {
            push_edit_input(&mut images, &mut mimes, base64, mime);
        }
    }

    let paths = input
        .get("input_image_paths")
        .or_else(|| input.get("inputImagePaths"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for path in paths.iter().filter_map(Value::as_str) {
        if images.len() >= MAX_IMAGE_INPUTS {
            break;
        }
        let path = Path::new(path);
        if path.is_file() {
            let (base64, mime) = encode_image_file(path)?;
            push_edit_input(&mut images, &mut mimes, base64, mime);
        }
    }

    let raw_values = input
        .get("input_images")
        .or_else(|| input.get("inputImages"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for value in raw_values.iter().filter_map(Value::as_str) {
        if images.len() >= MAX_IMAGE_INPUTS {
            break;
        }
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        push_edit_input(
            &mut images,
            &mut mimes,
            strip_data_url(value).to_string(),
            image_mime_for_data_url(value).to_string(),
        );
    }

    // Keep compatibility with the original single-image tool shape.
    if images.is_empty() {
        if let Some(value) = input
            .get("input_image_b64")
            .or_else(|| input.get("image_base64"))
            .and_then(Value::as_str)
        {
            let value = value.trim();
            if !value.is_empty() {
                push_edit_input(
                    &mut images,
                    &mut mimes,
                    strip_data_url(value).to_string(),
                    image_mime_for_data_url(value).to_string(),
                );
            }
        }
    }

    for (index, value) in images.iter().enumerate() {
        base64::engine::general_purpose::STANDARD
            .decode(value)
            .with_context(|| format!("decode input image {index}"))?;
    }
    Ok((images, mimes))
}

fn image_model_is_capable(
    provider: &worldbase_protocol::types::ProviderEntry,
    model: &str,
    edit: bool,
) -> bool {
    match provider
        .models
        .iter()
        .find(|candidate| candidate.id == model)
    {
        Some(model) => {
            if edit {
                model.image_editing
            } else {
                model.image_generation
            }
        }
        // Older Rust-only profiles stored only the provider-level generation
        // flag. Keep those profiles usable while Electron profiles use the
        // stricter per-model capability fields above.
        None => provider.models.is_empty() || (!edit && provider.image_generation),
    }
}

fn image_model_for_provider(
    provider: &worldbase_protocol::types::ProviderEntry,
    requested_model: Option<&str>,
    edit: bool,
) -> Option<String> {
    if let Some(model) = requested_model
        .map(str::trim)
        .filter(|model| !model.is_empty())
    {
        return image_model_is_capable(provider, model, edit).then(|| model.to_string());
    }
    if image_model_is_capable(provider, &provider.active_model, edit) {
        return Some(provider.active_model.clone());
    }
    provider
        .models
        .iter()
        .find(|model| {
            if edit {
                model.image_editing
            } else {
                model.image_generation
            }
        })
        .map(|model| model.id.clone())
}

/// A provider without credentials is served by `generate_images`' deterministic
/// mock implementation. Fresh mobile profiles often do not have model
/// capability flags yet, so do not reject them before that implementation has
/// a chance to run. Keyed providers still use the stricter capability check
/// above and therefore cannot accidentally target a text-only model.
fn image_model_for_mock_provider(
    provider: &worldbase_protocol::types::ProviderEntry,
    requested_model: Option<&str>,
) -> Option<String> {
    if !provider.api_key.trim().is_empty() {
        return None;
    }
    requested_model
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| {
            let model = provider.active_model.trim();
            (!model.is_empty()).then(|| model.to_string())
        })
        .or_else(|| {
            provider
                .models
                .first()
                .map(|model| model.id.trim().to_string())
                .filter(|model| !model.is_empty())
        })
        .or_else(|| Some("mock-image".to_string()))
}

fn resolve_image_provider(
    providers: &worldbase_protocol::types::ProvidersConfig,
    requested_provider: Option<&str>,
    requested_model: Option<&str>,
    edit: bool,
) -> Result<(worldbase_protocol::types::ProviderEntry, String)> {
    let requested_provider = requested_provider
        .map(str::trim)
        .filter(|id| !id.is_empty());
    if let Some(provider_id) = requested_provider {
        let provider = providers
            .providers
            .iter()
            .find(|provider| provider.id == provider_id)
            .ok_or_else(|| anyhow::anyhow!("image provider not found: {provider_id}"))?;
        let model = image_model_for_provider(provider, requested_model, edit)
            .or_else(|| image_model_for_mock_provider(provider, requested_model))
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "provider {} has no configured model with image {} capability",
                    provider_id,
                    if edit { "editing" } else { "generation" }
                )
            })?;
        return Ok((provider.clone(), model));
    }

    let mut candidates: Vec<&worldbase_protocol::types::ProviderEntry> =
        providers.providers.iter().collect();
    if let Some(active_id) = providers.active_provider_id.as_deref() {
        if let Some(index) = candidates
            .iter()
            .position(|provider| provider.id == active_id)
        {
            let active = candidates.remove(index);
            candidates.insert(0, active);
        }
    }
    candidates
        .into_iter()
        .find_map(|provider| {
            image_model_for_provider(provider, requested_model, edit)
                .or_else(|| image_model_for_mock_provider(provider, requested_model))
                .map(|model| (provider.clone(), model))
        })
        .or_else(|| {
            // A brand-new mobile installation has no provider entry at all.
            // Keep the local/demo path functional; the empty key guarantees
            // `generate_images` returns a local placeholder without a request.
            if providers.providers.is_empty() {
                Some((
                    worldbase_protocol::types::ProviderEntry {
                        id: "mock".into(),
                        name: "Mock".into(),
                        base_url: String::new(),
                        api_key: String::new(),
                        api_protocol: "openai".into(),
                        models: Vec::new(),
                        active_model: "mock-image".into(),
                        temperature: None,
                        image_generation: true,
                    },
                    requested_model
                        .map(str::trim)
                        .filter(|model| !model.is_empty())
                        .unwrap_or("mock-image")
                        .to_string(),
                ))
            } else {
                None
            }
        })
        .ok_or_else(|| {
            anyhow::anyhow!(
                "no configured model supports image {}",
                if edit { "editing" } else { "generation" }
            )
        })
}

#[cfg(test)]
#[allow(dead_code)]
async fn run_image(input: &Value, services: &ToolServices, edit: bool) -> Result<Value> {
    let prompt = require_str(input, "prompt")?;
    // Native image tools bypass `studio.generate`, so they must perform the
    // same TS -> Rust gallery handoff before writing new image/folder mirrors.
    services
        .store
        .import_image_library_mirror(&image_file_dir())?;
    let providers = services
        .store
        .get_setting("providers")?
        .and_then(|value| {
            serde_json::from_value::<worldbase_protocol::types::ProvidersConfig>(value).ok()
        })
        .unwrap_or_default();
    let (entry, model) = resolve_image_provider(
        &providers,
        input.get("provider_id").and_then(Value::as_str),
        input.get("model").and_then(Value::as_str),
        edit,
    )?;
    let (input_images, input_mimes) = if edit {
        resolve_edit_inputs(input, services).await?
    } else {
        (Vec::new(), Vec::new())
    };
    anyhow::ensure!(
        !edit || !input_images.is_empty(),
        "edit_image requires at least one input image (input_image_ids, input_image_paths, or input_images)"
    );
    let input_refs: Vec<&str> = input_images.iter().map(String::as_str).collect();
    let mime_refs: Vec<&str> = input_mimes.iter().map(String::as_str).collect();
    let params = worldbase_providers::ImageParams {
        prompt,
        negative_prompt: input.get("negative_prompt").and_then(Value::as_str),
        aspect: input
            .get("aspect_ratio")
            .or_else(|| input.get("aspect"))
            .and_then(Value::as_str),
        size: input.get("size").and_then(Value::as_str),
        resolution: input.get("resolution").and_then(Value::as_str),
        quality: input.get("quality").and_then(Value::as_str),
        format: input
            .get("output_format")
            .or_else(|| input.get("format"))
            .and_then(Value::as_str),
        n: input
            .get("n")
            .and_then(Value::as_u64)
            .unwrap_or(1)
            .clamp(1, 4) as u32,
        input_image_b64: input_refs.first().copied(),
        input_images_b64: input_refs,
        input_image_mimes: mime_refs,
    };
    let generated = worldbase_providers::generate_images(&entry, &model, &params).await?;
    std::fs::create_dir_all(image_file_dir())?;
    let mut out = Vec::new();
    for image in generated {
        let id = uuid::Uuid::new_v4().to_string();
        let source_image_file_names = if edit {
            write_edit_source_images(&image_file_dir(), &id, &input_images, &input_mimes)
        } else {
            Vec::new()
        };
        let file = format!("{id}.{}", image.ext);
        std::fs::write(image_file_dir().join(&file), &image.bytes)?;
        let thumbnail =
            worldbase_memory::Store::write_image_library_thumbnail(&image_file_dir(), &id, &file);
        let mut meta = json!({
            "mode": if edit { "edit" } else { "generate" },
            "aspect": input.get("aspect_ratio").or_else(|| input.get("aspect")),
            "size": input.get("size"),
            "resolution": input.get("resolution"),
            "quality": input.get("quality"),
            "format": input.get("output_format").or_else(|| input.get("format")),
            "negativePrompt": input.get("negative_prompt"),
            "inputCount": source_image_file_names.len(),
            "sourceImageFileNames": source_image_file_names,
        });
        if let Some(thumbnail) = thumbnail {
            let metadata = meta
                .as_object_mut()
                .expect("image tool metadata is always a JSON object");
            metadata.insert("thumbName".into(), thumbnail.name.into());
            metadata.insert("width".into(), thumbnail.width.into());
            metadata.insert("height".into(), thumbnail.height.into());
        }
        let image_entry = worldbase_protocol::types::ImageEntry {
            id: id.clone(),
            prompt: prompt.to_string(),
            provider_id: Some(entry.id.clone()),
            model: model.clone(),
            file,
            created_at: worldbase_protocol::event::now_rfc3339(),
            folder: input
                .get("folder")
                .and_then(Value::as_str)
                .unwrap_or("")
                .into(),
            tags: input
                .get("tags")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(ToOwned::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
            meta,
        };
        services.store.add_image(&image_entry)?;
        worldbase_memory::Store::write_image_library_mirror(&image_file_dir(), &image_entry)?;
        out.push(image_entry);
    }
    let folders = services.store.list_image_folders()?;
    worldbase_memory::Store::write_image_folder_mirror(&image_file_dir(), &folders)?;
    Ok(json!({"ok": true, "mode": if edit { "edit" } else { "generate" }, "images": out}))
}

/// Resolve one Electron-compatible Studio request without executing it. The
/// renderer owns concurrency and task lifecycle; Rust only validates the
/// provider/input and persists the handoff request atomically.
async fn prepare_studio_request(
    input: &Value,
    services: &ToolServices,
    edit: bool,
) -> Result<Value> {
    let prompt = require_str(input, "prompt")?.trim();
    anyhow::ensure!(!prompt.is_empty(), "prompt is required");
    let providers = services
        .store
        .get_setting("providers")?
        .and_then(|value| {
            serde_json::from_value::<worldbase_protocol::types::ProvidersConfig>(value).ok()
        })
        .unwrap_or_default();
    let (provider, model) = resolve_image_provider(
        &providers,
        input
            .get("provider_id")
            .or_else(|| input.get("providerId"))
            .and_then(Value::as_str),
        input.get("model").and_then(Value::as_str),
        edit,
    )?;

    let (input_images, input_mimes) = if edit {
        resolve_edit_inputs(input, services).await?
    } else {
        (Vec::new(), Vec::new())
    };
    anyhow::ensure!(
        !edit || !input_images.is_empty(),
        "edit_image requires at least one input image (input_image_ids, input_image_paths, or input_images)"
    );
    let aspect = input
        .get("aspect_ratio")
        .or_else(|| input.get("aspect"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let resolution = input.get("resolution").and_then(Value::as_str);
    let size = input
        .get("size")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| worldbase_providers::size_for(aspect, resolution).to_string());
    let quality = input
        .get("quality")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("high");
    let output_format = input
        .get("output_format")
        .or_else(|| input.get("format"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("png");
    let n = input
        .get("n")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .clamp(1, 4);
    let input_urls: Vec<String> = input_images
        .iter()
        .enumerate()
        .map(|(index, image)| {
            let mime = input_mimes
                .get(index)
                .map(String::as_str)
                .unwrap_or("image/png");
            format!("data:{mime};base64,{image}")
        })
        .collect();
    Ok(json!({
        "providerId": provider.id,
        "model": model,
        "mode": if edit { "edit" } else { "generate" },
        "prompt": prompt,
        "negativePrompt": input.get("negative_prompt").or_else(|| input.get("negativePrompt")),
        "aspectRatio": aspect,
        "size": size,
        "quality": quality,
        "outputFormat": output_format,
        "n": n,
        "folder": input.get("folder"),
        "tags": input.get("tags").cloned().unwrap_or_else(|| json!([])),
        "inputImages": input_urls,
    }))
}

async fn enqueue_studio_batch(input: &Value, services: &ToolServices, edit: bool) -> Result<Value> {
    let raw_tasks = match input.get("tasks").and_then(Value::as_array) {
        Some(tasks) => tasks.clone(),
        // Electron's tools always hand a single-form request to the shared
        // queue instead of blocking the conversation on image generation.
        None => vec![input.clone()],
    };
    if raw_tasks.is_empty() {
        return Ok(json!({
            "ok": false,
            "mode": if edit { "edit" } else { "generate" },
            "queued": 0,
            "failed": 0,
            "error": "tasks 不能为空，请提供至少一个任务。"
        }));
    }

    let mut requests = Vec::new();
    let mut queued = Vec::new();
    let mut errors = Vec::new();
    for (index, task) in raw_tasks.iter().take(20).enumerate() {
        let mut merged = input.clone();
        if let (Value::Object(target), Value::Object(overrides)) = (&mut merged, task) {
            for (key, value) in overrides {
                target.insert(key.clone(), value.clone());
            }
        }
        match prepare_studio_request(&merged, services, edit).await {
            Ok(request) => {
                queued.push(json!({
                    "index": index,
                    "prompt": request.get("prompt"),
                    "mode": request.get("mode"),
                    "providerId": request.get("providerId"),
                    "model": request.get("model"),
                    "size": request.get("size"),
                    "quality": request.get("quality"),
                    "outputFormat": request.get("outputFormat"),
                    "n": request.get("n"),
                    "inputCount": request.get("inputImages").and_then(Value::as_array).map(Vec::len),
                }));
                requests.push(request);
            }
            Err(error) => errors.push(json!({
                "index": index,
                "prompt": merged.get("prompt"),
                "error": error.to_string(),
            })),
        }
    }
    let truncated = raw_tasks.len().saturating_sub(20);
    let added = services.store.enqueue_studio_pending_tasks(&requests)?;
    Ok(json!({
        "ok": added > 0,
        "mode": if edit { "edit" } else { "generate" },
        "queued": added,
        "failed": errors.len(),
        "tasks": queued,
        "errors": if errors.is_empty() { Value::Null } else { Value::Array(errors) },
        "truncated": truncated,
        "message": format!("已将 {added} 个{}任务加入绘制工作台的任务队列。", if edit { "图片编辑" } else { "图片生成" }),
    }))
}

pub struct GenerateImageTool;
#[async_trait]
impl Tool for GenerateImageTool {
    fn name(&self) -> &str {
        "generate_image"
    }
    fn description(&self) -> &str {
        "Generate one or more images and save them to the image library."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"prompt":{"type":"string"},"tasks":{"type":"array","items":{"type":"object"}},"provider_id":{"type":"string"},"model":{"type":"string"},"negative_prompt":{"type":"string"},"aspect_ratio":{"type":"string"},"resolution":{"type":"string"},"size":{"type":"string"},"quality":{"type":"string"},"output_format":{"type":"string"},"folder":{"type":"string"},"tags":{"type":"array","items":{"type":"string"}},"n":{"type":"integer"}},"anyOf":[{"required":["prompt"]},{"required":["tasks"]}]})
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        enqueue_studio_batch(&input, services, false).await
    }
}

pub struct EditImageTool;
#[async_trait]
impl Tool for EditImageTool {
    fn name(&self) -> &str {
        "edit_image"
    }
    fn description(&self) -> &str {
        "Edit a reference image and save the result to the image library."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"prompt":{"type":"string"},"tasks":{"type":"array","items":{"type":"object"}},"input_image_ids":{"type":"array","items":{"type":"string"}},"input_image_paths":{"type":"array","items":{"type":"string"}},"input_images":{"type":"array","items":{"type":"string"}},"input_image_b64":{"type":"string"},"image_base64":{"type":"string"},"provider_id":{"type":"string"},"model":{"type":"string"},"aspect_ratio":{"type":"string"},"resolution":{"type":"string"},"size":{"type":"string"},"quality":{"type":"string"},"output_format":{"type":"string"},"folder":{"type":"string"},"tags":{"type":"array","items":{"type":"string"}},"n":{"type":"integer"}},"anyOf":[{"required":["prompt"]},{"required":["tasks"]}]})
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        enqueue_studio_batch(&input, services, true).await
    }
}

#[cfg(test)]
mod image_provider_tests {
    use super::*;
    use worldbase_protocol::types::{ModelInfo, ProviderEntry, ProvidersConfig};

    fn provider(api_key: &str) -> ProviderEntry {
        ProviderEntry {
            id: "mobile-demo".into(),
            name: "Mobile demo".into(),
            base_url: "https://example.invalid/v1".into(),
            api_key: api_key.into(),
            api_protocol: "openai".into(),
            models: vec![ModelInfo {
                id: "text-model".into(),
                context_window_k: 0,
                input_price: 0.0,
                output_price: 0.0,
                cache_read_price: 0.0,
                image_generation: false,
                image_editing: false,
            }],
            active_model: "text-model".into(),
            temperature: None,
            image_generation: false,
        }
    }

    #[test]
    fn no_key_provider_without_image_flags_uses_mock_target() {
        let config = ProvidersConfig {
            providers: vec![provider("")],
            active_provider_id: Some("mobile-demo".into()),
        };

        let (resolved, model) =
            resolve_image_provider(&config, Some("mobile-demo"), None, false).unwrap();

        assert_eq!(resolved.id, "mobile-demo");
        assert_eq!(model, "text-model");
    }

    #[test]
    fn no_provider_configuration_uses_synthetic_mock_target() {
        let (resolved, model) =
            resolve_image_provider(&ProvidersConfig::default(), None, None, false).unwrap();

        assert_eq!(resolved.id, "mock");
        assert!(resolved.api_key.is_empty());
        assert_eq!(model, "mock-image");
    }

    #[test]
    fn keyed_provider_without_image_capability_remains_rejected() {
        let config = ProvidersConfig {
            providers: vec![provider("key")],
            active_provider_id: Some("mobile-demo".into()),
        };

        assert!(resolve_image_provider(&config, Some("mobile-demo"), None, false).is_err());
    }
}

fn _keep_types_linked(_: Option<Duration>) {}
