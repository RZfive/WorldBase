//! 全栈项目工具（desktop 域）：create/dev_start/dev_stop/list/status。

use super::{require_str, Tool, ToolServices};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Map, Value};
use sha1::{Digest, Sha1};
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

pub struct ProjectCreateTool;

fn object_argument(
    input: &Value,
    key: &str,
    allow_missing_or_null: bool,
) -> Result<Map<String, Value>> {
    let Some(value) = input.get(key) else {
        anyhow::ensure!(
            allow_missing_or_null,
            "create_project 的 {key} 参数必须是 JSON 对象"
        );
        return Ok(Map::new());
    };
    if value.is_null() && allow_missing_or_null {
        return Ok(Map::new());
    }

    let mut current = value.clone();
    for _ in 0..3 {
        if let Some(object) = current.as_object() {
            return Ok(object.clone());
        }
        let Some(text) = current.as_str() else {
            break;
        };
        let text = text.trim();
        if !text.starts_with('{') {
            break;
        }
        current = serde_json::from_str(text).map_err(|error| {
            anyhow::anyhow!("create_project 的 {key} 参数不是有效 JSON 对象: {error}")
        })?;
    }

    anyhow::bail!("create_project 的 {key} 参数必须是 JSON 对象")
}

fn project_files(input: &Value, development_mode: bool) -> Result<Map<String, Value>> {
    let files = object_argument(input, "files", development_mode)?;
    anyhow::ensure!(
        development_mode || !files.is_empty(),
        "create_project 的 files 参数至少要包含一个文件。"
    );
    for (file_path, content) in &files {
        anyhow::ensure!(
            !file_path.trim().is_empty(),
            "create_project 的 files 参数包含空文件路径。"
        );
        let normalized = file_path.replace('\\', "/");
        anyhow::ensure!(
            !normalized.starts_with('/')
                && !normalized.contains('\0')
                && !normalized.split('/').any(|part| part == "..")
                && !Path::new(file_path).components().any(|component| {
                    matches!(
                        component,
                        std::path::Component::ParentDir
                            | std::path::Component::RootDir
                            | std::path::Component::Prefix(_)
                    )
                }),
            "create_project 的文件路径不允许越出项目目录: {file_path}"
        );
        anyhow::ensure!(
            content.is_string(),
            "create_project 的 files[\"{file_path}\"] 必须是完整文件内容字符串。"
        );
    }
    Ok(files)
}

fn project_type(input: &Value) -> Result<&str> {
    let value = require_str(input, "type")?;
    anyhow::ensure!(
        matches!(value, "frontend" | "backend" | "fullstack"),
        "create_project 的 type 必须是 frontend、backend 或 fullstack。"
    );
    Ok(value)
}

fn package_has_next(files: &Map<String, Value>) -> bool {
    files
        .get("package.json")
        .and_then(Value::as_str)
        .and_then(|content| serde_json::from_str::<Value>(content).ok())
        .map(|package| {
            ["dependencies", "devDependencies"].into_iter().any(|key| {
                package
                    .get(key)
                    .and_then(Value::as_object)
                    .map(|entries| entries.contains_key("next"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

const MAX_PROJECT_SLUG_LENGTH: usize = 20;
const PROJECT_ID_HASH_LENGTH: usize = 8;

/// Generate the same filesystem-safe project ID shape as Electron's
/// `tool-create-project`: ASCII slug plus a short SHA-1 suffix, or a longer
/// hash-only ID for names that contain no Latin characters.
fn generate_project_id(name: &str) -> String {
    let normalized_name: String = name
        .nfkd()
        .filter(|character| !('\u{0300}'..='\u{036f}').contains(character))
        .collect();
    let mut slug = String::new();
    let mut pending_separator = false;
    for character in normalized_name.chars() {
        if character.is_ascii_alphanumeric() {
            if pending_separator && !slug.is_empty() {
                slug.push('_');
            }
            pending_separator = false;
            slug.push(character.to_ascii_lowercase());
        } else {
            pending_separator = true;
        }
        if slug.len() >= MAX_PROJECT_SLUG_LENGTH {
            break;
        }
    }
    if slug.len() > MAX_PROJECT_SLUG_LENGTH {
        slug.truncate(MAX_PROJECT_SLUG_LENGTH);
    }
    while slug.ends_with('_') {
        slug.pop();
    }

    let nonce = Uuid::new_v4().to_string();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let digest = |length: usize| {
        let mut hasher = Sha1::new();
        hasher.update(format!("{name}:{now}:{nonce}"));
        let hex = format!("{:x}", hasher.finalize());
        hex[..length].to_string()
    };
    if slug.is_empty() {
        format!("proj_{}", digest(MAX_PROJECT_SLUG_LENGTH))
    } else {
        format!("proj_{slug}_{}", digest(PROJECT_ID_HASH_LENGTH))
    }
}

fn metadata_project_value(services: &ToolServices, project_id: &str) -> Value {
    services
        .projects
        .project_meta(project_id)
        .unwrap_or_else(|_| json!({ "id": project_id }))
}

fn error_message(error: &anyhow::Error) -> String {
    error.to_string()
}

fn lifecycle_failure(
    name: &str,
    project: Value,
    project_id: &str,
    stage: &str,
    error: String,
    output: Option<Value>,
    logs: Option<Value>,
) -> Value {
    let mut result = json!({
        "success": false,
        "ready": false,
        "recoverable": true,
        "stage": stage,
        "project": project,
        "projectId": project_id,
        "project_id": project_id,
        "error": error,
        "message": format!(
            "Project \"{name}\" files were created (ID: {project_id}), but the {stage} stage failed. The project is NOT running. Fix the project and retry with rebuild_project or start_project_server."
        )
    });
    if let Some(output) = output {
        result["output"] = output;
    }
    if let Some(logs) = logs {
        result["logs"] = logs;
    }
    result
}

#[async_trait]
impl Tool for ProjectCreateTool {
    fn name(&self) -> &str {
        "create_project"
    }
    fn description(&self) -> &str {
        "Create a managed project that Electron can list, edit, package and run. Supports incremental files and .world-meta.json metadata."
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "name": { "type": "string" },
                "type": { "type": "string", "enum": ["frontend", "backend", "fullstack"] },
                "files": { "type": "object", "description": "Optional map of relative file paths to full file contents." },
                "meta": { "type": "object", "description": "Optional .world-meta.json fields." },
                "development_mode": { "type": "boolean", "description": "Create an incremental project workflow." },
                "install_dependencies": { "type": "boolean", "description": "Install package dependencies immediately after creation; defaults to true outside development mode when package.json exists." },
                "build_and_start": { "type": "boolean", "description": "Build Next.js projects and start the runtime immediately; defaults to true outside development mode." },
                "cleanup_dependencies_on_success": { "type": "boolean", "description": "Remove node_modules after a successful build/start." },
                "cleanup_build_cache_on_success": { "type": "boolean", "description": "Remove build caches after a successful build/start." }
            },
            "required": ["name", "type"]
        })
    }
    fn domain(&self) -> &str {
        "desktop"
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        if let Some(project_id) = services
            .target_project_id
            .as_deref()
            .map(str::trim)
            .filter(|project_id| !project_id.is_empty())
        {
            return Ok(json!({
                "success": false,
                "error": format!(
                "本次对话正在优化现有项目 {project_id}，不允许创建新项目。请使用 write_project_file 工具将代码写入已有项目，project_id 为 \"{project_id}\"。"
                )
            }));
        }
        let name = require_str(&input, "name")?.trim().to_string();
        anyhow::ensure!(!name.is_empty(), "create_project 的 name 不能为空。");
        let project_type = project_type(&input)?.to_string();
        let development_mode = input
            .get("development_mode")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let files = project_files(&input, development_mode)?;
        let meta = object_argument(&input, "meta", true)?;
        let next_hint = meta
            .get("framework")
            .and_then(Value::as_str)
            .is_some_and(|framework| framework.eq_ignore_ascii_case("nextjs"))
            || files.contains_key("next.config.js")
            || files.contains_key("next.config.mjs")
            || files.contains_key("next.config.ts")
            || files.contains_key("next.config.cjs")
            || package_has_next(&files);

        // Electron generates the ID before writing any files. Keep that ID
        // explicit when handing the project to Rust so TS/Rust switching can
        // address the same directory and metadata record.
        let project_id = generate_project_id(&name);

        // Match Electron's workflow metadata while preserving any additional
        // caller-provided workflow fields.
        let mut full_meta = meta;
        let mut workflow = full_meta
            .remove("workflow")
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        workflow.entry("mode").or_insert_with(|| {
            Value::String(
                if development_mode {
                    "development"
                } else {
                    "direct"
                }
                .into(),
            )
        });
        workflow
            .entry("incremental")
            .or_insert(Value::Bool(development_mode));
        full_meta.insert("workflow".into(), Value::Object(workflow));
        full_meta
            .entry("name")
            .or_insert_with(|| Value::String(name.clone()));
        full_meta
            .entry("type")
            .or_insert_with(|| Value::String(project_type.clone()));
        let meta_value = Value::Object(full_meta);

        let info = services
            .projects
            .create_project_with_id_and_files_and_template(
                &project_id,
                &name,
                &project_type,
                &files,
                meta_value,
                files.is_empty() && next_hint,
            )
            .await?;
        let project_id = info.id.clone();
        let project = metadata_project_value(services, &project_id);

        // Electron initializes declared SQLite tables before any lifecycle
        // work.  The Rust control plane owns that same schema operation.
        let _ = services
            .projects
            .initialize_project_database_for_tool(&project_id)?;

        let root = services.projects.project_root(&project_id)?;
        let has_package_json = root.join("package.json").is_file();
        let should_install = input
            .get("install_dependencies")
            .and_then(Value::as_bool)
            .unwrap_or(!development_mode && has_package_json);
        let should_build_and_start = input
            .get("build_and_start")
            .and_then(Value::as_bool)
            .unwrap_or(!development_mode);
        let cleanup_dependencies = input
            .get("cleanup_dependencies_on_success")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let cleanup_build_cache = input
            .get("cleanup_build_cache_on_success")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        if has_package_json && should_install {
            if let Err(error) = services.projects.install(&root).await {
                let _ = services
                    .projects
                    .cleanup_project_for_ui(&project_id, true, true)
                    .await;
                return Ok(lifecycle_failure(
                    &name,
                    project,
                    &project_id,
                    "install",
                    error_message(&error),
                    None,
                    None,
                ));
            }
        }

        if development_mode && !should_build_and_start {
            return Ok(json!({
                "success": true,
                "ready": false,
                "development_mode": true,
                "project": project,
                "projectId": project_id,
                "project_id": project_id,
                "message": format!("Project \"{name}\" created with ID: {project_id}. Development mode is active. Continue with write_project_file or patch_project_file, then call rebuild_project when ready.")
            }));
        }

        let current_meta = metadata_project_value(services, &project_id);
        let is_next = current_meta
            .get("framework")
            .and_then(Value::as_str)
            .is_some_and(|framework| framework.eq_ignore_ascii_case("nextjs"))
            || next_hint;

        if should_build_and_start && is_next && has_package_json {
            let build = match services.projects.build_project_for_ui(&project_id).await {
                Ok(build) => build,
                Err(error) => {
                    return Ok(lifecycle_failure(
                        &name,
                        metadata_project_value(services, &project_id),
                        &project_id,
                        "build",
                        error_message(&error),
                        None,
                        None,
                    ));
                }
            };
            let build_ok = build
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !build_ok {
                let output = build.get("output").cloned();
                let error = build
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown build error")
                    .to_string();
                return Ok(lifecycle_failure(
                    &name,
                    metadata_project_value(services, &project_id),
                    &project_id,
                    "build",
                    error,
                    output,
                    None,
                ));
            }
            if cleanup_dependencies || cleanup_build_cache {
                let _ = services
                    .projects
                    .cleanup_project_for_ui(&project_id, cleanup_dependencies, cleanup_build_cache)
                    .await;
            }
        }

        let server = if should_build_and_start {
            match services.projects.start_dev(&project_id).await {
                Ok(server) => Some(server),
                Err(error) => {
                    let logs = services.projects.logs(&project_id, 40).await;
                    return Ok(lifecycle_failure(
                        &name,
                        metadata_project_value(services, &project_id),
                        &project_id,
                        "start",
                        error_message(&error),
                        None,
                        Some(serde_json::to_value(logs)?),
                    ));
                }
            }
        } else {
            None
        };

        let project = metadata_project_value(services, &project_id);
        let (status, port, ready) = server
            .as_ref()
            .map(|server| {
                (
                    server.status.clone(),
                    Some(server.port),
                    server.status == "running",
                )
            })
            .unwrap_or_else(|| ("created".to_string(), None, false));
        let command = project
            .get("runtime")
            .and_then(|runtime| runtime.get("backend"))
            .and_then(|backend| backend.get("command"))
            .and_then(Value::as_str)
            .unwrap_or("node server.js");
        Ok(json!({
            "success": true,
            "ready": ready,
            "project": project,
            "projectId": project_id,
            "project_id": project_id,
            "port": port,
            "status": status,
            "development_mode": development_mode,
            "message": format!("Project \"{name}\" created with ID: {project_id}.{} Runtime configured with command: {command}{}", if should_install { " Dependencies installed." } else { " Dependencies were not auto-installed." }, if let Some(port) = port { format!(" Running on port {port}") } else if should_build_and_start { String::new() } else { " Continue editing files and call rebuild_project when ready.".to_string() })
        }))
    }
}

pub struct ProjectListTool;

#[async_trait]
impl Tool for ProjectListTool {
    fn name(&self) -> &str {
        "project_list"
    }
    fn description(&self) -> &str {
        "列出全部全栈项目"
    }
    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {} })
    }
    fn domain(&self) -> &str {
        "desktop"
    }
    async fn execute(&self, _input: Value, services: &ToolServices) -> Result<Value> {
        let list = services.projects.list_projects()?;
        Ok(json!({ "projects": list }))
    }
}

pub struct ProjectDevStartTool;

/// `start_project_server` is the Electron-facing alias for this tool.  The
/// Electron contract has no `install` argument and the runtime manager owns
/// first-run dependency installation, so an omitted flag must mean "start"
/// rather than the legacy Rust-only "install then return" behavior.
fn install_requested(input: &Value) -> bool {
    input
        .get("install")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

#[async_trait]
impl Tool for ProjectDevStartTool {
    fn name(&self) -> &str {
        "project_dev_start"
    }
    fn description(&self) -> &str {
        "启动项目 dev server（pnpm install 后可用）"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project": { "type": "string" },
                "install": { "type": "boolean", "description": "先执行 pnpm install" }
            },
            "required": ["project"]
        })
    }
    fn domain(&self) -> &str {
        "desktop"
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        // `project_id` is the Electron spelling; retain `project` for the
        // original Rust protocol and CLI callers.
        let project = input
            .get("project_id")
            .or_else(|| input.get("project"))
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("missing required string parameter: project_id"))?;
        if install_requested(&input) {
            let path = services.projects.list_projects()?;
            let found = path.iter().find(|p| p.id == project);
            if let Some(p) = found {
                let log = services
                    .projects
                    .install(std::path::Path::new(&p.path))
                    .await?;
                return Ok(
                    json!({ "installLog": log, "note": "install 完成，请再次调用且 install=false 启动" }),
                );
            }
        }
        let info = services.projects.start_dev(project).await?;
        Ok(serde_json::to_value(&info)?)
    }
}

pub struct ProjectDevStopTool;

#[async_trait]
impl Tool for ProjectDevStopTool {
    fn name(&self) -> &str {
        "project_dev_stop"
    }
    fn description(&self) -> &str {
        "停止项目 dev server"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "project": { "type": "string" } },
            "required": ["project"]
        })
    }
    fn domain(&self) -> &str {
        "desktop"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let project = input
            .get("project_id")
            .or_else(|| input.get("project"))
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("missing required string parameter: project_id"))?;
        let stopped = services.projects.stop_dev(project).await?;
        Ok(json!({ "stopped": stopped }))
    }
}

/// Restart a managed project server, mirroring Electron's
/// `restart_project_server` tool.  Stopping first is important because
/// `start_dev` intentionally returns an existing handle when one is active.
pub struct ProjectDevRestartTool;

#[async_trait]
impl Tool for ProjectDevRestartTool {
    fn name(&self) -> &str {
        "project_dev_restart"
    }

    fn description(&self) -> &str {
        "重启项目 dev server"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "project_id": { "type": "string" } },
            "required": ["project_id"]
        })
    }

    fn domain(&self) -> &str {
        "desktop"
    }

    fn permission(&self) -> &str {
        "ask"
    }

    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let project = require_str(&input, "project_id")?;
        let _ = services.projects.stop_dev(project).await?;
        let info = services.projects.start_dev(project).await?;
        Ok(serde_json::to_value(&info)?)
    }
}

/// Return the lifecycle/health state of a managed project server.
pub struct ProjectStatusTool;

fn read_project_status_metadata(
    root: Option<&Path>,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    bool,
    bool,
    bool,
    bool,
) {
    let Some(root) = root else {
        return (None, None, None, false, false, false, false);
    };

    let package_json_path = root.join("package.json");
    let package_json_exists = package_json_path.is_file();
    let node_modules_present = root.join("node_modules").is_dir();
    let standalone_build_present = root.join(".next/standalone/server.js").is_file();
    let metadata = root
        .join(".world-meta.json")
        .is_file()
        .then(|| std::fs::read_to_string(root.join(".world-meta.json")).ok())
        .flatten()
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok());
    let framework = metadata
        .as_ref()
        .and_then(|value| value.get("framework"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let build_status = metadata
        .as_ref()
        .and_then(|value| value.get("buildStatus"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let last_build_at = metadata
        .as_ref()
        .and_then(|value| value.get("lastBuildAt"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let is_next_project = framework
        .as_deref()
        .is_some_and(|value| value.eq_ignore_ascii_case("nextjs"))
        || std::fs::read_to_string(&package_json_path)
            .ok()
            .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
            .is_some_and(|package| {
                ["dependencies", "devDependencies"].into_iter().any(|key| {
                    package
                        .get(key)
                        .and_then(Value::as_object)
                        .is_some_and(|dependencies| dependencies.contains_key("next"))
                })
            });

    (
        framework,
        build_status,
        last_build_at,
        package_json_exists,
        node_modules_present,
        standalone_build_present,
        is_next_project,
    )
}

fn failure_value(
    source: &str,
    phase: &str,
    status: &str,
    summary: String,
    time: Option<Value>,
    exit_code: Option<Value>,
    error: Option<String>,
    stderr_excerpt: Vec<String>,
) -> Value {
    let mut failure = serde_json::Map::new();
    failure.insert("source".into(), json!(source));
    failure.insert("phase".into(), json!(phase));
    failure.insert("status".into(), json!(status));
    failure.insert("summary".into(), json!(summary));
    if let Some(time) = time {
        failure.insert("time".into(), time);
    }
    if let Some(exit_code) = exit_code {
        failure.insert("exitCode".into(), exit_code);
    }
    if let Some(error) = error {
        failure.insert("error".into(), json!(error));
    }
    failure.insert("stderrExcerpt".into(), json!(stderr_excerpt));
    Value::Object(failure)
}

fn latest_project_failure(
    status: &Value,
    build_status: Option<&str>,
    last_build_at: Option<&str>,
    recent_error_texts: &[String],
) -> Option<Value> {
    let runtime_status = status
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("not_started");
    let runtime_failure = match runtime_status {
        "crashed" => Some(failure_value(
            "runtime",
            "crash",
            runtime_status,
            status
                .get("error")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("Project process crashed")
                .to_string(),
            status.get("startedAt").cloned(),
            status
                .get("exitCode")
                .or_else(|| status.get("exit_code"))
                .cloned(),
            status
                .get("error")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            recent_error_texts.to_vec(),
        )),
        "error" => Some(failure_value(
            "runtime",
            "spawn",
            runtime_status,
            status
                .get("error")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("Project runtime failed to start")
                .to_string(),
            status.get("startedAt").cloned(),
            status
                .get("exitCode")
                .or_else(|| status.get("exit_code"))
                .cloned(),
            status
                .get("error")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            recent_error_texts.to_vec(),
        )),
        _ => None,
    };
    let build_failure = if build_status == Some("failed") {
        Some(failure_value(
            "build",
            "build_failed",
            "failed",
            "Build failed".into(),
            last_build_at.map(|value| json!(value)),
            None,
            None,
            recent_error_texts.to_vec(),
        ))
    } else {
        None
    };

    match (runtime_failure, build_failure) {
        (Some(runtime), Some(build)) => {
            let runtime_time = runtime.get("time").and_then(Value::as_str);
            let build_time = build.get("time").and_then(Value::as_str);
            if runtime_time.is_some() && build_time.is_none() {
                Some(runtime)
            } else if runtime_time.is_none() && build_time.is_some() {
                Some(build)
            } else if runtime_time.unwrap_or_default() >= build_time.unwrap_or_default() {
                Some(runtime)
            } else {
                Some(build)
            }
        }
        (Some(runtime), None) => Some(runtime),
        (None, Some(build)) => Some(build),
        (None, None) => None,
    }
}

fn recommended_next_debug_step(
    runtime_status: &str,
    last_failure: Option<&Value>,
    has_recent_error_logs: bool,
) -> &'static str {
    if last_failure
        .and_then(|failure| failure.get("source"))
        .and_then(Value::as_str)
        == Some("build")
    {
        return "check_build_output";
    }
    if last_failure
        .and_then(|failure| failure.get("phase"))
        .and_then(Value::as_str)
        .is_some_and(|phase| matches!(phase, "terminated_before_ready" | "ready_timeout" | "spawn"))
    {
        return "inspect_startup_failure";
    }
    if matches!(runtime_status, "crashed" | "error") {
        let has_failure_excerpt = last_failure
            .and_then(|failure| failure.get("stderrExcerpt"))
            .and_then(Value::as_array)
            .is_some_and(|excerpt| !excerpt.is_empty());
        return if has_recent_error_logs || has_failure_excerpt {
            "check_stderr_logs"
        } else {
            "restart_project_server"
        };
    }
    "none"
}

#[async_trait]
impl Tool for ProjectStatusTool {
    fn name(&self) -> &str {
        "get_project_status"
    }

    fn description(&self) -> &str {
        "Get the current project runtime status, port, PID, start time, dependency/build state, and the most recent structured runtime failure summary."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "project_id": { "type": "string" } },
            "required": ["project_id"]
        })
    }

    fn domain(&self) -> &str {
        "desktop"
    }

    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let project = require_str(&input, "project_id")?;
        let status = services.projects.status(project).await?;
        let root = services.projects.project_root(project).ok();
        let (
            framework,
            build_status,
            last_build_at,
            package_json_exists,
            node_modules_present,
            standalone_build_present,
            is_next_project,
        ) = read_project_status_metadata(root.as_deref());
        let needs_rebuild = if is_next_project {
            Some(
                services
                    .projects
                    .project_needs_rebuild_for_ui(project)
                    .unwrap_or(true),
            )
        } else {
            None
        };
        let dependency_status = if !package_json_exists {
            "not_applicable"
        } else if node_modules_present {
            "installed"
        } else {
            "missing"
        };
        let recent_logs = services.projects.logs(project, 20).await;
        let stderr_logs = recent_logs
            .iter()
            .filter(|entry| entry.kind == "stderr")
            .cloned()
            .collect::<Vec<_>>();
        let recent_error_logs = stderr_logs
            .split_at(stderr_logs.len().saturating_sub(10))
            .1
            .to_vec();
        let recent_error_texts = recent_error_logs
            .iter()
            .flat_map(|entry| entry.text.split(['\r', '\n']))
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        let recent_error_texts = recent_error_texts
            .split_at(recent_error_texts.len().saturating_sub(12))
            .1
            .to_vec();
        let last_failure = latest_project_failure(
            &status,
            build_status.as_deref(),
            last_build_at.as_deref(),
            &recent_error_texts,
        );
        let runtime_status = status
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("not_started");
        let recommended_prepare_action = if !package_json_exists {
            "none"
        } else if !is_next_project {
            if node_modules_present {
                "none"
            } else {
                "install_dependencies"
            }
        } else if needs_rebuild == Some(true) {
            "rebuild_project"
        } else if standalone_build_present {
            "none"
        } else if node_modules_present {
            "rebuild_project"
        } else {
            "install_dependencies"
        };
        let recommended_debug_step = recommended_next_debug_step(
            runtime_status,
            last_failure.as_ref(),
            !recent_error_logs.is_empty(),
        );

        let mut result = status.as_object().cloned().unwrap_or_default();
        if let Some(framework) = framework {
            result.insert("framework".into(), json!(framework));
        }
        if let Some(build_status) = build_status {
            result.insert("build_status".into(), json!(build_status));
        }
        result.insert("package_json_exists".into(), json!(package_json_exists));
        result.insert("node_modules_present".into(), json!(node_modules_present));
        result.insert(
            "standalone_build_present".into(),
            json!(standalone_build_present),
        );
        if let Some(needs_rebuild) = needs_rebuild {
            result.insert("needs_rebuild".into(), json!(needs_rebuild));
        }
        result.insert("dependency_status".into(), json!(dependency_status));
        result.insert(
            "recommended_prepare_action".into(),
            json!(recommended_prepare_action),
        );
        if let Some(last_failure) = last_failure {
            let last_error_source = last_failure.get("source").cloned();
            let last_error_phase = last_failure.get("phase").cloned();
            let last_error_time = last_failure.get("time").cloned();
            let last_error_summary = last_failure.get("summary").cloned().or_else(|| {
                status
                    .get("error")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .map(|value| json!(value))
            });
            let last_error_excerpt = last_failure
                .get("stderrExcerpt")
                .cloned()
                .unwrap_or_else(|| json!(recent_error_texts));
            result.insert("last_failure".into(), last_failure);
            if let Some(value) = last_error_source {
                result.insert("last_error_source".into(), value);
            }
            if let Some(value) = last_error_phase {
                result.insert("last_error_phase".into(), value);
            }
            if let Some(value) = last_error_time {
                result.insert("last_error_time".into(), value);
            }
            if let Some(value) = last_error_summary {
                result.insert("last_error_summary".into(), value);
            }
            result.insert("last_error_excerpt".into(), last_error_excerpt);
        } else if let Some(error) = status
            .get("error")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            result.insert("last_error_summary".into(), json!(error));
            result.insert("last_error_excerpt".into(), json!(recent_error_texts));
        }
        result.insert(
            "recommended_next_debug_step".into(),
            json!(recommended_debug_step),
        );
        result.insert(
            "recent_error_logs".into(),
            serde_json::to_value(recent_error_logs)?,
        );
        Ok(Value::Object(result))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn services(root: &std::path::Path, target_project_id: Option<&str>) -> ToolServices {
        let workspace = root.join("workspace");
        let projects = root.join("projects");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&projects).unwrap();
        let store = Arc::new(worldbase_memory::Store::open(&root.join("store.sqlite")).unwrap());
        ToolServices {
            host: Arc::new(super::super::HostBridge::new()),
            current_stream: Arc::new(Mutex::new(String::new())),
            abort: None,
            workspace,
            folder_workspace: None,
            target_project_id: target_project_id.map(ToOwned::to_owned),
            allowed_mcp_server_ids: None,
            plan_goal: Arc::new(Mutex::new(None)),
            todo_items: Arc::new(Mutex::new(Vec::new())),
            read_files: Arc::new(Mutex::new(std::collections::HashSet::new())),
            visible_tool_catalog: None,
            store: store.clone(),
            skills: Arc::new(worldbase_skills::SkillRegistry::new(vec![])),
            scheduler: Arc::new(worldbase_scheduler::Scheduler::new(store)),
            mcp: Arc::new(worldbase_mcp_client::McpManager::default()),
            projects: Arc::new(worldbase_project_runtime::ProjectRuntime::new(projects)),
            group_collaboration: None,
            subagent_runtime: None,
        }
    }

    #[test]
    fn project_server_start_does_not_install_when_flag_is_omitted() {
        assert!(!install_requested(&json!({ "project_id": "demo" })));
        assert!(!install_requested(&json!({ "project": "demo" })));
        assert!(!install_requested(
            &json!({ "project_id": "demo", "install": null })
        ));
        assert!(install_requested(
            &json!({ "project_id": "demo", "install": true })
        ));
        assert!(!install_requested(
            &json!({ "project_id": "demo", "install": false })
        ));
    }

    #[tokio::test]
    async fn target_project_prevents_new_project_creation() {
        let temp = tempfile::tempdir().unwrap();
        let services = services(temp.path(), Some("existing-project"));

        let result = ProjectCreateTool
            .execute(json!({ "name": "another-project" }), &services)
            .await
            .unwrap();

        assert_eq!(result["success"], false);
        assert!(result["error"]
            .as_str()
            .unwrap_or_default()
            .contains("existing-project"));
        assert!(!temp.path().join("projects/another-project").exists());
    }

    #[tokio::test]
    async fn development_mode_allows_an_empty_project_without_lifecycle_side_effects() {
        let temp = tempfile::tempdir().unwrap();
        let services = services(temp.path(), None);

        let result = ProjectCreateTool
            .execute(
                json!({
                    "name": "incremental shell",
                    "type": "fullstack",
                    "development_mode": true
                }),
                &services,
            )
            .await
            .unwrap();

        assert_eq!(result["success"], true);
        assert_eq!(result["ready"], false);
        assert_eq!(result["development_mode"], true);
        let project_id = result["projectId"].as_str().unwrap();
        let root = services.projects.project_root(project_id).unwrap();
        assert!(!root.join("package.json").exists());
        assert_eq!(root.join(".world-meta.json").is_file(), true);
        let meta: Value =
            serde_json::from_str(&std::fs::read_to_string(root.join(".world-meta.json")).unwrap())
                .unwrap();
        assert_eq!(meta["workflow"]["mode"], "development");
        assert_eq!(meta["workflow"]["incremental"], true);
    }

    #[tokio::test]
    async fn create_project_uses_electron_id_shape_and_completes_partial_next_template() {
        let temp = tempfile::tempdir().unwrap();
        let services = services(temp.path(), None);
        let result = ProjectCreateTool
            .execute(
                json!({
                    "name": "Café Planner",
                    "type": "frontend",
                    "development_mode": true,
                    "build_and_start": false,
                    "files": {
                        "package.json": "{\"dependencies\":{\"next\":\"1\"}}",
                        "app/page.tsx": "export default function Page () { return <main>ok</main> }"
                    }
                }),
                &services,
            )
            .await
            .unwrap();
        assert_eq!(result["success"], true);
        let project_id = result["projectId"].as_str().unwrap();
        let mut parts = project_id.split('_');
        assert_eq!(parts.next(), Some("proj"));
        assert_eq!(parts.next(), Some("cafe"));
        assert_eq!(parts.next(), Some("planner"));
        let suffix = parts.next().unwrap_or_default();
        assert_eq!(suffix.len(), 8);
        assert!(suffix
            .chars()
            .all(|character| character.is_ascii_hexdigit()));
        let root = services.projects.project_root(project_id).unwrap();
        assert!(root.join("app/layout.tsx").is_file());
        assert!(root.join("app/globals.css").is_file());
        assert!(root.join("next.config.js").is_file());
        let package: Value =
            serde_json::from_str(&std::fs::read_to_string(root.join("package.json")).unwrap())
                .unwrap();
        assert_eq!(package["dependencies"]["next"], "^15.0.0");
        assert_eq!(package["scripts"]["start"], "next start");
    }

    #[tokio::test]
    async fn create_project_uses_hash_only_id_for_non_latin_name() {
        let temp = tempfile::tempdir().unwrap();
        let services = services(temp.path(), None);
        let result = ProjectCreateTool
            .execute(
                json!({
                    "name": "笔记管理",
                    "type": "backend",
                    "development_mode": true,
                    "build_and_start": false
                }),
                &services,
            )
            .await
            .unwrap();
        let project_id = result["projectId"].as_str().unwrap();
        let suffix = project_id.strip_prefix("proj_").unwrap();
        assert_eq!(suffix.len(), 20);
        assert!(suffix
            .chars()
            .all(|character| character.is_ascii_hexdigit()));
    }

    #[tokio::test]
    async fn create_project_initializes_declared_sqlite_schema() {
        let temp = tempfile::tempdir().unwrap();
        let services = services(temp.path(), None);
        let result = ProjectCreateTool
            .execute(
                json!({
                    "name": "notes data",
                    "type": "backend",
                    "development_mode": true,
                    "files": { "server.js": "console.log('ready')" },
                    "meta": {
                        "dataSchema": {
                            "database": "sqlite",
                            "dbPath": "data/notes.sqlite",
                            "tables": [{
                                "name": "notes",
                                "columns": [
                                    { "name": "id", "type": "INTEGER", "primaryKey": true, "autoIncrement": true },
                                    { "name": "body", "type": "TEXT", "notNull": true }
                                ]
                            }]
                        }
                    }
                }),
                &services,
            )
            .await
            .unwrap();

        assert_eq!(result["success"], true);
        let project_id = result["projectId"].as_str().unwrap();
        let root = services.projects.project_root(project_id).unwrap();
        let db = root.join("data/notes.sqlite");
        assert!(db.is_file());
        let connection = rusqlite::Connection::open(db).unwrap();
        let table_exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='notes'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table_exists, 1);
    }

    #[tokio::test]
    async fn next_build_failure_is_reported_as_recoverable_stage() {
        let temp = tempfile::tempdir().unwrap();
        let services = services(temp.path(), None);
        let result = ProjectCreateTool
            .execute(
                json!({
                    "name": "broken next",
                    "type": "frontend",
                    "install_dependencies": false,
                    "build_and_start": true,
                    "files": {
                        "package.json": "{\"scripts\":{\"build\":\"node -e \\\"process.exit(1)\\\"\"},\"dependencies\":{\"next\":\"1\"}}",
                        "next.config.js": "module.exports = { output: 'standalone' }",
                        "app/page.js": "export default function Page(){ return null }"
                    }
                }),
                &services,
            )
            .await
            .unwrap();

        assert_eq!(result["success"], false);
        assert_eq!(result["recoverable"], true);
        assert_eq!(result["stage"], "build");
        assert!(result["projectId"].as_str().is_some());
        assert!(result["output"].as_str().is_some());
    }

    #[tokio::test]
    async fn project_status_includes_runtime_build_and_recovery_fields() {
        let temp = tempfile::tempdir().unwrap();
        let services = services(temp.path(), None);
        let project_id = "status-project";
        let root = temp.path().join("projects").join(project_id);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("package.json"),
            r#"{"dependencies":{"next":"15.0.0"}}"#,
        )
        .unwrap();
        std::fs::write(
            root.join(".world-meta.json"),
            r#"{"id":"status-project","framework":"nextjs","buildStatus":"failed"}"#,
        )
        .unwrap();

        let result = ProjectStatusTool
            .execute(json!({ "project_id": project_id }), &services)
            .await
            .unwrap();

        assert_eq!(result["status"], "not_started");
        assert_eq!(result["framework"], "nextjs");
        assert_eq!(result["build_status"], "failed");
        assert_eq!(result["package_json_exists"], true);
        assert_eq!(result["node_modules_present"], false);
        assert_eq!(result["standalone_build_present"], false);
        assert_eq!(result["dependency_status"], "missing");
        assert_eq!(result["needs_rebuild"], true);
        assert_eq!(result["recommended_prepare_action"], "rebuild_project");
        assert_eq!(result["last_failure"]["source"], "build");
        assert_eq!(result["last_failure"]["phase"], "build_failed");
        assert_eq!(result["last_error_source"], "build");
        assert_eq!(result["last_error_phase"], "build_failed");
        assert_eq!(result["recommended_next_debug_step"], "check_build_output");
        assert_eq!(result["recent_error_logs"], json!([]));
    }

    #[tokio::test]
    async fn project_status_keeps_missing_project_response_compatible() {
        let temp = tempfile::tempdir().unwrap();
        let services = services(temp.path(), None);

        let result = ProjectStatusTool
            .execute(json!({ "project_id": "missing-project" }), &services)
            .await
            .unwrap();

        assert_eq!(result["status"], "not_started");
        assert_eq!(result["running"], false);
        assert_eq!(result["package_json_exists"], false);
        assert_eq!(result["dependency_status"], "not_applicable");
        assert_eq!(result["recommended_prepare_action"], "none");
        assert_eq!(result["recommended_next_debug_step"], "none");
        assert_eq!(result["recent_error_logs"], json!([]));
        assert!(result.get("framework").is_none());
        assert!(result.get("needs_rebuild").is_none());
    }

    #[test]
    fn create_project_schema_exposes_electron_lifecycle_options() {
        let schema = ProjectCreateTool.input_schema();
        let properties = schema["properties"].as_object().unwrap();
        for key in [
            "development_mode",
            "install_dependencies",
            "build_and_start",
            "cleanup_dependencies_on_success",
            "cleanup_build_cache_on_success",
        ] {
            assert!(
                properties.contains_key(key),
                "missing schema property {key}"
            );
        }
        assert_eq!(schema["required"], json!(["name", "type"]));
    }
}
