//! Native live LSP diagnostics tool.
//!
//! Resolves a project-relative source file, selects an installed language
//! server, opens the document through [`worldbase_coding::lsp_client`], and
//! returns normalized `publishDiagnostics`. The tool never installs or
//! downloads servers and never falls back to a shell.

use crate::{Tool, ToolServices};
use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::{Component, Path};
use std::time::Duration;
use worldbase_coding::lsp_client::{LspClient, LspServerConfig};
use worldbase_coding::{
    merge_lsp_diagnostics, parse_publish_diagnostics, path_to_file_uri, Diagnostic,
    PublishDiagnosticsParams,
};

const DEFAULT_TIMEOUT_MS: u64 = 15_000;
const MAX_TIMEOUT_MS: u64 = 60_000;
const SHUTDOWN_CLOSE_TIMEOUT: Duration = Duration::from_secs(2);
const SUPPORTED_LANGUAGE_IDS: &str =
    "typescript, typescriptreact, javascript, python, go, rust, java";

pub struct CodingLspTool;

#[async_trait]
impl Tool for CodingLspTool {
    fn name(&self) -> &str {
        "coding_lsp"
    }

    fn description(&self) -> &str {
        "Start an installed language server for one project file, open the document, and return normalized LSP publishDiagnostics. Auto-detects common servers; never installs or downloads anything."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_id": {
                    "type": "string",
                    "description": "Managed project ID that owns the file."
                },
                "file_path": {
                    "type": "string",
                    "description": "Project-relative source file to diagnose."
                },
                "language_id": {
                    "type": "string",
                    "enum": [
                        "typescript",
                        "typescriptreact",
                        "javascript",
                        "python",
                        "go",
                        "rust",
                        "java"
                    ],
                    "description": "Optional language ID. Inferred from the file extension when omitted."
                },
                "server_program": {
                    "type": "string",
                    "description": "Optional language-server executable override. When set, auto-detection is skipped."
                },
                "server_args": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Optional server arguments. Replaces the detected arguments or accompanies server_program."
                },
                "timeout_ms": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_TIMEOUT_MS,
                    "default": DEFAULT_TIMEOUT_MS,
                    "description": "Maximum wait for the language server and its diagnostics."
                },
                "include_raw": {
                    "type": "boolean",
                    "description": "Include the raw publishDiagnostics payload in the result."
                }
            },
            "required": ["project_id", "file_path"]
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
        let project_id = require_project_id(&input)?;
        let file_path = require_file_path(&input)?;
        let root = services
            .projects
            .project_root(project_id)
            .with_context(|| format!("resolve project {project_id}"))?;
        let path = services
            .projects
            .project_path(project_id, file_path)
            .with_context(|| format!("resolve project file {file_path}"))?;
        let text = tokio::fs::read_to_string(&path)
            .await
            .with_context(|| format!("read project file {file_path}"))?;

        let language = parse_language(&input, &path)?;
        let server = match resolve_server(
            language,
            optional_string(&input, "server_program")?,
            parse_server_args(&input)?,
            executable_available,
        ) {
            ServerResolution::Found(server) => server,
            ServerResolution::Missing { reason } => {
                return Ok(unavailable_payload(file_path, language, reason));
            }
        };

        let timeout_ms = normalize_timeout_ms(&input);
        let params = collect_diagnostics(&root, &path, &text, language, &server, timeout_ms)
            .await
            .with_context(|| format!("collect LSP diagnostics for {file_path}"))?;
        let diagnostics = normalize_diagnostics(&params)?;
        let raw = if input
            .get("include_raw")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            Some(serde_json::to_value(&params).context("serialize publishDiagnostics parameters")?)
        } else {
            None
        };

        Ok(success_payload(
            file_path,
            language,
            &server,
            &diagnostics,
            raw,
        ))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LanguageId {
    TypeScript,
    TypeScriptReact,
    JavaScript,
    Python,
    Go,
    Rust,
    Java,
}

impl LanguageId {
    fn as_str(self) -> &'static str {
        match self {
            Self::TypeScript => "typescript",
            Self::TypeScriptReact => "typescriptreact",
            Self::JavaScript => "javascript",
            Self::Python => "python",
            Self::Go => "go",
            Self::Rust => "rust",
            Self::Java => "java",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "typescript" => Some(Self::TypeScript),
            "typescriptreact" => Some(Self::TypeScriptReact),
            "javascript" => Some(Self::JavaScript),
            "python" => Some(Self::Python),
            "go" => Some(Self::Go),
            "rust" => Some(Self::Rust),
            "java" => Some(Self::Java),
            _ => None,
        }
    }

    fn from_path(path: &Path) -> Option<Self> {
        let extension = path.extension()?.to_str()?;
        Self::from_extension(extension)
    }

    fn from_extension(extension: &str) -> Option<Self> {
        let extension = extension.trim_start_matches('.').to_ascii_lowercase();
        match extension.as_str() {
            "ts" | "mts" | "cts" => Some(Self::TypeScript),
            "tsx" => Some(Self::TypeScriptReact),
            "js" | "jsx" | "mjs" | "cjs" => Some(Self::JavaScript),
            "py" | "pyi" => Some(Self::Python),
            "go" => Some(Self::Go),
            "rs" => Some(Self::Rust),
            "java" => Some(Self::Java),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ServerSpec {
    program: String,
    args: Vec<String>,
}

impl ServerSpec {
    fn new(program: &str, args: &[&str]) -> Self {
        Self {
            program: program.to_string(),
            args: args.iter().map(|arg| (*arg).to_string()).collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ServerResolution {
    Found(ServerSpec),
    Missing { reason: String },
}

fn server_candidates(language: LanguageId) -> Vec<ServerSpec> {
    match language {
        LanguageId::TypeScript | LanguageId::TypeScriptReact | LanguageId::JavaScript => {
            vec![ServerSpec::new("typescript-language-server", &["--stdio"])]
        }
        LanguageId::Python => vec![
            ServerSpec::new("pyright-langserver", &["--stdio"]),
            ServerSpec::new("pylsp", &[]),
        ],
        LanguageId::Go => vec![ServerSpec::new("gopls", &[])],
        LanguageId::Rust => vec![ServerSpec::new("rust-analyzer", &[])],
        LanguageId::Java => vec![ServerSpec::new("jdtls", &[])],
    }
}

fn resolve_server<F>(
    language: LanguageId,
    program_override: Option<&str>,
    args_override: Option<Vec<String>>,
    is_available: F,
) -> ServerResolution
where
    F: Fn(&str) -> bool,
{
    let args_override = args_override.as_deref();

    if let Some(program) = program_override {
        let program = program.trim();
        if program.is_empty() {
            return ServerResolution::Missing {
                reason: "server_program must not be empty".to_string(),
            };
        }
        if !is_available(program) {
            return ServerResolution::Missing {
                reason: format!(
                    "configured server_program {program:?} was not found or is not executable"
                ),
            };
        }
        return ServerResolution::Found(ServerSpec {
            program: program.to_string(),
            args: args_override.map(<[String]>::to_vec).unwrap_or_default(),
        });
    }

    let candidates = server_candidates(language);
    let tried = candidates
        .iter()
        .map(|candidate| candidate.program.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    for mut candidate in candidates {
        if is_available(&candidate.program) {
            if let Some(args) = args_override {
                candidate.args = args.to_vec();
            }
            return ServerResolution::Found(candidate);
        }
    }

    ServerResolution::Missing {
        reason: format!(
            "no language server found for {} (tried: {tried}); install one or pass server_program/server_args",
            language.as_str()
        ),
    }
}

fn executable_available(program: &str) -> bool {
    let program = program.trim();
    if program.is_empty() {
        return false;
    }

    let path = Path::new(program);
    if path.is_absolute() || path.components().count() > 1 {
        return is_executable_file(path);
    }

    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&paths).any(|directory| {
        if is_executable_file(&directory.join(program)) {
            return true;
        }
        #[cfg(windows)]
        {
            if let Some(pathext) = std::env::var_os("PATHEXT") {
                let pathext = pathext.to_string_lossy();
                return pathext
                    .split(';')
                    .filter(|ext| !ext.is_empty())
                    .any(|ext| is_executable_file(&directory.join(format!("{program}{ext}"))));
            }
        }
        false
    })
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn require_project_id(input: &Value) -> Result<&str> {
    let project_id = crate::require_str(input, "project_id")?.trim();
    anyhow::ensure!(!project_id.is_empty(), "project_id must not be empty");
    Ok(project_id)
}

fn require_file_path(input: &Value) -> Result<&str> {
    let file_path = crate::require_str(input, "file_path")?.trim();
    validate_project_relative(file_path)?;
    Ok(file_path)
}

fn validate_project_relative(file_path: &str) -> Result<()> {
    anyhow::ensure!(!file_path.is_empty(), "file_path must not be empty");
    let path = Path::new(file_path);
    anyhow::ensure!(
        !path.is_absolute()
            && !path.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            }),
        "file_path must stay inside the project: {file_path}"
    );
    Ok(())
}

fn parse_language(input: &Value, path: &Path) -> Result<LanguageId> {
    match input.get("language_id") {
        None | Some(Value::Null) => LanguageId::from_path(path).ok_or_else(|| {
            anyhow!(
                "cannot infer language_id from {}; pass one of: {SUPPORTED_LANGUAGE_IDS}",
                path.display()
            )
        }),
        Some(Value::String(value)) if value.trim().is_empty() => LanguageId::from_path(path)
            .ok_or_else(|| {
                anyhow!(
                    "cannot infer language_id from {}; pass one of: {SUPPORTED_LANGUAGE_IDS}",
                    path.display()
                )
            }),
        Some(Value::String(value)) => LanguageId::parse(value).ok_or_else(|| {
            anyhow!(
                "unsupported language_id {:?}; expected one of: {SUPPORTED_LANGUAGE_IDS}",
                value.trim()
            )
        }),
        Some(_) => bail!("language_id must be a string"),
    }
}

fn optional_string<'a>(input: &'a Value, key: &str) -> Result<Option<&'a str>> {
    match input.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.trim().is_empty() => Ok(Some(value.trim())),
        Some(Value::String(_)) => bail!("{key} must not be empty"),
        Some(_) => bail!("{key} must be a string"),
    }
}

fn parse_server_args(input: &Value) -> Result<Option<Vec<String>>> {
    match input.get("server_args") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(values)) => values
            .iter()
            .enumerate()
            .map(|(index, value)| {
                value
                    .as_str()
                    .map(str::to_string)
                    .ok_or_else(|| anyhow!("server_args[{index}] must be a string"))
            })
            .collect::<Result<Vec<_>>>()
            .map(Some),
        Some(_) => bail!("server_args must be an array of strings"),
    }
}

fn normalize_timeout_ms(input: &Value) -> u64 {
    input
        .get("timeout_ms")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1, MAX_TIMEOUT_MS)
}

async fn collect_diagnostics(
    root: &Path,
    path: &Path,
    text: &str,
    language: LanguageId,
    server: &ServerSpec,
    timeout_ms: u64,
) -> Result<PublishDiagnosticsParams> {
    let config = LspServerConfig {
        program: server.program.clone(),
        args: server.args.clone(),
        root_uri: path_to_file_uri(root),
        initialization_options: None,
    };
    let mut client = LspClient::start(config)
        .await
        .context("start language server")?;
    let wait = Duration::from_millis(timeout_ms);

    let session = async {
        client.initialize().await?;
        client.open_document(path, language.as_str(), text).await?;
        client.diagnostics_for(path, wait).await
    };
    let outcome = tokio::time::timeout(wait, session).await;

    // Best-effort cleanup. A slow or dead server must not replace the
    // diagnostics result (or a more useful session error) with a shutdown
    // error.
    let _ = tokio::time::timeout(SHUTDOWN_CLOSE_TIMEOUT, client.close_document(path)).await;
    let _ = client.shutdown().await;

    match outcome {
        Ok(Ok(params)) => Ok(params),
        Ok(Err(error)) => Err(error).context("live LSP session failed"),
        Err(_) => bail!("timed out after {timeout_ms} ms waiting for language server diagnostics"),
    }
}

fn normalize_diagnostics(params: &PublishDiagnosticsParams) -> Result<Vec<Diagnostic>> {
    let value = serde_json::to_value(params).context("serialize publishDiagnostics parameters")?;
    let diagnostics = parse_publish_diagnostics(&value)?;
    Ok(merge_lsp_diagnostics(&[], &diagnostics))
}

fn success_payload(
    file_path: &str,
    language: LanguageId,
    server: &ServerSpec,
    diagnostics: &[Diagnostic],
    raw: Option<Value>,
) -> Value {
    let mut payload = json!({
        "available": true,
        "server": {
            "program": &server.program,
            "args": &server.args,
        },
        "languageId": language.as_str(),
        "filePath": file_path,
        "diagnostics": diagnostics,
    });
    if let Some(raw) = raw {
        payload["raw"] = raw;
    }
    payload
}

fn unavailable_payload(file_path: &str, language: LanguageId, reason: String) -> Value {
    json!({
        "available": false,
        "server": Value::Null,
        "languageId": language.as_str(),
        "filePath": file_path,
        "diagnostics": [],
        "reason": reason,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn test_services(root: &Path) -> ToolServices {
        let workspace = root.join("workspace");
        let projects = root.join("projects");
        std::fs::create_dir_all(&workspace).unwrap();
        let store = Arc::new(worldbase_memory::Store::open(&root.join("store.sqlite")).unwrap());
        ToolServices {
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
        }
    }

    fn project_with_file(root: &Path, relative: &str, contents: &str) {
        let project = root.join("projects").join("alpha");
        let file = project.join(relative);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, contents).unwrap();
    }

    #[test]
    fn maps_extensions_to_language_ids() {
        for (file, expected) in [
            ("src/main.ts", LanguageId::TypeScript),
            ("src/types.mts", LanguageId::TypeScript),
            ("src/legacy.cts", LanguageId::TypeScript),
            ("src/App.tsx", LanguageId::TypeScriptReact),
            ("src/index.js", LanguageId::JavaScript),
            ("src/index.jsx", LanguageId::JavaScript),
            ("src/index.mjs", LanguageId::JavaScript),
            ("src/index.cjs", LanguageId::JavaScript),
            ("script.py", LanguageId::Python),
            ("types.pyi", LanguageId::Python),
            ("main.go", LanguageId::Go),
            ("lib.rs", LanguageId::Rust),
            ("Main.java", LanguageId::Java),
        ] {
            assert_eq!(
                LanguageId::from_path(Path::new(file)),
                Some(expected),
                "{file}"
            );
        }
        assert_eq!(LanguageId::from_path(Path::new("README.md")), None);
        assert_eq!(LanguageId::from_path(Path::new("no_extension")), None);
        assert_eq!(
            LanguageId::from_extension(".TS"),
            Some(LanguageId::TypeScript)
        );
        assert_eq!(
            LanguageId::parse("TypeScriptReact"),
            Some(LanguageId::TypeScriptReact)
        );
        assert_eq!(LanguageId::parse("cobol"), None);
    }

    #[test]
    fn explicit_language_overrides_the_extension() {
        let input = json!({ "language_id": "python" });
        assert_eq!(
            parse_language(&input, Path::new("src/main.ts")).unwrap(),
            LanguageId::Python
        );

        let inferred = json!({});
        assert_eq!(
            parse_language(&inferred, Path::new("src/main.ts")).unwrap(),
            LanguageId::TypeScript
        );
        assert!(parse_language(&inferred, Path::new("README.md")).is_err());
        assert!(parse_language(&json!({ "language_id": "cobol" }), Path::new("a.ts")).is_err());
    }

    #[test]
    fn server_resolution_override_wins() {
        let resolution = resolve_server(
            LanguageId::TypeScript,
            Some("custom-lsp"),
            Some(vec!["--custom".to_string()]),
            |_| true,
        );
        assert_eq!(
            resolution,
            ServerResolution::Found(ServerSpec::new("custom-lsp", &["--custom"]))
        );
    }

    #[test]
    fn server_resolution_uses_default_args_without_override() {
        let resolution = resolve_server(LanguageId::TypeScript, None, None, |program| {
            program == "typescript-language-server"
        });
        assert_eq!(
            resolution,
            ServerResolution::Found(ServerSpec::new("typescript-language-server", &["--stdio"]))
        );
    }

    #[test]
    fn python_prefers_pyright_then_pylsp() {
        assert_eq!(
            resolve_server(LanguageId::Python, None, None, |program| {
                program == "pyright-langserver" || program == "pylsp"
            }),
            ServerResolution::Found(ServerSpec::new("pyright-langserver", &["--stdio"]))
        );
        assert_eq!(
            resolve_server(LanguageId::Python, None, None, |program| program == "pylsp"),
            ServerResolution::Found(ServerSpec::new("pylsp", &[]))
        );
    }

    #[test]
    fn missing_server_returns_available_false() {
        let resolution = resolve_server(LanguageId::Rust, None, None, |_| false);
        let ServerResolution::Missing { reason } = resolution else {
            panic!("expected missing server");
        };
        assert!(reason.contains("rust-analyzer"));

        let payload = unavailable_payload("src/lib.rs", LanguageId::Rust, reason);
        assert_eq!(payload["available"], false);
        assert_eq!(payload["server"], Value::Null);
        assert_eq!(payload["languageId"], "rust");
        assert_eq!(payload["filePath"], "src/lib.rs");
        assert_eq!(payload["diagnostics"], json!([]));
        assert!(payload["reason"]
            .as_str()
            .unwrap()
            .contains("rust-analyzer"));
    }

    #[test]
    fn missing_override_does_not_fall_back_to_detection() {
        let resolution = resolve_server(
            LanguageId::TypeScript,
            Some("custom-lsp"),
            None,
            |program| program == "typescript-language-server",
        );
        assert!(matches!(resolution, ServerResolution::Missing { .. }));
    }

    #[test]
    fn project_path_escape_is_rejected() {
        for path in [
            "",
            "../secret.ts",
            "../../etc/passwd",
            "/etc/passwd",
            "src/../../secret.ts",
            "..",
        ] {
            assert!(
                validate_project_relative(path).is_err(),
                "expected rejection: {path:?}"
            );
        }
        assert!(validate_project_relative("src/main.ts").is_ok());
        assert!(validate_project_relative("./src/main.ts").is_ok());
    }

    #[test]
    fn output_shape_normalizes_diagnostics_and_includes_raw_on_request() {
        let params: PublishDiagnosticsParams = serde_json::from_value(json!({
            "uri": "file:///project/src/main.ts",
            "version": 3,
            "diagnostics": [{
                "range": {
                    "start": { "line": 0, "character": 1 },
                    "end": { "line": 0, "character": 4 }
                },
                "severity": 1,
                "code": "TS1005",
                "source": "ts",
                "message": "';' expected."
            }]
        }))
        .unwrap();
        let diagnostics = normalize_diagnostics(&params).unwrap();
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].line, Some(1));
        assert_eq!(diagnostics[0].column, Some(2));

        let server = ServerSpec::new("typescript-language-server", &["--stdio"]);
        let payload = success_payload(
            "src/main.ts",
            LanguageId::TypeScript,
            &server,
            &diagnostics,
            None,
        );
        assert_eq!(payload["available"], true);
        assert_eq!(payload["server"]["program"], "typescript-language-server");
        assert_eq!(payload["server"]["args"], json!(["--stdio"]));
        assert_eq!(payload["languageId"], "typescript");
        assert_eq!(payload["filePath"], "src/main.ts");
        assert_eq!(payload["diagnostics"][0]["severity"], "error");
        assert_eq!(payload["diagnostics"][0]["code"], "TS1005");
        assert!(payload.get("raw").is_none());

        let raw = serde_json::to_value(&params).unwrap();
        let payload = success_payload(
            "src/main.ts",
            LanguageId::TypeScript,
            &server,
            &diagnostics,
            Some(raw),
        );
        assert_eq!(payload["raw"]["version"], 3);
        assert_eq!(payload["raw"]["diagnostics"][0]["code"], "TS1005");
    }

    #[test]
    fn timeout_defaults_and_caps() {
        assert_eq!(normalize_timeout_ms(&json!({})), DEFAULT_TIMEOUT_MS);
        assert_eq!(normalize_timeout_ms(&json!({ "timeout_ms": 1000 })), 1000);
        assert_eq!(
            normalize_timeout_ms(&json!({ "timeout_ms": MAX_TIMEOUT_MS + 1 })),
            MAX_TIMEOUT_MS
        );
        assert_eq!(normalize_timeout_ms(&json!({ "timeout_ms": 0 })), 1);
    }

    #[tokio::test]
    async fn tool_rejects_project_path_escape_before_starting_a_server() {
        let temp = tempfile::tempdir().unwrap();
        project_with_file(temp.path(), "src/main.rs", "fn main() {}");
        let services = test_services(temp.path());

        let error = CodingLspTool
            .execute(
                json!({
                    "project_id": "alpha",
                    "file_path": "../outside.rs"
                }),
                &services,
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("inside the project"));
    }

    #[tokio::test]
    async fn tool_reports_unavailable_when_the_override_server_is_missing() {
        let temp = tempfile::tempdir().unwrap();
        project_with_file(temp.path(), "src/main.rs", "fn main() {}");
        let services = test_services(temp.path());

        let result = CodingLspTool
            .execute(
                json!({
                    "project_id": "alpha",
                    "file_path": "src/main.rs",
                    "server_program": "definitely-missing-worldbase-lsp-server"
                }),
                &services,
            )
            .await
            .unwrap();
        assert_eq!(result["available"], false);
        assert_eq!(result["languageId"], "rust");
        assert_eq!(result["filePath"], "src/main.rs");
        assert_eq!(result["diagnostics"], json!([]));
        assert!(result["reason"]
            .as_str()
            .unwrap()
            .contains("not found or is not executable"));
    }
}
