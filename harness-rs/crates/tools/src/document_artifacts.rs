//! Durable document artifacts shared by direct RPC and Agent tools.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

const DEFAULT_CHUNK_CHARS: usize = 12_000;
const MIN_CHUNK_CHARS: usize = 2_000;
const MAX_CHUNK_CHARS: usize = 30_000;
/// File names are metadata for virtual artifacts, but they are still sent to
/// the Electron/Flutter document workbench. Keep them bounded to the same
/// practical single-component limit used by common filesystems and strip
/// path-like input before persisting them.
pub const MAX_DOCUMENT_FILE_NAME_BYTES: usize = 255;
/// Keep document imports aligned with Electron's workbench limit.  The
/// parser reads the source into memory, so this is also an important safety
/// bound for direct/mobile JSON-RPC callers.
pub const MAX_DOCUMENT_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub text: String,
    pub level: i32,
    pub page_index: i32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<DocumentNode>,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub meta: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentArtifact {
    pub id: String,
    pub file_path: String,
    pub file_name: String,
    pub file_type: String,
    pub file_size: u64,
    pub plain_text: String,
    #[serde(default)]
    pub nodes: Vec<DocumentNode>,
    #[serde(default)]
    pub parsed: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub render: Option<Value>,
    /// Pending AI-authored draft for this artifact.  The draft bytes live in
    /// the workspace-owned draft directory; the original file is untouched
    /// until the user explicitly applies or saves the draft elsewhere.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft: Option<Value>,
    pub imported_at: String,
}

/// A user-created document selection/annotation.
///
/// Electron keeps selections in a process-local `DocumentStore`. Rust owns
/// its artifacts on disk, so selections live in a small sibling JSON store to
/// survive harness restarts and remain visible to Flutter callers.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionRegion {
    pub id: String,
    pub artifact_id: String,
    pub node_ids: Vec<String>,
    pub label: String,
    pub color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<String>,
    pub created_at: String,
}

fn artifact_dir(workspace: &Path) -> PathBuf {
    workspace.join(".worldbase").join("document-artifacts")
}

fn selection_store_path(workspace: &Path) -> PathBuf {
    workspace
        .join(".worldbase")
        .join("document-selections.json")
}

fn selection_store_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub fn valid_artifact_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn artifact_path(workspace: &Path, id: &str) -> Result<PathBuf> {
    anyhow::ensure!(valid_artifact_id(id), "invalid document artifact id");
    Ok(artifact_dir(workspace).join(format!("{id}.json")))
}

fn inferred_node_count(artifact: &DocumentArtifact) -> usize {
    if !artifact.nodes.is_empty() {
        return artifact.nodes.len();
    }
    let parsed = &artifact.parsed;
    let text = &artifact.plain_text;
    for key in ["items", "sheets", "nodes"] {
        if let Some(values) = parsed.get(key).and_then(Value::as_array) {
            return values.len();
        }
    }
    for key in ["pages", "paragraphs", "slides"] {
        if let Some(value) = parsed.get(key).and_then(Value::as_u64) {
            return value as usize;
        }
    }
    text.lines().filter(|line| !line.trim().is_empty()).count()
}

fn text_node(
    id: impl Into<String>,
    node_type: &str,
    text: impl Into<String>,
    level: i32,
    page_index: i32,
) -> DocumentNode {
    DocumentNode {
        id: id.into(),
        node_type: node_type.to_string(),
        text: text.into(),
        level,
        page_index,
        children: Vec::new(),
        meta: Value::Object(serde_json::Map::new()),
    }
}

fn normalize_pdf_paragraphs(text: &str) -> Vec<String> {
    text.split("\n\n")
        .map(|paragraph| {
            paragraph
                .chars()
                .map(|character| {
                    if character.is_whitespace() {
                        ' '
                    } else {
                        character
                    }
                })
                .collect::<String>()
                .trim()
                .to_string()
        })
        .filter(|paragraph| !paragraph.is_empty())
        .collect()
}

fn pdf_page_texts(parsed: &Value, plain_text: &str) -> Vec<(i32, String)> {
    if let Some(items) = parsed
        .get("items")
        .and_then(Value::as_array)
        .or_else(|| parsed.get("pageItems").and_then(Value::as_array))
    {
        return items
            .iter()
            .enumerate()
            .map(|(index, page)| {
                let number = page
                    .get("number")
                    .or_else(|| page.get("num"))
                    .and_then(Value::as_u64)
                    .unwrap_or(index as u64 + 1)
                    .clamp(1, i32::MAX as u64) as i32;
                let text = page
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                (number, text)
            })
            .collect();
    }

    let page_count = parsed
        .get("pages")
        .and_then(Value::as_u64)
        .map(|count| count.min(i32::MAX as u64) as usize)
        .unwrap_or(0);
    if page_count == 0 {
        return if plain_text.trim().is_empty() {
            Vec::new()
        } else {
            vec![(1, plain_text.to_string())]
        };
    }

    // Artifacts written by the first parser only carried a numeric page count
    // and a concatenated text field.  Preserve all text in the first page when
    // a reliable page delimiter is unavailable, while retaining empty page
    // nodes for the remaining pages.
    let mut page_texts = plain_text
        .split('\u{000c}')
        .map(str::to_string)
        .collect::<Vec<_>>();
    if page_texts.len() != page_count {
        page_texts = if page_count == 1 {
            vec![plain_text.to_string()]
        } else {
            let mut values = vec![String::new(); page_count];
            values[0] = plain_text.to_string();
            values
        };
    }
    page_texts
        .into_iter()
        .enumerate()
        .map(|(index, text)| (index as i32 + 1, text))
        .collect()
}

/// Convert the parser-native payload into the node tree expected by the
/// Electron document workbench.  This intentionally stays deterministic and
/// dependency-free: native parsers remain the source of truth while this
/// adapter supplies stable IDs for selection and preview clients.
fn build_document_nodes(parsed: &Value, file_type: &str, plain_text: &str) -> Vec<DocumentNode> {
    match file_type {
        "xlsx" | "xls" => parsed
            .get("sheets")
            .and_then(Value::as_array)
            .map(|sheets| {
                sheets
                    .iter()
                    .enumerate()
                    .map(|(sheet_index, sheet)| {
                        let name = sheet.get("name").and_then(Value::as_str).unwrap_or("Sheet");
                        let children = sheet
                            .get("rows")
                            .and_then(Value::as_array)
                            .map(|rows| {
                                rows.iter()
                                    .enumerate()
                                    .map(|(row_index, row)| {
                                        let cells = row.as_array().cloned().unwrap_or_default();
                                        let text = cells
                                            .iter()
                                            .map(value_to_text)
                                            .collect::<Vec<_>>()
                                            .join("\t");
                                        let mut node = text_node(
                                            format!(
                                                "sheet-{}-row-{}",
                                                sheet_index + 1,
                                                row_index + 1
                                            ),
                                            "table_row",
                                            text,
                                            1,
                                            sheet_index as i32 + 1,
                                        );
                                        node.meta = json!({
                                            "sheetName": name,
                                            "rowIndex": row_index + 1,
                                            "cells": cells,
                                        });
                                        node
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        let mut node = text_node(
                            format!("sheet-{}", sheet_index + 1),
                            "sheet",
                            name,
                            0,
                            sheet_index as i32 + 1,
                        );
                        node.children = children;
                        node.meta = json!({ "sheetName": name, "sheetIndex": sheet_index + 1 });
                        node
                    })
                    .collect()
            })
            .unwrap_or_default(),
        "pptx" | "ppt" => parsed
            .get("items")
            .and_then(Value::as_array)
            .map(|slides| {
                slides
                    .iter()
                    .enumerate()
                    .map(|(index, slide)| {
                        let number = slide
                            .get("number")
                            .and_then(Value::as_u64)
                            .unwrap_or(index as u64 + 1)
                            as i32;
                        let paragraphs = slide
                            .get("paragraphs")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        let children = paragraphs
                            .iter()
                            .enumerate()
                            .filter_map(|(paragraph_index, value)| {
                                value.as_str().map(|text| {
                                    text_node(
                                        format!(
                                            "slide-{}-paragraph-{}",
                                            number,
                                            paragraph_index + 1
                                        ),
                                        "paragraph",
                                        text,
                                        1,
                                        number,
                                    )
                                })
                            })
                            .collect::<Vec<_>>();
                        let text = children
                            .iter()
                            .map(|node| node.text.as_str())
                            .collect::<Vec<_>>()
                            .join("\n");
                        let mut node =
                            text_node(format!("slide-{}", number), "slide", text, 0, number);
                        node.children = children;
                        node.meta = json!({ "slideNumber": number });
                        node
                    })
                    .collect()
            })
            .unwrap_or_default(),
        "docx" | "doc" => parsed
            .get("paragraphs")
            .and_then(Value::as_array)
            .map(|paragraphs| {
                let metadata = parsed.get("paragraphMetadata").and_then(Value::as_array);
                paragraphs
                    .iter()
                    .enumerate()
                    .filter_map(|(paragraph_index, value)| {
                        let text = value.as_str()?.to_string();
                        let metadata_value =
                            metadata.and_then(|values| values.get(paragraph_index));
                        let node_type = metadata_value
                            .and_then(|value| value.get("type"))
                            .and_then(Value::as_str)
                            .filter(|value| matches!(*value, "heading" | "paragraph" | "list_item"))
                            .unwrap_or("paragraph");
                        let level = metadata_value
                            .and_then(|value| value.get("level"))
                            .and_then(Value::as_i64)
                            .unwrap_or(0)
                            .clamp(0, i32::MAX as i64) as i32;
                        let source_index = metadata_value
                            .and_then(|value| value.get("docxParagraphIndex"))
                            .and_then(Value::as_u64)
                            .map(|value| value.min(i32::MAX as u64) as i32)
                            .unwrap_or(paragraph_index.min(i32::MAX as usize) as i32);
                        let style = metadata_value
                            .and_then(|value| value.get("paragraphStyle"))
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let part = metadata_value
                            .and_then(|value| value.get("docxPart"))
                            .and_then(Value::as_str)
                            .filter(|value| !value.trim().is_empty())
                            .unwrap_or("word/document.xml");
                        let mut node = text_node(
                            format!("paragraph-{}", paragraph_index + 1),
                            node_type,
                            text,
                            level,
                            1,
                        );
                        node.meta = json!({
                            "docxPart": part,
                            "docxParagraphIndex": source_index,
                            "paragraphStyle": style,
                        });
                        Some(node)
                    })
                    .collect()
            })
            .unwrap_or_default(),
        "csv" => {
            let header = parsed
                .get("header")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let mut children = Vec::new();
            if !header.is_empty() {
                let mut header_node = text_node(
                    "table-header",
                    "table_row",
                    header
                        .iter()
                        .map(value_to_text)
                        .collect::<Vec<_>>()
                        .join("\t"),
                    1,
                    1,
                );
                header_node.meta = json!({ "header": true, "cells": header });
                children.push(header_node);
            }
            if let Some(rows) = parsed.get("rows").and_then(Value::as_array) {
                children.extend(rows.iter().enumerate().map(|(index, row)| {
                    let cells = row.as_array().cloned().unwrap_or_default();
                    let mut node = text_node(
                        format!("table-row-{}", index + 1),
                        "table_row",
                        cells
                            .iter()
                            .map(value_to_text)
                            .collect::<Vec<_>>()
                            .join("\t"),
                        1,
                        1,
                    );
                    node.meta = json!({ "rowIndex": index + 1, "cells": cells });
                    node
                }));
            }
            if children.is_empty() && !plain_text.trim().is_empty() {
                children.push(text_node("table-text", "paragraph", plain_text, 0, 1));
            }
            if children.is_empty() {
                Vec::new()
            } else {
                let mut table = text_node("table", "table", plain_text, 0, 1);
                table.children = children;
                vec![table]
            }
        }
        "pdf" => pdf_page_texts(parsed, plain_text)
            .into_iter()
            .map(|(number, page_text)| {
                let paragraphs = normalize_pdf_paragraphs(&page_text);
                let child_texts = if paragraphs.is_empty() {
                    vec!["(无文本内容)".to_string()]
                } else {
                    paragraphs
                };
                let children = child_texts
                    .into_iter()
                    .enumerate()
                    .map(|(paragraph_index, text)| {
                        text_node(
                            format!("page-{}-paragraph-{}", number, paragraph_index + 1),
                            "paragraph",
                            text,
                            1,
                            number,
                        )
                    })
                    .collect::<Vec<_>>();
                let mut node = text_node(
                    format!("page-{}", number),
                    "page",
                    format!("第 {} 页", number),
                    0,
                    number,
                );
                node.children = children;
                node.meta = json!({ "pageNumber": number });
                node
            })
            .collect(),
        "markdown" | "md" => plain_text
            .lines()
            .enumerate()
            .filter(|(_, line)| !line.trim().is_empty())
            .map(|(index, line)| {
                let trimmed = line.trim_start();
                let hashes = trimmed.chars().take_while(|ch| *ch == '#').count();
                let (node_type, level, text) =
                    if hashes > 0 && trimmed.chars().nth(hashes) == Some(' ') {
                        (
                            "heading",
                            hashes as i32,
                            trimmed[hashes..].trim().to_string(),
                        )
                    } else if trimmed.starts_with("- ") || trimmed.starts_with("* ") {
                        ("list_item", 0, trimmed[2..].trim().to_string())
                    } else {
                        ("paragraph", 0, line.to_string())
                    };
                text_node(format!("line-{}", index + 1), node_type, text, level, 1)
            })
            .collect(),
        _ => plain_text
            .lines()
            .enumerate()
            .filter(|(_, line)| !line.trim().is_empty())
            .map(|(index, line)| text_node(format!("line-{}", index + 1), "paragraph", line, 0, 1))
            .collect(),
    }
}

fn value_to_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.clone(),
        other => other.to_string(),
    }
}

fn write_artifact(workspace: &Path, artifact: &DocumentArtifact) -> Result<()> {
    let directory = artifact_dir(workspace);
    std::fs::create_dir_all(&directory)
        .with_context(|| format!("create document artifact directory {}", directory.display()))?;
    let target = artifact_path(workspace, &artifact.id)?;
    let temporary = directory.join(format!(".{}.{}.tmp", artifact.id, uuid::Uuid::new_v4()));
    std::fs::write(&temporary, serde_json::to_vec_pretty(artifact)?)
        .with_context(|| format!("write document artifact {}", temporary.display()))?;
    if let Err(error) = std::fs::rename(&temporary, &target) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error)
            .with_context(|| format!("commit document artifact {}", target.display()));
    }
    Ok(())
}

fn artifact_source_path(workspace: &Path, artifact: &DocumentArtifact) -> PathBuf {
    let source = Path::new(&artifact.file_path);
    if source.is_absolute() {
        source.to_path_buf()
    } else {
        workspace.join(source)
    }
}

/// Convert an internal artifact/source path into the path exposed to a
/// renderer or mobile client.  The artifact store keeps the canonical source
/// path internally because desktop host callbacks need to open/stat the real
/// file, but transport DTOs must not leak a machine-specific absolute path.
fn public_path(workspace: &Path, raw: &str) -> String {
    let raw = raw.trim();
    if raw.is_empty() {
        return String::new();
    }
    let path = Path::new(raw);
    if !path.is_absolute() {
        return raw.replace('\\', "/");
    }

    let workspace = workspace
        .canonicalize()
        .unwrap_or_else(|_| workspace.to_path_buf());
    // macOS commonly exposes the same temporary directory as both `/var`
    // and `/private/var`. Normalize both sides before containment checks so a
    // workspace-owned render is not mistaken for an external file.
    let resolved_path = path
        .canonicalize()
        .or_else(|_| canonicalize_existing_ancestor(path))
        .unwrap_or_else(|_| path.to_path_buf());
    if let Ok(relative) = resolved_path.strip_prefix(&workspace) {
        return relative.to_string_lossy().replace('\\', "/");
    }

    // Sources outside the managed workspace are still useful as a display
    // label, but exposing their parent directories leaks local machine paths.
    resolved_path
        .file_name()
        .and_then(|name| name.to_str())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| "document".to_string())
}

/// Serialize the public artifact DTO.  Internal artifact JSON remains
/// path-complete for Rust's own persistence and host callbacks; this helper is
/// the only shape that should cross doc.* RPC boundaries.
pub fn artifact_public_value(workspace: &Path, artifact: &DocumentArtifact) -> Value {
    let mut value = serde_json::to_value(artifact).unwrap_or_else(|_| json!({}));
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "filePath".into(),
            Value::String(public_path(workspace, &artifact.file_path)),
        );
        if let Some(render) = object.get_mut("render").and_then(Value::as_object_mut) {
            if let Some(asset_path) = render.get("assetPath").and_then(Value::as_str) {
                render.insert(
                    "assetPath".into(),
                    Value::String(public_path(workspace, asset_path)),
                );
            }
        }
        if let Some(draft) = object.get_mut("draft").and_then(Value::as_object_mut) {
            if let Some(draft_path) = draft.get("path").and_then(Value::as_str) {
                draft.insert(
                    "path".into(),
                    Value::String(public_path(workspace, draft_path)),
                );
            }
        }
    }
    value
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes.min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

/// Normalize a file name that came from a virtual document (for example the
/// active browser page). `Path::file_name` only recognizes the host platform's
/// separator, while these values can originate from a different platform or
/// from an untrusted JSON caller, so handle both separators explicitly.
fn normalize_file_name(raw: &str) -> String {
    let basename = raw
        .trim()
        .rsplit(|character| character == '/' || character == '\\')
        .next()
        .unwrap_or_default();
    let cleaned = basename
        .chars()
        .filter(|character| !character.is_control())
        .collect::<String>();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return "current-page.txt".to_string();
    }
    let truncated = truncate_utf8(cleaned, MAX_DOCUMENT_FILE_NAME_BYTES);
    if truncated.is_empty() {
        "current-page.txt".to_string()
    } else {
        truncated
    }
}

/// Resolve and validate an imported source at the artifact boundary. The RPC
/// dispatcher performs the same checks for useful invalid-params errors, but
/// this function is also called by Agent tools and may be called directly by
/// an FFI host, so it must not trust its callers.
fn validated_source_file(source_path: &Path) -> Result<(PathBuf, std::fs::Metadata)> {
    let canonical = source_path
        .canonicalize()
        .with_context(|| format!("resolve document source {}", source_path.display()))?;
    let metadata = std::fs::metadata(&canonical)
        .with_context(|| format!("stat document source {}", canonical.display()))?;
    anyhow::ensure!(
        metadata.is_file(),
        "document source is not a regular file: {}",
        canonical.display()
    );
    anyhow::ensure!(
        metadata.len() <= MAX_DOCUMENT_BYTES,
        "document source is too large (maximum {} bytes)",
        MAX_DOCUMENT_BYTES
    );
    Ok((canonical, metadata))
}

fn is_virtual_artifact(artifact: &DocumentArtifact) -> bool {
    artifact.parsed.get("_sourceKind").and_then(Value::as_str) == Some("virtual")
}

fn render_cache_dir(workspace: &Path) -> PathBuf {
    workspace.join(".worldbase").join("document-render-cache")
}

/// Resolve a render asset without allowing an artifact JSON payload to turn
/// `doc.preview.read` into an arbitrary file reader.  Original source bytes
/// are allowed only when the descriptor points at the artifact's own source;
/// generated assets must live below the dedicated render cache directory.
fn safe_render_asset_path(
    workspace: &Path,
    artifact: &DocumentArtifact,
    raw_asset_path: &str,
) -> Result<PathBuf> {
    anyhow::ensure!(
        !is_virtual_artifact(artifact),
        "virtual documents have no render asset"
    );
    let raw = Path::new(raw_asset_path);
    let candidate = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        workspace.join(raw)
    };
    // A stale descriptor may point at a cache file that has not been
    // recreated yet. Resolve the existing ancestor in that case so callers
    // can distinguish a missing asset (regenerate it) from an escaping or
    // otherwise invalid path (reject it).
    let canonical_asset = if candidate.exists() {
        candidate
            .canonicalize()
            .with_context(|| format!("resolve document render asset {}", candidate.display()))?
    } else {
        canonicalize_existing_ancestor(&candidate)
            .with_context(|| format!("resolve document render asset {}", candidate.display()))?
    };

    let source = artifact_source_path(workspace, artifact);
    let source_matches = source
        .canonicalize()
        .map(|canonical_source| canonical_source == canonical_asset)
        .unwrap_or(false);

    // The render cache may not exist yet when a caller first constructs a
    // descriptor. Resolve its nearest existing ancestor so the containment
    // check remains deterministic instead of silently turning into `false`
    // solely because the cache directory has not been created.
    let cache_matches = canonicalize_existing_ancestor(&render_cache_dir(workspace))
        .map(|cache_root| canonical_asset.starts_with(cache_root))
        .unwrap_or(false);

    anyhow::ensure!(
        source_matches || cache_matches,
        "document render asset path is outside the document source or render cache"
    );
    Ok(canonical_asset)
}

fn canonicalize_existing_ancestor(path: &Path) -> Result<PathBuf> {
    let mut existing = path.to_path_buf();
    let mut missing = Vec::new();
    while !existing.exists() {
        let Some(name) = existing.file_name().map(|name| name.to_os_string()) else {
            anyhow::bail!("invalid path: {}", path.display());
        };
        missing.push(name);
        let Some(parent) = existing.parent() else {
            anyhow::bail!("invalid path: {}", path.display());
        };
        existing = parent.to_path_buf();
    }
    let mut resolved = existing.canonicalize()?;
    for component in missing.iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
}

pub fn import_parsed_document(
    workspace: &Path,
    source_path: &Path,
    parsed: &Value,
) -> Result<DocumentArtifact> {
    let (source_path, source_metadata) = validated_source_file(source_path)?;
    let text = parsed
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let file_type = parsed
        .get("kind")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| source_path.extension().and_then(|value| value.to_str()))
        .unwrap_or("text")
        .to_string();
    let nodes = build_document_nodes(
        parsed,
        &file_type,
        parsed
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    let artifact = DocumentArtifact {
        id: uuid::Uuid::new_v4().to_string(),
        file_path: source_path.to_string_lossy().into_owned(),
        file_name: normalize_file_name(
            &source_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("document"),
        ),
        file_type: file_type.clone(),
        file_size: source_metadata.len(),
        plain_text: text,
        nodes,
        parsed: parsed.clone(),
        render: None,
        draft: None,
        imported_at: worldbase_protocol::event::now_rfc3339(),
    };
    write_artifact(workspace, &artifact)?;
    Ok(artifact)
}

pub fn import_text_document(
    workspace: &Path,
    file_name: &str,
    text: &str,
) -> Result<DocumentArtifact> {
    let file_name = normalize_file_name(file_name);
    let file_type = Path::new(&file_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("text")
        .to_string();
    let parsed = json!({ "kind": file_type, "text": text, "_sourceKind": "virtual" });
    let nodes = build_document_nodes(&parsed, &file_type, text);
    let artifact = DocumentArtifact {
        id: uuid::Uuid::new_v4().to_string(),
        file_path: file_name.to_string(),
        file_name: file_name.to_string(),
        file_type,
        file_size: text.len() as u64,
        plain_text: text.to_string(),
        nodes,
        parsed,
        render: None,
        draft: None,
        imported_at: worldbase_protocol::event::now_rfc3339(),
    };
    write_artifact(workspace, &artifact)?;
    Ok(artifact)
}

pub fn get_document(workspace: &Path, id: &str) -> Result<Option<DocumentArtifact>> {
    let path = artifact_path(workspace, id)?;
    let raw = match std::fs::read(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| format!("read document artifact {}", path.display()))
        }
    };
    Ok(Some(serde_json::from_slice(&raw).with_context(|| {
        format!("parse document artifact {}", path.display())
    })?))
}

pub fn list_documents(workspace: &Path) -> Result<Vec<DocumentArtifact>> {
    let directory = artifact_dir(workspace);
    let entries = match std::fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("list document artifacts {}", directory.display()))
        }
    };
    let mut artifacts = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("json"))
        .filter_map(|entry| std::fs::read(entry.path()).ok())
        .filter_map(|raw| serde_json::from_slice::<DocumentArtifact>(&raw).ok())
        .collect::<Vec<_>>();
    artifacts.sort_by(|left, right| right.imported_at.cmp(&left.imported_at));
    Ok(artifacts)
}

/// Remove an imported artifact and all selections that reference it.  The
/// artifact ID is validated before constructing a path, so a malformed RPC
/// request cannot turn this into an arbitrary file delete.
pub fn remove_document(workspace: &Path, id: &str) -> Result<bool> {
    let path = artifact_path(workspace, id)?;
    let removed_artifact = match std::fs::remove_file(&path) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            return Err(error)
                .with_context(|| format!("remove document artifact {}", path.display()))
        }
    };

    let _guard = selection_store_lock().lock().unwrap();
    let mut selections = read_selections_unlocked(workspace)?;
    let original_len = selections.len();
    selections.retain(|selection| selection.artifact_id != id);
    let removed_selection = selections.len() != original_len;
    if removed_selection {
        write_selections_unlocked(workspace, &selections)?;
    }
    Ok(removed_artifact || removed_selection)
}

/// Return a lightweight render descriptor and persist it on the artifact.
/// Rust does not have Electron's HTML renderer, so only original PDF bytes
/// and structured fallbacks are advertised as available here.  Electron's
/// host override remains responsible for the richer Word/Office preview.
pub fn ensure_render_preview(workspace: &Path, id: &str) -> Result<Option<DocumentArtifact>> {
    let Some(mut artifact) = get_document(workspace, id)? else {
        return Ok(None);
    };
    let generated_at = worldbase_protocol::event::now_rfc3339();
    let source = artifact_source_path(workspace, &artifact);
    let render = match artifact.file_type.to_ascii_lowercase().as_str() {
        "pdf" if !is_virtual_artifact(&artifact) && source.is_file() => json!({
            "kind": "pdf",
            "source": "original",
            "status": "ready",
            "mimeType": "application/pdf",
            "assetPath": artifact.file_path,
            "generatedAt": generated_at,
        }),
        "xlsx" | "xls" | "pptx" | "ppt" => json!({
            "kind": "structured",
            "source": "generated",
            "status": "ready",
            "generatedAt": generated_at,
        }),
        "md" | "markdown" => json!({
            "kind": "structured",
            "source": "generated",
            "status": "ready",
            "generatedAt": generated_at,
        }),
        "docx" | "doc" => json!({
            "kind": "structured",
            "source": "fallback",
            "status": "unavailable",
            "error": "Rust document renderer does not expose an HTML preview for Word documents",
            "generatedAt": generated_at,
        }),
        _ => json!({
            "kind": "structured",
            "source": "fallback",
            "status": "unavailable",
            "error": format!("Rust document renderer does not support preview for {}", artifact.file_type),
            "generatedAt": generated_at,
        }),
    };
    artifact.render = Some(render);
    write_artifact(workspace, &artifact)?;
    Ok(Some(artifact))
}

/// Persist a preview generated by a host implementation (for example
/// Electron's Mammoth DOCX renderer) into Rust's workspace-owned cache.
///
/// Host processes must not make their private cache paths part of the Rust
/// artifact contract: Electron stores previews below `app.getPath('userData')`
/// while Flutter may not have a filesystem path at all. Copying the bytes into
/// this cache gives every transport the same `doc.preview.read` behavior and
/// keeps the existing path containment check effective.
pub fn persist_host_render_preview(
    workspace: &Path,
    id: &str,
    mut render: Value,
    bytes: &[u8],
) -> Result<Option<DocumentArtifact>> {
    anyhow::ensure!(
        bytes.len() as u64 <= MAX_DOCUMENT_BYTES,
        "document render asset is too large"
    );
    let Some(render_object) = render.as_object_mut() else {
        anyhow::bail!("host document preview render must be an object");
    };
    anyhow::ensure!(
        render_object.get("status").and_then(Value::as_str) == Some("ready"),
        "host document preview is not ready"
    );
    anyhow::ensure!(
        render_object.get("kind").and_then(Value::as_str) != Some("structured"),
        "structured document previews do not carry a binary render asset"
    );

    let Some(mut artifact) = get_document(workspace, id)? else {
        return Ok(None);
    };
    anyhow::ensure!(
        !is_virtual_artifact(&artifact),
        "virtual documents have no render asset"
    );

    let cache_dir = render_cache_dir(workspace);
    std::fs::create_dir_all(&cache_dir)
        .with_context(|| format!("create document render cache {}", cache_dir.display()))?;
    let extension = match render_object
        .get("mimeType")
        .or_else(|| render_object.get("mime_type"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
    {
        "application/pdf" => "pdf",
        "text/html" => "html",
        "text/plain" => "txt",
        _ => "bin",
    };
    let asset_path = cache_dir.join(format!("{id}.preview.{extension}"));
    let temporary = cache_dir.join(format!(".{id}.{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temporary, bytes)
        .with_context(|| format!("write document render asset {}", temporary.display()))?;
    if let Err(error) = std::fs::rename(&temporary, &asset_path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error)
            .with_context(|| format!("commit document render asset {}", asset_path.display()));
    }

    render_object.insert(
        "assetPath".to_string(),
        Value::String(asset_path.to_string_lossy().into_owned()),
    );
    render_object.remove("asset_path");
    artifact.render = Some(render);
    write_artifact(workspace, &artifact)?;
    Ok(Some(artifact))
}

/// Read a binary render asset when the descriptor points to one.  Structured
/// previews deliberately return `None`; Flutter can then render the node tree
/// or plain text without relying on a JS `Uint8Array` wire representation.
pub fn read_render_asset(workspace: &Path, id: &str) -> Result<Option<Value>> {
    let Some(artifact) = get_document(workspace, id)? else {
        return Ok(None);
    };
    let Some(render) = artifact.render.as_ref() else {
        return Ok(None);
    };
    if render.get("status").and_then(Value::as_str) != Some("ready")
        || render.get("kind").and_then(Value::as_str) == Some("structured")
    {
        return Ok(None);
    }
    let Some(raw_asset_path) = render.get("assetPath").and_then(Value::as_str) else {
        return Ok(None);
    };
    let asset_path = safe_render_asset_path(workspace, &artifact, raw_asset_path)?;
    let metadata = match std::fs::metadata(&asset_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("read document render metadata {}", asset_path.display()))
        }
    };
    anyhow::ensure!(metadata.is_file(), "document render asset is not a file");
    anyhow::ensure!(
        metadata.len() <= MAX_DOCUMENT_BYTES,
        "document render asset is too large"
    );
    let bytes = std::fs::read(&asset_path)
        .with_context(|| format!("read document render asset {}", asset_path.display()))?;
    Ok(Some(json!({
        "mimeType": render.get("mimeType").and_then(Value::as_str).unwrap_or("application/octet-stream"),
        "bytes": bytes,
    })))
}

/// Fingerprint the original file for optimistic document editing.
pub fn edit_source_state(workspace: &Path, id: &str) -> Result<Value> {
    let Some(artifact) = get_document(workspace, id)? else {
        anyhow::bail!("文档不存在: {id}");
    };
    if is_virtual_artifact(&artifact) {
        return Ok(json!({
            "supported": false,
            "error": "This document has no editable source file."
        }));
    }
    let source = artifact_source_path(workspace, &artifact);
    let metadata = std::fs::metadata(&source)
        .with_context(|| format!("stat document source {}", source.display()))?;
    anyhow::ensure!(metadata.is_file(), "document source is not a file");
    anyhow::ensure!(
        metadata.len() <= MAX_DOCUMENT_BYTES,
        "document source is too large"
    );
    let bytes = std::fs::read(&source)
        .with_context(|| format!("read document source {}", source.display()))?;
    let digest = Sha256::digest(bytes);
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    Ok(json!({
        "sha256": format!("{digest:x}"),
        "size": metadata.len(),
        "mtimeMs": mtime_ms,
    }))
}

// ---------------------------------------------------------------------------
// AI draft lifecycle
//
// The AI authors a full rewrite of an imported document into a workspace-owned
// draft file; the original source is never touched until the user explicitly
// applies the draft (with an automatic backup) or saves it to another path.
// Draft state is persisted on the artifact record so it survives restarts.
// ---------------------------------------------------------------------------

/// Fully-authored draft content, mirroring the `doc_write` argument families.
/// `OfficeOps` is the fidelity-preserving form: the draft is produced by
/// copying the source package and applying surgical operations, so media and
/// untouched styling survive; the other variants rebuild the file from full
/// content (flagged by `dataLossRisk` when the source carries media).
#[derive(Debug, Clone)]
pub enum DraftContent {
    Text { kind: &'static str, body: String },
    Docx(Vec<worldbase_docs::edit::DocBlock>),
    Xlsx(Vec<worldbase_docs::edit::Sheet>),
    Pptx(Vec<worldbase_docs::edit::Slide>),
    OfficeOps(Vec<worldbase_docs::ops::OfficeOp>),
}

fn draft_dir(workspace: &Path) -> PathBuf {
    workspace.join(".worldbase").join("document-drafts")
}

/// Process-local monotonic counter used to keep same-tick draft stagings from
/// choosing the same filename. The existence check also protects against a
/// filename left by an earlier process run.
static DRAFT_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn unique_draft_path(directory: &Path, artifact_id: &str, extension: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    loop {
        let sequence = DRAFT_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let candidate = directory.join(format!("{artifact_id}-{stamp}-{sequence}.{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
}

fn document_backup_dir(workspace: &Path) -> PathBuf {
    workspace.join(".worldbase").join("document-backups")
}

fn file_sha256(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path)
        .with_context(|| format!("read document source {}", path.display()))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn normalize_draft_type(raw: &str) -> Option<&'static str> {
    match raw.to_ascii_lowercase().as_str() {
        "md" | "markdown" => Some("md"),
        "txt" | "text" => Some("text"),
        "docx" | "doc" => Some("docx"),
        "xlsx" | "xls" => Some("xlsx"),
        "pptx" | "ppt" => Some("pptx"),
        _ => None,
    }
}

fn artifact_type_matches_draft(file_type: &str, content: &DraftContent) -> Result<()> {
    let content_kind = match content {
        DraftContent::Text { kind, .. } => *kind,
        DraftContent::Docx(_) => "docx",
        DraftContent::Xlsx(_) => "xlsx",
        DraftContent::Pptx(_) => "pptx",
        DraftContent::OfficeOps(ops) => ops
            .first()
            .map(|op| op.family())
            .unwrap_or("docx"),
    };
    let Some(target_kind) = normalize_draft_type(file_type) else {
        anyhow::bail!(
            "该文档类型（{file_type}）暂不支持 AI 改写；PDF 可先让 AI 输出 markdown 后另存"
        );
    };
    anyhow::ensure!(
        target_kind == content_kind,
        "草稿内容类型（{content_kind}）与文档类型（{target_kind}）不一致；请按文档原格式提交完整内容"
    );
    Ok(())
}

/// Find an artifact whose source resolves to `file_path`, or import the file
/// as a new artifact when the store has not seen it yet.
fn resolve_artifact_for_draft(
    workspace: &Path,
    artifact_id: Option<&str>,
    file_path: Option<&str>,
) -> Result<DocumentArtifact> {
    if let Some(id) = artifact_id.filter(|value| !value.trim().is_empty()) {
        return get_document(workspace, id)?.ok_or_else(|| anyhow::anyhow!("文档不存在: {id}"));
    }
    let Some(raw_path) = file_path.map(str::trim).filter(|value| !value.is_empty()) else {
        anyhow::bail!("doc_draft 需要 artifact_id 或 file_path 之一");
    };
    let candidate = Path::new(raw_path);
    let absolute = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        workspace.join(candidate)
    };
    if let Ok(canonical) = absolute.canonicalize() {
        for artifact in list_documents(workspace)? {
            let stored = artifact_source_path(workspace, &artifact);
            let stored_canonical = stored
                .canonicalize()
                .or_else(|_| canonicalize_existing_ancestor(&stored))
                .unwrap_or(stored);
            if stored_canonical == canonical {
                return Ok(artifact);
            }
        }
    }
    // The store has not seen this file yet — import it so the draft has an
    // artifact record and later apply/saveAs calls have something to update.
    let parsed = worldbase_docs::parse_file(&absolute)?;
    import_parsed_document(workspace, &absolute, &parsed)
}

fn clear_draft_state(mut artifact: DocumentArtifact) -> DocumentArtifact {
    artifact.draft = None;
    artifact
}

fn draft_record_value(
    workspace: &Path,
    artifact: &DocumentArtifact,
) -> Value {
    let draft = artifact.draft.clone().unwrap_or(Value::Null);
    if draft.is_null() {
        return Value::Null;
    }
    let draft_path = draft
        .get("path")
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut value = draft;
    if let Some(object) = value.as_object_mut() {
        object.insert("artifactId".into(), json!(artifact.id));
        object.insert(
            "filePath".into(),
            json!(public_path(workspace, &artifact.file_path)),
        );
        object.insert("fileName".into(), json!(artifact.file_name));
        object.insert("fileType".into(), json!(artifact.file_type));
        // The desktop draft banner re-imports the draft file for preview, so
        // the pull path (doc.draft.get) must carry the same absolute draft
        // path the push notification (document.draftStaged) does.
        if let Some(draft_path) = draft_path {
            object.insert("draftPath".into(), json!(draft_path));
        }
    }
    value
}

/// Author a full draft rewrite of a document.  Writes the draft bytes below
/// `.worldbase/document-drafts/`, prunes older drafts of the same artifact,
/// fingerprints the source file, and records the pending draft on the
/// artifact together with a change list (`changes`), the model's own summary
/// and — for full-content drafts of media-bearing files — a `dataLossRisk`
/// marker surfaced by the desktop UI.  Returns the draft descriptor for
/// host/UI notification.
pub fn stage_document_draft(
    workspace: &Path,
    artifact_id: Option<&str>,
    file_path: Option<&str>,
    content: DraftContent,
    summary: Option<String>,
) -> Result<Value> {
    let mut artifact = resolve_artifact_for_draft(workspace, artifact_id, file_path)?;
    if is_virtual_artifact(&artifact) {
        anyhow::bail!("虚拟文档没有源文件，无法生成修改草稿");
    }
    let source = artifact_source_path(workspace, &artifact);
    anyhow::ensure!(
        source.is_file(),
        "文档源文件不存在: {}",
        source.display()
    );
    if let Err(message) = artifact_type_matches_draft(&artifact.file_type, &content) {
        return Err(message);
    }

    let draft_extension = match &content {
        DraftContent::Text { kind, .. } => {
            if *kind == "md" {
                if artifact.file_type.eq_ignore_ascii_case("markdown") {
                    "markdown"
                } else {
                    "md"
                }
            } else {
                "txt"
            }
        }
        DraftContent::Docx(_) => "docx",
        DraftContent::Xlsx(_) => "xlsx",
        DraftContent::Pptx(_) => "pptx",
        DraftContent::OfficeOps(ops) => ops
            .first()
            .map(|op| op.family())
            .unwrap_or("docx"),
    };

    let directory = draft_dir(workspace);
    std::fs::create_dir_all(&directory)
        .with_context(|| format!("create document draft directory {}", directory.display()))?;

    // One live draft per artifact: prune earlier draft files before writing.
    let draft_prefix = format!("{}-", artifact.id);
    if let Ok(entries) = std::fs::read_dir(&directory) {
        for entry in entries.filter_map(|entry| entry.ok()) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(&draft_prefix) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    let draft_path = unique_draft_path(&directory, &artifact.id, draft_extension);

    // Fidelity-preserving path: copy the source package and apply ops, so
    // media/untouched styling survive verbatim.
    if let DraftContent::OfficeOps(ops) = &content {
        worldbase_docs::ops::apply_ops(&source, &draft_path, ops)
            .with_context(|| format!("apply document edit ops to {}", source.display()))?;
    } else {
        match &content {
            DraftContent::Text { body, .. } => worldbase_docs::edit::write_text(&draft_path, body)?,
            DraftContent::Docx(blocks) => worldbase_docs::edit::write_docx(&draft_path, blocks)?,
            DraftContent::Xlsx(sheets) => worldbase_docs::edit::write_xlsx(&draft_path, sheets)?,
            DraftContent::Pptx(slides) => worldbase_docs::edit::write_pptx(&draft_path, slides)?,
            DraftContent::OfficeOps(_) => unreachable!("ops handled above"),
        }
    }

    // Change list: op-derived when available (exact), otherwise computed by
    // diffing the source parse against the draft parse.
    let changes = match &content {
        DraftContent::OfficeOps(ops) => changes_from_ops(ops),
        _ => {
            let draft_parsed = worldbase_docs::parse_file(&draft_path)?;
            let draft_text = draft_parsed
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default();
            compute_draft_changes(
                &artifact.file_type,
                &artifact.parsed,
                &artifact.plain_text,
                &draft_parsed,
                draft_text,
            )
        }
    };

    // A full-content rebuild drops every media part of the source package;
    // surface that to the user before they overwrite the original.
    let data_loss_risk = match &content {
        DraftContent::OfficeOps(_) | DraftContent::Text { .. } => None,
        _ => match worldbase_docs::ops::count_media_parts(&source) {
            Ok(count) if count > 0 => Some(json!({ "mediaCount": count })),
            _ => None,
        },
    };

    let source_sha256 = file_sha256(&source)?;
    let mut record = json!({
        "path": draft_path.to_string_lossy(),
        "fileType": draft_extension,
        "sourceSha256": source_sha256,
        "createdAt": worldbase_protocol::event::now_rfc3339(),
    });
    if let Some(object) = record.as_object_mut() {
        object.insert("changes".into(), changes);
        if let Some(summary) = summary.as_deref().filter(|value| !value.trim().is_empty()) {
            object.insert("summary".into(), json!(summary.trim()));
        }
        if let Some(risk) = data_loss_risk {
            object.insert("dataLossRisk".into(), risk);
        }
    }
    artifact.draft = Some(record.clone());
    write_artifact(workspace, &artifact)?;

    Ok(json!({
        "artifactId": artifact.id,
        "filePath": artifact.file_path,
        "draftPath": draft_path.to_string_lossy(),
        "fileType": draft_extension,
        "sourceSha256": source_sha256,
        "createdAt": record.get("createdAt").cloned().unwrap_or(Value::Null),
        "changes": record.get("changes").cloned().unwrap_or(Value::Array(Vec::new())),
        "summary": record.get("summary").cloned().unwrap_or(Value::Null),
        "dataLossRisk": record.get("dataLossRisk").cloned().unwrap_or(Value::Null),
    }))
}

// ---------------------------------------------------------------------------
// Draft change list（变更清单）
//
// 两种来源：ops 草稿由操作直接推导（精确）；全文草稿由原文/草稿解析结果做
// patience-diff 推导（段落级）。输出统一为
// `{ items: [...], counts: { added, removed, modified, total }, truncated }`，
// 渲染层据此展示"改了什么"。
// ---------------------------------------------------------------------------

const MAX_DRAFT_CHANGES: usize = 200;

/// One comparable text unit: display text + 1-based page/sheet index.
#[derive(Debug, Clone)]
struct DiffUnit {
    page: i32,
    text: String,
}

fn extract_diff_units(file_type: &str, parsed: &Value, plain_text: &str) -> Vec<DiffUnit> {
    let mut units = Vec::new();
    let push_unit = |units: &mut Vec<DiffUnit>, page: i32, text: &str| {
        if !text.trim().is_empty() {
            units.push(DiffUnit { page, text: text.to_string() });
        }
    };
    match file_type {
        "pptx" | "ppt" => {
            for slide in parsed
                .get("items")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let page = slide
                    .get("number")
                    .and_then(Value::as_u64)
                    .unwrap_or(1)
                    .min(i32::MAX as u64) as i32;
                for paragraph in slide
                    .get("paragraphs")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if let Some(text) = paragraph.as_str() {
                        push_unit(&mut units, page, text);
                    }
                }
            }
        }
        "xlsx" | "xls" => {
            for (index, sheet) in parsed
                .get("sheets")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .enumerate()
            {
                let page = index as i32 + 1;
                for row in sheet.get("rows").and_then(Value::as_array).into_iter().flatten() {
                    let text = row
                        .as_array()
                        .map(|cells| {
                            cells
                                .iter()
                                .map(|cell| match cell {
                                    Value::String(value) => value.clone(),
                                    Value::Null => String::new(),
                                    other => other.to_string(),
                                })
                                .collect::<Vec<_>>()
                                .join("\t")
                        })
                        .unwrap_or_default();
                    push_unit(&mut units, page, &text);
                }
            }
        }
        "docx" | "doc" => {
            for paragraph in parsed
                .get("paragraphs")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(text) = paragraph.as_str() {
                    push_unit(&mut units, 1, text);
                }
            }
        }
        "csv" => {
            if let Some(header) = parsed.get("header").and_then(Value::as_array) {
                let text = header
                    .iter()
                    .map(|cell| cell.as_str().unwrap_or_default())
                    .collect::<Vec<_>>()
                    .join(",");
                push_unit(&mut units, 1, &text);
            }
            for row in parsed.get("rows").and_then(Value::as_array).into_iter().flatten() {
                let text = row
                    .as_array()
                    .map(|cells| {
                        cells
                            .iter()
                            .map(|cell| cell.as_str().unwrap_or_default())
                            .collect::<Vec<_>>()
                            .join(",")
                    })
                    .unwrap_or_default();
                push_unit(&mut units, 1, &text);
            }
        }
        _ => {
            for line in plain_text.lines() {
                push_unit(&mut units, 1, line);
            }
        }
    }
    units
}

/// Patience diff on text units: trim common prefix/suffix, anchor on units
/// unique to both sides, recurse; leaf regions become delete+insert runs that
/// are later paired into `modify` entries.
fn diff_range(
    old: &[DiffUnit],
    old_start: usize,
    old_end: usize,
    new: &[DiffUnit],
    new_start: usize,
    new_end: usize,
    events: &mut Vec<(bool, DiffUnit)>,
) {
    let mut os = old_start;
    let mut ns = new_start;
    while os < old_end && ns < new_end && old[os].text == new[ns].text {
        os += 1;
        ns += 1;
    }
    let mut oe = old_end;
    let mut ne = new_end;
    while oe > os && ne > ns && old[oe - 1].text == new[ne - 1].text {
        oe -= 1;
        ne -= 1;
    }
    if os == oe {
        events.extend(new[ns..ne].iter().cloned().map(|unit| (false, unit)));
        return;
    }
    if ns == ne {
        events.extend(old[os..oe].iter().cloned().map(|unit| (true, unit)));
        return;
    }

    // Anchor on texts unique in both slices (in order).
    fn count_by_text(slice: &[DiffUnit], range: std::ops::Range<usize>) -> std::collections::HashMap<&str, usize> {
        let mut counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
        for unit in &slice[range] {
            *counts.entry(unit.text.as_str()).or_default() += 1;
        }
        counts
    }
    let old_counts = count_by_text(old, os..oe);
    let new_counts = count_by_text(new, ns..ne);

    let old_anchor_indices: Vec<usize> = (os..oe)
        .filter(|index| {
            old_counts.get(old[*index].text.as_str()) == Some(&1)
                && new_counts.get(old[*index].text.as_str()) == Some(&1)
        })
        .collect();
    let anchors: Vec<(usize, usize)> = if old_anchor_indices.is_empty() {
        Vec::new()
    } else {
        let mut new_pointer = ns;
        let mut pairs = Vec::with_capacity(old_anchor_indices.len());
        'outer: for old_index in old_anchor_indices {
            let text = &old[old_index].text;
            while new_pointer < ne {
                if new[new_pointer].text == *text {
                    pairs.push((old_index, new_pointer));
                    new_pointer += 1;
                    continue 'outer;
                }
                new_pointer += 1;
            }
            break;
        }
        pairs
    };

    if anchors.is_empty() {
        events.extend(old[os..oe].iter().cloned().map(|unit| (true, unit)));
        events.extend(new[ns..ne].iter().cloned().map(|unit| (false, unit)));
        return;
    }

    let mut cursor_old = os;
    let mut cursor_new = ns;
    for (anchor_old, anchor_new) in anchors {
        diff_range(old, cursor_old, anchor_old, new, cursor_new, anchor_new, events);
        cursor_old = anchor_old + 1;
        cursor_new = anchor_new + 1;
    }
    diff_range(old, cursor_old, oe, new, cursor_new, ne, events);
}

fn change_item(kind: &str, page: i32, before: Option<&str>, after: Option<&str>) -> Value {
    let anchor_source = before.or(after).unwrap_or_default();
    let anchor: String = anchor_source.chars().take(60).collect();
    let mut item = json!({ "kind": kind, "pageIndex": page, "anchor": anchor });
    if let Some(object) = item.as_object_mut() {
        if let Some(before) = before {
            object.insert("before".into(), json!(truncate_change_text(before)));
        }
        if let Some(after) = after {
            object.insert("after".into(), json!(truncate_change_text(after)));
        }
    }
    item
}

/// Full diff-derived change record for a rewritten draft.
fn compute_draft_changes(
    file_type: &str,
    old_parsed: &Value,
    old_text: &str,
    new_parsed: &Value,
    new_text: &str,
) -> Value {
    let old_units = extract_diff_units(file_type, old_parsed, old_text);
    let new_units = extract_diff_units(file_type, new_parsed, new_text);
    let mut events = Vec::new();
    diff_range(&old_units, 0, old_units.len(), &new_units, 0, new_units.len(), &mut events);
    changes_record_from_events(events)
}

fn changes_record_from_events(events: Vec<(bool, DiffUnit)>) -> Value {
    let mut items = Vec::new();
    let (mut added, mut removed, mut modified) = (0usize, 0usize, 0usize);
    let mut cursor = 0usize;
    while cursor < events.len() {
        let mut deletes: Vec<DiffUnit> = Vec::new();
        while cursor < events.len() && events[cursor].0 {
            deletes.push(events[cursor].1.clone());
            cursor += 1;
        }
        let mut inserts: Vec<DiffUnit> = Vec::new();
        while cursor < events.len() && !events[cursor].0 {
            inserts.push(events[cursor].1.clone());
            cursor += 1;
        }

        let paired = deletes.len().min(inserts.len());
        for index in 0..paired {
            modified += 1;
            if items.len() < MAX_DRAFT_CHANGES {
                let before = deletes[index].text.as_str();
                let after = inserts[index].text.as_str();
                items.push(change_item("modify", inserts[index].page, Some(before), Some(after)));
            }
        }
        for delete in deletes.iter().skip(paired) {
            removed += 1;
            if items.len() < MAX_DRAFT_CHANGES {
                items.push(change_item("delete", delete.page, Some(&delete.text), None));
            }
        }
        for insert in inserts.iter().skip(paired) {
            added += 1;
            if items.len() < MAX_DRAFT_CHANGES {
                items.push(change_item("insert", insert.page, None, Some(&insert.text)));
            }
        }
    }

    json!({
        "items": items,
        "counts": {
            "added": added,
            "removed": removed,
            "modified": modified,
            "total": added + removed + modified,
        },
        "truncated": (added + removed + modified) > items.len(),
    })
}

fn truncate_change_text(text: &str) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    const MAX_CHANGE_TEXT_CHARS: usize = 240;
    if normalized.chars().count() <= MAX_CHANGE_TEXT_CHARS {
        normalized
    } else {
        let cut: String = normalized.chars().take(MAX_CHANGE_TEXT_CHARS).collect();
        format!("{cut}…")
    }
}

/// Op-derived change record: exact by construction (no diffing needed).
fn changes_from_ops(ops: &[worldbase_docs::ops::OfficeOp]) -> Value {
    let mut items = Vec::new();
    let (mut added, mut removed, mut modified) = (0usize, 0usize, 0usize);
    for op in ops {
        if items.len() >= MAX_DRAFT_CHANGES {
            break;
        }
        let item = match op {
            worldbase_docs::ops::OfficeOp::DocxReplaceText { paragraph_index, after_text, expect_before } => {
                modified += 1;
                let mut item = change_item(
                    "modify",
                    1,
                    expect_before.as_deref(),
                    Some(after_text.as_str()),
                );
                if let Some(object) = item.as_object_mut() {
                    object.insert("after".into(), json!(truncate_change_text(after_text)));
                    object.insert("opIndex".into(), json!(paragraph_index));
                }
                item
            }
            worldbase_docs::ops::OfficeOp::DocxInsertParagraphAfter { paragraph_index, text, style } => {
                added += 1;
                let mut item = change_item("insert", 1, None, Some(text));
                if let Some(object) = item.as_object_mut() {
                    object.insert("after".into(), json!(truncate_change_text(text)));
                    object.insert("opIndex".into(), json!(paragraph_index));
                    if let worldbase_docs::ops::ParagraphStyle::Heading(level) = style {
                        object.insert("headingLevel".into(), json!(level));
                    }
                }
                item
            }
            worldbase_docs::ops::OfficeOp::DocxDeleteParagraph { paragraph_index } => {
                removed += 1;
                let mut item = change_item("delete", 1, None, None);
                if let Some(object) = item.as_object_mut() {
                    object.insert("opIndex".into(), json!(paragraph_index));
                }
                item
            }
            worldbase_docs::ops::OfficeOp::DocxInsertImage { paragraph_index, image_path, .. } => {
                added += 1;
                let name = image_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("image");
                let mut item = change_item("insert", 1, None, Some(&format!("[图片 {name}]")));
                if let Some(object) = item.as_object_mut() {
                    object.insert("opIndex".into(), json!(paragraph_index));
                    object.insert("image".into(), json!(name));
                }
                item
            }
            worldbase_docs::ops::OfficeOp::PptxReplaceText { slide, paragraph_index, after_text, expect_before } => {
                modified += 1;
                let mut item = change_item(
                    "modify",
                    *slide as i32,
                    expect_before.as_deref(),
                    Some(after_text.as_str()),
                );
                if let Some(object) = item.as_object_mut() {
                    object.insert("after".into(), json!(truncate_change_text(after_text)));
                    object.insert("opIndex".into(), json!(paragraph_index));
                }
                item
            }
            worldbase_docs::ops::OfficeOp::PptxInsertImage { slide, image_path, .. } => {
                added += 1;
                let name = image_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("image");
                let mut item = change_item(
                    "insert",
                    *slide as i32,
                    None,
                    Some(&format!("[图片 {name}]")),
                );
                if let Some(object) = item.as_object_mut() {
                    object.insert("image".into(), json!(name));
                }
                item
            }
            worldbase_docs::ops::OfficeOp::PptxInsertSlideAfter { index, title, content } => {
                added += 1;
                let preview = if title.trim().is_empty() {
                    content.first().map(String::as_str).unwrap_or("(新页面)")
                } else {
                    title.as_str()
                };
                change_item("insert", *index as i32 + 1, None, Some(preview))
            }
            worldbase_docs::ops::OfficeOp::PptxDeleteSlide { index } => {
                removed += 1;
                change_item("delete", *index as i32, None, None)
            }
        };
        items.push(item);
    }
    let total = added + removed + modified;
    json!({
        "items": items,
        "counts": { "added": added, "removed": removed, "modified": modified, "total": total },
        "truncated": total > items.len(),
    })
}

/// Direct-write guard：已导入工作区的文档与已存在的 Office 文件一律禁止
/// 直写工具覆写（全文重建会丢失图片/样式），必须改走 `doc_draft`。
pub fn ensure_document_write_allowed(workspace: &Path, absolute_path: &Path) -> Result<()> {
    let office_extension = matches!(
        absolute_path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("docx" | "doc" | "pptx" | "ppt" | "xlsx" | "xls")
    );

    // 已导入的文档：无论扩展名（含用户改名的场景）都拒绝直写。
    if let Ok(canonical) = absolute_path.canonicalize() {
        for artifact in list_documents(workspace)? {
            if artifact_source_path(workspace, &artifact) == canonical {
                anyhow::bail!(
                    "「{}」已导入工作区，直接覆写会丢失图片与样式；请使用 doc_draft 生成修改草稿",
                    artifact.file_name
                );
            }
        }
    }

    // 已存在的 Office 文件：重建必然破坏内容，同样拒绝。
    if office_extension && absolute_path.is_file() {
        anyhow::bail!(
            "「{}」是已存在的 Office 文档，直接覆写会丢失图片与样式；请使用 doc_draft 生成修改草稿",
            absolute_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("document")
        );
    }
    Ok(())
}

/// Overwrite the document source with its staged draft.  The original file is
/// backed up first (newest 5 kept per artifact), the store record is re-parsed
/// from the new bytes, and the render preview is invalidated so the workbench
/// shows the saved content immediately.
pub fn apply_document_draft(
    workspace: &Path,
    id: &str,
    expected_source_sha256: Option<&str>,
) -> Result<Value> {
    let artifact = get_document(workspace, id)?.ok_or_else(|| anyhow::anyhow!("文档不存在: {id}"))?;
    let draft = artifact.draft.clone().ok_or_else(|| {
        anyhow::anyhow!("该文档没有待处理的修改草稿")
    })?;
    anyhow::ensure!(
        !is_virtual_artifact(&artifact),
        "virtual documents have no applyable draft"
    );
    let source = artifact_source_path(workspace, &artifact);
    anyhow::ensure!(source.is_file(), "文档源文件不存在: {}", source.display());

    let draft_path = Path::new(
        draft
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    anyhow::ensure!(
        !draft_path.as_os_str().is_empty() && draft_path.is_file(),
        "草稿文件已丢失，请放弃该草稿后重新生成"
    );
    let recorded_sha = draft.get("sourceSha256").and_then(Value::as_str);
    if let (Some(expected), Some(recorded)) = (expected_source_sha256, recorded_sha) {
        anyhow::ensure!(
            expected.eq_ignore_ascii_case(recorded),
            "draftConflict: 草稿基于旧版本文件生成，请放弃后重新生成"
        );
    }
    let current_sha = file_sha256(&source)?;
    if let Some(recorded) = recorded_sha {
        anyhow::ensure!(
            recorded.eq_ignore_ascii_case(&current_sha),
            "draftSourceChanged: 文件在草稿生成后被修改过，请重新生成草稿或先另存为副本"
        );
    }

    // Backup the original before the first overwrite of this draft generation.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let backup_dir = document_backup_dir(workspace).join(&artifact.id);
    std::fs::create_dir_all(&backup_dir)?;
    let backup_extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    let backup_path = backup_dir.join(format!("{stamp}{backup_extension}"));
    std::fs::copy(&source, &backup_path)
        .with_context(|| format!("backup document source {}", backup_path.display()))?;
    prune_document_backups(&backup_dir, 5)?;

    // Atomic overwrite: copy the draft next to the source, then rename onto it.
    let temporary = source.with_extension(format!(
        "{}.{}.tmp",
        source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default(),
        uuid::Uuid::new_v4()
    ));
    std::fs::copy(draft_path, &temporary)
        .with_context(|| format!("stage draft write {}", temporary.display()))?;
    if let Err(error) = std::fs::rename(&temporary, &source) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error)
            .with_context(|| format!("commit draft overwrite {}", source.display()));
    }

    // Re-parse the saved file so the stored artifact reflects the new content.
    let parsed = worldbase_docs::parse_file(&source)?;
    let text = parsed
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let file_type = artifact.file_type.clone();
    let metadata = std::fs::metadata(&source)?;
    let mut updated = clear_draft_state(artifact);
    updated.plain_text = text.clone();
    updated.nodes = build_document_nodes(&parsed, &file_type, &text);
    updated.parsed = parsed;
    updated.file_size = metadata.len();
    updated.render = None;
    write_artifact(workspace, &updated)?;
    ensure_render_preview(workspace, &updated.id)?;

    let _ = std::fs::remove_file(draft_path);

    Ok(json!({
        "artifact": artifact_public_value(workspace, &updated),
        "backupPath": public_path(workspace, &backup_path.to_string_lossy()),
    }))
}

/// Write the staged draft to a user-chosen path without touching the original.
pub fn save_document_draft_as(
    workspace: &Path,
    id: &str,
    target_path: &Path,
) -> Result<Value> {
    let artifact = get_document(workspace, id)?.ok_or_else(|| anyhow::anyhow!("文档不存在: {id}"))?;
    let draft = artifact
        .draft
        .clone()
        .ok_or_else(|| anyhow::anyhow!("该文档没有待处理的修改草稿"))?;
    let draft_path = Path::new(
        draft
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    anyhow::ensure!(
        !draft_path.as_os_str().is_empty() && draft_path.is_file(),
        "草稿文件已丢失，请放弃该草稿后重新生成"
    );
    let source = artifact_source_path(workspace, &artifact);
    anyhow::ensure!(
        target_path != source,
        "另存为路径与原文件相同；如需覆盖请使用保存操作"
    );
    if let Some(parent) = target_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create save-as directory {}", parent.display()))?;
    }
    std::fs::copy(draft_path, target_path)
        .with_context(|| format!("write draft copy {}", target_path.display()))?;

    let parsed = worldbase_docs::parse_file(target_path)?;
    let imported = import_parsed_document(workspace, target_path, &parsed)?;
    let _ = std::fs::remove_file(draft_path);
    write_artifact(workspace, &clear_draft_state(artifact))?;

    Ok(json!({
        "artifact": artifact_public_value(workspace, &imported),
    }))
}

/// Drop the staged draft: delete the draft bytes and clear the record.
pub fn discard_document_draft(workspace: &Path, id: &str) -> Result<Value> {
    let artifact = get_document(workspace, id)?.ok_or_else(|| anyhow::anyhow!("文档不存在: {id}"))?;
    let draft = artifact.draft.clone();
    if let Some(draft) = &draft {
        if let Some(path) = draft.get("path").and_then(Value::as_str) {
            let _ = std::fs::remove_file(path);
        }
    }
    write_artifact(workspace, &clear_draft_state(artifact))?;
    Ok(json!({ "discarded": draft.is_some() }))
}

/// Draft pending for a source file, looked up by path (host/UI restore path).
/// This RPC-facing helper intentionally returns absolute paths: it is only
/// consumed by the desktop host process on the same machine.
pub fn get_document_draft(workspace: &Path, file_path: &str) -> Result<Value> {
    let candidate = Path::new(file_path);
    let absolute = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        workspace.join(candidate)
    };
    let Ok(canonical) = absolute.canonicalize() else {
        return Ok(Value::Null);
    };
    for artifact in list_documents(workspace)? {
        if artifact.draft.is_some() && artifact_source_path(workspace, &artifact) == canonical {
            return Ok(draft_record_value(workspace, &artifact));
        }
    }
    Ok(Value::Null)
}

fn prune_document_backups(directory: &Path, keep: usize) -> Result<()> {
    let mut backups: Vec<(u128, PathBuf)> = Vec::new();
    for entry in std::fs::read_dir(directory)?.filter_map(|entry| entry.ok()) {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(stamp_text) = name.split('.').next() else {
            continue;
        };
        if let Ok(stamp) = stamp_text.parse::<u128>() {
            backups.push((stamp, entry.path()));
        }
    }
    backups.sort_by_key(|(stamp, _)| *stamp);
    while backups.len() > keep {
        let (_, oldest) = backups.remove(0);
        let _ = std::fs::remove_file(oldest);
    }
    Ok(())
}

fn read_selections_unlocked(workspace: &Path) -> Result<Vec<SelectionRegion>> {
    let path = selection_store_path(workspace);
    let raw = match std::fs::read(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("read document selections {}", path.display()))
        }
    };
    serde_json::from_slice(&raw)
        .with_context(|| format!("parse document selections {}", path.display()))
}

fn write_selections_unlocked(workspace: &Path, selections: &[SelectionRegion]) -> Result<()> {
    let directory = workspace.join(".worldbase");
    std::fs::create_dir_all(&directory).with_context(|| {
        format!(
            "create document selection directory {}",
            directory.display()
        )
    })?;
    let target = selection_store_path(workspace);
    let temporary = directory.join(format!(".document-selections.{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temporary, serde_json::to_vec_pretty(selections)?)
        .with_context(|| format!("write document selections {}", temporary.display()))?;
    if let Err(error) = std::fs::rename(&temporary, &target) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error)
            .with_context(|| format!("commit document selections {}", target.display()));
    }
    Ok(())
}

/// Return all persisted selections, in creation order.
pub fn list_selections(workspace: &Path) -> Result<Vec<SelectionRegion>> {
    let _guard = selection_store_lock().lock().unwrap();
    read_selections_unlocked(workspace)
}

/// Create and persist a selection for an imported artifact.
pub fn create_selection(
    workspace: &Path,
    artifact_id: &str,
    node_ids: &[String],
    label: Option<&str>,
    color: Option<&str>,
    excerpt: Option<&str>,
) -> Result<SelectionRegion> {
    anyhow::ensure!(
        valid_artifact_id(artifact_id),
        "invalid document artifact id"
    );
    anyhow::ensure!(
        get_document(workspace, artifact_id)?.is_some(),
        "文档不存在: {artifact_id}"
    );

    let node_ids = node_ids
        .iter()
        .map(|id| id.trim())
        .filter(|id| !id.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    if !node_ids.is_empty() {
        let artifact =
            get_document(workspace, artifact_id)?.expect("artifact existence checked above");
        let mut known_ids = std::collections::HashSet::new();
        fn collect_ids(nodes: &[DocumentNode], output: &mut std::collections::HashSet<String>) {
            for node in nodes {
                output.insert(node.id.clone());
                collect_ids(&node.children, output);
            }
        }
        collect_ids(&artifact.nodes, &mut known_ids);
        // Artifacts persisted before node trees were introduced may still be
        // selected by excerpt.  When a structured tree exists, enforce the
        // same unknown-node rejection as Electron's DocumentStore.
        if !known_ids.is_empty() {
            for node_id in &node_ids {
                anyhow::ensure!(known_ids.contains(node_id), "节点不存在: {node_id}");
            }
        }
    }
    let excerpt = excerpt
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    anyhow::ensure!(!node_ids.is_empty() || excerpt.is_some(), "选区不能为空");

    let _guard = selection_store_lock().lock().unwrap();
    let mut selections = read_selections_unlocked(workspace)?;
    let region = SelectionRegion {
        id: uuid::Uuid::new_v4().to_string(),
        artifact_id: artifact_id.to_string(),
        node_ids,
        label: label
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("未命名选区")
            .to_string(),
        color: color
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("#3b82f6")
            .to_string(),
        excerpt,
        created_at: worldbase_protocol::event::now_rfc3339(),
    };
    selections.push(region.clone());
    write_selections_unlocked(workspace, &selections)?;
    Ok(region)
}

/// Remove one selection. Returns false when the ID is unknown.
pub fn remove_selection(workspace: &Path, id: &str) -> Result<bool> {
    let _guard = selection_store_lock().lock().unwrap();
    let mut selections = read_selections_unlocked(workspace)?;
    let original_len = selections.len();
    selections.retain(|selection| selection.id != id);
    if selections.len() == original_len {
        return Ok(false);
    }
    write_selections_unlocked(workspace, &selections)?;
    Ok(true)
}

/// Update one selection's label. Returns None when the ID is unknown.
pub fn update_selection_label(
    workspace: &Path,
    id: &str,
    label: &str,
) -> Result<Option<SelectionRegion>> {
    let _guard = selection_store_lock().lock().unwrap();
    let mut selections = read_selections_unlocked(workspace)?;
    let Some(selection) = selections.iter_mut().find(|selection| selection.id == id) else {
        return Ok(None);
    };
    selection.label = label.trim().to_string();
    let updated = selection.clone();
    write_selections_unlocked(workspace, &selections)?;
    Ok(Some(updated))
}

fn selections_for_artifact_unlocked(
    workspace: &Path,
    artifact_id: &str,
) -> Result<Vec<SelectionRegion>> {
    Ok(read_selections_unlocked(workspace)?
        .into_iter()
        .filter(|selection| selection.artifact_id == artifact_id)
        .collect())
}

/// Return selections attached to one artifact.
pub fn get_selections_for_artifact(
    workspace: &Path,
    artifact_id: &str,
) -> Result<Vec<SelectionRegion>> {
    let _guard = selection_store_lock().lock().unwrap();
    selections_for_artifact_unlocked(workspace, artifact_id)
}

fn selection_text(artifact: &DocumentArtifact, selection: &SelectionRegion) -> String {
    if let Some(excerpt) = selection.excerpt.as_deref().map(str::trim) {
        if !excerpt.is_empty() {
            return excerpt.to_string();
        }
    }

    // Prefer the persisted structured node tree. The parser payload fallback
    // keeps artifacts written by pre-node versions readable after upgrade.
    fn collect_document_nodes(
        nodes: &[DocumentNode],
        output: &mut std::collections::HashMap<String, String>,
    ) {
        for node in nodes {
            output.insert(node.id.clone(), node.text.clone());
            collect_document_nodes(&node.children, output);
        }
    }

    fn collect_nodes(value: &Value, output: &mut std::collections::HashMap<String, String>) {
        match value {
            Value::Array(values) => values.iter().for_each(|value| collect_nodes(value, output)),
            Value::Object(object) => {
                if let (Some(id), Some(text)) = (
                    object.get("id").and_then(Value::as_str),
                    object.get("text").and_then(Value::as_str),
                ) {
                    output.insert(id.to_string(), text.to_string());
                }
                object
                    .values()
                    .for_each(|value| collect_nodes(value, output));
            }
            _ => {}
        }
    }

    let mut nodes = std::collections::HashMap::new();
    collect_document_nodes(&artifact.nodes, &mut nodes);
    collect_nodes(&artifact.parsed, &mut nodes);
    selection
        .node_ids
        .iter()
        .filter_map(|id| nodes.get(id))
        .filter(|text| !text.trim().is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join("\n")
}

/// Build the exact prompt envelope used by Electron when selected document
/// regions are injected into an agent request.
///
/// `None` means all persisted selections, while `Some(&[])` intentionally
/// means no selections. Unknown region IDs are ignored, matching Electron's
/// `buildSelectionRefs` behavior.
pub fn build_selections_prompt(workspace: &Path, region_ids: Option<&[String]>) -> Result<String> {
    let _guard = selection_store_lock().lock().unwrap();
    let selections = read_selections_unlocked(workspace)?;
    let mut prompts = Vec::new();

    for selection in selections {
        if let Some(region_ids) = region_ids {
            if !region_ids
                .iter()
                .any(|region_id| region_id == &selection.id)
            {
                continue;
            }
        }

        let Some(artifact) = get_document(workspace, &selection.artifact_id)? else {
            continue;
        };
        let text = selection_text(&artifact, &selection);
        prompts.push(format!(
            "【文档选区：{} — {}】\n{}\n【选区结束】",
            artifact.file_name, selection.label, text
        ));
    }

    Ok(prompts.join("\n\n"))
}

fn selection_refs_for_artifact(
    workspace: &Path,
    artifact: &DocumentArtifact,
    region_ids: &[String],
) -> Result<Vec<Value>> {
    let selections = selections_for_artifact_unlocked(workspace, &artifact.id)?;
    Ok(selections
        .into_iter()
        .filter(|selection| {
            region_ids.is_empty() || region_ids.iter().any(|id| id == &selection.id)
        })
        .map(|selection| {
            json!({
                "regionId": selection.id,
                "label": selection.label,
                "text": selection_text(artifact, &selection),
            })
        })
        .collect())
}

pub fn list_documents_result(workspace: &Path) -> Result<Value> {
    let artifacts = list_documents(workspace)?;
    let _guard = selection_store_lock().lock().unwrap();
    let selections = read_selections_unlocked(workspace)?;
    if artifacts.is_empty() {
        return Ok(
            json!({ "message": "当前没有已导入的文档。", "documents": [], "selections": [] }),
        );
    }
    Ok(json!({
        "documents": artifacts.iter().map(|artifact| {
            json!({
                "id": artifact.id,
                "filePath": public_path(workspace, &artifact.file_path),
                "fileName": artifact.file_name,
                "fileType": artifact.file_type,
                "fileSize": artifact.file_size,
                "nodeCount": inferred_node_count(artifact),
                "selectionCount": selections
                    .iter()
                    .filter(|selection| selection.artifact_id == artifact.id)
                    .count(),
                "importedAt": artifact.imported_at,
            })
        }).collect::<Vec<_>>(),
        "selections": selections.iter().map(|selection| json!({
            "id": selection.id,
            "artifactId": selection.artifact_id,
            "label": selection.label,
            "nodeCount": selection.node_ids.len(),
        })).collect::<Vec<_>>(),
    }))
}

fn split_text(text: &str, max_chars: usize) -> Vec<String> {
    if text.is_empty() {
        return vec![String::new()];
    }
    let chars = text.chars().collect::<Vec<_>>();
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let hard_end = (start + max_chars).min(chars.len());
        let end = if hard_end == chars.len() {
            hard_end
        } else {
            let search_start = start + max_chars / 2;
            (search_start..hard_end)
                .rev()
                .find(|index| chars[*index] == '\n')
                .map(|index| index + 1)
                .unwrap_or(hard_end)
        };
        chunks.push(chars[start..end].iter().collect());
        start = end;
    }
    chunks
}

pub fn read_document_result(
    workspace: &Path,
    id: &str,
    chunk_index: usize,
    max_chars: Option<usize>,
    region_ids: &[String],
) -> Result<Value> {
    let Some(artifact) = get_document(workspace, id)? else {
        return Ok(json!({ "error": format!("文档不存在: {id}") }));
    };
    if !region_ids.is_empty() {
        let _guard = selection_store_lock().lock().unwrap();
        return Ok(json!({
            "fileName": artifact.file_name,
            "fileType": artifact.file_type,
            "selections": selection_refs_for_artifact(workspace, &artifact, region_ids)?,
        }));
    }
    let max_chars = max_chars
        .unwrap_or(DEFAULT_CHUNK_CHARS)
        .clamp(MIN_CHUNK_CHARS, MAX_CHUNK_CHARS);
    let chunks = split_text(&artifact.plain_text, max_chars);
    if chunk_index >= chunks.len() {
        return Ok(json!({
            "error": format!("文档分块索引超出范围: {chunk_index}，可用范围为 0-{}", chunks.len().saturating_sub(1)),
            "fileName": artifact.file_name,
            "fileType": artifact.file_type,
            "totalLength": artifact.plain_text.chars().count(),
            "totalChunks": chunks.len(),
            "requestedChunkIndex": chunk_index,
        }));
    }
    let has_more = chunk_index + 1 < chunks.len();
    Ok(json!({
        "strategy": "chunk",
        "fileName": artifact.file_name,
        "fileType": artifact.file_type,
        "totalLength": artifact.plain_text.chars().count(),
        "totalChunks": chunks.len(),
        "chunkIndex": chunk_index,
        "maxChars": max_chars,
        "hasMore": has_more,
        "nextChunkIndex": has_more.then_some(chunk_index + 1),
        "range": {
            "startNodeId": Value::Null,
            "endNodeId": Value::Null,
            "startPageIndex": Value::Null,
            "endPageIndex": Value::Null,
        },
        "guidance": if has_more {
            format!("继续读取请再次调用 read_document，并传入 artifact_id={id} 与 chunk_index={}", chunk_index + 1)
        } else {
            "已到达文档末尾。".to_string()
        },
        "content": chunks[chunk_index],
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imported_documents_are_listed_and_read_in_unicode_safe_chunks() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("报告.md");
        let text = format!(
            "第一节\n{}\n第二节\n{}",
            "内容".repeat(900),
            "结尾".repeat(900)
        );
        std::fs::write(&source, &text).unwrap();
        let artifact = import_parsed_document(
            root.path(),
            &source,
            &json!({ "kind": "markdown", "text": text, "headings": ["第一节", "第二节"] }),
        )
        .unwrap();

        let listed = list_documents_result(root.path()).unwrap();
        assert_eq!(listed["documents"][0]["id"], artifact.id);
        assert_eq!(listed["documents"][0]["fileName"], "报告.md");

        let first = read_document_result(root.path(), &artifact.id, 0, Some(2_000), &[]).unwrap();
        assert_eq!(first["chunkIndex"], 0);
        assert!(first["hasMore"].as_bool().unwrap());
        assert!(first["content"]
            .as_str()
            .unwrap()
            .is_char_boundary(first["content"].as_str().unwrap().len()));
        let second = read_document_result(root.path(), &artifact.id, 1, Some(2_000), &[]).unwrap();
        assert_eq!(second["chunkIndex"], 1);
    }

    #[test]
    fn artifact_ids_cannot_escape_the_store() {
        let root = tempfile::tempdir().unwrap();
        assert!(get_document(root.path(), "../outside").is_err());
    }

    #[test]
    fn draft_stage_apply_roundtrip_with_backup() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("notes.md");
        std::fs::write(&source, "# 原始标题\n\n原文内容\n").unwrap();
        let artifact =
            import_parsed_document(root.path(), &source, &json!({ "kind": "md", "text": "# 原始标题\n\n原文内容" }))
                .unwrap();

        // Stage a markdown draft.
        let staged = stage_document_draft(
            root.path(),
            Some(artifact.id.as_str()),
            None,
            DraftContent::Text { kind: "md", body: "# 新标题\n\n改写后的内容\n".into() },
            None,
        )
        .unwrap();
        assert_eq!(staged["fileType"], "md");
        let draft_path = Path::new(staged["draftPath"].as_str().unwrap());
        assert!(draft_path.is_file(), "draft bytes written");
        assert!(draft_path.starts_with(root.path().join(".worldbase/document-drafts")));

        // The artifact record carries the pending draft.
        let with_draft = get_document(root.path(), &artifact.id).unwrap().unwrap();
        assert!(with_draft.draft.is_some());
        assert_eq!(
            get_document_draft(root.path(), source.to_str().unwrap()).unwrap()["artifactId"],
            artifact.id
        );

        // Wrong sha is rejected before any write happens.
        assert!(apply_document_draft(root.path(), &artifact.id, Some("deadbeef")).is_err());
        assert_eq!(std::fs::read_to_string(&source).unwrap(), "# 原始标题\n\n原文内容\n");

        // Apply overwrites the source, backs it up, and re-parses the record.
        let applied = apply_document_draft(root.path(), &artifact.id, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(&source).unwrap(),
            "# 新标题\n\n改写后的内容\n"
        );
        let backup_path = applied["backupPath"].as_str().unwrap();
        assert!(
            !backup_path.is_empty(),
            "backup path returned (public form may be relative)"
        );
        let applied_artifact = applied["artifact"]["id"].as_str().unwrap();
        let refreshed = get_document(root.path(), applied_artifact).unwrap().unwrap();
        assert!(refreshed.draft.is_none(), "draft state cleared after apply");
        assert!(refreshed.plain_text.contains("改写后的内容"));
        // The backup lives under the workspace backups dir and holds the ORIGINAL bytes.
        let backup_dir = root.path().join(".worldbase/document-backups").join(&artifact.id);
        let backups: Vec<_> = std::fs::read_dir(&backup_dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .collect();
        assert_eq!(backups.len(), 1, "one backup kept");
        assert_eq!(
            std::fs::read_to_string(backups[0].path()).unwrap(),
            "# 原始标题\n\n原文内容\n"
        );

        // No pending draft remains.
        assert!(get_document_draft(root.path(), source.to_str().unwrap()).unwrap().is_null());
    }

    #[test]
    fn draft_stage_rejects_type_mismatch_and_pdf() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("doc.md");
        std::fs::write(&source, "原文").unwrap();
        let artifact =
            import_parsed_document(root.path(), &source, &json!({ "kind": "md", "text": "原文" }))
                .unwrap();

        // docx content onto a markdown file is rejected.
        assert!(stage_document_draft(
            root.path(),
            Some(artifact.id.as_str()),
            None,
            DraftContent::Docx(vec![worldbase_docs::edit::DocBlock::Paragraph("x".into())]),
            None,
        )
        .is_err());

        // text content onto a markdown file is rejected (strict format match).
        assert!(stage_document_draft(
            root.path(),
            Some(artifact.id.as_str()),
            None,
            DraftContent::Text { kind: "text", body: "x".into() },
            None,
        )
        .is_err());

        // pdf sources are not draftable.
        let pdf = root.path().join("doc.pdf");
        std::fs::write(&pdf, b"%PDF-1.4").unwrap();
        let pdf_artifact =
            import_parsed_document(root.path(), &pdf, &json!({ "kind": "pdf", "text": "" }))
                .unwrap();
        let error = stage_document_draft(
            root.path(),
            Some(pdf_artifact.id.as_str()),
            None,
            DraftContent::Text { kind: "text", body: "x".into() },
            None,
        )
        .unwrap_err();
        assert!(error.to_string().contains("暂不支持"), "pdf gets a clear message");
    }

    #[test]
    fn draft_restages_replace_older_drafts_and_discard_clears_state() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("doc.md");
        std::fs::write(&source, "v1").unwrap();
        let artifact =
            import_parsed_document(root.path(), &source, &json!({ "kind": "md", "text": "v1" }))
                .unwrap();

        let first = stage_document_draft(
            root.path(),
            Some(artifact.id.as_str()),
            None,
            DraftContent::Text { kind: "md", body: "v2".into() },
            None,
        )
        .unwrap();
        let second = stage_document_draft(
            root.path(),
            Some(artifact.id.as_str()),
            None,
            DraftContent::Text { kind: "md", body: "v3".into() },
            None,
        )
        .unwrap();
        assert_ne!(first["draftPath"], second["draftPath"], "new draft file");
        assert!(!Path::new(first["draftPath"].as_str().unwrap()).is_file(), "old draft pruned");

        let discarded = discard_document_draft(root.path(), &artifact.id).unwrap();
        assert_eq!(discarded["discarded"], true);
        assert!(!Path::new(second["draftPath"].as_str().unwrap()).is_file());
        let cleared = get_document(root.path(), &artifact.id).unwrap().unwrap();
        assert!(cleared.draft.is_none());
        assert!(get_document_draft(root.path(), source.to_str().unwrap()).unwrap().is_null());
        assert_eq!(std::fs::read_to_string(&source).unwrap(), "v1", "source untouched");
    }

    #[test]
    fn rapid_draft_restages_use_unique_paths_and_keep_only_the_latest_file() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("rapid.md");
        std::fs::write(&source, "v0").unwrap();
        let artifact =
            import_parsed_document(root.path(), &source, &json!({ "kind": "md", "text": "v0" }))
                .unwrap();

        let mut draft_paths = Vec::new();
        for index in 1..=20 {
            let staged = stage_document_draft(
                root.path(),
                Some(artifact.id.as_str()),
                None,
                DraftContent::Text {
                    kind: "md",
                    body: format!("v{index}"),
                },
                None,
            )
            .unwrap();
            let draft_path = PathBuf::from(staged["draftPath"].as_str().unwrap());
            let file_name = draft_path.file_name().unwrap().to_string_lossy();

            assert!(
                file_name.starts_with(&format!("{}-", artifact.id)),
                "draft filename keeps the artifact-id prefix: {file_name}"
            );
            assert_eq!(
                draft_path.extension().and_then(|value| value.to_str()),
                Some("md")
            );
            assert!(draft_path.is_file());
            assert!(
                !draft_paths.contains(&draft_path),
                "draft path reused within the same millisecond: {}",
                draft_path.display()
            );
            for previous in &draft_paths {
                assert!(
                    !previous.is_file(),
                    "older draft was not pruned: {}",
                    previous.display()
                );
            }
            draft_paths.push(draft_path);
        }

        let latest = draft_paths.last().unwrap();
        assert!(latest.is_file());
        let stored = get_document(root.path(), &artifact.id).unwrap().unwrap();
        let stored_path = stored.draft.as_ref().unwrap()["path"].as_str().unwrap();
        assert_eq!(Path::new(stored_path), latest);
    }

    #[test]
    fn draft_save_as_writes_a_copy_and_imports_it() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("report.md");
        std::fs::write(&source, "原稿").unwrap();
        let artifact =
            import_parsed_document(root.path(), &source, &json!({ "kind": "md", "text": "原稿" }))
                .unwrap();
        stage_document_draft(
            root.path(),
            Some(artifact.id.as_str()),
            None,
            DraftContent::Text { kind: "md", body: "改写稿".into() },
            None,
        )
        .unwrap();

        let target = root.path().join("export").join("report-v2.md");
        let saved = save_document_draft_as(root.path(), &artifact.id, &target).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "改写稿");
        assert_eq!(
            std::fs::read_to_string(&source).unwrap(),
            "原稿",
            "original untouched by save-as"
        );
        let new_id = saved["artifact"]["id"].as_str().unwrap();
        assert_ne!(new_id, artifact.id, "save-as imports a new artifact");
        // Both the original (draft cleared) and the new copy exist in the store.
        assert!(get_document(root.path(), new_id).unwrap().is_some());
        let cleared = get_document(root.path(), &artifact.id).unwrap().unwrap();
        assert!(cleared.draft.is_none());
    }

    #[test]
    fn draft_can_target_the_store_by_file_path_without_an_id() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("auto.md");
        std::fs::write(&source, "内容").unwrap();
        // Unknown path auto-imports, then stages.
        let unknown = root.path().join("fresh.md");
        std::fs::write(&unknown, "自动导入").unwrap();
        let staged = stage_document_draft(
            root.path(),
            None,
            Some(unknown.to_str().unwrap()),
            DraftContent::Text { kind: "md", body: "草稿".into() },
            None,
        )
        .unwrap();
        assert!(staged["artifactId"].as_str().is_some());
        let staged_id = staged["artifactId"].as_str().unwrap();
        assert!(get_document(root.path(), staged_id).unwrap().is_some());

        // Existing artifacts are matched by canonical source path.
        let _ = import_parsed_document(root.path(), &source, &json!({ "kind": "md", "text": "内容" }))
            .unwrap();
        let by_path = stage_document_draft(
            root.path(),
            None,
            Some(source.to_str().unwrap()),
            DraftContent::Text { kind: "md", body: "按路径".into() },
            None,
        )
        .unwrap();
        assert!(!by_path["artifactId"].as_str().unwrap().is_empty());
        let applied = apply_document_draft(root.path(), by_path["artifactId"].as_str().unwrap(), None).unwrap();
        assert_eq!(std::fs::read_to_string(&source).unwrap(), "按路径");
        assert!(applied["artifact"].is_object());
    }

    #[test]
    fn parsed_import_requires_a_regular_source_within_the_size_limit() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("missing.pdf");
        assert!(import_parsed_document(
            root.path(),
            &missing,
            &json!({ "kind": "pdf", "text": "" }),
        )
        .is_err());

        let directory = root.path().join("source-dir");
        std::fs::create_dir(&directory).unwrap();
        assert!(import_parsed_document(
            root.path(),
            &directory,
            &json!({ "kind": "text", "text": "" }),
        )
        .is_err());

        let oversized = root.path().join("oversized.pdf");
        let file = std::fs::File::create(&oversized).unwrap();
        file.set_len(MAX_DOCUMENT_BYTES + 1).unwrap();
        assert!(import_parsed_document(
            root.path(),
            &oversized,
            &json!({ "kind": "pdf", "text": "" }),
        )
        .is_err());
    }

    #[test]
    fn parsed_import_persists_a_canonical_source_path() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("nested").join("notes.txt");
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::write(&source, "内容").unwrap();

        let non_canonical = root
            .path()
            .join("nested")
            .join("..")
            .join("nested")
            .join("notes.txt");
        let artifact = import_parsed_document(
            root.path(),
            &non_canonical,
            &json!({ "kind": "text", "text": "内容" }),
        )
        .unwrap();
        assert_eq!(
            Path::new(&artifact.file_path),
            &source.canonicalize().unwrap()
        );
        let public = artifact_public_value(root.path(), &artifact);
        assert_eq!(public["filePath"], "nested/notes.txt");
        assert!(!public
            .to_string()
            .contains(&root.path().to_string_lossy().to_string()));
    }

    #[test]
    fn public_artifact_hides_external_paths_but_internal_storage_remains_resolvable() {
        let workspace = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let source = external.path().join("external-notes.docx");
        std::fs::write(&source, b"source bytes").unwrap();

        let artifact = import_parsed_document(
            workspace.path(),
            &source,
            &json!({ "kind": "docx", "text": "external notes" }),
        )
        .unwrap();
        persist_host_render_preview(
            workspace.path(),
            &artifact.id,
            json!({
                "kind": "html",
                "source": "generated",
                "status": "ready",
                "mimeType": "text/html"
            }),
            b"<p>preview</p>",
        )
        .unwrap();

        let internal = get_document(workspace.path(), &artifact.id)
            .unwrap()
            .expect("persisted artifact");
        assert_eq!(
            Path::new(&internal.file_path),
            &source.canonicalize().unwrap()
        );
        let internal_asset = internal.render.as_ref().unwrap()["assetPath"]
            .as_str()
            .unwrap();
        assert!(Path::new(internal_asset).is_absolute());
        assert!(Path::new(internal_asset).is_file());

        let public = artifact_public_value(workspace.path(), &internal);
        assert_eq!(public["filePath"], "external-notes.docx");
        assert!(public["render"]["assetPath"]
            .as_str()
            .unwrap()
            .starts_with(".worldbase/document-render-cache/"));
        assert!(!public
            .to_string()
            .contains(&workspace.path().to_string_lossy().to_string()));
        assert!(!public
            .to_string()
            .contains(&external.path().to_string_lossy().to_string()));
    }

    #[test]
    fn virtual_import_normalizes_path_like_and_unbounded_file_names() {
        let root = tempfile::tempdir().unwrap();
        let artifact =
            import_text_document(root.path(), r"C:\Users\someone\..\report.md", "正文").unwrap();
        assert_eq!(artifact.file_name, "report.md");
        assert_eq!(artifact.file_path, "report.md");

        let long_name = format!("{}-终.md", "x".repeat(MAX_DOCUMENT_FILE_NAME_BYTES));
        let artifact = import_text_document(root.path(), &long_name, "正文").unwrap();
        assert!(artifact.file_name.len() <= MAX_DOCUMENT_FILE_NAME_BYTES);
        assert!(artifact
            .file_name
            .is_char_boundary(artifact.file_name.len()));

        let fallback = import_text_document(root.path(), "../", "正文").unwrap();
        assert_eq!(fallback.file_name, "current-page.txt");
    }

    #[test]
    fn selections_are_persisted_and_returned_by_list_and_read() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("notes.md");
        std::fs::write(&source, "第一段\n\n第二段").unwrap();
        let artifact = import_parsed_document(
            root.path(),
            &source,
            &json!({ "kind": "markdown", "text": "第一段\n\n第二段" }),
        )
        .unwrap();

        let region = create_selection(
            root.path(),
            &artifact.id,
            &[],
            Some("重点"),
            Some("#ef4444"),
            Some("第二段"),
        )
        .unwrap();
        assert_eq!(region.label, "重点");
        assert_eq!(region.color, "#ef4444");

        // Read through the file-backed APIs again to prove the selection is
        // durable rather than held in an in-memory process map.
        let listed = list_documents_result(root.path()).unwrap();
        assert_eq!(listed["documents"][0]["selectionCount"], 1);
        assert_eq!(listed["selections"][0]["id"], region.id);
        assert_eq!(listed["selections"][0]["artifactId"], artifact.id);
        assert_eq!(listed["selections"][0]["nodeCount"], 0);

        let selected = read_document_result(
            root.path(),
            &artifact.id,
            0,
            None,
            std::slice::from_ref(&region.id),
        )
        .unwrap();
        assert_eq!(selected["fileName"], "notes.md");
        assert_eq!(selected["selections"][0]["regionId"], region.id);
        assert_eq!(selected["selections"][0]["label"], "重点");
        assert_eq!(selected["selections"][0]["text"], "第二段");

        let reloaded = list_selections(root.path()).unwrap();
        assert_eq!(reloaded.len(), 1);
        assert_eq!(reloaded[0].id, region.id);
    }

    #[test]
    fn selection_prompt_matches_electron_envelope_and_optional_filtering() {
        let root = tempfile::tempdir().unwrap();
        let artifact = import_text_document(root.path(), "报告.md", "正文").unwrap();
        let first = create_selection(
            root.path(),
            &artifact.id,
            &[],
            Some("重点"),
            Some("#ef4444"),
            Some("第一段"),
        )
        .unwrap();
        let second = create_selection(
            root.path(),
            &artifact.id,
            &[],
            Some("补充"),
            Some("#3b82f6"),
            Some("第二段"),
        )
        .unwrap();

        assert_eq!(
            build_selections_prompt(root.path(), Some(&[first.id.clone()])).unwrap(),
            "【文档选区：报告.md — 重点】\n第一段\n【选区结束】"
        );
        assert_eq!(build_selections_prompt(root.path(), Some(&[])).unwrap(), "");
        assert_eq!(
            build_selections_prompt(root.path(), Some(&["unknown".to_string()])).unwrap(),
            ""
        );
        assert_eq!(
            build_selections_prompt(root.path(), None).unwrap(),
            "【文档选区：报告.md — 重点】\n第一段\n【选区结束】\n\n【文档选区：报告.md — 补充】\n第二段\n【选区结束】"
        );
        assert!(!second.id.is_empty());
    }

    #[test]
    fn selections_can_be_renamed_and_removed() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("notes.txt");
        std::fs::write(&source, "内容").unwrap();
        let artifact = import_parsed_document(
            root.path(),
            &source,
            &json!({ "kind": "text", "text": "内容" }),
        )
        .unwrap();
        let region =
            create_selection(root.path(), &artifact.id, &[], None, None, Some("内容")).unwrap();

        let updated = update_selection_label(root.path(), &region.id, " 新标签 ")
            .unwrap()
            .unwrap();
        assert_eq!(updated.label, "新标签");
        assert_eq!(
            get_selections_for_artifact(root.path(), &artifact.id).unwrap()[0].label,
            "新标签"
        );
        assert!(remove_selection(root.path(), &region.id).unwrap());
        assert!(list_selections(root.path()).unwrap().is_empty());
        assert!(!remove_selection(root.path(), &region.id).unwrap());
    }

    // -------------------------------------------------------------------
    // Draft changes / dataLossRisk / direct-write guard
    // -------------------------------------------------------------------

    /// 与 docs crate 测试一致的含图 docx fixture。
    fn write_docx_with_media(path: &std::path::Path) {
        use std::io::Write as _;
        const TINY_PNG: &[u8] = &[
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49,
            0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
            0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44,
            0x41, 0x54, 0x78, 0x9C, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D,
            0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42,
            0x60, 0x82,
        ];
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
        for (name, content) in [
            ("[Content_Types].xml", "<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Default Extension=\"png\" ContentType=\"image/png\"/></Types>"),
            ("word/document.xml", concat!(
                "<?xml version=\"1.0\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><w:body>",
                "<w:p><w:r><w:t>第一段</w:t></w:r></w:p>",
                "<w:p><w:r><w:t>第二段</w:t></w:r></w:p>",
                "</w:body></w:document>")),
            ("word/_rels/document.xml.rels", "<?xml version=\"1.0\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"media/image1.png\"/></Relationships>"),
        ] {
            zip.start_file(name, options).unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.start_file("word/media/image1.png", options).unwrap();
        zip.write_all(TINY_PNG).unwrap();
        zip.finish().unwrap();
    }

    #[test]
    fn full_text_md_draft_computes_change_list() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("notes.md");
        std::fs::write(&source, "# 标题\n\n第一段\n第二段\n\n结尾\n").unwrap();
        let artifact = import_parsed_document(
            root.path(),
            &source,
            &json!({ "kind": "markdown", "text": "# 标题\n\n第一段\n第二段\n\n结尾" }),
        )
        .unwrap();

        let staged = stage_document_draft(
            root.path(),
            Some(artifact.id.as_str()),
            None,
            DraftContent::Text {
                kind: "md",
                body: "# 标题\n\n第一段改写\n第二段\n\n结尾\n新增尾巴\n".into(),
            },
            Some("改写第一段并新增结尾".into()),
        )
        .unwrap();

        let changes = &staged["changes"];
        assert_eq!(changes["counts"]["modified"], 1);
        assert_eq!(changes["counts"]["added"], 1);
        assert_eq!(staged["summary"], "改写第一段并新增结尾");
        let items = changes["items"].as_array().unwrap();
        let modified = items
            .iter()
            .find(|item| item["kind"] == "modify")
            .expect("modify entry present");
        assert!(modified["before"].as_str().unwrap().contains("第一段"));
        assert!(modified["after"].as_str().unwrap().contains("第一段改写"));

        // doc.draft.get 也带回 changes（渲染层恢复路径）
        let record = get_document_draft(root.path(), source.to_str().unwrap()).unwrap();
        assert_eq!(record["changes"]["counts"]["modified"], 1);
    }

    #[test]
    fn media_bearing_docx_marks_data_loss_for_full_text_and_ops_preserve_media() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("with-image.docx");
        write_docx_with_media(&source);
        let parsed = worldbase_docs::parse_file(&source).unwrap();
        let artifact = import_parsed_document(root.path(), &source, &parsed).unwrap();

        // 全文重建 → dataLossRisk 标记
        let full_text = stage_document_draft(
            root.path(),
            Some(artifact.id.as_str()),
            None,
            DraftContent::Docx(vec![worldbase_docs::edit::DocBlock::Paragraph("全新内容".into())]),
            None,
        )
        .unwrap();
        assert_eq!(full_text["dataLossRisk"]["mediaCount"], 1);

        // ops 草稿 → 无风险标记，media 字节保留
        let image = root.path().join("insert.png");
        std::fs::write(&image, b"not-a-real-png").unwrap(); // 占位；插图在 docs crate 测试覆盖
        let ops_draft = stage_document_draft(
            root.path(),
            Some(artifact.id.as_str()),
            None,
            DraftContent::OfficeOps(vec![worldbase_docs::ops::OfficeOp::DocxReplaceText {
                paragraph_index: 0,
                after_text: "第一段改写".into(),
                expect_before: Some("第一段".into()),
            }]),
            Some("改第一段".into()),
        )
        .unwrap();
        assert!(ops_draft["dataLossRisk"].is_null(), "ops drafts carry no data loss");
        assert_eq!(ops_draft["changes"]["counts"]["modified"], 1);
        let draft_path = Path::new(ops_draft["draftPath"].as_str().unwrap());
        let package = worldbase_docs::ops::count_media_parts(draft_path).unwrap();
        assert_eq!(package, 1, "media survives into the ops draft");
        let _ = image;
    }

    #[test]
    fn direct_write_guard_blocks_imported_and_existing_office_targets() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("doc.md");
        std::fs::write(&source, "内容").unwrap();
        let artifact =
            import_parsed_document(root.path(), &source, &json!({ "kind": "text", "text": "内容" }))
                .unwrap();

        // 已导入路径拒绝
        assert!(ensure_document_write_allowed(root.path(), &source).is_err());
        // 新文本文件放行
        assert!(ensure_document_write_allowed(root.path(), &root.path().join("new.txt")).is_ok());
        let _ = artifact;

        // 已存在的 office 文件拒绝（即使未导入）
        let office = root.path().join("untracked.docx");
        write_docx_with_media(&office);
        assert!(ensure_document_write_allowed(root.path(), &office).is_err());
        // 不存在的 office 路径放行（新建文档语义）
        assert!(ensure_document_write_allowed(root.path(), &root.path().join("fresh.docx")).is_ok());
    }
}

#[cfg(test)]
mod draft_pull_path_tests {
    use super::*;

    #[test]
    fn draft_record_value_exposes_absolute_draft_path_for_ui_pull() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path();
        let source = workspace.join("notes.md");
        std::fs::write(&source, "# Title\nbody").unwrap();
        let staged = stage_document_draft(
            workspace,
            None,
            Some(source.to_str().unwrap()),
            DraftContent::Text { kind: "md", body: "# Title\nchanged".to_string() },
            None,
        )
        .unwrap();
        let artifact_id = staged["artifactId"].as_str().unwrap().to_string();

        let pulled = get_document_draft(workspace, source.to_str().unwrap()).unwrap();
        assert!(!pulled.is_null(), "draft must be pullable");
        assert_eq!(
            pulled["draftPath"].as_str().unwrap(),
            staged["draftPath"].as_str().unwrap(),
            "pull and push payloads must agree on draftPath"
        );
        assert_eq!(pulled["artifactId"].as_str().unwrap(), artifact_id);
    }

    #[test]
    fn staging_twice_reuses_the_same_artifact_for_one_source() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path();
        let source = workspace.join("report.md");
        std::fs::write(&source, "v1").unwrap();
        let first = stage_document_draft(
            workspace,
            None,
            Some(source.to_str().unwrap()),
            DraftContent::Text { kind: "md", body: "a".into() },
            None,
        )
        .unwrap();
        let second = stage_document_draft(
            workspace,
            None,
            Some(source.to_str().unwrap()),
            DraftContent::Text { kind: "md", body: "b".into() },
            None,
        )
        .unwrap();
        assert_eq!(
            first["artifactId"].as_str().unwrap(),
            second["artifactId"].as_str().unwrap(),
            "re-staging the same source must not create a duplicate artifact"
        );
    }
}
