//! Durable document artifacts shared by direct RPC and Agent tools.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
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
}
