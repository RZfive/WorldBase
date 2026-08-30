//! 文件系统工具：read/write/edit/list，均限制在工作区内。
//!
//! The `*_project_file` tools intentionally resolve through the project
//! runtime instead of the harness workspace. Electron starts the harness with
//! its *projects directory* as the workspace, so treating that directory as a
//! single project would otherwise write `<projects>/<file>` rather than
//! `<projects>/<project_id>/<file>`.

use super::{require_str, Tool, ToolServices};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const MAX_PROJECT_RETURN_CHARS: usize = 50_000;
const EDGE_PROJECT_RETURN_CHARS: usize = 25_000;
const DEFAULT_PROJECT_SEGMENT_LINES: usize = 1_000;
const MAX_PROJECT_SEGMENT_LINES: usize = 2_000;
const MAX_PROJECT_LIST_ENTRIES: usize = 200;

fn project_file_path(
    input: &Value,
    file_key: &str,
    services: &ToolServices,
) -> Result<(String, String, PathBuf)> {
    let project_id = require_str(input, "project_id")?.trim().to_string();
    let file_path = require_str(input, file_key)?.to_string();
    let full = services.projects.project_path(&project_id, &file_path)?;
    Ok((project_id, file_path, full))
}

fn project_dir_path(input: &Value, services: &ToolServices) -> Result<(String, String, PathBuf)> {
    let project_id = require_str(input, "project_id")?.trim().to_string();
    let dir_path = input
        .get("dir_path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let full = services.projects.project_path(&project_id, &dir_path)?;
    Ok((project_id, dir_path, full))
}

fn numbered_lines(lines: &[&str], first_line: usize) -> String {
    lines
        .iter()
        .enumerate()
        .map(|(index, line)| format!("{:>6}\t{}", first_line + index, line))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Tool response limits are measured in bytes to match Electron, while Rust
/// strings can only be sliced on character boundaries.
fn char_boundary_before(text: &str, index: usize) -> usize {
    let mut index = index.min(text.len());
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn char_boundary_after(text: &str, index: usize) -> usize {
    let mut index = index.min(text.len());
    while index < text.len() && !text.is_char_boundary(index) {
        index += 1;
    }
    index
}

#[derive(Debug)]
struct LinePatch {
    start: i64,
    end: i64,
    content: String,
}

fn parse_line_patches(input: &Value) -> Result<Vec<LinePatch>> {
    let parsed_patches;
    let raw = match input.get("patches") {
        Some(Value::Array(items)) => items,
        Some(Value::String(value)) => {
            parsed_patches = serde_json::from_str::<Value>(value)
                .map_err(|_| anyhow::anyhow!("patches must be an array"))?;
            parsed_patches
                .as_array()
                .ok_or_else(|| anyhow::anyhow!("patches must be an array"))?
        }
        _ => anyhow::bail!("patches must be an array"),
    };
    anyhow::ensure!(!raw.is_empty(), "patches must contain at least one entry");
    let mut patches = Vec::with_capacity(raw.len());
    for value in raw {
        let start = value
            .get("start_line")
            .and_then(Value::as_i64)
            .ok_or_else(|| anyhow::anyhow!("patch.start_line must be an integer"))?;
        let end = value
            .get("end_line")
            .and_then(Value::as_i64)
            .ok_or_else(|| anyhow::anyhow!("patch.end_line must be an integer"))?;
        anyhow::ensure!(start >= 1, "patch.start_line must be >= 1");
        let content = value
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("patch.content must be a string"))?
            .to_string();
        patches.push(LinePatch {
            start,
            end,
            content,
        });
    }
    patches.sort_by(|left, right| right.start.cmp(&left.start));
    for pair in patches.windows(2) {
        let current = &pair[0];
        let next = &pair[1];
        let next_end = if next.end < next.start {
            next.start - 1
        } else {
            next.end
        };
        anyhow::ensure!(
            next_end < current.start,
            "patches overlap: lines {}-{} and {}-{}",
            next.start,
            next.end,
            current.start,
            current.end
        );
    }
    Ok(patches)
}

async fn apply_line_patches(path: &Path, input: &Value) -> Result<(usize, usize, usize)> {
    let original = tokio::fs::read_to_string(path).await?;
    let mut lines: Vec<String> = original.split('\n').map(ToOwned::to_owned).collect();
    let original_lines = lines.len();
    let total_lines = original_lines as i64;
    let patches = parse_line_patches(input)?;
    for patch in &patches {
        anyhow::ensure!(
            patch.start <= total_lines + 1,
            "patch.start_line exceeds file length"
        );
        let start_index = (patch.start - 1) as usize;
        let replacement: Vec<String> = if patch.content.is_empty() {
            Vec::new()
        } else {
            patch.content.split('\n').map(ToOwned::to_owned).collect()
        };
        if patch.end < patch.start {
            lines.splice(start_index..start_index, replacement);
        } else {
            // Electron clamps an overlong replacement range to the end of the
            // file. Keep the same behavior for prompts produced by older
            // models rather than rejecting an otherwise valid patch.
            let end_index = (patch.end as usize).min(original_lines);
            lines.splice(start_index..end_index, replacement);
        }
    }
    let new_lines = lines.len();
    tokio::fs::write(path, lines.join("\n")).await?;
    Ok((patches.len(), original_lines, new_lines))
}

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
        services.ensure_workspace_path(&full)?;
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
        services.ensure_workspace_path(&full)?;
        if let Some(parent) = full.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&full, content).await?;
        Ok(json!({ "path": path, "bytes_written": content.len() }))
    }
}

/// Electron-compatible `write_project_file` wrapper.
pub struct ProjectWriteFileTool;

#[async_trait]
impl Tool for ProjectWriteFileTool {
    fn name(&self) -> &str {
        "write_project_file"
    }

    fn description(&self) -> &str {
        "写入当前项目文件"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_id": { "type": "string" },
                "file_path": { "type": "string" },
                "content": { "type": "string" }
            },
            "required": ["project_id", "file_path", "content"]
        })
    }

    fn permission(&self) -> &str {
        "ask"
    }

    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let (_, file_path, full) = project_file_path(&input, "file_path", services)?;
        let content = require_str(&input, "content")?;
        if let Some(parent) = full.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&full, content).await?;
        services.mark_file_read(&full.canonicalize().unwrap_or(full.clone()));
        Ok(json!({
            "success": true,
            "file_path": file_path,
            "message": format!("File {file_path} written successfully")
        }))
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
                "new_string": { "type": "string" },
                "replace_all": { "type": "boolean" }
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
        services.ensure_workspace_path(&full)?;
        let content = tokio::fs::read_to_string(&full).await?;
        let count = content.matches(old).count();
        let replace_all = input
            .get("replace_all")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        anyhow::ensure!(
            count > 0,
            "old_string matched 0 times, must match the current file"
        );
        anyhow::ensure!(
            replace_all || count == 1,
            "old_string matched {count} times, must be unique"
        );
        let updated = content.replace(old, new);
        tokio::fs::write(&full, updated).await?;
        Ok(json!({ "path": path, "replaced": if replace_all { count } else { 1 } }))
    }
}

/// Electron-compatible exact-string edit wrapper.
pub struct ProjectEditFileTool;

#[async_trait]
impl Tool for ProjectEditFileTool {
    fn name(&self) -> &str {
        "edit_project_file"
    }

    fn description(&self) -> &str {
        "在当前项目文件中做精确文本替换"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_id": { "type": "string" },
                "file_path": { "type": "string" },
                "old_string": { "type": "string" },
                "new_string": { "type": "string" },
                "replace_all": { "type": "boolean" }
            },
            "required": ["project_id", "file_path", "old_string", "new_string"]
        })
    }

    fn permission(&self) -> &str {
        "ask"
    }

    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let (_, file_path, full) = project_file_path(&input, "file_path", services)?;
        let old = require_str(&input, "old_string")?;
        let new = require_str(&input, "new_string")?;
        let tracked_path = full.canonicalize().unwrap_or(full.clone());
        anyhow::ensure!(
            !old.is_empty(),
            "old_string must not be empty. To create a new file, use write_project_file instead."
        );
        anyhow::ensure!(
            old != new,
            "old_string and new_string are identical - nothing to change."
        );
        anyhow::ensure!(
            services.has_read_file(&tracked_path),
            "You must read {file_path} with read_project_file before editing it, so the edit matches its current content."
        );
        let original = tokio::fs::read_to_string(&full).await?;
        let occurrences = original.matches(old).count();
        anyhow::ensure!(
            occurrences > 0,
            "old_string was not found in {file_path}; re-read the file and use an exact snippet"
        );
        let replace_all = input
            .get("replace_all")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        anyhow::ensure!(
            replace_all || occurrences == 1,
            "old_string is not unique in {file_path} ({occurrences} matches); add context or set replace_all"
        );
        let replacements = if replace_all { occurrences } else { 1 };
        let updated = if replace_all {
            original.replace(old, new)
        } else {
            original.replacen(old, new, 1)
        };
        tokio::fs::write(&full, updated).await?;
        services.mark_file_read(&tracked_path);
        Ok(json!({
            "success": true,
            "file_path": file_path,
            "replacements": replacements,
            "message": format!("Replaced {replacements} occurrence(s) in {file_path}.")
        }))
    }
}

/// Electron-compatible project-file read wrapper.
pub struct ProjectReadFileTool;

#[async_trait]
impl Tool for ProjectReadFileTool {
    fn name(&self) -> &str {
        "read_project_file"
    }

    fn description(&self) -> &str {
        "读取当前项目文件"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_id": { "type": "string" },
                "file_path": { "type": "string" },
                "start_line": { "type": "integer" },
                "max_lines": { "type": "integer" }
            },
            "required": ["project_id", "file_path"]
        })
    }

    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let (_, file_path, full) = project_file_path(&input, "file_path", services)?;
        let content = tokio::fs::read_to_string(&full).await?;
        services.mark_file_read(&full.canonicalize().unwrap_or(full.clone()));
        let lines = if content.is_empty() {
            Vec::new()
        } else {
            content.split('\n').collect::<Vec<_>>()
        };
        if lines.is_empty() {
            return Ok(json!({
                "file_path": file_path,
                "content": "(This file exists but is empty - 0 lines.)",
                "truncated": false,
                "total_chars": 0,
                "total_lines": 0,
                "start_line": 0,
                "end_line": 0,
                "has_more": false,
                "next_start_line": null
            }));
        }
        let requested_start = input
            .get("start_line")
            .and_then(Value::as_u64)
            .unwrap_or(1)
            .max(1) as usize;
        let requested_max = input
            .get("max_lines")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .unwrap_or_else(|| {
                if content.len() > MAX_PROJECT_RETURN_CHARS {
                    DEFAULT_PROJECT_SEGMENT_LINES
                } else {
                    lines.len()
                }
            })
            .clamp(1, MAX_PROJECT_SEGMENT_LINES);
        let start = (requested_start - 1).min(lines.len() - 1);
        let end = (start + requested_max).min(lines.len());
        let mut rendered = numbered_lines(&lines[start..end], start + 1);
        let mut truncated = false;
        if rendered.len() > MAX_PROJECT_RETURN_CHARS {
            let head_end = char_boundary_before(&rendered, EDGE_PROJECT_RETURN_CHARS);
            let tail_start = char_boundary_after(
                &rendered,
                rendered.len().saturating_sub(EDGE_PROJECT_RETURN_CHARS),
            );
            let head = rendered[..head_end].to_string();
            let tail = rendered[tail_start..].to_string();
            let omitted = rendered.len().saturating_sub(EDGE_PROJECT_RETURN_CHARS * 2);
            rendered = format!(
                "{head}\n\n...[truncated {omitted} characters within requested segment lines {}-{}; narrow the range with start_line / max_lines to read the middle]...\n\n{tail}",
                start + 1,
                end
            );
            truncated = true;
        }
        let has_more = end < lines.len();
        Ok(json!({
            "file_path": file_path,
            "content": rendered,
            "truncated": truncated,
            "total_chars": content.len(),
            "total_lines": lines.len(),
            "start_line": start + 1,
            "end_line": end,
            "has_more": has_more,
            "next_start_line": if has_more { Some(end + 1) } else { None::<usize> }
        }))
    }
}

/// List entries under the active workspace directory.
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
        let rel = input.get("path").and_then(Value::as_str).unwrap_or(".");
        let full = services.workspace_path(rel);
        services.ensure_workspace_path(&full)?;
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

/// Electron-compatible `list_project_files` wrapper.
pub struct ProjectListFilesTool;

#[async_trait]
impl Tool for ProjectListFilesTool {
    fn name(&self) -> &str {
        "list_project_files"
    }

    fn description(&self) -> &str {
        "列出当前项目目录内容"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_id": { "type": "string" },
                "dir_path": { "type": "string" }
            },
            "required": ["project_id"]
        })
    }

    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let (_, dir_path, full) = project_dir_path(&input, services)?;
        let mut entries = Vec::new();
        let mut reader = tokio::fs::read_dir(full).await?;
        while let Some(entry) = reader.next_entry().await? {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == "node_modules" || name.starts_with('.') {
                continue;
            }
            let kind = if entry.file_type().await?.is_dir() {
                "directory"
            } else {
                "file"
            };
            let path = if dir_path.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", dir_path.trim_end_matches('/'), name)
            };
            entries.push(json!({ "name": name, "path": path, "type": kind }));
        }
        entries.sort_by(|left, right| left["name"].as_str().cmp(&right["name"].as_str()));
        let total_entries = entries.len();
        let truncated = total_entries > MAX_PROJECT_LIST_ENTRIES;
        entries.truncate(MAX_PROJECT_LIST_ENTRIES);
        Ok(json!({
            "dir_path": dir_path,
            "entries": entries,
            "total_entries": total_entries,
            "truncated": truncated
        }))
    }
}

/// Delete a single file inside the workspace.
///
/// Electron exposes this operation as `delete_project_file`.  The Rust
/// implementation keeps the path workspace-scoped and treats a missing file
/// as a successful no-op, matching the desktop tool's behavior.
pub struct DeleteFileTool;

#[async_trait]
impl Tool for DeleteFileTool {
    fn name(&self) -> &str {
        "delete_file"
    }

    fn description(&self) -> &str {
        "删除工作区内的单个文件"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "path": { "type": "string" } },
            "required": ["path"]
        })
    }

    fn permission(&self) -> &str {
        "ask"
    }

    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let path = require_str(&input, "path")?;
        let full = services.workspace_path(path);
        services.ensure_workspace_path(&full)?;
        let existed = full.is_file();
        if existed {
            tokio::fs::remove_file(&full).await?;
        }
        Ok(json!({
            "path": path,
            "deleted": existed,
            "skipped": !existed
        }))
    }
}

/// A project-file compatible name used by the Electron tool catalog.  The
/// harness workspace is already the active project, so this alias only needs
/// to translate `file_path` to the Rust tool's `path` field.
pub struct ProjectDeleteFileTool;

#[async_trait]
impl Tool for ProjectDeleteFileTool {
    fn name(&self) -> &str {
        "delete_project_file"
    }

    fn description(&self) -> &str {
        "删除当前项目中的单个文件"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_id": { "type": "string" },
                "file_path": { "type": "string" }
            },
            "required": ["project_id", "file_path"]
        })
    }

    fn permission(&self) -> &str {
        "ask"
    }

    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let (_, file_path, full) = project_file_path(&input, "file_path", services)?;
        if !full.exists() {
            return Ok(json!({
                "success": true,
                "skipped": true,
                "file_path": file_path,
                "message": format!("File {file_path} does not exist")
            }));
        }
        tokio::fs::remove_file(full).await?;
        Ok(json!({
            "success": true,
            "file_path": file_path,
            "message": format!("File {file_path} deleted successfully")
        }))
    }
}

/// Apply non-overlapping line-range patches to a workspace file.
///
/// Ranges are 1-based and inclusive.  Set `end_line < start_line` for a pure
/// insertion before `start_line`; patches are applied from bottom to top so
/// their line numbers remain stable.
pub struct PatchFileTool;

#[async_trait]
impl Tool for PatchFileTool {
    fn name(&self) -> &str {
        "patch_file"
    }

    fn description(&self) -> &str {
        "按行号增量修改工作区文件"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" },
                "patches": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "start_line": { "type": "integer" },
                            "end_line": { "type": "integer" },
                            "content": { "type": "string" }
                        },
                        "required": ["start_line", "end_line", "content"]
                    }
                }
            },
            "required": ["path", "patches"]
        })
    }

    fn permission(&self) -> &str {
        "ask"
    }

    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let path = require_str(&input, "path")?;
        let full = services.workspace_path(path);
        services.ensure_workspace_path(&full)?;
        let (patches_applied, _, _) = apply_line_patches(&full, &input).await?;
        Ok(json!({ "path": path, "patches_applied": patches_applied }))
    }
}

/// Electron-compatible project-file patch name.  See [`PatchFileTool`] for
/// the actual line-range implementation.
pub struct ProjectPatchFileTool;

#[async_trait]
impl Tool for ProjectPatchFileTool {
    fn name(&self) -> &str {
        "patch_project_file"
    }

    fn description(&self) -> &str {
        "按行号增量修改当前项目文件"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_id": { "type": "string" },
                "file_path": { "type": "string" },
                "patches": { "type": "array", "items": { "type": "object" } }
            },
            "required": ["project_id", "file_path", "patches"]
        })
    }

    fn permission(&self) -> &str {
        "ask"
    }

    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let (_, file_path, full) = project_file_path(&input, "file_path", services)?;
        let (patches_applied, original_lines, new_lines) =
            apply_line_patches(&full, &input).await?;
        services.mark_file_read(&full.canonicalize().unwrap_or(full.clone()));
        Ok(json!({
            "success": true,
            "file_path": file_path,
            "patches_applied": patches_applied,
            "original_lines": original_lines,
            "new_lines": new_lines,
            "message": format!("Applied {patches_applied} patch(es) to {file_path}. File went from {original_lines} to {new_lines} lines.")
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn services(root: &Path) -> ToolServices {
        let workspace = root.join("workspace");
        let projects = root.join("projects");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(projects.join("alpha")).unwrap();
        let store = Arc::new(worldbase_memory::Store::open(&root.join("store.sqlite")).unwrap());
        ToolServices {
            host: Arc::new(super::super::HostBridge::new()),
            current_stream: Arc::new(std::sync::Mutex::new(String::new())),
            workspace,
            folder_workspace: None,
            target_project_id: None,
            allowed_mcp_server_ids: None,
            plan_goal: Arc::new(std::sync::Mutex::new(None)),
            todo_items: Arc::new(std::sync::Mutex::new(Vec::new())),
            read_files: Arc::new(std::sync::Mutex::new(std::collections::HashSet::new())),
            store: store.clone(),
            skills: Arc::new(worldbase_skills::SkillRegistry::new(vec![])),
            scheduler: Arc::new(worldbase_scheduler::Scheduler::new(store)),
            mcp: Arc::new(worldbase_mcp_client::McpManager::default()),
            projects: Arc::new(worldbase_project_runtime::ProjectRuntime::new(projects)),
            group_collaboration: None,
        }
    }

    #[tokio::test]
    async fn project_file_tools_are_scoped_to_project_id() {
        let temp = tempfile::tempdir().unwrap();
        let tool_services = services(temp.path());
        let project_file = temp.path().join("projects/alpha/src/example.txt");

        let written = ProjectWriteFileTool
            .execute(
                json!({
                    "project_id": "alpha",
                    "file_path": "src/example.txt",
                    "content": "one\ntwo\nthree"
                }),
                &tool_services,
            )
            .await
            .unwrap();
        assert_eq!(written["success"], true);
        assert_eq!(
            std::fs::read_to_string(&project_file).unwrap(),
            "one\ntwo\nthree"
        );
        assert!(!temp.path().join("projects/src/example.txt").exists());

        let read = ProjectReadFileTool
            .execute(
                json!({ "project_id": "alpha", "file_path": "src/example.txt", "start_line": 2, "max_lines": 1 }),
                &tool_services,
            )
            .await
            .unwrap();
        assert_eq!(read["content"], "     2\ttwo");
        assert_eq!(read["next_start_line"], 3);

        let blind_services = services(temp.path());
        assert!(ProjectEditFileTool
            .execute(
                json!({
                    "project_id": "alpha",
                    "file_path": "src/example.txt",
                    "old_string": "two",
                    "new_string": "TWO"
                }),
                &blind_services,
            )
            .await
            .is_err());

        let edited = ProjectEditFileTool
            .execute(
                json!({
                    "project_id": "alpha",
                    "file_path": "src/example.txt",
                    "old_string": "two",
                    "new_string": "TWO"
                }),
                &tool_services,
            )
            .await
            .unwrap();
        assert_eq!(edited["replacements"], 1);

        let patched = ProjectPatchFileTool
            .execute(
                json!({
                    "project_id": "alpha",
                    "file_path": "src/example.txt",
                    "patches": "[{\"start_line\":3,\"end_line\":99,\"content\":\"tail\"}]"
                }),
                &tool_services,
            )
            .await
            .unwrap();
        assert_eq!(patched["success"], true);
        assert_eq!(
            std::fs::read_to_string(&project_file).unwrap(),
            "one\nTWO\ntail"
        );

        let listing = ProjectListFilesTool
            .execute(
                json!({ "project_id": "alpha", "dir_path": "src" }),
                &tool_services,
            )
            .await
            .unwrap();
        assert_eq!(listing["entries"][0]["path"], "src/example.txt");

        let deleted = ProjectDeleteFileTool
            .execute(
                json!({ "project_id": "alpha", "file_path": "src/example.txt" }),
                &tool_services,
            )
            .await
            .unwrap();
        assert_eq!(deleted["success"], true);
        assert!(!project_file.exists());

        assert!(ProjectWriteFileTool
            .execute(
                json!({ "project_id": "alpha", "file_path": "../outside.txt", "content": "no" }),
                &tool_services,
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn project_read_truncation_keeps_utf8_boundaries() {
        let temp = tempfile::tempdir().unwrap();
        let services = services(temp.path());
        let content = "你".repeat(20_000);
        let file = temp.path().join("projects/alpha/unicode.txt");
        std::fs::write(&file, content).unwrap();

        let result = ProjectReadFileTool
            .execute(
                json!({ "project_id": "alpha", "file_path": "unicode.txt" }),
                &services,
            )
            .await
            .unwrap();
        let shown = result["content"].as_str().unwrap();
        assert!(result["truncated"].as_bool().unwrap());
        assert!(shown.contains("truncated"));
        assert!(std::str::from_utf8(shown.as_bytes()).is_ok());
    }
}
