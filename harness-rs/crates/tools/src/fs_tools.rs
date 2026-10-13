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

/// Office 直写守卫（移植自 Electron 的 office-write-guard）：文本写入工具
/// 一律不得以 Office 二进制包为目标——无论文件是否已存在，全文重建都会
/// 损坏包内的图片与样式。
fn assert_text_tool_not_office_target(file_path: &str) -> Result<()> {
    let extension = file_path.rsplit('.').next().unwrap_or("").to_lowercase();
    if matches!(extension.as_str(), "docx" | "doc" | "pptx" | "ppt" | "xlsx" | "xls") {
        let file_name = file_path
            .split(['/', '\\'])
            .filter(|part| !part.is_empty())
            .last()
            .unwrap_or("document");
        anyhow::bail!("「{file_name}」是 Office 文档，文本写入工具无法处理（会损坏文件）。修改已有文档请使用 doc_draft 生成草稿；新建 Office 文档请使用 local_write_file 的 office_data 参数。");
    }
    Ok(())
}

/// Mirror the Electron SafeWriter: copy an existing file into the shared
/// `snapshots/_backups` directory before an overwrite. Best-effort — a backup
/// failure must never block the write. The snapshots directory sits next to
/// the projects directory under the host data root, matching
/// `<userData>/projects/<id>` beside `<userData>/snapshots`.
fn backup_project_file_before_overwrite(project_root: &Path, full: &Path) {
    let Some(projects_dir) = project_root.parent() else { return };
    let Some(user_data) = projects_dir.parent() else { return };
    let backup_dir = user_data.join("snapshots").join("_backups");
    if std::fs::create_dir_all(&backup_dir).is_err() {
        return;
    }
    let digest = {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        full.hash(&mut hasher);
        format!("{:016x}", hasher.finish())[..12].to_string()
    };
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let name = full
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    let _ = std::fs::copy(full, backup_dir.join(format!("{name}.{digest}.{millis}.bak")));
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
        // 已导入文档 / 已存在 Office 文件禁止直写，改走 doc_draft。
        crate::document_artifacts::ensure_document_write_allowed(&services.workspace, &full)?;
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
        "Modify a file in the specified project. A backup is created automatically."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_id": { "type": "string", "description": "Project ID" },
                "file_path": { "type": "string", "description": "File path relative to the project root" },
                "content": { "type": "string", "description": "Full file content" }
            },
            "required": ["project_id", "file_path", "content"]
        })
    }

    fn permission(&self) -> &str {
        "ask"
    }

    fn electron_native(&self) -> bool {
        true
    }

    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let (project_id, file_path, full) = project_file_path(&input, "file_path", services)?;
        let content = require_str(&input, "content")?;
        assert_text_tool_not_office_target(&file_path)?;
        if full.is_file() {
            let project_root = services.projects.project_root(&project_id)?;
            backup_project_file_before_overwrite(&project_root, &full);
        }
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
        // 已导入文档 / 已存在 Office 文件禁止直写，改走 doc_draft。
        crate::document_artifacts::ensure_document_write_allowed(&services.workspace, &full)?;
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
            "old_string was not found in {file_path}. It must match the current file content exactly (including whitespace) and must not include the line-number prefix from read_project_file. Re-read the file and copy the exact snippet."
        );
        let replace_all = input
            .get("replace_all")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        anyhow::ensure!(
            replace_all || occurrences == 1,
            "old_string is not unique in {file_path} ({occurrences} matches). Add more surrounding context to make it unique, or set replace_all: true to replace all {occurrences} occurrences."
        );
        let replacements = if replace_all { occurrences } else { 1 };
        let updated = if replace_all {
            original.replace(old, new)
        } else {
            original.replacen(old, new, 1)
        };
        assert_text_tool_not_office_target(&file_path)?;
        if full.is_file() {
            let project_id = input["project_id"].as_str().unwrap_or_default();
            let project_root = services.projects.project_root(project_id)?;
            backup_project_file_before_overwrite(&project_root, &full);
        }
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
        "Read file content from the specified project. Large files can be read in line-based segments via start_line / max_lines. Results are returned in `cat -n` format: each line is prefixed with a right-aligned line number and a tab, then the original content. Line numbers are 1-based and absolute within the file. When you later edit this file (edit_project_file / patch_project_file), do NOT include the line-number + tab prefix — match or write only the real file content that follows it. Defaults read up to 1000 lines (max 2000); small and medium files are returned in full in one call."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_id": { "type": "string", "description": "Project ID" },
                "file_path": { "type": "string", "description": "File path relative to the project root" },
                "start_line": { "type": "integer", "description": "Start line number (1-based). Use segments for large files." },
                "max_lines": { "type": "integer", "description": "Maximum lines to read. Default 1000, maximum 2000." }
            },
            "required": ["project_id", "file_path"]
        })
    }

    fn electron_native(&self) -> bool {
        true
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
                "content": "(This file exists but is empty — 0 lines.)",
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
        "List files and folders in the specified project directory."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_id": { "type": "string", "description": "Project ID" },
                "dir_path": { "type": "string", "description": "Directory path relative to the project root. Defaults to the project root." }
            },
            "required": ["project_id"]
        })
    }

    fn electron_native(&self) -> bool {
        true
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
        "Delete a single file from the specified project."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_id": { "type": "string", "description": "Project ID" },
                "file_path": { "type": "string", "description": "File path relative to the project root" }
            },
            "required": ["project_id", "file_path"]
        })
    }

    fn permission(&self) -> &str {
        "ask"
    }

    fn electron_native(&self) -> bool {
        true
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
        "Apply incremental line-range patches to a project file. Much more token-efficient than rewriting the whole file with write_project_file when only a few sections need to change. Patches are applied in reverse line order so that later patches do not shift the line numbers of earlier ones."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_id": { "type": "string", "description": "Project ID" },
                "file_path": { "type": "string", "description": "File path relative to the project root" },
                "patches": { "type": "array", "description": "Array of { start_line, end_line, content } patches. Lines are 1-based inclusive; end_line < start_line inserts before start_line.", "items": { "type": "object", "properties": { "start_line": { "type": "integer" }, "end_line": { "type": "integer" }, "content": { "type": "string" } }, "required": ["start_line", "end_line", "content"] } }
            },
            "required": ["project_id", "file_path", "patches"]
        })
    }

    fn permission(&self) -> &str {
        "ask"
    }

    fn electron_native(&self) -> bool {
        true
    }

    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        const SHAPE: &str = "patches must be an array of { start_line, end_line, content } objects.";
        let (project_id, file_path, full) = project_file_path(&input, "file_path", services)?;
        anyhow::ensure!(!file_path.trim().is_empty(), "file_path is required");

        let raw = input.get("patches").ok_or_else(|| anyhow::anyhow!("{SHAPE}"))?;
        let array = if let Some(array) = raw.as_array() {
            array.clone()
        } else if let Some(text) = raw.as_str() {
            let parsed: Value = serde_json::from_str(text).map_err(|_| anyhow::anyhow!("{SHAPE}"))?;
            parsed.as_array().cloned().ok_or_else(|| anyhow::anyhow!("{SHAPE}"))?
        } else {
            anyhow::bail!("{SHAPE}");
        };
        let mut patches = Vec::with_capacity(array.len());
        for (index, entry) in array.iter().enumerate() {
            let Some(object) = entry.as_object() else {
                anyhow::bail!("patches[{index}] must be an object with start_line, end_line, and content.");
            };
            let number = |key: &str| -> Option<f64> {
                match object.get(key) {
                    Some(Value::Number(number)) => number.as_f64(),
                    Some(Value::String(text)) => text.trim().parse::<f64>().ok(),
                    _ => None,
                }
            };
            let start_line = number("start_line")
                .ok_or_else(|| anyhow::anyhow!("patches[{index}].start_line must be a positive integer."))?;
            let end_line = number("end_line")
                .ok_or_else(|| anyhow::anyhow!("patches[{index}].end_line must be an integer."))?;
            let Some(content) = object.get("content").and_then(Value::as_str) else {
                anyhow::bail!("patches[{index}].content must be a string.");
            };
            anyhow::ensure!(
                start_line.is_finite() && start_line >= 1.0,
                "patches[{index}].start_line must be a positive integer."
            );
            anyhow::ensure!(
                end_line.is_finite(),
                "patches[{index}].end_line must be an integer."
            );
            patches.push((start_line.floor() as usize, end_line.floor() as usize, content.to_string()));
        }
        anyhow::ensure!(
            !patches.is_empty(),
            "patch_project_file requires at least one patch entry."
        );

        let original = tokio::fs::read_to_string(&full).await?;
        let mut lines: Vec<String> = original.split('\n').map(ToOwned::to_owned).collect();
        let total_lines = lines.len();
        patches.sort_by(|left, right| right.0.cmp(&left.0));
        for index in 0..patches.len().saturating_sub(1) {
            let (current_start, current_end, _) = patches[index];
            let (next_start, next_end, _) = patches[index + 1];
            let current_effective_start = current_start.max(1);
            let next_effective_end = if next_end < next_start { next_start - 1 } else { next_end };
            anyhow::ensure!(
                next_effective_end < current_effective_start,
                "Patches overlap: lines {next_start}-{next_end} and {current_start}-{current_end}. Split into non-overlapping ranges."
            );
        }
        for (start_line, end_line, content) in &patches {
            let start_index = (start_line - 1).min(total_lines);
            let is_insert = end_line < start_line;
            let end_index = if is_insert { start_index } else { (*end_line).min(total_lines) };
            let replacement: Vec<String> = if content.is_empty() {
                Vec::new()
            } else {
                content.split('\n').map(ToOwned::to_owned).collect()
            };
            if is_insert || end_index < start_index {
                lines.splice(start_index..start_index, replacement);
            } else {
                lines.splice(start_index..end_index, replacement);
            }
        }
        let new_lines = lines.len();

        assert_text_tool_not_office_target(&file_path)?;
        if full.is_file() {
            let project_root = services.projects.project_root(&project_id)?;
            backup_project_file_before_overwrite(&project_root, &full);
        }
        tokio::fs::write(&full, lines.join("\n")).await?;
        let patches_applied = patches.len();
        Ok(json!({
            "success": true,
            "file_path": file_path,
            "patches_applied": patches_applied,
            "original_lines": total_lines,
            "new_lines": new_lines,
            "message": format!("Applied {patches_applied} patch(es) to {file_path}. File went from {total_lines} to {new_lines} lines.")
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

#[cfg(test)]
mod project_native_parity_tests {
    use super::{
        ProjectDeleteFileTool, ProjectEditFileTool, ProjectListFilesTool,
        ProjectPatchFileTool, ProjectReadFileTool, ProjectWriteFileTool,
    };
    use crate::{Tool, ToolServices};
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    fn services(root: &std::path::Path) -> ToolServices {
        let workspace = root.join("projects");
        std::fs::create_dir_all(workspace.join("alpha")).unwrap();
        let store = Arc::new(worldbase_memory::Store::open(&root.join("store.sqlite")).unwrap());
        ToolServices {
            host: Arc::new(crate::HostBridge::new()),
            current_stream: Arc::new(Mutex::new(String::new())),
            abort: None,
            workspace: workspace.clone(),
            folder_workspace: None,
            target_project_id: None,
            created_project_id: Arc::new(std::sync::Mutex::new(None)),
            allowed_mcp_server_ids: None,
            plan_goal: Arc::new(Mutex::new(None)),
            todo_items: Arc::new(Mutex::new(Vec::new())),
            read_files: Arc::new(Mutex::new(std::collections::HashSet::new())),
            visible_tool_catalog: None,
            store: store.clone(),
            memory_queue: None,
            memory_scopes: Vec::new(),
            skills: Arc::new(worldbase_skills::SkillRegistry::new(vec![])),
            scheduler: Arc::new(worldbase_scheduler::Scheduler::new(store)),
            mcp: Arc::new(worldbase_mcp_client::McpManager::default()),
            projects: Arc::new(worldbase_project_runtime::ProjectRuntime::new(workspace)),
            group_collaboration: None,
            subagent_runtime: None,
        }
    }

    #[tokio::test]
    async fn write_project_file_blocks_office_targets_like_electron_guard() {
        let temp = tempfile::tempdir().unwrap();
        let service = services(temp.path());
        let blocked = ProjectWriteFileTool
            .execute(
                json!({ "project_id": "alpha", "file_path": "docs/report.docx", "content": "x" }),
                &service,
            )
            .await;
        assert!(blocked
            .unwrap_err()
            .to_string()
            .contains("「report.docx」是 Office 文档，文本写入工具无法处理（会损坏文件）"));

        let ok = ProjectWriteFileTool
            .execute(
                json!({ "project_id": "alpha", "file_path": "src/main.ts", "content": "const a = 1;\n" }),
                &service,
            )
            .await
            .unwrap();
        assert_eq!(ok["message"], "File src/main.ts written successfully");
    }

    #[tokio::test]
    async fn write_project_file_backs_up_existing_file_before_overwrite() {
        let temp = tempfile::tempdir().unwrap();
        let service = services(temp.path());
        ProjectWriteFileTool
            .execute(
                json!({ "project_id": "alpha", "file_path": "notes.txt", "content": "v1" }),
                &service,
            )
            .await
            .unwrap();
        ProjectWriteFileTool
            .execute(
                json!({ "project_id": "alpha", "file_path": "notes.txt", "content": "v2" }),
                &service,
            )
            .await
            .unwrap();

        let backups = temp.path().join("snapshots").join("_backups");
        let entries: Vec<_> = std::fs::read_dir(backups)
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(entries.len(), 1, "one .bak file expected");
        assert!(
            entries[0].file_name().to_string_lossy().starts_with("notes.txt."),
            "backup keeps the original file name prefix"
        );
        assert_eq!(std::fs::read_to_string(entries[0].path()).unwrap(), "v1");
    }

    #[tokio::test]
    async fn edit_project_file_enforces_read_first_and_electron_messages() {
        let temp = tempfile::tempdir().unwrap();
        let service = services(temp.path());
        std::fs::write(temp.path().join("projects/alpha/dup.txt"), "dup and dup").unwrap();

        let denied = ProjectEditFileTool
            .execute(
                json!({ "project_id": "alpha", "file_path": "dup.txt", "old_string": "dup", "new_string": "hi" }),
                &service,
            )
            .await;
        assert!(denied
            .unwrap_err()
            .to_string()
            .contains("You must read dup.txt with read_project_file before editing it, so the edit matches its current content."));

        ProjectReadFileTool
            .execute(json!({ "project_id": "alpha", "file_path": "dup.txt" }), &service)
            .await
            .unwrap();

        let ambiguous = ProjectEditFileTool
            .execute(
                json!({ "project_id": "alpha", "file_path": "dup.txt", "old_string": "dup", "new_string": "hi" }),
                &service,
            )
            .await;
        assert!(ambiguous
            .unwrap_err()
            .to_string()
            .contains("old_string is not unique in dup.txt (2 matches). Add more surrounding context to make it unique, or set replace_all: true to replace all 2 occurrences."));

        let replaced = ProjectEditFileTool
            .execute(
                json!({ "project_id": "alpha", "file_path": "dup.txt", "old_string": "dup", "new_string": "hi", "replace_all": true }),
                &service,
            )
            .await
            .unwrap();
        assert_eq!(replaced["replacements"], 2);
        assert_eq!(replaced["message"], "Replaced 2 occurrence(s) in dup.txt.");
    }

    #[tokio::test]
    async fn patch_project_file_rejects_overlap_and_office_targets() {
        let temp = tempfile::tempdir().unwrap();
        let service = services(temp.path());
        std::fs::write(temp.path().join("projects/alpha/list.txt"), "a\nb\nc\nd").unwrap();

        let overlap = ProjectPatchFileTool
            .execute(
                json!({ "project_id": "alpha", "file_path": "list.txt", "patches": [
                    { "start_line": 1, "end_line": 2, "content": "X" },
                    { "start_line": 2, "end_line": 3, "content": "Y" }
                ] }),
                &service,
            )
            .await;
        assert!(overlap
            .unwrap_err()
            .to_string()
            .contains("Patches overlap: lines 1-2 and 2-3. Split into non-overlapping ranges."));

        let applied = ProjectPatchFileTool
            .execute(
                json!({ "project_id": "alpha", "file_path": "list.txt", "patches": [
                    { "start_line": 1, "end_line": 2, "content": "X" },
                    { "start_line": 4, "end_line": 4, "content": "" }
                ] }),
                &service,
            )
            .await
            .unwrap();
        assert_eq!(applied["patches_applied"], 2);
        assert_eq!(
            applied["message"],
            "Applied 2 patch(es) to list.txt. File went from 4 to 2 lines."
        );

        // The office guard fires after the read, exactly like the Electron
        // handler: an existing (readable) Office target is refused.
        std::fs::write(temp.path().join("projects/alpha/book.xlsx"), "PK").unwrap();
        let office = ProjectPatchFileTool
            .execute(
                json!({ "project_id": "alpha", "file_path": "book.xlsx", "patches": [
                    { "start_line": 1, "end_line": 1, "content": "X" }
                ] }),
                &service,
            )
            .await;
        assert!(office
            .unwrap_err()
            .to_string()
            .contains("是 Office 文档，文本写入工具无法处理"));
    }

    #[tokio::test]
    async fn read_project_file_uses_electron_empty_placeholder_and_paging() {
        let temp = tempfile::tempdir().unwrap();
        let service = services(temp.path());
        std::fs::write(temp.path().join("projects/alpha/empty.md"), "").unwrap();
        std::fs::write(temp.path().join("projects/alpha/app.txt"), "l1\nl2\nl3").unwrap();

        let empty = ProjectReadFileTool
            .execute(json!({ "project_id": "alpha", "file_path": "empty.md" }), &service)
            .await
            .unwrap();
        assert_eq!(
            empty["content"],
            "(This file exists but is empty \u{2014} 0 lines.)"
        );

        let segment = ProjectReadFileTool
            .execute(
                json!({ "project_id": "alpha", "file_path": "app.txt", "start_line": 2, "max_lines": 1 }),
                &service,
            )
            .await
            .unwrap();
        assert_eq!(segment["content"], "     2\tl2");
        assert_eq!(segment["has_more"], true);
        assert_eq!(segment["next_start_line"], 3);
    }

    #[tokio::test]
    async fn delete_and_list_project_files_match_electron_shapes() {
        let temp = tempfile::tempdir().unwrap();
        let service = services(temp.path());
        std::fs::write(temp.path().join("projects/alpha/gone.txt"), "x").unwrap();

        let deleted = ProjectDeleteFileTool
            .execute(json!({ "project_id": "alpha", "file_path": "gone.txt" }), &service)
            .await
            .unwrap();
        assert_eq!(deleted["message"], "File gone.txt deleted successfully");

        let skipped = ProjectDeleteFileTool
            .execute(json!({ "project_id": "alpha", "file_path": "gone.txt" }), &service)
            .await
            .unwrap();
        assert_eq!(skipped["skipped"], true);
        assert_eq!(skipped["message"], "File gone.txt does not exist");

        std::fs::create_dir_all(temp.path().join("projects/alpha/src")).unwrap();
        std::fs::write(temp.path().join("projects/alpha/src/index.ts"), "").unwrap();
        std::fs::create_dir_all(temp.path().join("projects/alpha/.hidden")).unwrap();
        std::fs::write(temp.path().join("projects/alpha/stay.txt"), "").unwrap();
        let listing = ProjectListFilesTool
            .execute(json!({ "project_id": "alpha" }), &service)
            .await
            .unwrap();
        let names: Vec<&str> = listing["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["name"].as_str().unwrap())
            .collect();
        // node_modules and dot entries are skipped, entries sort by name.
        assert_eq!(names, vec!["src", "stay.txt"]);
    }
}
