//! Rust-owned project control plane used by the Electron IPC adapter.
//!
//! Agent tools intentionally expose compact, model-friendly responses.  The
//! desktop UI needs a separate API whose shapes match ProjectFS, BuilderService
//! and ProjectDataAccess, while keeping all project bytes and process state in
//! the Rust harness once it is selected.

use super::{bundled_node, normalize_project_id, with_runtime_environment, ProjectRuntime};
use anyhow::{Context, Result};
use rusqlite::{
    params_from_iter,
    types::{Value as SqlValue, ValueRef},
    Connection,
};
use serde_json::{json, Map, Value};
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Instant,
};

const PROJECT_PACKAGE_KIND: &str = "the-world-app-package";
const PROJECT_PACKAGE_FORMAT_VERSION: u64 = 1;
const PROJECT_PACKAGE_SOURCE_PREFIX: &str = "source/";
const PROJECT_PACKAGE_BUILD_PREFIX: &str = "build/";
const PROJECT_PACKAGE_MANIFEST_PATH: &str = "manifest.json";
const PROJECT_PACKAGE_DECLARED_SCHEMA_PATH: &str = "database/declared-schema.json";
const PROJECT_PACKAGE_INTROSPECTED_SCHEMA_PATH: &str = "database/introspected-schema.json";
const MAX_WORKSPACE_TREE_ENTRIES: usize = 5_000;
const MAX_WORKSPACE_TREE_DEPTH: usize = 12;
const MAX_WORKSPACE_PREVIEW_BYTES: u64 = 1024 * 1024;

const WORKSPACE_IGNORED_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    ".next",
    "dist",
    "build",
    "coverage",
    ".cache",
    ".turbo",
    ".output",
    "__pycache__",
    ".venv",
    "venv",
];

const WORKSPACE_BINARY_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "avif", "woff", "woff2", "ttf", "eot",
    "otf", "zip", "tar", "gz", "bz2", "rar", "7z", "pdf", "doc", "docx", "xls", "xlsx", "ppt",
    "pptx", "mp3", "mp4", "avi", "mov", "wav", "flac", "exe", "dll", "so", "dylib", "o", "sqlite",
    "db",
];

fn project_display_name(project_id: &str) -> String {
    let without_prefix = project_id.strip_prefix("proj_").unwrap_or(project_id);
    let mut parts = without_prefix.rsplitn(2, '_');
    let suffix = parts.next().unwrap_or_default();
    let stem = parts.next().unwrap_or(without_prefix);
    if suffix.len() == 6 || suffix.len() == 8 {
        stem.to_string()
    } else {
        without_prefix.to_string()
    }
}

fn as_object(value: Value, label: &str) -> Result<Map<String, Value>> {
    value
        .as_object()
        .cloned()
        .with_context(|| format!("{label} must be a JSON object"))
}

fn meta_from_value(project_id: &str, value: Value) -> Result<Value> {
    let mut meta = as_object(value, ".world-meta.json")?;
    meta.insert("id".into(), Value::String(project_id.to_string()));
    let fallback_name = project_display_name(project_id);
    let name = meta
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(&fallback_name)
        .to_string();
    meta.insert("name".into(), Value::String(name));
    Ok(Value::Object(meta))
}

fn standalone_recovery_meta(project_id: &str) -> Value {
    json!({
        "id": project_id,
        "name": project_display_name(project_id),
        "type": "frontend",
        "framework": "nextjs",
        "createdAt": worldbase_protocol::event::now_rfc3339(),
        "buildStatus": "built",
        "runtime": { "backend": { "command": "node .next/standalone/server.js" } }
    })
}

fn visible_tree(root: &Path, relative: &str) -> Result<Vec<Value>> {
    let mut entries =
        fs::read_dir(root.join(relative))?.collect::<std::result::Result<Vec<_>, _>>()?;
    entries.sort_by(|left, right| left.file_name().cmp(&right.file_name()));

    let mut result = Vec::new();
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        // Match Electron ProjectFS: its source viewer hides every dot entry
        // and node_modules from the project tree.
        if name == "node_modules" || name.starts_with('.') {
            continue;
        }
        let path = if relative.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", relative.trim_end_matches('/'), name)
        };
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            result.push(json!({
                "name": name,
                "path": path,
                "type": "directory",
                "children": visible_tree(root, &path)?
            }));
        } else {
            result.push(json!({ "name": name, "path": path, "type": "file" }));
        }
    }
    Ok(result)
}

fn atomic_write(path: &Path, content: &str) -> Result<()> {
    let parent = path
        .parent()
        .context("project file has no parent directory")?;
    fs::create_dir_all(parent)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .context("project file name is invalid")?;
    let temporary = parent.join(format!(".{file_name}.{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temporary, content)?;
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(&temporary, path).or_else(|error| {
        let _ = fs::remove_file(&temporary);
        Err(error)
    })?;
    Ok(())
}

pub(crate) fn is_next_project(root: &Path) -> bool {
    if [
        "next.config.js",
        "next.config.mjs",
        "next.config.cjs",
        "next.config.ts",
    ]
    .iter()
    .any(|name| root.join(name).is_file())
    {
        return true;
    }
    if fs::read_to_string(root.join(".world-meta.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|meta| {
            meta.get("framework")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .is_some_and(|framework| framework.eq_ignore_ascii_case("nextjs"))
    {
        return true;
    }
    let package = root.join("package.json");
    fs::read_to_string(package)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .map(|package| {
            ["dependencies", "devDependencies"].into_iter().any(|key| {
                package
                    .get(key)
                    .and_then(Value::as_object)
                    .map(|items| items.contains_key("next"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Ensure the standalone output contract expected by both runtimes. Existing
/// user config files are preserved; a missing config receives the same small
/// output-only config as Electron's BuilderService.
pub(crate) fn ensure_next_standalone_config(root: &Path) -> Result<()> {
    let candidates = [
        "next.config.js",
        "next.config.mjs",
        "next.config.cjs",
        "next.config.ts",
    ];
    if candidates.iter().any(|name| root.join(name).is_file()) {
        return Ok(());
    }
    fs::write(
        root.join("next.config.js"),
        "/** @type {import('next').NextConfig} */\nconst nextConfig = { output: 'standalone' }\n\nmodule.exports = nextConfig\n",
    )?;
    Ok(())
}

fn update_meta_field(root: &Path, update: impl FnOnce(&mut Map<String, Value>)) -> Result<Value> {
    let path = root.join(".world-meta.json");
    let text = fs::read_to_string(&path)?;
    let mut meta = as_object(serde_json::from_str(&text)?, ".world-meta.json")?;
    update(&mut meta);
    let value = Value::Object(meta);
    atomic_write(&path, &serde_json::to_string_pretty(&value)?)?;
    Ok(value)
}

fn collect_source_hash(root: &Path, current: &Path, hasher: &mut DefaultHasher) -> Result<()> {
    let mut entries = fs::read_dir(current)?.collect::<std::result::Result<Vec<_>, _>>()?;
    entries.sort_by(|left, right| left.file_name().cmp(&right.file_name()));
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let file_type = entry.file_type()?;
        if file_type.is_dir()
            && (name == "node_modules"
                || name == ".git"
                || name == ".next"
                || name == "dist"
                || name == "build"
                || name == "out"
                || name == ".output"
                || name == "release")
        {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_source_hash(root, &path, hasher)?;
        } else if file_type.is_file() {
            path.strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .hash(hasher);
            fs::read(path)?.hash(hasher);
        }
    }
    Ok(())
}

fn source_hash(root: &Path) -> Result<String> {
    let mut hasher = DefaultHasher::new();
    collect_source_hash(root, root, &mut hasher)?;
    Ok(format!("{:016x}", hasher.finish()))
}

fn directory_size(path: &Path) -> Result<u64> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error.into()),
    };
    if metadata.is_file() {
        return Ok(metadata.len());
    }
    if !metadata.is_dir() {
        return Ok(0);
    }
    let mut size = 0;
    for entry in fs::read_dir(path)? {
        size += directory_size(&entry?.path())?;
    }
    Ok(size)
}

async fn command_output(
    root: &Path,
    project_id: &str,
    command_text: &str,
    node_env: &str,
) -> Result<(bool, String)> {
    let node = bundled_node()
        .or_else(|| super::which("node"))
        .context("node runtime not found")?;
    #[cfg(windows)]
    let mut command = {
        let mut command = tokio::process::Command::new("cmd");
        command.arg("/C").arg(command_text);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = tokio::process::Command::new("sh");
        command.arg("-c").arg(command_text);
        command
    };
    command.current_dir(root);
    with_runtime_environment(&mut command, &node, project_id, root, root, 0, node_env)?;
    let output = command.output().await.context("spawn project command")?;
    let log = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok((output.status.success(), log))
}

fn data_config(meta: &Value) -> Result<Option<Map<String, Value>>> {
    match meta.get("dataSchema") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => Ok(Some(as_object(value.clone(), "dataSchema")?)),
    }
}

fn sqlite_path(
    runtime: &ProjectRuntime,
    project_id: &str,
    config: &Map<String, Value>,
) -> Result<PathBuf> {
    let database = config
        .get("database")
        .and_then(Value::as_str)
        .unwrap_or_default();
    anyhow::ensure!(
        database == "sqlite",
        "project does not have SQLite configured"
    );
    let relative = config
        .get("dbPath")
        .and_then(Value::as_str)
        .context("SQLite dataSchema is missing dbPath")?;
    runtime.project_path(project_id, relative)
}

fn validate_identifier(value: &str) -> Result<&str> {
    let mut chars = value.chars();
    let first = chars.next().context("empty SQL identifier")?;
    anyhow::ensure!(
        first == '_' || first.is_ascii_alphabetic(),
        "invalid SQL identifier: {value}"
    );
    anyhow::ensure!(
        chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric()),
        "invalid SQL identifier: {value}"
    );
    Ok(value)
}

fn normalize_archive_path(value: &str) -> Result<String> {
    let value = value.replace('\\', "/");
    let mut components = Vec::new();
    for part in value.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        anyhow::ensure!(
            part != ".." && !part.contains('\0') && !part.contains(':'),
            "invalid archive path: {value}"
        );
        components.push(part);
    }
    anyhow::ensure!(!components.is_empty(), "invalid archive path: {value}");
    Ok(components.join("/"))
}

fn is_macos_metadata_path(relative: &str) -> bool {
    let lower = relative.to_ascii_lowercase();
    lower.starts_with("__macosx/")
        || relative.rsplit('/').next() == Some(".DS_Store")
        || relative
            .rsplit('/')
            .next()
            .map(|name| name.starts_with("._"))
            .unwrap_or(false)
}

fn package_files(
    root: &Path,
    relative: &Path,
    include: &impl Fn(&str) -> bool,
) -> Result<Vec<String>> {
    let full = root.join(relative);
    let metadata = fs::symlink_metadata(&full)?;
    if metadata.file_type().is_symlink() {
        return Ok(Vec::new());
    }
    if metadata.is_file() {
        let value = normalize_archive_path(&relative.to_string_lossy())?;
        return Ok(include(&value).then_some(value).into_iter().collect());
    }
    if !metadata.is_dir() {
        return Ok(Vec::new());
    }
    let mut entries = fs::read_dir(full)?.collect::<std::result::Result<Vec<_>, _>>()?;
    entries.sort_by(|left, right| left.file_name().cmp(&right.file_name()));
    let mut result = Vec::new();
    for entry in entries {
        let child = relative.join(entry.file_name());
        result.extend(package_files(root, &child, include)?);
    }
    Ok(result)
}

fn imported_project_id(name: &str) -> String {
    let slug = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect::<String>()
        .split('_')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("_");
    let slug = slug.chars().take(20).collect::<String>();
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    if slug.is_empty() {
        format!("proj_{}", &suffix[..20])
    } else {
        format!("proj_{slug}_{}", &suffix[..8])
    }
}

fn sqlite_value(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(value) => json!(value),
        ValueRef::Real(value) => json!(value),
        ValueRef::Text(value) => Value::String(String::from_utf8_lossy(value).into_owned()),
        ValueRef::Blob(value) => Value::Array(value.iter().copied().map(Value::from).collect()),
    }
}

fn sqlite_rows(connection: &Connection, sql: &str) -> Result<Vec<Value>> {
    let mut statement = connection.prepare(sql)?;
    let columns = statement
        .column_names()
        .iter()
        .map(|name| (*name).to_string())
        .collect::<Vec<_>>();
    let rows = statement.query_map([], |row| {
        let mut object = Map::new();
        for (index, name) in columns.iter().enumerate() {
            object.insert(name.clone(), sqlite_value(row.get_ref(index)?));
        }
        Ok(Value::Object(object))
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn sqlite_rows_with_params(
    connection: &Connection,
    sql: &str,
    values: Vec<SqlValue>,
) -> Result<Vec<Value>> {
    let mut statement = connection.prepare(sql)?;
    let columns = statement
        .column_names()
        .iter()
        .map(|name| (*name).to_string())
        .collect::<Vec<_>>();
    let rows = statement.query_map(params_from_iter(values), |row| {
        let mut object = Map::new();
        for (index, name) in columns.iter().enumerate() {
            object.insert(name.clone(), sqlite_value(row.get_ref(index)?));
        }
        Ok(Value::Object(object))
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn declared_table<'a>(
    config: &'a Map<String, Value>,
    table_name: &str,
) -> Result<&'a Map<String, Value>> {
    let table_name = validate_identifier(table_name)?;
    config
        .get("tables")
        .and_then(Value::as_array)
        .and_then(|tables| {
            tables
                .iter()
                .find(|table| table.get("name").and_then(Value::as_str) == Some(table_name))
        })
        .and_then(Value::as_object)
        .context(format!(
            "Table {table_name} is not declared in the project's dataSchema"
        ))
}

type DeclaredColumns = Vec<(String, Map<String, Value>)>;

fn declared_columns(table: &Map<String, Value>) -> Result<DeclaredColumns> {
    let columns = table
        .get("columns")
        .and_then(Value::as_array)
        .context("table is declared without any columns")?;
    anyhow::ensure!(!columns.is_empty(), "table is declared without any columns");
    let mut result = Vec::with_capacity(columns.len());
    for column in columns {
        let column = column.as_object().context("invalid table column")?;
        let name = column
            .get("name")
            .and_then(Value::as_str)
            .context("table column is missing name")?;
        result.push((validate_identifier(name)?.to_string(), column.clone()));
    }
    Ok(result)
}

fn has_declared_column(columns: &DeclaredColumns, name: &str) -> bool {
    columns.iter().any(|(column, _)| column == name)
}

fn json_to_sql_value(value: &Value) -> Result<SqlValue> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::Bool(value) => SqlValue::Integer(i64::from(*value)),
        Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                SqlValue::Integer(value)
            } else if let Some(value) = value.as_u64() {
                SqlValue::Integer(i64::try_from(value).context("integer exceeds SQLite range")?)
            } else {
                SqlValue::Real(value.as_f64().context("invalid JSON number")?)
            }
        }
        Value::String(value) => SqlValue::Text(value.clone()),
        Value::Array(_) | Value::Object(_) => SqlValue::Text(serde_json::to_string(value)?),
    })
}

fn workspace_relative_path(root: &Path, relative_path: &str) -> Result<(String, PathBuf)> {
    let relative = relative_path.trim().replace('\\', "/");
    anyhow::ensure!(!relative.is_empty(), "file_path is required");
    let relative_path = Path::new(&relative);
    anyhow::ensure!(
        !relative_path.is_absolute()
            && !relative_path.components().any(|component| matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )),
        "workspace file path escapes workspace"
    );
    let candidate = root.join(relative_path);
    let mut existing = candidate.clone();
    let mut missing = Vec::new();
    while !existing.exists() {
        let name = existing
            .file_name()
            .context("invalid workspace file path")?
            .to_os_string();
        missing.push(name);
        existing = existing
            .parent()
            .context("invalid workspace file path")?
            .to_path_buf();
    }
    let mut resolved = existing.canonicalize()?;
    for component in missing.iter().rev() {
        resolved.push(component);
    }
    anyhow::ensure!(
        resolved.starts_with(root),
        "workspace file path escapes workspace"
    );
    Ok((relative.trim_matches('/').to_string(), resolved))
}

fn workspace_language(path: &str) -> Option<&'static str> {
    let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    // Keep the preview language identifiers aligned with Electron's folder
    // workspace viewer. Check compound names before the generic extension.
    for (suffix, language) in [
        (".blade.php", "blade"),
        (".component.html", "xml"),
        (".module.css", "css"),
        (".module.scss", "scss"),
        (".module.sass", "scss"),
        (".module.less", "less"),
        (".stories.jsx", "javascript"),
        (".stories.tsx", "typescript"),
        (".stories.js", "javascript"),
        (".stories.ts", "typescript"),
    ] {
        if name.ends_with(suffix) {
            return Some(language);
        }
    }
    let extension = name
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .unwrap_or_default();
    match extension {
        "js" | "jsx" | "mjs" | "cjs" => Some("javascript"),
        "ts" | "tsx" | "mts" | "cts" => Some("typescript"),
        "vue" => Some("vue"),
        "svelte" => Some("svelte"),
        "astro" => Some("astro"),
        "html" | "htm" | "xml" | "svg" => Some("xml"),
        "css" => Some("css"),
        "scss" | "sass" => Some("scss"),
        "less" => Some("less"),
        "styl" => Some("stylus"),
        "json" | "jsonc" => Some("json"),
        "yaml" | "yml" => Some("yaml"),
        "toml" | "ini" => Some("ini"),
        "env" => Some("properties"),
        "py" => Some("python"),
        "rb" => Some("ruby"),
        "java" => Some("java"),
        "go" => Some("go"),
        "rs" => Some("rust"),
        "php" => Some("php"),
        "swift" => Some("swift"),
        "kt" | "kts" => Some("kotlin"),
        "c" | "h" | "cpp" | "cc" | "cxx" | "hpp" => Some("c"),
        "cs" => Some("csharp"),
        "sh" | "bash" | "zsh" | "fish" => Some("bash"),
        "ps1" => Some("powershell"),
        "sql" => Some("sql"),
        "graphql" | "gql" => Some("graphql"),
        "hbs" | "handlebars" | "mustache" => Some("handlebars"),
        "ejs" | "eta" => Some("ejs"),
        "twig" => Some("twig"),
        "njk" | "nunjucks" => Some("nunjucks"),
        "jinja" | "jinja2" | "j2" => Some("jinja"),
        "liquid" => Some("liquid"),
        "pug" | "jade" => Some("pug"),
        "haml" => Some("haml"),
        "erb" => Some("erb"),
        "eex" => Some("eex"),
        "heex" => Some("heex"),
        "gohtml" => Some("gohtml"),
        "gotmpl" => Some("gotmpl"),
        "tmpl" | "tpl" => Some("tmpl"),
        "cshtml" => Some("cshtml"),
        "razor" => Some("razor"),
        "jsp" => Some("jsp"),
        "ftl" => Some("ftl"),
        "vm" => Some("velocity"),
        "phtml" => Some("php-template"),
        "aspx" | "asp" => Some("vbscript-html"),
        "dockerfile" => Some("dockerfile"),
        _ if name == "dockerfile" => Some("dockerfile"),
        _ => None,
    }
}

fn workspace_file_kind(path: &str, size: u64) -> (&'static str, Option<&'static str>, bool) {
    let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    let extension = name
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .unwrap_or_default();
    if matches!(extension, "md" | "markdown" | "mdx") {
        return ("markdown", Some("markdown"), true);
    }
    if WORKSPACE_BINARY_EXTENSIONS.contains(&extension) {
        return ("binary", None, false);
    }
    if size > MAX_WORKSPACE_PREVIEW_BYTES {
        return ("large", workspace_language(path), false);
    }
    if let Some(language) = workspace_language(path) {
        return ("code", Some(language), false);
    }
    if matches!(extension, "txt" | "log" | "csv" | "tsv")
        || matches!(
            name.as_str(),
            ".gitignore"
                | ".npmrc"
                | ".editorconfig"
                | ".prettierrc"
                | ".eslintrc"
                | ".babelrc"
                | ".browserslistrc"
        )
    {
        return ("text", None, false);
    }
    ("unknown", None, false)
}

impl ProjectRuntime {
    /// Project metadata is source-of-truth data in Rust mode. Electron only
    /// renders this value and manages its windows/dialogs.
    pub fn project_meta(&self, project_id: &str) -> Result<Value> {
        let root = self.project_root(project_id)?;
        let path = root.join(".world-meta.json");
        match fs::read_to_string(&path) {
            Ok(text) => meta_from_value(project_id, serde_json::from_str(&text)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                anyhow::ensure!(
                    root.join(".next/standalone/server.js").is_file(),
                    "project meta not found: {project_id}"
                );
                let value = standalone_recovery_meta(project_id);
                atomic_write(&path, &serde_json::to_string_pretty(&value)?)?;
                Ok(value)
            }
            Err(error) => Err(error.into()),
        }
    }

    pub fn project_metas(&self) -> Result<Vec<Value>> {
        if !self.projects_dir.is_dir() {
            return Ok(Vec::new());
        }
        let mut ids = fs::read_dir(&self.projects_dir)?
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| {
                entry
                    .file_type()
                    .ok()
                    .filter(|kind| kind.is_dir())
                    .map(|_| entry.file_name())
            })
            .map(|name| name.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        ids.sort();
        Ok(ids
            .into_iter()
            .filter_map(|id| self.project_meta(&id).ok())
            .collect())
    }

    pub fn project_file_tree(&self, project_id: &str) -> Result<Vec<Value>> {
        visible_tree(&self.project_root(project_id)?, "")
    }

    pub fn read_project_file_for_ui(&self, project_id: &str, file_path: &str) -> Result<String> {
        Ok(fs::read_to_string(
            self.project_path(project_id, file_path)?,
        )?)
    }

    pub fn write_project_file_for_ui(
        &self,
        project_id: &str,
        file_path: &str,
        content: &str,
    ) -> Result<()> {
        atomic_write(&self.project_path(project_id, file_path)?, content)
    }

    pub fn update_project_meta_for_ui(&self, project_id: &str, updates: &Value) -> Result<Value> {
        let root = self.project_root(project_id)?;
        let updates = as_object(updates.clone(), "project updates")?;
        let mut updated = update_meta_field(&root, |meta| {
            if let Some(name) = updates
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
            {
                meta.insert("name".into(), Value::String(name.to_string()));
            }
            if let Some(icon) = updates.get("icon").and_then(Value::as_str) {
                let icon = icon.trim();
                if icon.is_empty() {
                    meta.remove("icon");
                } else {
                    meta.insert("icon".into(), Value::String(icon.to_string()));
                }
            }
            meta.insert("id".into(), Value::String(project_id.to_string()));
        })?;
        updated = meta_from_value(project_id, updated)?;
        atomic_write(
            &root.join(".world-meta.json"),
            &serde_json::to_string_pretty(&updated)?,
        )?;
        Ok(updated)
    }

    pub async fn delete_project_for_ui(&self, project_id: &str) -> Result<bool> {
        let project_id = normalize_project_id(project_id)?;
        if !self.projects_dir.join(project_id).exists() {
            return Ok(false);
        }
        let root = self.project_root(project_id)?;
        let stopped = self.stop_dev(project_id).await?;
        tokio::fs::remove_dir_all(root).await?;
        Ok(stopped)
    }

    pub async fn build_project_for_ui(&self, project_id: &str) -> Result<Value> {
        let root = self.project_root(project_id)?;
        let started = Instant::now();
        update_meta_field(&root, |meta| {
            meta.insert("buildStatus".into(), Value::String("building".into()));
        })?;
        let (success, output) =
            command_output(&root, project_id, "npm run build", "production").await?;
        let duration = started.elapsed().as_millis() as u64;
        let standalone_ok =
            !is_next_project(&root) || root.join(".next/standalone/server.js").is_file();
        let succeeded = success && standalone_ok;
        let hash = if succeeded {
            Some(source_hash(&root)?)
        } else {
            None
        };
        update_meta_field(&root, |meta| {
            meta.insert(
                "buildStatus".into(),
                Value::String(if succeeded { "built" } else { "failed" }.into()),
            );
            if let Some(hash) = &hash {
                meta.insert("buildHash".into(), Value::String(hash.clone()));
            }
        })?;
        let error = (!succeeded).then(|| {
            if success {
                "Next.js build completed but standalone output is missing".to_string()
            } else {
                "Build failed".to_string()
            }
        });
        Ok(json!({
            "success": succeeded,
            "buildStatus": if succeeded { "built" } else { "failed" },
            "duration": duration,
            "output": output,
            "error": error
        }))
    }

    pub async fn cleanup_project_for_ui(
        &self,
        project_id: &str,
        remove_node_modules: bool,
        remove_build_cache: bool,
    ) -> Result<Value> {
        let root = self.project_root(project_id)?;
        let mut freed = 0_u64;
        for target in [
            (remove_node_modules, root.join("node_modules")),
            (remove_build_cache, root.join(".next/cache")),
        ] {
            if target.0 && target.1.exists() {
                freed += directory_size(&target.1)?;
                tokio::fs::remove_dir_all(target.1).await?;
            }
        }
        Ok(json!({ "success": true, "freedBytes": freed }))
    }

    pub fn project_needs_rebuild_for_ui(&self, project_id: &str) -> Result<bool> {
        let root = self.project_root(project_id)?;
        let meta = self.project_meta(project_id)?;
        let old_hash = meta.get("buildHash").and_then(Value::as_str);
        if old_hash.is_none()
            || (is_next_project(&root) && !root.join(".next/standalone/server.js").is_file())
        {
            return Ok(true);
        }
        Ok(old_hash != Some(source_hash(&root)?.as_str()))
    }

    pub async fn rebuild_project_for_ui(
        &self,
        project_id: &str,
        clean_install: bool,
        cleanup_dependencies: bool,
        cleanup_build_cache: bool,
    ) -> Result<Value> {
        let root = self.project_root(project_id)?;
        let _ = self.stop_dev(project_id).await?;
        if clean_install {
            let _ = self.cleanup_project_for_ui(project_id, true, true).await?;
            for lockfile in ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"] {
                let _ = fs::remove_file(root.join(lockfile));
            }
        }
        if root.join("package.json").is_file() {
            self.install(&root).await?;
        }
        let mut result = self.build_project_for_ui(project_id).await?;
        if result
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            if cleanup_dependencies || cleanup_build_cache {
                let can_remove_dependencies =
                    cleanup_dependencies && root.join(".next/standalone/server.js").is_file();
                let _ = self
                    .cleanup_project_for_ui(
                        project_id,
                        can_remove_dependencies,
                        cleanup_build_cache,
                    )
                    .await?;
            }
            match self.start_dev(project_id).await {
                Ok(server) => {
                    result["runtimeStatus"] = Value::String(server.status);
                    result["port"] = json!(server.port);
                    result["pid"] = json!(server.pid);
                }
                Err(error) => {
                    result["success"] = Value::Bool(false);
                    result["error"] =
                        Value::String(format!("Build succeeded but restart failed: {error}"));
                }
            }
        }
        Ok(result)
    }

    pub fn set_restart_policy_for_ui(&self, project_id: &str, policy: &str) -> Result<()> {
        anyhow::ensure!(
            matches!(policy, "always" | "on-failure" | "never"),
            "invalid restart policy: {policy}"
        );
        self.project_root(project_id)?;
        self.restart_policies
            .lock()
            .expect("restart policy lock poisoned")
            .insert(project_id.to_string(), policy.to_string());
        Ok(())
    }

    fn restart_policy_for_ui(&self, project_id: &str) -> String {
        self.restart_policies
            .lock()
            .expect("restart policy lock poisoned")
            .get(project_id)
            .cloned()
            .unwrap_or_else(|| "on-failure".to_string())
    }

    pub async fn gateway_service_map_for_ui(&self) -> Result<Value> {
        let mut services = Vec::new();
        let mut total_running = 0_u32;
        let mut total_stopped = 0_u32;
        let mut total_crashed = 0_u32;
        for meta in self.project_metas()? {
            let project_id = meta
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let policy = self.restart_policy_for_ui(&project_id);
            let status = self.status(&project_id).await?;
            let state = status
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("not_started");
            if state == "running" {
                total_running += 1;
            } else if matches!(state, "crashed" | "error") {
                total_crashed += 1;
            } else {
                total_stopped += 1;
            }
            services.push(json!({
                "projectId": project_id,
                "name": meta.get("name").and_then(Value::as_str).unwrap_or_default(),
                "port": status.get("port").cloned().unwrap_or(Value::from(0)),
                "status": state,
                "pid": status.get("pid").cloned().unwrap_or(Value::Null),
                "startedAt": status.get("startedAt").cloned().unwrap_or(Value::Null),
                "framework": meta.get("framework").cloned().unwrap_or(Value::Null),
                "restartPolicy": policy,
                "restartCount": self.restart_counts.lock().expect("restart count lock poisoned").get(&project_id).copied().unwrap_or(0)
            }));
        }
        Ok(json!({
            "services": services,
            "totalRunning": total_running,
            "totalStopped": total_stopped,
            "totalCrashed": total_crashed
        }))
    }

    /// Rust counterpart to Electron AppGateway's 30-second recovery loop.
    /// UI snapshots only observe state; restart policy evaluation happens here
    /// so a frequently refreshed dashboard cannot unexpectedly launch a
    /// project process.
    pub async fn gateway_health_check_for_ui(&self) -> Result<()> {
        let _guard = self.gateway_health_check.lock().await;
        for meta in self.project_metas()? {
            let project_id = meta
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let status = self.status(&project_id).await?;
            let state = status
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("not_started");
            if !matches!(state, "crashed" | "error") {
                continue;
            }

            let policy = self.restart_policy_for_ui(&project_id);
            if policy == "never" {
                continue;
            }
            let prior = self
                .restart_counts
                .lock()
                .expect("restart count lock poisoned")
                .get(&project_id)
                .copied()
                .unwrap_or(0);
            if policy == "on-failure" && prior >= 3 {
                continue;
            }

            // Electron records every attempted recovery, including a failed
            // spawn, so a permanently invalid project does not retry forever.
            let _ = self.start_dev(&project_id).await;
            self.restart_counts
                .lock()
                .expect("restart count lock poisoned")
                .insert(project_id, prior + 1);
        }
        Ok(())
    }

    pub async fn gateway_start_all_for_ui(&self) -> Result<Value> {
        let mut started = Vec::new();
        let mut failed = Vec::new();
        for meta in self.project_metas()? {
            let project_id = meta.get("id").and_then(Value::as_str).unwrap_or_default();
            let state = self.status(project_id).await?;
            if state.get("status").and_then(Value::as_str) == Some("running") {
                continue;
            }
            match self.start_dev(project_id).await {
                Ok(_) => started.push(Value::String(project_id.to_string())),
                Err(_) => failed.push(Value::String(project_id.to_string())),
            }
        }
        Ok(json!({ "started": started, "failed": failed }))
    }

    pub async fn gateway_stop_all_for_ui(&self) -> Result<()> {
        for meta in self.project_metas()? {
            if let Some(project_id) = meta.get("id").and_then(Value::as_str) {
                let _ = self.stop_dev(project_id).await?;
            }
        }
        Ok(())
    }

    pub async fn restart_project_for_ui(&self, project_id: &str) -> Result<Value> {
        let _ = self.stop_dev(project_id).await?;
        Ok(serde_json::to_value(self.start_dev(project_id).await?)?)
    }

    pub async fn force_kill_project_for_ui(&self, project_id: &str) -> Result<bool> {
        let mut servers = self.servers.lock().await;
        let Some(handle) = servers.get_mut(project_id) else {
            return Ok(false);
        };
        handle.refresh_lifecycle();
        if !handle.is_active() {
            return Ok(false);
        }
        handle.stop_requested = true;
        handle.info.status = "stopping".into();
        handle
            .child
            .start_kill()
            .context("force kill project process")?;
        let status = handle
            .child
            .wait()
            .await
            .context("wait for force-killed project process")?;
        handle.record_exit(status);
        Ok(true)
    }

    pub async fn project_process_snapshot_for_ui(&self) -> Result<Value> {
        let mut managed = Vec::new();
        for meta in self.project_metas()? {
            let project_id = meta.get("id").and_then(Value::as_str).unwrap_or_default();
            let status = self.status(project_id).await?;
            if status.get("status").and_then(Value::as_str) == Some("not_started") {
                continue;
            }
            managed.push(json!({
                "projectId": project_id,
                "projectName": meta.get("name").and_then(Value::as_str).unwrap_or(project_id),
                "status": status.get("status").cloned().unwrap_or(Value::String("unknown".into())),
                "pid": status.get("pid").cloned().unwrap_or(Value::Null),
                "port": status.get("port").cloned().unwrap_or(Value::Null),
                "startedAt": status.get("startedAt").cloned().unwrap_or(Value::Null),
                "exitCode": status.get("exitCode").cloned().unwrap_or(Value::Null),
                "error": status.get("error").cloned().unwrap_or(Value::Null)
            }));
        }
        Ok(json!({
            "managed": managed,
            "orphans": self.find_orphan_processes_for_ui().await?,
            "fetchedAt": worldbase_protocol::event::now_rfc3339()
        }))
    }

    #[cfg(not(windows))]
    async fn find_orphan_processes_for_ui(&self) -> Result<Vec<Value>> {
        let output = tokio::process::Command::new("ps")
            .args(["ax", "-o", "pid,rss,comm,args"])
            .output()
            .await
            .context("list local processes")?;
        if !output.status.success() {
            return Ok(Vec::new());
        }
        let managed_pids = {
            let servers = self.servers.lock().await;
            servers
                .values()
                .filter_map(|handle| handle.info.pid)
                .collect::<std::collections::HashSet<_>>()
        };
        let roots = self.projects_dir.to_string_lossy().to_ascii_lowercase();
        let mut orphans = Vec::new();
        for line in String::from_utf8_lossy(&output.stdout).lines().skip(1) {
            let fields = line
                .trim()
                .splitn(4, char::is_whitespace)
                .collect::<Vec<_>>();
            if fields.len() < 4 {
                continue;
            }
            let Ok(pid) = fields[0].parse::<u32>() else {
                continue;
            };
            if managed_pids.contains(&pid) {
                continue;
            }
            let rss = fields[1].parse::<u64>().unwrap_or(0).saturating_mul(1024);
            let command = fields[3];
            let lower = command.to_ascii_lowercase();
            if !(lower.contains(&roots)
                || lower.contains("the_world_project_id")
                || lower.contains("next-server"))
            {
                continue;
            }
            orphans.push(json!({
                "pid": pid,
                "name": fields[2],
                "memoryRssBytes": rss,
                "commandLine": command.chars().take(200).collect::<String>()
            }));
        }
        Ok(orphans)
    }

    #[cfg(windows)]
    async fn find_orphan_processes_for_ui(&self) -> Result<Vec<Value>> {
        // The bundled desktop child process list is still Rust-owned.  Windows
        // orphan discovery is intentionally conservative until a native API is
        // available, so it never labels unrelated Electron helpers as projects.
        Ok(Vec::new())
    }

    pub async fn kill_orphan_process_for_ui(&self, pid: u32) -> Result<()> {
        anyhow::ensure!(pid > 1, "invalid process id");
        #[cfg(windows)]
        let output = tokio::process::Command::new("taskkill")
            .args(["/pid", &pid.to_string(), "/t", "/f"])
            .output()
            .await?;
        #[cfg(not(windows))]
        let output = tokio::process::Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .output()
            .await?;
        anyhow::ensure!(output.status.success(), "failed to kill process {pid}");
        Ok(())
    }

    /// Clear orphaned project children after a previous harness or Electron
    /// process exited unexpectedly. The discovery and termination both stay
    /// inside the selected Rust project runtime rather than falling back to
    /// Electron's RuntimeManager.
    pub async fn cleanup_orphan_processes_for_ui(&self) -> Result<Value> {
        let mut killed = Vec::new();
        let mut failed = Vec::new();
        for orphan in self.find_orphan_processes_for_ui().await? {
            let Some(pid) = orphan.get("pid").and_then(Value::as_u64) else {
                continue;
            };
            let Ok(pid) = u32::try_from(pid) else {
                continue;
            };
            match self.kill_orphan_process_for_ui(pid).await {
                Ok(()) => killed.push(orphan),
                Err(error) => failed.push(json!({ "pid": pid, "error": error.to_string() })),
            }
        }
        Ok(json!({ "killed": killed, "failed": failed }))
    }

    pub fn project_data_query_for_ui(&self, project_id: &str, sql: &str) -> Result<Value> {
        anyhow::ensure!(
            sql.trim_start().to_ascii_lowercase().starts_with("select"),
            "Only SELECT queries are allowed for direct database access"
        );
        let meta = self.project_meta(project_id)?;
        let config = data_config(&meta)?.context("project does not declare a dataSchema")?;
        let db = sqlite_path(self, project_id, &config)?;
        anyhow::ensure!(db.is_file(), "Database file not found");
        Ok(Value::Array(sqlite_rows(&Connection::open(db)?, sql)?))
    }

    pub fn project_data_schema_for_ui(&self, project_id: &str) -> Result<Value> {
        let meta = self.project_meta(project_id)?;
        let Some(config) = data_config(&meta)? else {
            return Ok(Value::Null);
        };
        if let Some(tables) = config.get("tables") {
            return Ok(tables.clone());
        }
        if config.get("database").and_then(Value::as_str) != Some("sqlite") {
            return Ok(Value::Null);
        }
        let db = sqlite_path(self, project_id, &config)?;
        if !db.is_file() {
            return Ok(Value::Null);
        }
        let connection = Connection::open(db)?;
        let table_rows = sqlite_rows(&connection, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")?;
        let mut tables = Vec::new();
        for row in table_rows {
            let name = row.get("name").and_then(Value::as_str).unwrap_or_default();
            let escaped = name.replace('"', "\"\"");
            let columns = sqlite_rows(&connection, &format!("PRAGMA table_info(\"{escaped}\")"))?;
            tables.push(json!({ "name": name, "columns": columns }));
        }
        Ok(Value::Array(tables))
    }

    pub fn project_data_summary_for_ui(&self, project_id: &str) -> Result<Value> {
        let meta = self.project_meta(project_id)?;
        let Some(config) = data_config(&meta)? else {
            return Ok(json!({ "projectId": project_id, "hasData": false }));
        };
        let database = config
            .get("database")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if database != "sqlite" {
            return Ok(
                json!({ "projectId": project_id, "hasData": true, "database": database, "tables": [] }),
            );
        }
        let db = sqlite_path(self, project_id, &config)?;
        if !db.is_file() {
            return Ok(
                json!({ "projectId": project_id, "hasData": false, "reason": "Database file not found" }),
            );
        }
        let connection = Connection::open(db)?;
        let rows = sqlite_rows(&connection, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")?;
        let mut tables = Vec::new();
        for row in rows {
            let name = row.get("name").and_then(Value::as_str).unwrap_or_default();
            let name = validate_identifier(name)?;
            let count = sqlite_rows(
                &connection,
                &format!("SELECT COUNT(*) AS count FROM \"{name}\""),
            )?
            .first()
            .and_then(|row| row.get("count"))
            .cloned()
            .unwrap_or(Value::from(0));
            tables.push(json!({ "name": name, "rowCount": count }));
        }
        Ok(
            json!({ "projectId": project_id, "hasData": true, "database": database, "tables": tables }),
        )
    }

    pub fn project_data_query_table_for_ui(
        &self,
        project_id: &str,
        table_name: &str,
        page: u64,
        page_size: u64,
    ) -> Result<Value> {
        let table = validate_identifier(table_name)?;
        let meta = self.project_meta(project_id)?;
        let config = data_config(&meta)?.context("No data config for project")?;
        let db = sqlite_path(self, project_id, &config)?;
        anyhow::ensure!(db.is_file(), "Database file not found");
        let connection = Connection::open(db)?;
        let total = sqlite_rows(
            &connection,
            &format!("SELECT COUNT(*) AS count FROM \"{table}\""),
        )?
        .first()
        .and_then(|row| row.get("count"))
        .cloned()
        .unwrap_or(Value::from(0));
        let page = page.max(1);
        let page_size = page_size.clamp(1, 1_000);
        let offset = (page - 1).saturating_mul(page_size);
        let rows = sqlite_rows(
            &connection,
            &format!("SELECT * FROM \"{table}\" LIMIT {page_size} OFFSET {offset}"),
        )?;
        Ok(json!({ "rows": rows, "total": total }))
    }

    pub fn project_data_list_all_for_ui(&self) -> Result<Value> {
        let mut result = Vec::new();
        for meta in self.project_metas()? {
            let Some(project_id) = meta.get("id").and_then(Value::as_str) else {
                continue;
            };
            let Some(config) = data_config(&meta)? else {
                continue;
            };
            let database = config
                .get("database")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let db_path = config
                .get("dbPath")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let full_path = if database == "sqlite" {
                sqlite_path(self, project_id, &config)
                    .ok()
                    .map(|path| path.display().to_string())
            } else {
                None
            };
            let schema = self
                .project_data_schema_for_ui(project_id)
                .unwrap_or(Value::Array(Vec::new()));
            let summary = self
                .project_data_summary_for_ui(project_id)
                .unwrap_or_else(|_| json!({ "tables": [] }));
            let tables = summary["tables"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|summary_table| {
                    let name = summary_table["name"].as_str().unwrap_or_default();
                    let schema_table = schema
                        .as_array()
                        .and_then(|tables| {
                            tables
                                .iter()
                                .find(|table| table["name"].as_str() == Some(name))
                        })
                        .cloned()
                        .unwrap_or_else(|| json!({}));
                    let columns = schema_table["columns"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default()
                        .into_iter()
                        .map(|column| {
                            json!({
                                "name": column["name"].as_str().unwrap_or_default(),
                                "type": column["type"].as_str().unwrap_or_default(),
                                "primaryKey": column["primaryKey"].as_bool().unwrap_or(false)
                                    || column["pk"].as_i64().unwrap_or(0) != 0
                            })
                        })
                        .collect::<Vec<_>>();
                    json!({
                        "name": name,
                        "rowCount": summary_table["rowCount"].clone(),
                        "columns": columns
                    })
                })
                .collect::<Vec<_>>();
            result.push(json!({
                "projectId": project_id,
                "projectName": meta.get("name").and_then(Value::as_str).unwrap_or(project_id),
                "database": database,
                "dbPath": db_path,
                "fullPath": full_path,
                "tables": tables
            }));
        }
        Ok(Value::Array(result))
    }

    pub fn project_data_tables_for_ui(&self, project_id: &str) -> Result<Value> {
        let meta = self.project_meta(project_id)?;
        let Some(config) = data_config(&meta)? else {
            return Ok(json!({ "tables": [] }));
        };
        if config.get("database").and_then(Value::as_str) != Some("sqlite") {
            return Ok(json!({ "tables": [] }));
        }
        let db = sqlite_path(self, project_id, &config)?;
        anyhow::ensure!(db.is_file(), "Database file not found: {}", db.display());
        let connection = Connection::open(db)?;
        let rows = sqlite_rows(&connection, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")?;
        let tables = rows
            .into_iter()
            .filter_map(|row| row.get("name").and_then(Value::as_str).map(str::to_string))
            .map(Value::String)
            .collect::<Vec<_>>();
        Ok(json!({ "tables": tables }))
    }

    /// Initialize the SQLite database declared by a project's `dataSchema`.
    ///
    /// The Electron create-project tool performs this immediately after the
    /// project files are written.  Keep the schema-aware implementation below
    /// private, but expose a small metadata-driven entry point for Rust tools
    /// so they cannot accidentally create a database with a different schema.
    pub fn initialize_project_database_for_tool(
        &self,
        project_id: &str,
    ) -> Result<Option<PathBuf>> {
        let meta = self.project_meta(project_id)?;
        let Some(config) = data_config(&meta)? else {
            return Ok(None);
        };
        if config.get("database").and_then(Value::as_str) != Some("sqlite") {
            return Ok(None);
        }
        self.ensure_project_database_from_config(project_id, &config)
            .map(Some)
    }

    fn ensure_project_database_from_config(
        &self,
        project_id: &str,
        config: &Map<String, Value>,
    ) -> Result<PathBuf> {
        let db = sqlite_path(self, project_id, config)?;
        let parent = db
            .parent()
            .context("SQLite database has no parent directory")?;
        fs::create_dir_all(parent)?;
        let connection = Connection::open(&db)?;
        for table in config
            .get("tables")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let table = table.as_object().context("invalid dataSchema table")?;
            let table_name = table
                .get("name")
                .and_then(Value::as_str)
                .context("dataSchema table missing name")?;
            let table_name = validate_identifier(table_name)?;
            let columns = declared_columns(table)?;
            let mut definitions = Vec::new();
            let primary_keys = columns
                .iter()
                .filter(|(_, column)| {
                    column
                        .get("primaryKey")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                })
                .map(|(name, _)| name.clone())
                .collect::<Vec<_>>();
            let inline_primary_key = primary_keys.len() <= 1;
            for (name, column) in &columns {
                let mut definition = format!(
                    "\"{}\" {}",
                    name,
                    column
                        .get("type")
                        .and_then(Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or("TEXT")
                );
                if inline_primary_key
                    && column
                        .get("primaryKey")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                {
                    definition.push_str(" PRIMARY KEY");
                    if column
                        .get("autoIncrement")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                    {
                        definition.push_str(" AUTOINCREMENT");
                    }
                }
                if column
                    .get("notNull")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    definition.push_str(" NOT NULL");
                }
                if column
                    .get("unique")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    definition.push_str(" UNIQUE");
                }
                if let Some(default_sql) = column.get("defaultSql").and_then(Value::as_str) {
                    let default_sql = default_sql.trim().to_ascii_uppercase();
                    anyhow::ensure!(
                        matches!(
                            default_sql.as_str(),
                            "CURRENT_TIMESTAMP" | "CURRENT_DATE" | "CURRENT_TIME" | "NULL"
                        ),
                        "Unsupported defaultSql expression: {default_sql}"
                    );
                    definition.push_str(&format!(" DEFAULT {default_sql}"));
                } else if let Some(default_value) = column.get("defaultValue") {
                    let value = json_to_sql_value(default_value)?;
                    let literal = match value {
                        SqlValue::Null => "NULL".to_string(),
                        SqlValue::Integer(value) => value.to_string(),
                        SqlValue::Real(value) => value.to_string(),
                        SqlValue::Text(value) => format!("'{}'", value.replace('\'', "''")),
                        SqlValue::Blob(_) => {
                            anyhow::bail!("binary default values are not supported")
                        }
                    };
                    definition.push_str(&format!(" DEFAULT {literal}"));
                }
                definitions.push(definition);
            }
            if !inline_primary_key && !primary_keys.is_empty() {
                definitions.push(format!(
                    "PRIMARY KEY ({})",
                    primary_keys
                        .iter()
                        .map(|name| format!("\"{name}\""))
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            connection.execute_batch(&format!(
                "CREATE TABLE IF NOT EXISTS \"{table_name}\" ({})",
                definitions.join(", ")
            ))?;
        }
        Ok(db)
    }

    pub fn project_data_read_records_for_ui(
        &self,
        project_id: &str,
        table_name: &str,
        filters: Option<Value>,
        limit: Option<u64>,
        offset: Option<u64>,
        order_by: Option<&str>,
        order_direction: Option<&str>,
        columns: Option<Value>,
    ) -> Result<Value> {
        let table_name = validate_identifier(table_name)?;
        let meta = self.project_meta(project_id)?;
        let config = data_config(&meta)?.context("project does not declare a dataSchema")?;
        let table = declared_table(&config, table_name)?;
        let allowed_columns = declared_columns(table)?;
        let db = self.ensure_project_database_from_config(project_id, &config)?;
        let selected_columns = match columns {
            Some(Value::Array(columns)) if !columns.is_empty() => columns
                .iter()
                .map(|column| {
                    let column = column.as_str().context("columns must contain strings")?;
                    let column = validate_identifier(column)?;
                    anyhow::ensure!(
                        has_declared_column(&allowed_columns, column),
                        "Column {column} is not declared in schema for table {table_name}"
                    );
                    Ok(format!("\"{column}\""))
                })
                .collect::<Result<Vec<_>>>()?,
            Some(Value::Array(_)) | None | Some(Value::Null) => vec!["*".to_string()],
            Some(_) => anyhow::bail!("columns must be an array"),
        };
        let filters = match filters {
            Some(Value::Object(filters)) => filters,
            None | Some(Value::Null) => Map::new(),
            Some(_) => anyhow::bail!("filters must be an object"),
        };
        let mut where_parts = Vec::new();
        let mut values = Vec::new();
        for (column, value) in filters {
            let column = validate_identifier(&column)?;
            anyhow::ensure!(
                has_declared_column(&allowed_columns, column),
                "Column {column} is not declared in schema for table {table_name}"
            );
            if value.is_null() {
                where_parts.push(format!("\"{column}\" IS NULL"));
            } else {
                where_parts.push(format!("\"{column}\" = ?"));
                values.push(json_to_sql_value(&value)?);
            }
        }
        let mut sql = format!(
            "SELECT {} FROM \"{table_name}\"",
            selected_columns.join(", ")
        );
        if !where_parts.is_empty() {
            sql.push_str(&format!(" WHERE {}", where_parts.join(" AND ")));
        }
        if let Some(order_by) = order_by.filter(|value| !value.trim().is_empty()) {
            let order_by = validate_identifier(order_by)?;
            anyhow::ensure!(
                has_declared_column(&allowed_columns, order_by),
                "Column {order_by} is not declared in schema for table {table_name}"
            );
            let direction =
                if order_direction.is_some_and(|value| value.eq_ignore_ascii_case("desc")) {
                    "DESC"
                } else {
                    "ASC"
                };
            sql.push_str(&format!(" ORDER BY \"{order_by}\" {direction}"));
        }
        if let Some(limit) = limit {
            sql.push_str(" LIMIT ?");
            values.push(SqlValue::Integer(limit.clamp(1, 1_000) as i64));
        }
        if let Some(offset) = offset {
            if limit.is_none() {
                sql.push_str(" LIMIT -1");
            }
            sql.push_str(" OFFSET ?");
            values.push(SqlValue::Integer(offset.min(i64::MAX as u64) as i64));
        }
        Ok(Value::Array(sqlite_rows_with_params(
            &Connection::open(db)?,
            &sql,
            values,
        )?))
    }

    pub fn project_data_save_records_for_ui(
        &self,
        project_id: &str,
        table_name: &str,
        records: &Value,
        mode: Option<&str>,
    ) -> Result<Value> {
        let table_name = validate_identifier(table_name)?;
        let mode = mode.unwrap_or("upsert");
        anyhow::ensure!(
            matches!(mode, "insert" | "upsert"),
            "mode must be insert or upsert"
        );
        let meta = self.project_meta(project_id)?;
        let config = data_config(&meta)?.context("project does not declare a dataSchema")?;
        let table = declared_table(&config, table_name)?;
        let allowed_columns = declared_columns(table)?;
        let primary_keys = allowed_columns
            .iter()
            .filter(|(_, column)| {
                column
                    .get("primaryKey")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            })
            .map(|(name, _)| name.clone())
            .collect::<Vec<_>>();
        let db = self.ensure_project_database_from_config(project_id, &config)?;
        let records = match records {
            Value::Array(records) => records.clone(),
            Value::Object(record) => vec![Value::Object(record.clone())],
            Value::Null => Vec::new(),
            _ => anyhow::bail!("records must be an array or object"),
        };
        let connection = Connection::open(db)?;
        let transaction = connection.unchecked_transaction()?;
        let mut count = 0_u64;
        for record in &records {
            let record = record.as_object().context("record must be an object")?;
            let entries = record
                .iter()
                .map(|(column, value)| {
                    let column = validate_identifier(column)?;
                    anyhow::ensure!(
                        has_declared_column(&allowed_columns, column),
                        "Column {column} is not declared in schema for table {table_name}"
                    );
                    Ok((column.to_string(), json_to_sql_value(value)?))
                })
                .collect::<Result<Vec<_>>>()?;
            anyhow::ensure!(
                !entries.is_empty(),
                "Record for table {table_name} has no writable fields"
            );
            let columns = entries
                .iter()
                .map(|(column, _)| column.clone())
                .collect::<Vec<_>>();
            let mut sql = format!(
                "INSERT INTO \"{table_name}\" ({}) VALUES ({})",
                columns
                    .iter()
                    .map(|column| format!("\"{column}\""))
                    .collect::<Vec<_>>()
                    .join(", "),
                std::iter::repeat("?")
                    .take(columns.len())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            if mode == "upsert"
                && !primary_keys.is_empty()
                && primary_keys.iter().all(|key| columns.contains(key))
            {
                let updatable = columns
                    .iter()
                    .filter(|column| !primary_keys.contains(column))
                    .collect::<Vec<_>>();
                if updatable.is_empty() {
                    sql.push_str(&format!(
                        " ON CONFLICT ({}) DO NOTHING",
                        primary_keys
                            .iter()
                            .map(|column| format!("\"{column}\""))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ));
                } else {
                    sql.push_str(&format!(
                        " ON CONFLICT ({}) DO UPDATE SET {}",
                        primary_keys
                            .iter()
                            .map(|column| format!("\"{column}\""))
                            .collect::<Vec<_>>()
                            .join(", "),
                        updatable
                            .iter()
                            .map(|column| format!("\"{column}\" = excluded.\"{column}\""))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ));
                }
            }
            transaction.execute(
                &sql,
                params_from_iter(entries.into_iter().map(|(_, value)| value)),
            )?;
            count += 1;
        }
        transaction.commit()?;
        Ok(json!({ "table": table_name, "count": count, "mode": mode }))
    }

    pub fn analyze_project_for_ui(&self, project_id: &str) -> Result<Value> {
        fn collect_files(entries: &[Value], result: &mut Vec<String>) {
            for entry in entries {
                if entry.get("type").and_then(Value::as_str) == Some("file") {
                    if let Some(path) = entry.get("path").and_then(Value::as_str) {
                        result.push(path.to_string());
                    }
                }
                if let Some(children) = entry.get("children").and_then(Value::as_array) {
                    collect_files(children, result);
                }
            }
        }
        let tree = self.project_file_tree(project_id)?;
        let mut files = Vec::new();
        collect_files(&tree, &mut files);
        let has_backend = files.iter().any(|path| {
            path.contains("server.js")
                || path.contains("app.js")
                || path.contains("index.js")
                || path.starts_with("backend/")
        });
        let has_frontend = files.iter().any(|path| {
            path.ends_with(".vue")
                || path.ends_with(".jsx")
                || path.ends_with(".tsx")
                || path.starts_with("frontend/")
                || path.starts_with("src/")
        });
        let project_type = if has_backend && has_frontend {
            "fullstack"
        } else if has_backend {
            "backend"
        } else if has_frontend {
            "frontend"
        } else {
            "unknown"
        };
        let framework = self
            .read_project_file_for_ui(project_id, "package.json")
            .ok()
            .and_then(|content| serde_json::from_str::<Value>(&content).ok())
            .and_then(|package| {
                let dependencies = ["dependencies", "devDependencies"]
                    .into_iter()
                    .filter_map(|key| package.get(key).and_then(Value::as_object))
                    .collect::<Vec<_>>();
                ["vue", "react", "express", "koa", "fastify"]
                    .into_iter()
                    .find(|name| {
                        dependencies
                            .iter()
                            .any(|dependency| dependency.contains_key(*name))
                    })
                    .map(str::to_string)
            });
        let routes = files
            .iter()
            .filter(|path| {
                path.contains("route") || path.contains("router") || path.contains("controller")
            })
            .cloned()
            .collect::<Vec<_>>();
        let models = files
            .iter()
            .filter(|path| path.contains("model") || path.contains("schema"))
            .cloned()
            .collect::<Vec<_>>();
        let entry_points = files
            .iter()
            .filter(|path| {
                ["server.js", "app.js", "index.js", "main.js"]
                    .iter()
                    .any(|suffix| path.ends_with(suffix))
            })
            .cloned()
            .collect::<Vec<_>>();
        let database = files
            .iter()
            .any(|path| path.ends_with(".sqlite") || path.ends_with(".db"))
            .then_some("sqlite");
        Ok(json!({
            "projectId": project_id,
            "type": project_type,
            "framework": framework,
            "hasBackend": has_backend,
            "hasFrontend": has_frontend,
            "entryPoints": entry_points,
            "routes": routes,
            "models": models,
            "database": database
        }))
    }

    pub fn folder_workspace_list_for_ui(&self, root: &Path) -> Result<Value> {
        fn walk(
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
            let mut entries = match fs::read_dir(&directory) {
                Ok(entries) => entries.collect::<std::result::Result<Vec<_>, _>>()?,
                Err(_) => return Ok(Vec::new()),
            };
            entries.sort_by(|left, right| {
                let left_dir = left.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
                let right_dir = right.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
                right_dir
                    .cmp(&left_dir)
                    .then_with(|| left.file_name().cmp(&right.file_name()))
            });
            let mut result = Vec::new();
            for entry in entries {
                if *truncated {
                    break;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                let file_type = entry.file_type()?;
                if name.starts_with('.')
                    && name != ".env"
                    && name != ".gitignore"
                    && file_type.is_dir()
                {
                    continue;
                }
                if file_type.is_dir() && WORKSPACE_IGNORED_DIRS.contains(&name.as_str()) {
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
                        walk(root, &path, depth + 1, total, truncated)?
                    } else {
                        Vec::new()
                    };
                    result.push(json!({ "name": name, "path": path, "type": "directory", "children": children }));
                } else {
                    let size = entry.metadata().map(|metadata| metadata.len()).unwrap_or(0);
                    let (kind, language, _) = workspace_file_kind(&path, size);
                    result.push(json!({ "name": name, "path": path, "type": "file", "size": size, "kind": kind, "language": language }));
                }
            }
            Ok(result)
        }
        let root = root.canonicalize()?;
        anyhow::ensure!(root.is_dir(), "rootPath is not a directory");
        let mut total = 0;
        let mut truncated = false;
        let entries = walk(&root, "", 0, &mut total, &mut truncated)?;
        let root_name = root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_else(|| root.to_str().unwrap_or_default());
        Ok(
            json!({ "rootPath": root, "rootName": root_name, "entries": entries, "totalEntries": total, "truncated": truncated }),
        )
    }

    pub fn folder_workspace_read_for_ui(&self, root: &Path, file_path: &str) -> Result<Value> {
        let root = root.canonicalize()?;
        anyhow::ensure!(root.is_dir(), "rootPath is not a directory");
        let (file_path, full_path) = workspace_relative_path(&root, file_path)?;
        let metadata = fs::metadata(&full_path)?;
        anyhow::ensure!(metadata.is_file(), "Path is not a file: {file_path}");
        let (kind, language, is_markdown) = workspace_file_kind(&file_path, metadata.len());
        anyhow::ensure!(kind != "binary", "Cannot preview binary file: {file_path}");
        let mut file = fs::File::open(&full_path)?;
        let mut bytes =
            vec![0; usize::try_from(metadata.len().min(MAX_WORKSPACE_PREVIEW_BYTES)).unwrap_or(0)];
        let read = file.read(&mut bytes)?;
        bytes.truncate(read);
        anyhow::ensure!(
            !bytes.iter().take(4096).any(|byte| *byte == 0),
            "Cannot preview binary file: {file_path}"
        );
        let content = String::from_utf8_lossy(&bytes).into_owned();
        let line_count = if content.is_empty() {
            0
        } else {
            content.split('\n').count()
        };
        Ok(json!({
            "rootPath": root,
            "filePath": file_path,
            "fileName": full_path.file_name().and_then(|name| name.to_str()).unwrap_or_default(),
            "size": metadata.len(),
            "content": content,
            "kind": if kind == "unknown" { "text" } else { kind },
            "language": language,
            "isMarkdown": is_markdown,
            "lineCount": line_count,
            "truncated": metadata.len() > MAX_WORKSPACE_PREVIEW_BYTES
        }))
    }

    pub fn export_project_package_for_ui(
        &self,
        project_id: &str,
        output_path: &Path,
    ) -> Result<Value> {
        let root = self.project_root(project_id)?;
        let meta = self.project_meta(project_id)?;
        let project_name = meta
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(project_id)
            .to_string();
        let declared_schema = meta
            .get("dataSchema")
            .cloned()
            .filter(|value| !value.is_null());
        let introspected_schema = self
            .project_data_schema_for_ui(project_id)
            .ok()
            .filter(|value| !value.is_null());
        let database_path = declared_schema
            .as_ref()
            .and_then(Value::as_object)
            .and_then(|schema| schema.get("dbPath"))
            .and_then(Value::as_str)
            .map(normalize_archive_path)
            .transpose()?;
        let source_files = package_files(&root, Path::new(""), &|relative| {
            let first = relative.split('/').next().unwrap_or_default();
            ![
                "node_modules",
                ".git",
                ".next",
                "dist",
                "build",
                "out",
                ".output",
                "release",
            ]
            .contains(&first)
                && !is_macos_metadata_path(relative)
                && database_path
                    .as_deref()
                    .map(|path| {
                        relative != path
                            && relative != format!("{path}-wal")
                            && relative != format!("{path}-shm")
                    })
                    .unwrap_or(true)
        })?;
        let mut build_roots = Vec::new();
        let mut build_files = Vec::new();
        for name in [".next", "dist", "build", "out", ".output", "release"] {
            if !root.join(name).exists() {
                continue;
            }
            build_roots.push(name.to_string());
            build_files.extend(package_files(&root, Path::new(name), &|relative| {
                !is_macos_metadata_path(relative)
                    && relative != ".next/cache"
                    && !relative.starts_with(".next/cache/")
            })?);
        }
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let manifest = json!({
            "packageType": PROJECT_PACKAGE_KIND,
            "formatVersion": PROJECT_PACKAGE_FORMAT_VERSION,
            "exportedAt": worldbase_protocol::event::now_rfc3339(),
            "sourceProjectId": project_id,
            "project": { "name": project_name, "meta": meta },
            "source": { "root": "source", "fileCount": source_files.len() },
            "build": { "root": "build", "includedPaths": build_roots },
            "database": {
                "declaredSchemaPath": declared_schema.as_ref().map(|_| PROJECT_PACKAGE_DECLARED_SCHEMA_PATH),
                "introspectedSchemaPath": introspected_schema.as_ref().map(|_| PROJECT_PACKAGE_INTROSPECTED_SCHEMA_PATH),
                "dbPath": database_path
            }
        });
        let file = fs::File::create(output_path)?;
        let mut archive = zip::ZipWriter::new(file);
        let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        archive.start_file(PROJECT_PACKAGE_MANIFEST_PATH, options)?;
        archive.write_all(serde_json::to_string_pretty(&manifest)?.as_bytes())?;
        if let Some(schema) = declared_schema {
            archive.start_file(PROJECT_PACKAGE_DECLARED_SCHEMA_PATH, options)?;
            archive.write_all(serde_json::to_string_pretty(&schema)?.as_bytes())?;
        }
        if let Some(schema) = introspected_schema {
            archive.start_file(PROJECT_PACKAGE_INTROSPECTED_SCHEMA_PATH, options)?;
            archive.write_all(serde_json::to_string_pretty(&schema)?.as_bytes())?;
        }
        for relative in &source_files {
            archive.start_file(
                format!("{PROJECT_PACKAGE_SOURCE_PREFIX}{relative}"),
                options,
            )?;
            archive.write_all(&fs::read(root.join(relative))?)?;
        }
        for relative in &build_files {
            archive.start_file(format!("{PROJECT_PACKAGE_BUILD_PREFIX}{relative}"), options)?;
            archive.write_all(&fs::read(root.join(relative))?)?;
        }
        archive.finish()?;
        Ok(json!({
            "filePath": output_path,
            "projectId": project_id,
            "projectName": project_name,
            "includedBuildArtifacts": build_roots
        }))
    }

    pub fn import_project_package_for_ui(&self, file_path: &Path) -> Result<Value> {
        let file = fs::File::open(file_path)?;
        let mut archive = zip::ZipArchive::new(file).context("open project package")?;
        let mut manifest_text = String::new();
        archive
            .by_name(PROJECT_PACKAGE_MANIFEST_PATH)
            .context("project package is missing manifest.json")?
            .read_to_string(&mut manifest_text)?;
        let manifest: Value =
            serde_json::from_str(&manifest_text).context("parse project package manifest")?;
        anyhow::ensure!(
            manifest.get("packageType").and_then(Value::as_str) == Some(PROJECT_PACKAGE_KIND),
            "unsupported project package format"
        );
        anyhow::ensure!(
            manifest.get("formatVersion").and_then(Value::as_u64)
                == Some(PROJECT_PACKAGE_FORMAT_VERSION),
            "unsupported project package format"
        );
        let name = manifest
            .get("project")
            .and_then(Value::as_object)
            .and_then(|project| project.get("name"))
            .and_then(Value::as_str)
            .or_else(|| manifest.get("sourceProjectId").and_then(Value::as_str))
            .unwrap_or("Imported App")
            .trim();
        let project_id = imported_project_id(if name.is_empty() {
            "Imported App"
        } else {
            name
        });
        let root = self.projects_dir.join(&project_id);
        anyhow::ensure!(!root.exists(), "project already exists: {project_id}");
        fs::create_dir_all(&root)?;
        let unpack = (|| -> Result<()> {
            for index in 0..archive.len() {
                let mut entry = archive.by_index(index)?;
                if entry.is_dir() {
                    continue;
                }
                let raw_name = entry.name().to_string();
                if raw_name == PROJECT_PACKAGE_MANIFEST_PATH
                    || raw_name == PROJECT_PACKAGE_DECLARED_SCHEMA_PATH
                    || raw_name == "database/introspected-schema.json"
                    || is_macos_metadata_path(&raw_name)
                {
                    continue;
                }
                let relative = if let Some(value) =
                    raw_name.strip_prefix(PROJECT_PACKAGE_SOURCE_PREFIX)
                {
                    value
                } else if let Some(value) = raw_name.strip_prefix(PROJECT_PACKAGE_BUILD_PREFIX) {
                    value
                } else {
                    continue;
                };
                let relative = normalize_archive_path(relative)?;
                let destination = root.join(Path::new(&relative));
                anyhow::ensure!(
                    destination.starts_with(&root),
                    "unsafe project package path: {relative}"
                );
                if let Some(parent) = destination.parent() {
                    fs::create_dir_all(parent)?;
                }
                let mut target = fs::File::create(destination)?;
                std::io::copy(&mut entry, &mut target)?;
            }
            let imported = self
                .project_meta(&project_id)
                .unwrap_or_else(|_| standalone_recovery_meta(&project_id));
            let mut merged = manifest
                .get("project")
                .and_then(Value::as_object)
                .and_then(|project| project.get("meta"))
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            if let Some(imported) = imported.as_object() {
                merged.extend(imported.clone());
            }
            merged.insert("id".into(), Value::String(project_id.clone()));
            merged.insert(
                "name".into(),
                Value::String(if name.is_empty() {
                    "Imported App".into()
                } else {
                    name.into()
                }),
            );
            merged.insert("importedFrom".into(), json!({
                "packageType": PROJECT_PACKAGE_KIND,
                "sourceProjectId": manifest.get("sourceProjectId").cloned().unwrap_or(Value::Null),
                "exportedAt": manifest.get("exportedAt").cloned().unwrap_or(Value::Null),
                "importedAt": worldbase_protocol::event::now_rfc3339(),
                "packageFileName": file_path.file_name().and_then(|value| value.to_str()).unwrap_or_default(),
                "formatVersion": PROJECT_PACKAGE_FORMAT_VERSION
            }));
            let meta = meta_from_value(&project_id, Value::Object(merged))?;
            atomic_write(
                &root.join(".world-meta.json"),
                &serde_json::to_string_pretty(&meta)?,
            )?;
            Ok(())
        })();
        if let Err(error) = unpack {
            let _ = fs::remove_dir_all(&root);
            return Err(error);
        }
        Ok(json!({
            "filePath": file_path,
            "projectId": project_id,
            "meta": self.project_meta(&project_id)?
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_project(root: &Path, id: &str, meta: Value) -> PathBuf {
        let project = root.join(id);
        fs::create_dir_all(project.join("src")).unwrap();
        fs::write(project.join("src/main.ts"), "export const answer = 42\n").unwrap();
        fs::write(
            project.join(".world-meta.json"),
            serde_json::to_string_pretty(&meta).unwrap(),
        )
        .unwrap();
        project
    }

    #[tokio::test]
    async fn ui_project_control_owns_meta_tree_files_and_sqlite_data() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("projects");
        let project = write_project(
            &root,
            "alpha",
            json!({
                "name": "Alpha App",
                "type": "frontend",
                "icon": "rocket",
                "dataSchema": { "database": "sqlite", "dbPath": "data/app.db" }
            }),
        );
        fs::create_dir_all(project.join("node_modules/ignored")).unwrap();
        fs::write(project.join("node_modules/ignored/index.js"), "ignored").unwrap();
        fs::create_dir_all(project.join(".next")).unwrap();
        fs::write(project.join(".next/internal"), "hidden").unwrap();
        fs::create_dir_all(project.join("data")).unwrap();
        let connection = Connection::open(project.join("data/app.db")).unwrap();
        connection
            .execute(
                "CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT)",
                [],
            )
            .unwrap();
        connection
            .execute("INSERT INTO tasks (title) VALUES ('native')", [])
            .unwrap();

        let runtime = ProjectRuntime::new(root);
        let meta = runtime.project_meta("alpha").unwrap();
        assert_eq!(meta["name"], "Alpha App");
        assert_eq!(runtime.project_metas().unwrap().len(), 1);

        let tree = runtime.project_file_tree("alpha").unwrap();
        assert!(tree.iter().any(|entry| entry["path"] == "src"));
        assert!(!tree.iter().any(|entry| entry["path"] == "node_modules"));
        assert!(!tree.iter().any(|entry| entry["path"] == ".next"));
        assert_eq!(
            runtime
                .read_project_file_for_ui("alpha", "src/main.ts")
                .unwrap(),
            "export const answer = 42\n"
        );
        runtime
            .write_project_file_for_ui("alpha", "src/next.ts", "export default 1\n")
            .unwrap();
        assert_eq!(
            fs::read_to_string(project.join("src/next.ts")).unwrap(),
            "export default 1\n"
        );
        assert!(runtime
            .write_project_file_for_ui("alpha", "../escape.ts", "no")
            .is_err());

        let rows = runtime
            .project_data_query_for_ui("alpha", "SELECT title FROM tasks")
            .unwrap();
        assert_eq!(rows, json!([{ "title": "native" }]));
        let page = runtime
            .project_data_query_table_for_ui("alpha", "tasks", 1, 20)
            .unwrap();
        assert_eq!(page["total"], 1);
        assert_eq!(
            runtime.project_data_summary_for_ui("alpha").unwrap()["hasData"],
            true
        );
    }

    #[test]
    fn ui_project_package_round_trip_and_rejects_traversal() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("projects");
        write_project(
            &root,
            "alpha",
            json!({ "name": "Alpha App", "type": "frontend" }),
        );
        let runtime = ProjectRuntime::new(root.clone());
        let package = temporary.path().join("alpha.twapp");
        let exported = runtime
            .export_project_package_for_ui("alpha", &package)
            .unwrap();
        assert_eq!(exported["projectName"], "Alpha App");
        let imported = runtime.import_project_package_for_ui(&package).unwrap();
        let id = imported["projectId"].as_str().unwrap();
        assert!(root.join(id).join("src/main.ts").is_file());

        let unsafe_package = temporary.path().join("unsafe.twapp");
        let mut archive = zip::ZipWriter::new(fs::File::create(&unsafe_package).unwrap());
        let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
        archive
            .start_file(PROJECT_PACKAGE_MANIFEST_PATH, options)
            .unwrap();
        archive.write_all(br#"{"packageType":"the-world-app-package","formatVersion":1,"project":{"name":"Unsafe"}}"#).unwrap();
        archive
            .start_file("source/../../escaped.txt", options)
            .unwrap();
        archive.write_all(b"bad").unwrap();
        archive.finish().unwrap();
        assert!(runtime
            .import_project_package_for_ui(&unsafe_package)
            .is_err());
        assert!(!temporary.path().join("escaped.txt").exists());
    }

    #[test]
    fn ui_data_records_and_workspace_preview_use_rust_control_plane() {
        let temporary = tempfile::tempdir().unwrap();
        let projects = temporary.path().join("projects");
        let project = write_project(
            &projects,
            "records",
            json!({
                "name": "Records",
                "dataSchema": {
                    "database": "sqlite",
                    "dbPath": "data/records.db",
                    "tables": [{
                        "name": "tasks",
                        "columns": [
                            { "name": "id", "type": "INTEGER", "primaryKey": true },
                            { "name": "title", "type": "TEXT", "notNull": true },
                            { "name": "done", "type": "INTEGER", "defaultValue": 0 }
                        ]
                    }]
                }
            }),
        );
        let runtime = ProjectRuntime::new(projects);
        let saved = runtime
            .project_data_save_records_for_ui(
                "records",
                "tasks",
                &json!([{ "id": 1, "title": "native", "done": false }]),
                Some("upsert"),
            )
            .unwrap();
        assert_eq!(saved["count"], 1);
        let queried = runtime
            .project_data_read_records_for_ui(
                "records",
                "tasks",
                Some(json!({ "id": 1 })),
                Some(10),
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert_eq!(queried, json!([{ "id": 1, "title": "native", "done": 0 }]));
        assert_eq!(
            runtime.project_data_tables_for_ui("records").unwrap()["tables"],
            json!(["tasks"])
        );

        let workspace = temporary.path().join("workspace");
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::write(
            workspace.join("src/main.ts"),
            "export const native = true\n",
        )
        .unwrap();
        fs::create_dir_all(workspace.join("node_modules/ignored")).unwrap();
        fs::write(workspace.join("node_modules/ignored/index.js"), "ignored").unwrap();
        let listed = runtime.folder_workspace_list_for_ui(&workspace).unwrap();
        assert!(listed["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["path"] == "src"));
        assert!(!listed["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["path"] == "node_modules"));
        let preview = runtime
            .folder_workspace_read_for_ui(&workspace, "src/main.ts")
            .unwrap();
        assert_eq!(preview["kind"], "code");
        assert_eq!(preview["language"], "typescript");
        assert_eq!(preview["content"], "export const native = true\n");
        assert_eq!(
            workspace_file_kind(".env", 0),
            ("code", Some("properties"), false)
        );
        assert_eq!(
            workspace_file_kind("views/card.blade.php", 0),
            ("code", Some("blade"), false)
        );
        assert_eq!(
            workspace_file_kind("components/panel.svelte", 0),
            ("code", Some("svelte"), false)
        );
        assert_eq!(
            workspace_file_kind("templates/page.njk", 0),
            ("code", Some("nunjucks"), false)
        );
        assert_eq!(workspace_file_kind(".prettierrc", 0), ("text", None, false));
        assert_eq!(
            workspace_file_kind("Dockerfile", 0),
            ("code", Some("dockerfile"), false)
        );
        assert!(runtime
            .folder_workspace_read_for_ui(&workspace, "../outside.txt")
            .is_err());
        assert!(project.is_dir());
    }
}
