//! Cross-file project inspection for coding tasks.
//!
//! The tool reads supported source files from a managed project, builds an
//! in-memory `ProjectIndex`, and returns context, symbols, imports, or a
//! read-only cross-file rename plan. It never writes files.

use crate::{Tool, ToolServices};
use anyhow::{Context, Result};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use worldbase_coding::project_index::{ProjectIndex, SourceFile};
use worldbase_coding::smart_editor::SymbolKind;

const MAX_FILES: usize = 5_000;
const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_RENAME_AFTER_BYTES: usize = 256 * 1024;

const SKIP_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "vendor",
    "__pycache__",
    ".venv",
    "venv",
    ".tox",
    "coverage",
    ".cache",
];

const SUPPORTED_EXTENSIONS: &[&str] = &[
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "py", "pyi", "go", "rs", "java",
];

pub struct CodingProjectTool;

#[async_trait]
impl Tool for CodingProjectTool {
    fn name(&self) -> &str {
        "coding_project"
    }

    fn description(&self) -> &str {
        "Inspect a project across files: symbol lookup, import/importers, context selection for changed files, and a read-only cross-file rename plan. Read-only; never writes files."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_id": { "type": "string", "description": "Managed project ID." },
                "operation": {
                    "type": "string",
                    "enum": ["context", "symbols", "imports", "rename"],
                    "description": "Inspection operation."
                },
                "files": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Project-relative changed files for context."
                },
                "file_path": { "type": "string", "description": "Project-relative file for imports." },
                "name": { "type": "string", "description": "Symbol name for symbols/rename." },
                "kind": {
                    "type": "string",
                    "description": "Optional symbol kind: function, method, type, interface, variable, module, import, export."
                },
                "new_name": { "type": "string", "description": "New name for rename." },
                "max_hops": { "type": "integer", "minimum": 0, "maximum": 8 }
            },
            "required": ["project_id", "operation"]
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

    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let project_id = require_str(&input, "project_id")?.trim().to_string();
        let operation = require_str(&input, "operation")?.trim().to_string();
        let root = services.projects.project_root(&project_id)?;
        let sources = collect_sources(&root).await?;
        let index = ProjectIndex::from_sources(sources)?;
        let parse_errors = index
            .parse_errors()
            .iter()
            .take(20)
            .map(|(path, error)| json!({ "path": project_relative(&root, path), "error": error }))
            .collect::<Vec<_>>();

        match operation.as_str() {
            "context" => {
                let files = input
                    .get("files")
                    .and_then(Value::as_array)
                    .ok_or_else(|| anyhow::anyhow!("files is required for context"))?
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|file| !file.is_empty())
                    .map(PathBuf::from)
                    .collect::<Vec<_>>();
                let hops = input
                    .get("max_hops")
                    .and_then(Value::as_u64)
                    .unwrap_or(2)
                    .min(8) as usize;
                let context = index
                    .context_for(&files, hops)
                    .into_iter()
                    .map(|path| project_relative(&root, &path))
                    .collect::<Vec<_>>();
                Ok(json!({
                    "operation": "context",
                    "files": context,
                    "parseErrors": parse_errors,
                }))
            }
            "symbols" => {
                let name = require_str(&input, "name")?.trim();
                let kind = parse_kind(input.get("kind"))?;
                let symbols = index
                    .find_symbols(name, kind)
                    .into_iter()
                    .map(|symbol| {
                        json!({
                            "file": project_relative(&root, &symbol.file),
                            "name": symbol.name,
                            "kind": format!("{:?}", symbol.kind).to_ascii_lowercase(),
                            "startByte": symbol.start_byte,
                            "endByte": symbol.end_byte,
                            "startRow": symbol.start_row,
                            "endRow": symbol.end_row,
                            "parentPath": symbol.parent_path,
                            "exported": symbol.exported,
                        })
                    })
                    .collect::<Vec<_>>();
                Ok(json!({
                    "operation": "symbols",
                    "symbols": symbols,
                    "parseErrors": parse_errors,
                }))
            }
            "imports" => {
                let file_path = require_str(&input, "file_path")?.trim();
                let file = normalize_project_path(&root, file_path)?;
                Ok(json!({
                    "operation": "imports",
                    "file": file_path,
                    "imports": index
                        .imports_of(&file)
                        .into_iter()
                        .map(|path| project_relative(&root, path))
                        .collect::<Vec<_>>(),
                    "importers": index
                        .importers_of(&file)
                        .into_iter()
                        .map(|path| project_relative(&root, path))
                        .collect::<Vec<_>>(),
                    "parseErrors": parse_errors,
                }))
            }
            "rename" => {
                let name = require_str(&input, "name")?.trim();
                let new_name = require_str(&input, "new_name")?.trim();
                let kind = parse_kind(input.get("kind"))?;
                let plans = index.rename_plan(name, kind, new_name)?;
                let mut total_after_bytes = 0usize;
                let files = plans
                    .into_iter()
                    .map(|plan| {
                        let include_after =
                            total_after_bytes + plan.after.len() <= MAX_RENAME_AFTER_BYTES;
                        if include_after {
                            total_after_bytes += plan.after.len();
                        }
                        json!({
                            "file": project_relative(&root, &plan.path),
                            "replacements": plan.replacements.iter().map(|range| json!({
                                "start": range.start,
                                "end": range.end
                            })).collect::<Vec<_>>(),
                            "after": include_after.then_some(plan.after),
                        })
                    })
                    .collect::<Vec<_>>();
                Ok(json!({
                    "operation": "rename",
                    "name": name,
                    "newName": new_name,
                    "files": files,
                    "afterBytesIncluded": total_after_bytes,
                    "parseErrors": parse_errors,
                }))
            }
            other => anyhow::bail!(
                "unsupported operation `{other}`; expected context, symbols, imports, or rename"
            ),
        }
    }
}

async fn collect_sources(root: &Path) -> Result<Vec<SourceFile>> {
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        if files.len() >= MAX_FILES {
            break;
        }
        let mut entries = tokio::fs::read_dir(&directory)
            .await
            .with_context(|| format!("read directory {}", directory.display()))?;
        while let Some(entry) = entries.next_entry().await? {
            if files.len() >= MAX_FILES {
                break;
            }
            let file_type = entry.file_type().await?;
            let path = entry.path();
            if file_type.is_dir() {
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                if !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push(path);
                }
                continue;
            }
            if !file_type.is_file() || !is_supported(&path) {
                continue;
            }
            let metadata = entry.metadata().await?;
            if metadata.len() > MAX_FILE_BYTES {
                continue;
            }
            let source = tokio::fs::read_to_string(&path).await?;
            files.push(SourceFile { path, source });
        }
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn is_supported(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .is_some_and(|extension| SUPPORTED_EXTENSIONS.contains(&extension.as_str()))
}

fn require_str<'a>(input: &'a Value, key: &str) -> Result<&'a str> {
    input
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("missing required string parameter: {key}"))
}

fn parse_kind(value: Option<&Value>) -> Result<Option<SymbolKind>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("kind must be a string"))?
        .trim();
    if value.is_empty() {
        return Ok(None);
    }
    Ok(Some(value.parse::<SymbolKind>()?))
}

fn normalize_project_path(root: &Path, relative: &str) -> Result<PathBuf> {
    let path = Path::new(relative);
    anyhow::ensure!(!path.is_absolute(), "file_path must be project-relative");
    let normalized = root.join(path);
    let normalized = normalized.canonicalize().unwrap_or_else(|_| normalized);
    anyhow::ensure!(
        normalized.starts_with(root),
        "file_path escapes the project root"
    );
    Ok(normalized)
}

fn project_relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_supported_extensions_and_kinds() {
        assert!(is_supported(Path::new("src/main.ts")));
        assert!(is_supported(Path::new("src/main.py")));
        assert!(!is_supported(Path::new("README.md")));
        assert_eq!(
            parse_kind(Some(&json!("function"))).unwrap(),
            Some(SymbolKind::Function)
        );
        assert!(parse_kind(Some(&json!("not-a-kind"))).is_err());
        assert_eq!(parse_kind(None).unwrap(), None);
    }

    #[test]
    fn descriptor_is_read_only_and_native() {
        let tool = CodingProjectTool;
        assert_eq!(tool.name(), "coding_project");
        assert_eq!(tool.domain(), "desktop");
        assert_eq!(tool.permission(), "allow");
        assert!(tool.electron_native());
    }
}
