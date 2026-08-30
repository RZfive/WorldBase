//! 全栈项目运行时：Node/pnpm 探测、项目创建、依赖安装、dev server 生命周期。
//!
//! bundled Node 产物存在时优先使用（`dist/node-bin`），否则回退系统 Node；
//! 仅桌面/server 构建链接本 crate。

mod control;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, VecDeque},
    env,
    ffi::OsString,
    fs,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::net::TcpStream;
use worldbase_protocol::types::{DevServerInfo, ProjectInfo};

const MAX_LOG_ENTRIES: usize = 500;
const MAX_LOG_ENTRY_BYTES: usize = 16 * 1024;
const MAX_LOG_BUFFER_BYTES: usize = 1024 * 1024;
const LAN_SERVER_PORT: u16 = 19527;
const START_READY_TIMEOUT: Duration = Duration::from_secs(15);

pub struct ProjectRuntime {
    projects_dir: PathBuf,
    servers: tokio::sync::Mutex<HashMap<String, DevServerHandle>>,
    restart_policies: Mutex<HashMap<String, String>>,
    restart_counts: Mutex<HashMap<String, u32>>,
    /// Serialize the periodic gateway recovery pass. A slow HTTP health probe
    /// must not overlap the next scheduled pass and restart the same project
    /// twice.
    gateway_health_check: tokio::sync::Mutex<()>,
}

struct DevServerHandle {
    info: DevServerInfo,
    child: tokio::process::Child,
    logs: SharedLogBuffer,
    started_at: String,
    exit_code: Option<i32>,
    error: Option<String>,
    stop_requested: bool,
}

enum RuntimeCommand {
    NextDev { next_bin: PathBuf },
    Shell { command: String },
}

struct RuntimeLaunch {
    command: RuntimeCommand,
    cwd: PathBuf,
    port: u16,
    node_env: &'static str,
}

impl DevServerHandle {
    fn refresh_lifecycle(&mut self) {
        match self.child.try_wait() {
            Ok(Some(exit_status)) => self.record_exit(exit_status),
            Ok(None) => {}
            Err(error) => {
                self.info.status = "error".into();
                self.error = Some(format!("unable to inspect project process: {error}"));
            }
        }
    }

    fn record_exit(&mut self, exit_status: std::process::ExitStatus) {
        self.exit_code = exit_status.code();
        self.info.status = if self.stop_requested || exit_status.success() {
            "stopped"
        } else {
            "crashed"
        }
        .into();
    }

    fn is_active(&self) -> bool {
        matches!(
            self.info.status.as_str(),
            "starting" | "running" | "stopping"
        )
    }
}

/// A runtime process log entry. Its JSON form deliberately matches Electron's
/// `{ type, text, time }` log contract.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectRuntimeLogEntry {
    #[serde(rename = "type")]
    pub kind: String,
    pub text: String,
    pub time: u64,
}

type SharedLogBuffer = Arc<Mutex<RuntimeLogBuffer>>;

#[derive(Default)]
struct RuntimeLogBuffer {
    entries: VecDeque<ProjectRuntimeLogEntry>,
    total_bytes: usize,
}

impl RuntimeLogBuffer {
    fn append(&mut self, kind: &str, text: String) {
        if text.is_empty() {
            return;
        }
        let text = retain_log_tail(&text, MAX_LOG_ENTRY_BYTES);
        let entry_bytes = text.len();
        self.entries.push_back(ProjectRuntimeLogEntry {
            kind: kind.into(),
            text,
            time: unix_time_millis(),
        });
        self.total_bytes += entry_bytes;
        while self.entries.len() > MAX_LOG_ENTRIES || self.total_bytes > MAX_LOG_BUFFER_BYTES {
            let Some(removed) = self.entries.pop_front() else {
                break;
            };
            self.total_bytes = self.total_bytes.saturating_sub(removed.text.len());
        }
    }

    fn recent(&self, max_entries: usize) -> Vec<ProjectRuntimeLogEntry> {
        let skip = self.entries.len().saturating_sub(max_entries);
        self.entries.iter().skip(skip).cloned().collect()
    }
}

fn retain_log_tail(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.into();
    }

    const TRUNCATED_PREFIX: &str = "...[truncated]\n";
    let retained_bytes = max_bytes.saturating_sub(TRUNCATED_PREFIX.len());
    let mut start = text.len().saturating_sub(retained_bytes);
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    format!("{TRUNCATED_PREFIX}{}", &text[start..])
}

fn unix_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

async fn capture_process_output<R>(mut stream: R, kind: &'static str, logs: SharedLogBuffer)
where
    R: AsyncRead + Unpin,
{
    let mut buffer = [0u8; 4096];
    loop {
        match stream.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => {
                let text = String::from_utf8_lossy(&buffer[..read]).into_owned();
                logs.lock()
                    .expect("runtime log lock poisoned")
                    .append(kind, text.clone());
                tracing::debug!(target: "project_runtime", stream = kind, "{}", text.trim());
            }
            Err(error) => {
                tracing::debug!(target: "project_runtime", stream = kind, "process log stream ended: {error}");
                break;
            }
        }
    }
}

/// Match Electron's ProcessMonitor contract: startup succeeds only after the
/// allocated TCP port accepts connections. A short connect timeout keeps a
/// crashed process from blocking the harness for the full startup window.
async fn wait_for_port_or_exit(
    child: &mut tokio::process::Child,
    port: u16,
    timeout: Duration,
) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if child.try_wait().ok().flatten().is_some() {
            return false;
        }
        if tokio::time::timeout(Duration::from_secs(1), TcpStream::connect(("127.0.0.1", port)))
            .await
            .is_ok_and(|result| result.is_ok())
        {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn which(prog: &str) -> Option<PathBuf> {
    // 简易 PATH 探测（避免依赖 which crate）
    let path = std::env::var("PATH").ok()?;
    for dir in path.split(':') {
        let p = Path::new(dir).join(prog);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn command_env_path() -> OsString {
    env::var_os("PATH").unwrap_or_default()
}

fn shell_quote(value: &str) -> String {
    if cfg!(windows) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        format!("'{}'", value.replace('\'', "'\"'\"'"))
    }
}

fn runtime_wrapper_dir(node: &Path) -> Result<Option<PathBuf>> {
    let force_node_wrapper = env::var("WORLDBASE_RUNTIME_NODE_IS_ELECTRON")
        .map(|value| value == "1")
        .unwrap_or(false);
    let pnpm_cli = env::var_os("WORLDBASE_RUNTIME_PNPM")
        .map(PathBuf::from)
        .filter(|path| path.is_file());
    if !force_node_wrapper && pnpm_cli.is_none() {
        return Ok(None);
    }

    let dir = env::temp_dir().join(format!("worldbase-runtime-{}", std::process::id()));
    fs::create_dir_all(&dir)
        .with_context(|| format!("create runtime wrapper dir {}", dir.display()))?;

    #[cfg(windows)]
    {
        let node_script = dir.join("node.cmd");
        let node_prefix = if force_node_wrapper {
            "set ELECTRON_RUN_AS_NODE=1\r\n"
        } else {
            ""
        };
        fs::write(
            &node_script,
            format!("@echo off\r\n{node_prefix}\"{}\" %*\r\n", node.display()),
        )?;
        if let Some(pnpm_cli) = pnpm_cli {
            let body = format!(
                "@echo off\r\n{node_prefix}\"{}\" \"{}\" %*\r\n",
                node.display(),
                pnpm_cli.display()
            );
            for name in ["pnpm.cmd", "npm.cmd", "npx.cmd"] {
                fs::write(dir.join(name), &body)?;
            }
        }
    }

    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;

        let node_script = dir.join("node");
        let node_prefix = if force_node_wrapper {
            "exec env ELECTRON_RUN_AS_NODE=1"
        } else {
            "exec"
        };
        fs::write(
            &node_script,
            format!(
                "#!/bin/sh\n{node_prefix} {} \"$@\"\n",
                shell_quote(&node.display().to_string())
            ),
        )?;
        fs::set_permissions(&node_script, fs::Permissions::from_mode(0o755))?;
        if let Some(pnpm_cli) = pnpm_cli {
            let body = format!(
                "#!/bin/sh\n{node_prefix} {} {} \"$@\"\n",
                shell_quote(&node.display().to_string()),
                shell_quote(&pnpm_cli.display().to_string())
            );
            for name in ["pnpm", "npm", "npx"] {
                let script = dir.join(name);
                fs::write(&script, &body)?;
                fs::set_permissions(script, fs::Permissions::from_mode(0o755))?;
            }
        }
    }

    Ok(Some(dir))
}

fn with_runtime_environment(
    command: &mut tokio::process::Command,
    node: &Path,
    project_id: &str,
    project_root: &Path,
    cwd: &Path,
    port: u16,
    node_env: &str,
) -> Result<()> {
    let mut path_entries = Vec::new();
    if let Some(wrapper_dir) = runtime_wrapper_dir(node)? {
        path_entries.push(wrapper_dir.into_os_string());
    }
    path_entries.push(cwd.join("node_modules/.bin").into_os_string());
    if cwd != project_root {
        path_entries.push(project_root.join("node_modules/.bin").into_os_string());
    }
    path_entries.extend(env::split_paths(&command_env_path()).map(|path| path.into_os_string()));
    let path = env::join_paths(path_entries).unwrap_or_default();

    command
        .env("PATH", path)
        .env("PORT", port.to_string())
        .env("HOSTNAME", "0.0.0.0")
        .env("NODE_ENV", node_env)
        .env("THE_WORLD_PROJECT_ID", project_id)
        .env("THE_WORLD_PROJECT_ROOT", project_root)
        .env(
            "THE_WORLD_LAN_BASE_URL",
            format!("http://127.0.0.1:{LAN_SERVER_PORT}"),
        )
        .env(
            "THE_WORLD_RESOURCE_PROXY_BASE_URL",
            format!("http://127.0.0.1:{LAN_SERVER_PORT}/api/resource-proxy"),
        )
        .env(
            "THE_WORLD_PROJECT_DATA_BASE_URL",
            format!("http://127.0.0.1:{LAN_SERVER_PORT}/api/projects/{project_id}/data"),
        )
        .env(
            "THE_WORLD_SYSTEM_BASE_URL",
            format!("http://127.0.0.1:{LAN_SERVER_PORT}/api/system"),
        )
        .env(
            "NEXT_PUBLIC_THE_WORLD_LAN_BASE_URL",
            format!("http://127.0.0.1:{LAN_SERVER_PORT}"),
        )
        .env(
            "NEXT_PUBLIC_THE_WORLD_RESOURCE_PROXY_BASE_URL",
            format!("http://127.0.0.1:{LAN_SERVER_PORT}/api/resource-proxy"),
        )
        .env(
            "NEXT_PUBLIC_THE_WORLD_PROJECT_DATA_BASE_URL",
            format!("http://127.0.0.1:{LAN_SERVER_PORT}/api/projects/{project_id}/data"),
        )
        .env(
            "NEXT_PUBLIC_THE_WORLD_SYSTEM_BASE_URL",
            format!("http://127.0.0.1:{LAN_SERVER_PORT}/api/system"),
        );
    Ok(())
}

fn extract_runtime_backend(meta: &Value) -> Option<&serde_json::Map<String, Value>> {
    meta.get("runtime")?
        .as_object()?
        .get("backend")?
        .as_object()
}

fn configured_port(backend: Option<&serde_json::Map<String, Value>>) -> Option<u16> {
    backend
        .and_then(|backend| backend.get("port"))
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port > 0)
}

fn command_looks_like_development(command: &str) -> bool {
    command.contains(" run dev") || command.contains("next dev") || command.contains("--watch")
}

fn command_needs_node_modules(command: &str) -> bool {
    command.starts_with("npm ")
        || command.starts_with("pnpm ")
        || command.starts_with("yarn ")
        || command.contains("next ")
        || command.starts_with("npx ")
}

fn package_dependencies(package: &Value) -> HashMap<String, String> {
    let mut dependencies = HashMap::new();
    for key in ["dependencies", "devDependencies"] {
        let Some(entries) = package.get(key).and_then(Value::as_object) else {
            continue;
        };
        for (name, version) in entries {
            if let Some(version) = version.as_str() {
                dependencies.insert(name.clone(), version.to_string());
            }
        }
    }
    dependencies
}

/// Infer the initial runtime command when a created project's metadata does
/// not provide one. Electron uses the same order: package start/dev scripts,
/// then common Node entry points, then the conventional server entry point.
fn default_runtime_command_for_files(files: &Map<String, Value>) -> String {
    let scripts = files
        .get("package.json")
        .and_then(Value::as_str)
        .and_then(|content| serde_json::from_str::<Value>(content).ok())
        .and_then(|package| package.get("scripts").cloned())
        .and_then(|scripts| scripts.as_object().cloned());
    if let Some(scripts) = scripts {
        if scripts.get("start").and_then(Value::as_str).is_some() {
            return "npm start".into();
        }
        if scripts.get("dev").and_then(Value::as_str).is_some() {
            return "npm run dev".into();
        }
    }
    if files.contains_key("src/server.js") && !files.contains_key("server.js") {
        return "node src/server.js".into();
    }
    if files.contains_key("app.js") && !files.contains_key("server.js") {
        return "node app.js".into();
    }
    if files.contains_key("index.js") && !files.contains_key("server.js") {
        return "node index.js".into();
    }
    "node server.js".into()
}

const NEXT_CONFIG_TEMPLATE: &str = r#"/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone'
}

module.exports = nextConfig
"#;

const NEXT_JS_LAYOUT_TEMPLATE: &str = r#"import './globals.css'

export const metadata = {
  title: 'WorldBase App',
  description: 'Generated from WorldBase base template'
}

export default function RootLayout ({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
"#;

const NEXT_TS_LAYOUT_TEMPLATE: &str = r#"import './globals.css'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'

export const metadata: Metadata = {
  title: 'WorldBase App',
  description: 'Generated from WorldBase base template'
}

export default function RootLayout ({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
"#;

const NEXT_JS_PAGE_TEMPLATE: &str = r#"const highlights = [
  {
    title: 'Fast customization',
    description: 'Update this starter page with the requested modules, content, and actions.'
  },
  {
    title: 'Built-in styling',
    description: 'Global tokens and responsive layout are ready so the app does not render unstyled.'
  },
  {
    title: 'Runtime ready',
    description: 'Keep the Next.js App Router structure so build and startup stay compatible with WorldBase.'
  }
]

export default function HomePage () {
  return (
    <main className="page-shell">
      <section className="hero-card">
        <span className="eyebrow">WorldBase starter template</span>
        <h1>Start from a working Next.js baseline</h1>
        <p className="hero-copy">
          Replace this content with the requested product experience while keeping the starter structure intact.
        </p>
      </section>

      <section className="feature-grid">
        {highlights.map(item => (
          <article key={item.title} className="feature-card">
            <h2>{item.title}</h2>
            <p>{item.description}</p>
          </article>
        ))}
      </section>
    </main>
  )
}
"#;

// Keep the Rust-generated starter usable without requiring a separate CSS
// asset. This mirrors Electron's reset/tokens/responsive baseline while
// intentionally staying small enough to keep tool responses deterministic.
const NEXT_GLOBALS_CSS_TEMPLATE: &str = r#":root {
  color-scheme: light;
  --background: #f4f7fb;
  --surface: #ffffff;
  --text: #172033;
  --muted: #5f6b85;
  --border: rgba(15, 23, 42, 0.08);
  --accent: #2563eb;
}

* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body {
  min-height: 100vh;
  font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: var(--background);
  color: var(--text);
}
a { color: inherit; text-decoration: none; }
button, input, select, textarea { font: inherit; }
.page-shell { width: min(1100px, calc(100vw - 48px)); margin: 0 auto; padding: 48px 0 72px; }
.hero-card, .feature-card { border: 1px solid var(--border); background: var(--surface); box-shadow: 0 16px 40px rgba(15, 23, 42, 0.08); }
.hero-card { padding: 32px; border-radius: 8px; }
.eyebrow { color: var(--accent); font-size: .875rem; font-weight: 700; }
.hero-card h1 { margin: 18px 0 12px; font-size: clamp(2rem, 4vw, 3.5rem); line-height: 1.05; }
.hero-copy { margin: 0; max-width: 720px; color: var(--muted); line-height: 1.7; }
.feature-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; margin-top: 24px; }
.feature-card { padding: 24px; border-radius: 8px; }
.feature-card h2 { margin: 0 0 12px; font-size: 1.05rem; }
.feature-card p { margin: 0; color: var(--muted); line-height: 1.65; }
@media (max-width: 900px) { .page-shell { width: min(100vw - 32px, 1100px); padding-top: 32px; } .feature-grid { grid-template-columns: 1fr; } }
"#;

fn is_next_config_path(path: &str) -> bool {
    matches!(
        path,
        "next.config.js" | "next.config.mjs" | "next.config.ts" | "next.config.cjs"
    )
}

fn detect_next_project_files(files: &Map<String, Value>, meta: &Map<String, Value>) -> bool {
    if meta
        .get("framework")
        .and_then(Value::as_str)
        .is_some_and(|framework| framework.eq_ignore_ascii_case("nextjs"))
        || files.keys().any(|path| is_next_config_path(path))
    {
        return true;
    }
    files
        .get("package.json")
        .and_then(Value::as_str)
        .and_then(|content| serde_json::from_str::<Value>(content).ok())
        .map(|package| package_dependencies(&package).contains_key("next"))
        .unwrap_or(false)
}

fn has_typescript_sources(files: &Map<String, Value>) -> bool {
    files.keys().any(|path| path.ends_with(".ts") || path.ends_with(".tsx"))
}

fn app_root_for_files(files: &Map<String, Value>) -> &'static str {
    if files.keys().any(|path| path.starts_with("src/app/")) {
        "src/app"
    } else {
        "app"
    }
}

fn root_app_file(files: &Map<String, Value>, app_root: &str, base: &str) -> Option<String> {
    ["js", "jsx", "ts", "tsx"].iter().find_map(|extension| {
        let path = format!("{app_root}/{base}.{extension}");
        files.contains_key(&path).then_some(path)
    })
}

fn add_globals_import(source: &str) -> String {
    if source.contains("'./globals.css'") || source.contains("\"./globals.css\"") {
        return source.to_string();
    }
    let trimmed = source.trim_start();
    for quote in ['\'', '"'] {
        let directive = format!("{quote}use client{quote}");
        if let Some(rest) = trimmed.strip_prefix(&directive) {
            let (prefix, rest) = if let Some(rest) = rest.strip_prefix(';') {
                (format!("{directive};"), rest)
            } else {
                (directive, rest)
            };
            return format!("{prefix}\nimport './globals.css'\n\n{}", rest.trim_start());
        }
    }
    format!("import './globals.css'\n\n{trimmed}")
}

/// Apply Electron's Next.js starter invariants to a file map before it is
/// persisted. Invalid package JSON is deliberately left untouched so the
/// later install/build stage can report the same validation failure as TS.
fn apply_next_starter_template(
    files: &Map<String, Value>,
    meta: &Map<String, Value>,
    force_default: bool,
) -> (Map<String, Value>, bool) {
    let mut next_files = files.clone();
    let is_next = force_default || detect_next_project_files(files, meta);
    if !is_next {
        return (next_files, false);
    }

    let uses_typescript = has_typescript_sources(&next_files);
    let app_root = app_root_for_files(&next_files);
    let layout_path = format!("{app_root}/layout.{}", if uses_typescript { "tsx" } else { "js" });
    let page_path = format!("{app_root}/page.{}", if uses_typescript { "tsx" } else { "js" });
    let globals_path = format!("{app_root}/globals.css");

    let parsed_package = next_files
        .get("package.json")
        .and_then(Value::as_str)
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .and_then(|value| value.as_object().cloned());
    let mut package = parsed_package.clone().unwrap_or_default();
    if parsed_package.is_none() && !next_files.contains_key("package.json") {
        package.insert("name".into(), Value::String("worldbase-generated-app".into()));
    }
    if parsed_package.is_some() || !next_files.contains_key("package.json") {
        package.entry("private").or_insert(Value::Bool(true));
        let mut scripts = package
            .remove("scripts")
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        scripts
            .entry("dev")
            .or_insert_with(|| Value::String("next dev".into()));
        scripts.insert("build".into(), Value::String("next build".into()));
        scripts.insert("start".into(), Value::String("next start".into()));
        package.insert("scripts".into(), Value::Object(scripts));

        let mut dependencies = package
            .remove("dependencies")
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        let mut dev_dependencies = package
            .remove("devDependencies")
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        // Electron's compatibility profile selects Next 15/React 19 on all
        // currently supported desktop Node runtimes. Keep the same ranges in
        // Rust so a switch does not produce a different lockfile graph.
        dependencies.insert("next".into(), Value::String("^15.0.0".into()));
        dependencies.insert("react".into(), Value::String("^19.0.0".into()));
        dependencies.insert("react-dom".into(), Value::String("^19.0.0".into()));
        for name in ["next", "react", "react-dom"] {
            dev_dependencies.remove(name);
        }
        if uses_typescript {
            dev_dependencies
                .entry("typescript")
                .or_insert_with(|| Value::String("^5.0.0".into()));
            dev_dependencies
                .entry("@types/node")
                .or_insert_with(|| Value::String("^20.0.0".into()));
            dev_dependencies
                .entry("@types/react")
                .or_insert_with(|| Value::String("^19.0.0".into()));
        }
        package.insert("dependencies".into(), Value::Object(dependencies));
        if dev_dependencies.is_empty() {
            package.remove("devDependencies");
        } else {
            package.insert("devDependencies".into(), Value::Object(dev_dependencies));
        }
        if let Ok(text) = serde_json::to_string_pretty(&Value::Object(package)) {
            next_files.insert("package.json".into(), Value::String(format!("{text}\n")));
        }
    } else if !next_files.contains_key("package.json") {
        // A detected Next project with no package file receives Electron's
        // generated package baseline.
        let package = json!({
            "name": "worldbase-generated-app",
            "private": true,
            "scripts": { "dev": "next dev", "build": "next build", "start": "next start" },
            "dependencies": { "next": "^15.0.0", "react": "^19.0.0", "react-dom": "^19.0.0" },
            "devDependencies": if uses_typescript { json!({ "typescript": "^5.0.0", "@types/node": "^20.0.0", "@types/react": "^19.0.0" }) } else { json!({}) }
        });
        next_files.insert("package.json".into(), Value::String(format!("{}\n", serde_json::to_string_pretty(&package).unwrap_or_default())));
    }

    if let Some(existing) = root_app_file(&next_files, app_root, "layout") {
        if let Some(source) = next_files.get(&existing).and_then(Value::as_str) {
            next_files.insert(existing, Value::String(add_globals_import(source)));
        }
    } else {
        next_files.insert(
            layout_path,
            Value::String(if uses_typescript { NEXT_TS_LAYOUT_TEMPLATE } else { NEXT_JS_LAYOUT_TEMPLATE }.into()),
        );
    }
    if root_app_file(&next_files, app_root, "page").is_none() {
        next_files.insert(
            page_path,
            Value::String(NEXT_JS_PAGE_TEMPLATE.into()),
        );
    }
    next_files
        .entry(globals_path)
        .or_insert_with(|| Value::String(NEXT_GLOBALS_CSS_TEMPLATE.into()));
    if !next_files.keys().any(|path| is_next_config_path(path)) {
        next_files.insert("next.config.js".into(), Value::String(NEXT_CONFIG_TEMPLATE.into()));
    }
    (next_files, true)
}

fn replace_configured_port(
    command: &str,
    configured_port: Option<u16>,
    allocated_port: u16,
) -> String {
    let Some(configured_port) = configured_port else {
        return command.to_string();
    };
    if configured_port == allocated_port {
        return command.to_string();
    }
    let configured = configured_port.to_string();
    command
        .replace(&format!("--port={configured}"), "--port=$PORT")
        .replace(&format!("--port {configured}"), "--port $PORT")
        .replace(&format!("-p {configured}"), "-p $PORT")
        .replace(&format!("-p{configured}"), "-p$PORT")
}

impl ProjectRuntime {
    pub fn new(projects_dir: PathBuf) -> Self {
        Self {
            projects_dir,
            servers: tokio::sync::Mutex::new(Default::default()),
            restart_policies: Mutex::new(Default::default()),
            restart_counts: Mutex::new(Default::default()),
            gateway_health_check: tokio::sync::Mutex::new(()),
        }
    }

    pub fn runtime_tools(&self) -> Result<Value> {
        let node = bundled_node()
            .or_else(|| which("node"))
            .map(|p| p.display().to_string());
        let pnpm = which("pnpm").map(|p| p.display().to_string());
        Ok(json!({
            "node": node,
            "pnpm": pnpm,
            "projects_dir": self.projects_dir.display().to_string(),
        }))
    }

    /// Resolve a managed project directory without allowing callers to escape
    /// the projects root. Electron identifies projects by a single directory
    /// name, so accepting paths here would make every project-facing tool
    /// address the wrong filesystem boundary.
    pub fn project_root(&self, project_id: &str) -> Result<PathBuf> {
        let project_id = normalize_project_id(project_id)?;
        std::fs::create_dir_all(&self.projects_dir)
            .with_context(|| format!("create projects dir {}", self.projects_dir.display()))?;
        let projects_root = self
            .projects_dir
            .canonicalize()
            .with_context(|| format!("resolve projects dir {}", self.projects_dir.display()))?;
        let project = projects_root.join(project_id);
        let project = project
            .canonicalize()
            .with_context(|| format!("project not found: {project_id}"))?;
        anyhow::ensure!(project.is_dir(), "project is not a directory: {project_id}");
        anyhow::ensure!(
            project.starts_with(&projects_root),
            "project path escapes projects directory"
        );
        Ok(project)
    }

    /// Resolve a relative path inside a managed project. Parent traversal and
    /// symlink escapes are rejected before a filesystem operation is started.
    ///
    /// This intentionally permits a not-yet-created project root. Electron's
    /// ProjectFS allows `write_project_file` to create the first file in a
    /// managed project directory, and the caller creates the missing parents
    /// after this function has established the containment boundary.
    pub fn project_path(&self, project_id: &str, relative_path: &str) -> Result<PathBuf> {
        let project_id = normalize_project_id(project_id)?;
        std::fs::create_dir_all(&self.projects_dir)
            .with_context(|| format!("create projects dir {}", self.projects_dir.display()))?;
        let projects_root = self
            .projects_dir
            .canonicalize()
            .with_context(|| format!("resolve projects dir {}", self.projects_dir.display()))?;
        let project_root = projects_root.join(project_id);
        let relative = Path::new(relative_path);
        anyhow::ensure!(
            !relative.is_absolute()
                && !relative.components().any(|component| {
                    matches!(
                        component,
                        Component::ParentDir | Component::RootDir | Component::Prefix(_)
                    )
                }),
            "project file path escapes project"
        );

        let candidate = project_root.join(relative);
        let mut existing = candidate.clone();
        let mut missing = Vec::new();
        while !existing.exists() {
            let Some(name) = existing.file_name().map(|name| name.to_os_string()) else {
                anyhow::bail!("invalid project file path")
            };
            missing.push(name);
            let Some(parent) = existing.parent() else {
                anyhow::bail!("invalid project file path")
            };
            existing = parent.to_path_buf();
        }

        let mut resolved = existing.canonicalize()?;
        for component in missing.iter().rev() {
            resolved.push(component);
        }
        anyhow::ensure!(
            resolved.starts_with(&project_root),
            "project file path escapes project"
        );
        Ok(resolved)
    }

    /// 创建全栈项目骨架（Next.js App Router 结构，最小可运行）。
    pub async fn create_project(&self, name: &str) -> Result<ProjectInfo> {
        self.create_project_with_files(name, "fullstack", &Map::new(), Value::Null)
            .await
    }

    /// Create a managed project using the same on-disk contract consumed by
    /// Electron's ProjectFS.  The Rust harness owns the bytes and metadata;
    /// Electron can immediately list, edit, package and launch the result.
    pub async fn create_project_with_files(
        &self,
        name: &str,
        project_type: &str,
        files: &Map<String, Value>,
        meta: Value,
    ) -> Result<ProjectInfo> {
        self.create_project_with_files_and_template(name, project_type, files, meta, true)
            .await
    }

    /// Create a project at an explicit Electron-compatible directory ID. The
    /// agent-facing `create_project` tool generates this ID before calling the
    /// runtime; keeping the ID explicit prevents the runtime from silently
    /// changing it during a TS/Rust harness handoff.
    pub async fn create_project_with_id_and_files_and_template(
        &self,
        project_id: &str,
        name: &str,
        project_type: &str,
        files: &Map<String, Value>,
        meta: Value,
        default_template: bool,
    ) -> Result<ProjectInfo> {
        self.create_project_internal(
            Some(project_id),
            name,
            project_type,
            files,
            meta,
            default_template,
        )
        .await
    }

    /// Create a project with caller-provided files without implicitly adding
    /// the legacy Next.js skeleton.  Electron's `create_project` tool uses
    /// this mode for development workflows where `files` may be omitted.
    /// The explicit `default_template` switch keeps the public legacy API
    /// compatible with `create_project`, while allowing the tool contract to
    /// distinguish an empty project from a requested starter project.
    pub async fn create_project_with_files_and_template(
        &self,
        name: &str,
        project_type: &str,
        files: &Map<String, Value>,
        meta: Value,
        default_template: bool,
    ) -> Result<ProjectInfo> {
        self.create_project_internal(
            None,
            name,
            project_type,
            files,
            meta,
            default_template,
        )
        .await
    }

    async fn create_project_internal(
        &self,
        explicit_project_id: Option<&str>,
        name: &str,
        project_type: &str,
        files: &Map<String, Value>,
        meta: Value,
        default_template: bool,
    ) -> Result<ProjectInfo> {
        let safe_name: String = name
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '-'
                }
            })
            .collect();
        let safe_name = safe_name.trim_matches('-').to_string();
        let safe = explicit_project_id
            .map(str::trim)
            .filter(|project_id| !project_id.is_empty())
            .unwrap_or(&safe_name);
        anyhow::ensure!(
            !safe.is_empty(),
            "project name must contain a usable path character"
        );
        normalize_project_id(safe)?;
        let dir = self.projects_dir.join(&safe);
        anyhow::ensure!(!dir.exists(), "project already exists: {safe}");
        tokio::fs::create_dir_all(&dir).await?;

        let mut full_meta = meta.as_object().cloned().unwrap_or_default();
        let (prepared_files, files_are_next) = apply_next_starter_template(
            files,
            &full_meta,
            default_template && files.is_empty(),
        );
        for (relative_path, content) in &prepared_files {
            let content = content.as_str().ok_or_else(|| {
                anyhow::anyhow!("project file {relative_path:?} must be a string")
            })?;
            let target = self.project_path(safe, relative_path)?;
            let parent = target
                .parent()
                .ok_or_else(|| anyhow::anyhow!("invalid project file path: {relative_path}"))?;
            tokio::fs::create_dir_all(parent).await?;
            tokio::fs::write(target, content).await?;
        }

        full_meta.insert("id".into(), Value::String(safe.to_string()));
        full_meta
            .entry("name")
            .or_insert_with(|| Value::String(name.to_string()));
        full_meta
            .entry("type")
            .or_insert_with(|| Value::String(project_type.to_string()));
        full_meta
            .entry("createdAt")
            .or_insert_with(|| Value::String(worldbase_protocol::event::now_rfc3339()));
        if files_are_next {
            full_meta
                .entry("framework")
                .or_insert_with(|| Value::String("nextjs".into()));
        }
        let runtime = full_meta.entry("runtime").or_insert_with(|| json!({}));
        if !runtime.is_object() {
            *runtime = json!({});
        }
        let runtime = runtime.as_object_mut().expect("object inserted above");
        runtime.entry("backend").or_insert_with(|| {
            if files_are_next {
                json!({ "command": "node .next/standalone/server.js" })
            } else {
                json!({ "command": default_runtime_command_for_files(&prepared_files) })
            }
        });
        let workflow = full_meta.entry("workflow").or_insert_with(|| json!({}));
        if !workflow.is_object() {
            *workflow = json!({});
        }
        let workflow = workflow.as_object_mut().expect("object inserted above");
        workflow
            .entry("mode")
            .or_insert_with(|| Value::String("development".into()));
        workflow.entry("incremental").or_insert(Value::Bool(true));
        tokio::fs::write(
            dir.join(".world-meta.json"),
            serde_json::to_string_pretty(&Value::Object(full_meta))?,
        )
        .await?;

        Ok(ProjectInfo {
            id: safe.to_string(),
            name: name.into(),
            path: dir.display().to_string(),
            kind: if files_are_next { "nextjs" } else { "project" }.into(),
            dev_server: None,
        })
    }

    pub fn list_projects(&self) -> Result<Vec<ProjectInfo>> {
        let mut out = Vec::new();
        if !self.projects_dir.is_dir() {
            return Ok(out);
        }
        for entry in std::fs::read_dir(&self.projects_dir)? {
            let entry = entry?;
            let path = entry.path();
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let id = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            if id.is_empty() {
                continue;
            }
            let kind = if path.join("package.json").is_file() {
                "nextjs"
            } else {
                "project"
            };
            out.push(ProjectInfo {
                id: id.clone(),
                name: id,
                path: path.display().to_string(),
                kind: kind.into(),
                dev_server: None,
            });
        }
        out.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(out)
    }

    fn resolve_runtime_launch(
        &self,
        project_id: &str,
        project_path: &Path,
    ) -> Result<RuntimeLaunch> {
        let meta_path = project_path.join(".world-meta.json");
        let meta = fs::read_to_string(&meta_path)
            .ok()
            .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
            .unwrap_or_else(|| json!({}));
        let backend = extract_runtime_backend(&meta);
        let configured_port = configured_port(backend);
        let port = pick_free_port(configured_port)?;

        let standalone_dir = project_path.join(".next/standalone");
        if standalone_dir.join("server.js").is_file() {
            return Ok(RuntimeLaunch {
                command: RuntimeCommand::Shell {
                    command: "node server.js".into(),
                },
                cwd: standalone_dir,
                port,
                node_env: "production",
            });
        }

        let configured_command = backend
            .and_then(|backend| backend.get("command"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|command| !command.is_empty());
        let cwd = backend
            .and_then(|backend| backend.get("cwd"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|cwd| !cwd.is_empty())
            .map(|cwd| self.project_path(project_id, cwd))
            .transpose()?
            .unwrap_or_else(|| project_path.to_path_buf());
        anyhow::ensure!(
            cwd.is_dir(),
            "runtime cwd is not a directory: {}",
            cwd.display()
        );

        if let Some(command) = configured_command {
            let command = replace_configured_port(command, configured_port, port);
            let node_env = if command_looks_like_development(&command) {
                "development"
            } else {
                "production"
            };
            if command_needs_node_modules(&command) && !cwd.join("node_modules").is_dir() {
                anyhow::bail!("node_modules not installed; run install first");
            }
            return Ok(RuntimeLaunch {
                command: RuntimeCommand::Shell { command },
                cwd,
                port,
                node_env,
            });
        }

        let package_json = project_path.join("package.json");
        if package_json.is_file() {
            let package: Value = serde_json::from_str(&fs::read_to_string(&package_json)?)
                .context("parse project package.json")?;
            let next_bin = project_path.join("node_modules/.bin/next");
            let dependencies = package_dependencies(&package);
            if dependencies.contains_key("next") {
                anyhow::ensure!(next_bin.is_file(), "next not installed; run install first");
                return Ok(RuntimeLaunch {
                    command: RuntimeCommand::NextDev { next_bin },
                    cwd: project_path.to_path_buf(),
                    port,
                    node_env: "development",
                });
            }
            let scripts = package
                .get("scripts")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let command = if scripts.contains_key("start") {
                "npm start"
            } else if scripts.contains_key("dev") {
                "npm run dev"
            } else {
                ""
            };
            if !command.is_empty() {
                anyhow::ensure!(
                    project_path.join("node_modules").is_dir(),
                    "node_modules not installed; run install first"
                );
                return Ok(RuntimeLaunch {
                    command: RuntimeCommand::Shell {
                        command: command.into(),
                    },
                    cwd: project_path.to_path_buf(),
                    port,
                    node_env: if command_looks_like_development(command) {
                        "development"
                    } else {
                        "production"
                    },
                });
            }
        }

        for entry in ["server.js", "index.js", "app.js"] {
            if project_path.join(entry).is_file() {
                return Ok(RuntimeLaunch {
                    command: RuntimeCommand::Shell {
                        command: format!("node {entry}"),
                    },
                    cwd: project_path.to_path_buf(),
                    port,
                    node_env: "development",
                });
            }
        }
        if project_path.join("index.html").is_file() {
            return Ok(RuntimeLaunch {
                command: RuntimeCommand::Shell {
                    command: "npx http-server . -p $PORT -c-1 --cors".into(),
                },
                cwd: project_path.to_path_buf(),
                port,
                node_env: "development",
            });
        }

        anyhow::bail!("project has no runnable runtime backend: {project_id}")
    }

    /// Install a managed project's dependencies using the same package-manager
    /// surface exposed to a packaged Electron runtime. The wrapper directory
    /// makes `npm`/`pnpm` resolve to Electron's bundled pnpm when supplied by
    /// the host, while development builds continue to work with system tools.
    pub async fn install(&self, project_path: &Path) -> Result<String> {
        let node = bundled_node()
            .or_else(|| which("node"))
            .context("node runtime not found")?;
        let mut command = if project_path.join("pnpm-lock.yaml").is_file() {
            tokio::process::Command::new("pnpm")
        } else if project_path.join("yarn.lock").is_file() {
            tokio::process::Command::new("yarn")
        } else {
            tokio::process::Command::new("npm")
        };
        command.arg("install").current_dir(project_path);
        with_runtime_environment(
            &mut command,
            &node,
            "install",
            project_path,
            project_path,
            0,
            "development",
        )?;
        let output = command.output().await.context("dependency install spawn")?;
        let log = format!(
            "exit={}\n{}{}",
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
        anyhow::ensure!(output.status.success(), "dependency install failed: {log}");
        Ok(log)
    }

    /// Start a dev server and retain its lifecycle state plus bounded process
    /// output. A stopped/crashed handle remains available for status and log
    /// inspection until the next start for that project replaces it.
    pub async fn start_dev(&self, project_id: &str) -> Result<DevServerInfo> {
        let mut servers = self.servers.lock().await;
        if let Some(handle) = servers.get_mut(project_id) {
            handle.refresh_lifecycle();
            if handle.is_active() {
                return Ok(handle.info.clone());
            }
        }
        // Preserve completed process logs until a deliberate new start, then
        // replace the old handle with the new server lifecycle.
        servers.remove(project_id);

        let project_path = self.project_root(project_id)?;
        let node = bundled_node()
            .or_else(|| which("node"))
            .context("node runtime not found")?;

        // Match Electron RuntimeManager.start: package projects are
        // self-sufficient on first launch, and a Next.js app is promoted to a
        // standalone build before its process is spawned. This also makes a
        // Rust-selected run able to start projects created by the TS harness.
        let package_json = project_path.join("package.json");
        let standalone_server = project_path.join(".next/standalone/server.js");
        let is_next_project = control::is_next_project(&project_path);
        if package_json.is_file() && !standalone_server.is_file() {
            if !project_path.join("node_modules").is_dir() {
                self.install(&project_path)
                    .await
                    .with_context(|| format!("install dependencies for {project_id}"))?;
            }
            if is_next_project {
                control::ensure_next_standalone_config(&project_path)?;
                let build = self.build_project_for_ui(project_id).await?;
                let built = build
                    .get("success")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    && standalone_server.is_file();
                if !built {
                    let output = build
                        .get("output")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let error = build
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("Next.js standalone build failed before start");
                    anyhow::bail!(
                        "Next.js standalone build failed before start: {error}{}",
                        if output.is_empty() {
                            String::new()
                        } else {
                            format!("\n{output}")
                        }
                    );
                }
            }
        }
        let launch = self.resolve_runtime_launch(project_id, &project_path)?;
        let mut command = match &launch.command {
            RuntimeCommand::NextDev { next_bin } => {
                let mut command = tokio::process::Command::new(&node);
                command
                    .arg(next_bin)
                    .arg("dev")
                    .arg("-p")
                    .arg(launch.port.to_string());
                command
            }
            RuntimeCommand::Shell { command } => {
                #[cfg(windows)]
                let command_process = {
                    let mut command_process = tokio::process::Command::new("cmd");
                    command_process.arg("/C").arg(command);
                    command_process
                };
                #[cfg(not(windows))]
                let command_process = {
                    let mut command_process = tokio::process::Command::new("sh");
                    command_process.arg("-c").arg(command);
                    command_process
                };
                command_process
            }
        };
        command
            .current_dir(&launch.cwd)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            // The Electron host owns the app-server lifecycle. Do not leave a
            // Rust-owned project process behind when that server is disposed.
            .kill_on_drop(true);
        with_runtime_environment(
            &mut command,
            &node,
            project_id,
            &project_path,
            &launch.cwd,
            launch.port,
            launch.node_env,
        )?;
        let mut child = command
            .spawn()
            .with_context(|| format!("spawn project runtime for {project_id}"))?;
        let pid = child.id();
        let logs = Arc::new(Mutex::new(RuntimeLogBuffer::default()));
        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(capture_process_output(stdout, "stdout", Arc::clone(&logs)));
        }
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(capture_process_output(stderr, "stderr", Arc::clone(&logs)));
        }

        let info = DevServerInfo {
            port: launch.port,
            url: format!("http://127.0.0.1:{}", launch.port),
            status: "starting".into(),
            pid,
        };
        servers.insert(
            project_id.to_string(),
            DevServerHandle {
                info: info.clone(),
                child,
                logs,
                started_at: worldbase_protocol::event::now_rfc3339(),
                exit_code: None,
                error: None,
                stop_requested: false,
            },
        );

        let ready = if let Some(handle) = servers.get_mut(project_id) {
            wait_for_port_or_exit(&mut handle.child, info.port, START_READY_TIMEOUT).await
        } else {
            false
        };
        if ready {
            if let Some(handle) = servers.get_mut(project_id) {
                handle.refresh_lifecycle();
                if handle.is_active() {
                    handle.info.status = "running".into();
                    return Ok(handle.info.clone());
                }
                let logs = handle
                    .logs
                    .lock()
                    .expect("runtime log lock poisoned")
                    .recent(40)
                    .into_iter()
                    .map(|entry| entry.text)
                    .collect::<Vec<_>>()
                    .join("\n");
                anyhow::bail!(
                    "Project process terminated before ready.{}",
                    if logs.is_empty() {
                        String::new()
                    } else {
                        format!("\n{logs}")
                    }
                );
            }
        }

        // Keep startup failure recoverable and deterministic. The TS runtime
        // stops a process that never opens its port and includes recent logs
        // in the error surfaced to the model.
        if let Some(handle) = servers.get_mut(project_id) {
            handle.refresh_lifecycle();
            let already_stopped = !handle.is_active();
            if !already_stopped {
                handle.stop_requested = true;
                handle.info.status = "stopping".into();
                let _ = handle.child.start_kill();
                let _ = handle.child.wait().await;
                handle.info.status = "stopped".into();
            }
            let logs = handle
                .logs
                .lock()
                .expect("runtime log lock poisoned")
                .recent(40)
                .into_iter()
                .map(|entry| entry.text)
                .collect::<Vec<_>>()
                .join("\n");
            anyhow::bail!(
                "Project did not become ready on port {} within {} seconds.{}",
                info.port,
                START_READY_TIMEOUT.as_secs(),
                if logs.is_empty() {
                    String::new()
                } else {
                    format!("\n{logs}")
                }
            );
        }
        anyhow::bail!("Project process disappeared before becoming ready")
    }

    pub async fn stop_dev(&self, project_id: &str) -> Result<bool> {
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
        if let Err(error) = handle.child.start_kill() {
            handle.refresh_lifecycle();
            if handle.is_active() {
                handle.info.status = "error".into();
                handle.error = Some(format!("unable to stop project process: {error}"));
                return Err(error).context("stop project dev server");
            }
            return Ok(true);
        }
        match handle.child.wait().await {
            Ok(exit_status) => handle.record_exit(exit_status),
            Err(error) => {
                handle.info.status = "error".into();
                handle.error = Some(format!("unable to wait for project process: {error}"));
                return Err(error).context("wait for project dev server to stop");
            }
        }
        Ok(true)
    }

    pub async fn status(&self, project_id: &str) -> Result<Value> {
        let snapshot = {
            let mut servers = self.servers.lock().await;
            let Some(handle) = servers.get_mut(project_id) else {
                return Ok(json!({
                    "project": project_id,
                    "project_id": project_id,
                    "projectId": project_id,
                    "status": "not_started",
                    "running": false,
                    "alive": false,
                    "healthy": false,
                }));
            };
            handle.refresh_lifecycle();
            RuntimeStatusSnapshot::from_handle(handle)
        };

        let healthy = if snapshot.active {
            tokio::time::timeout(
                Duration::from_secs(2),
                reqwest::get(snapshot.info.url.clone()),
            )
            .await
            .map(|response| response.is_ok())
            .unwrap_or(false)
        } else {
            false
        };

        // Reap an exit that happened during the health probe as well. This
        // avoids reporting a stale `starting` state for a process that died
        // between the initial inspection and the HTTP request.
        let snapshot = {
            let mut servers = self.servers.lock().await;
            match servers.get_mut(project_id) {
                Some(handle) if handle.info.pid == snapshot.info.pid => {
                    handle.refresh_lifecycle();
                    if healthy && handle.info.status == "starting" && handle.is_active() {
                        handle.info.status = "running".into();
                    }
                    RuntimeStatusSnapshot::from_handle(handle)
                }
                _ => snapshot,
            }
        };

        let healthy = healthy && snapshot.active;
        let url = snapshot.active.then(|| snapshot.info.url.clone());
        Ok(json!({
            "project": project_id,
            "project_id": project_id,
            "projectId": project_id,
            "status": snapshot.info.status,
            "running": snapshot.info.status == "running",
            "alive": snapshot.active,
            "port": snapshot.info.port,
            "url": url,
            "pid": snapshot.info.pid,
            "started_at": snapshot.started_at,
            "startedAt": snapshot.started_at,
            "exit_code": snapshot.exit_code,
            "exitCode": snapshot.exit_code,
            "error": snapshot.error,
            "healthy": healthy,
            "log_count": snapshot.log_count,
        }))
    }

    /// Return recent buffered process output in chronological order. Buffering
    /// is per runtime process and is intentionally retained after it exits so
    /// callers can diagnose a failed startup.
    pub async fn logs(&self, project_id: &str, max_entries: usize) -> Vec<ProjectRuntimeLogEntry> {
        let logs = {
            let servers = self.servers.lock().await;
            servers
                .get(project_id)
                .map(|handle| Arc::clone(&handle.logs))
        };
        logs.map(|logs| {
            logs.lock()
                .expect("runtime log lock poisoned")
                .recent(max_entries)
        })
        .unwrap_or_default()
    }

    /// Append a browser-side runtime message to the project selected by its
    /// local dev-server port. Electron console events carry the page URL, not
    /// a project id, so this lookup keeps the log buffer owned by Rust.
    pub async fn append_external_log_by_port(
        &self,
        port: u16,
        kind: &str,
        text: &str,
    ) -> Result<Option<String>> {
        anyhow::ensure!(
            matches!(kind, "stdout" | "stderr"),
            "invalid project log kind: {kind}"
        );
        let matching = {
            let servers = self.servers.lock().await;
            servers.iter().find_map(|(project_id, handle)| {
                (handle.info.port == port).then(|| (project_id.clone(), Arc::clone(&handle.logs)))
            })
        };
        let Some((project_id, logs)) = matching else {
            return Ok(None);
        };
        logs.lock()
            .expect("runtime log lock poisoned")
            .append(kind, text.to_string());
        Ok(Some(project_id))
    }
}

struct RuntimeStatusSnapshot {
    info: DevServerInfo,
    active: bool,
    started_at: String,
    exit_code: Option<i32>,
    error: Option<String>,
    log_count: usize,
}

impl RuntimeStatusSnapshot {
    fn from_handle(handle: &DevServerHandle) -> Self {
        Self {
            info: handle.info.clone(),
            active: handle.is_active(),
            started_at: handle.started_at.clone(),
            exit_code: handle.exit_code,
            error: handle.error.clone(),
            log_count: handle
                .logs
                .lock()
                .expect("runtime log lock poisoned")
                .entries
                .len(),
        }
    }
}

fn normalize_project_id(project_id: &str) -> Result<&str> {
    let project_id = project_id.trim();
    anyhow::ensure!(
        !project_id.is_empty()
            && project_id != "."
            && project_id != ".."
            && !project_id.contains(['/', '\\', '\0', ':']),
        "invalid project id: {project_id}"
    );
    Ok(project_id)
}

fn bundled_node() -> Option<PathBuf> {
    if let Some(node) = env::var_os("WORLDBASE_RUNTIME_NODE")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return Some(node);
    }
    // 与 Electron 打包约定：extraResources/node-bin/node
    let candidates = [
        std::env::current_exe()
            .ok()?
            .parent()?
            .parent()?
            .join("node-bin/node"),
        PathBuf::from("dist/node-bin/node"),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

fn pick_free_port(preferred: Option<u16>) -> Result<u16> {
    if let Some(port) = preferred {
        if let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", port)) {
            drop(listener);
            return Ok(port);
        }
    }
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    #[tokio::test]
    async fn buffered_logs_keep_stream_type_order_and_bounds() {
        let logs = Arc::new(Mutex::new(RuntimeLogBuffer::default()));
        let (mut stdout_writer, stdout_reader) = tokio::io::duplex(128);
        let (mut stderr_writer, stderr_reader) = tokio::io::duplex(128);
        let stdout_task = tokio::spawn(capture_process_output(
            stdout_reader,
            "stdout",
            Arc::clone(&logs),
        ));
        let stderr_task = tokio::spawn(capture_process_output(
            stderr_reader,
            "stderr",
            Arc::clone(&logs),
        ));

        stdout_writer.write_all(b"stdout line\n").await.unwrap();
        stderr_writer.write_all(b"stderr line\n").await.unwrap();
        drop(stdout_writer);
        drop(stderr_writer);
        stdout_task.await.unwrap();
        stderr_task.await.unwrap();

        let entries = logs.lock().unwrap().recent(10);
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().any(|entry| {
            entry.kind == "stdout" && entry.text == "stdout line\n" && entry.time > 0
        }));
        assert!(entries.iter().any(|entry| {
            entry.kind == "stderr" && entry.text == "stderr line\n" && entry.time > 0
        }));

        let mut bounded = RuntimeLogBuffer::default();
        bounded.append("stdout", "a".repeat(MAX_LOG_ENTRY_BYTES + 32));
        assert_eq!(bounded.entries.len(), 1);
        assert!(bounded.entries[0].text.starts_with("...[truncated]\n"));
        assert!(bounded.entries[0].text.len() <= MAX_LOG_ENTRY_BYTES);
        for index in 0..=MAX_LOG_ENTRIES {
            bounded.append("stderr", index.to_string());
        }
        assert_eq!(bounded.entries.len(), MAX_LOG_ENTRIES);
        assert_eq!(bounded.entries.front().unwrap().kind, "stderr");

        let mut byte_bounded = RuntimeLogBuffer::default();
        for _ in 0..100 {
            byte_bounded.append("stdout", "b".repeat(MAX_LOG_ENTRY_BYTES));
        }
        assert!(byte_bounded.total_bytes <= MAX_LOG_BUFFER_BYTES);
        assert!(byte_bounded.entries.len() < MAX_LOG_ENTRIES);
    }

    #[tokio::test]
    async fn status_reaps_completed_process_and_retains_logs() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = ProjectRuntime::new(dir.path().to_path_buf());
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
            .arg("--help")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        let exit_status = child.wait().await.unwrap();
        assert!(exit_status.success());
        let logs = Arc::new(Mutex::new(RuntimeLogBuffer::default()));
        logs.lock()
            .unwrap()
            .append("stderr", "server stopped\n".into());
        runtime.servers.lock().await.insert(
            "completed".into(),
            DevServerHandle {
                info: DevServerInfo {
                    port: 43123,
                    url: "http://127.0.0.1:43123".into(),
                    status: "running".into(),
                    pid,
                },
                child,
                logs,
                started_at: worldbase_protocol::event::now_rfc3339(),
                exit_code: None,
                error: None,
                stop_requested: false,
            },
        );

        assert_eq!(
            runtime
                .append_external_log_by_port(43123, "stdout", "browser console\n")
                .await
                .unwrap()
                .as_deref(),
            Some("completed")
        );
        assert_eq!(
            runtime
                .append_external_log_by_port(43124, "stdout", "other project\n")
                .await
                .unwrap(),
            None
        );

        let status = runtime.status("completed").await.unwrap();
        assert_eq!(status["status"], "stopped");
        assert_eq!(status["running"], false);
        assert_eq!(status["alive"], false);
        assert_eq!(status["healthy"], false);
        assert_eq!(status["exit_code"], 0);
        assert_eq!(status["url"], Value::Null);

        let entries = runtime.logs("completed", 10).await;
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].kind, "stderr");
        assert_eq!(entries[0].text, "server stopped\n");
        assert_eq!(entries[1].kind, "stdout");
        assert_eq!(entries[1].text, "browser console\n");
    }

    #[tokio::test]
    async fn gateway_recovery_runs_in_the_health_loop_not_a_status_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("crashed-project");
        tokio::fs::create_dir_all(&project).await.unwrap();
        tokio::fs::write(
            project.join(".world-meta.json"),
            r#"{"name":"Crashed project","runtime":{"backend":{"command":""}}}"#,
        )
        .await
        .unwrap();

        let runtime = ProjectRuntime::new(dir.path().to_path_buf());
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
            .arg("--worldbase-intentionally-invalid-test-argument")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        let exit_status = child.wait().await.unwrap();
        assert!(!exit_status.success());
        runtime.servers.lock().await.insert(
            "crashed-project".into(),
            DevServerHandle {
                info: DevServerInfo {
                    port: 43124,
                    url: "http://127.0.0.1:43124".into(),
                    status: "running".into(),
                    pid,
                },
                child,
                logs: Arc::new(Mutex::new(RuntimeLogBuffer::default())),
                started_at: worldbase_protocol::event::now_rfc3339(),
                exit_code: None,
                error: None,
                stop_requested: false,
            },
        );

        let snapshot = runtime.gateway_service_map_for_ui().await.unwrap();
        assert_eq!(snapshot["services"][0]["status"], "crashed");
        assert_eq!(snapshot["services"][0]["restartCount"], 0);

        runtime.gateway_health_check_for_ui().await.unwrap();
        assert_eq!(
            runtime
                .restart_counts
                .lock()
                .unwrap()
                .get("crashed-project")
                .copied(),
            Some(1)
        );
    }

    #[tokio::test]
    async fn create_and_list_project() {
        let dir = tempfile::tempdir().unwrap();
        let rt = ProjectRuntime::new(dir.path().to_path_buf());
        let info = rt.create_project("my-app").await.unwrap();
        assert!(Path::new(&info.path).join("package.json").is_file());
        let meta: Value = serde_json::from_str(
            &tokio::fs::read_to_string(Path::new(&info.path).join(".world-meta.json"))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(meta["id"], "my-app");
        assert_eq!(meta["name"], "my-app");
        assert_eq!(meta["framework"], "nextjs");
        let list = rt.list_projects().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "my-app");
        let tools = rt.runtime_tools().unwrap();
        assert!(tools["projects_dir"].as_str().is_some());
    }

    #[tokio::test]
    async fn project_path_stays_inside_the_selected_project() {
        let dir = tempfile::tempdir().unwrap();
        let rt = ProjectRuntime::new(dir.path().to_path_buf());
        tokio::fs::create_dir_all(dir.path().join("one"))
            .await
            .unwrap();
        tokio::fs::create_dir_all(dir.path().join("two"))
            .await
            .unwrap();
        tokio::fs::write(dir.path().join("two/file.txt"), "two")
            .await
            .unwrap();

        let project_two = dir.path().join("two").canonicalize().unwrap();
        assert_eq!(
            rt.project_path("two", "file.txt").unwrap(),
            project_two.join("file.txt")
        );
        assert!(rt.project_path("two", "../one/file.txt").is_err());
        assert!(rt.project_root("../one").is_err());
    }

    #[tokio::test]
    async fn project_path_allows_first_managed_write_without_crossing_root() {
        let dir = tempfile::tempdir().unwrap();
        let rt = ProjectRuntime::new(dir.path().to_path_buf());

        let target = rt.project_path("fresh-project", "src/index.ts").unwrap();
        assert_eq!(
            target,
            dir.path()
                .canonicalize()
                .unwrap()
                .join("fresh-project/src/index.ts")
        );
        tokio::fs::create_dir_all(target.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&target, "export {}").await.unwrap();

        assert_eq!(
            tokio::fs::read_to_string(dir.path().join("fresh-project/src/index.ts"))
                .await
                .unwrap(),
            "export {}"
        );
        assert!(rt
            .project_path("fresh-project", "../../outside.txt")
            .is_err());
    }

    #[tokio::test]
    async fn create_project_with_files_keeps_electron_meta_contract() {
        let dir = tempfile::tempdir().unwrap();
        let rt = ProjectRuntime::new(dir.path().to_path_buf());
        let mut files = Map::new();
        files.insert(
            "src/main.ts".into(),
            Value::String("export const ok = true".into()),
        );
        let info = rt
            .create_project_with_files(
                "Rust workspace",
                "frontend",
                &files,
                json!({ "icon": "code", "runtime": { "backend": { "command": "npm run dev" } } }),
            )
            .await
            .unwrap();
        let meta: Value = serde_json::from_str(
            &tokio::fs::read_to_string(Path::new(&info.path).join(".world-meta.json"))
                .await
                .unwrap(),
        )
        .unwrap();

        assert_eq!(meta["id"], "Rust-workspace");
        assert_eq!(meta["name"], "Rust workspace");
        assert_eq!(meta["type"], "frontend");
        assert_eq!(meta["icon"], "code");
        assert_eq!(meta["runtime"]["backend"]["command"], "npm run dev");
        assert!(Path::new(&info.path).join("src/main.ts").is_file());
    }

    #[tokio::test]
    async fn explicit_project_id_applies_next_template_to_partial_files() {
        let dir = tempfile::tempdir().unwrap();
        let rt = ProjectRuntime::new(dir.path().to_path_buf());
        let mut files = Map::new();
        files.insert(
            "package.json".into(),
            Value::String(
                r#"{"dependencies":{"next":"1","react":"18","react-dom":"18"}}"#
                    .into(),
            ),
        );
        files.insert(
            "app/page.tsx".into(),
            Value::String("export default function Page () { return <main>ok</main> }".into()),
        );
        let info = rt
            .create_project_with_id_and_files_and_template(
                "proj_partial_1234abcd",
                "Partial Next",
                "frontend",
                &files,
                Value::Null,
                false,
            )
            .await
            .unwrap();
        assert_eq!(info.id, "proj_partial_1234abcd");
        let root = Path::new(&info.path);
        assert!(root.join("app/layout.tsx").is_file());
        assert!(root.join("app/globals.css").is_file());
        assert!(root.join("next.config.js").is_file());
        let package: Value = serde_json::from_str(
            &tokio::fs::read_to_string(root.join("package.json"))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(package["dependencies"]["next"], "^15.0.0");
        assert_eq!(package["scripts"]["build"], "next build");
        let meta: Value = serde_json::from_str(
            &tokio::fs::read_to_string(root.join(".world-meta.json"))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(meta["id"], "proj_partial_1234abcd");
        assert_eq!(meta["framework"], "nextjs");
        assert_eq!(
            meta["runtime"]["backend"]["command"],
            "node .next/standalone/server.js"
        );
    }

    #[tokio::test]
    async fn explicit_project_id_preserves_existing_layout_and_injects_globals_import() {
        let dir = tempfile::tempdir().unwrap();
        let rt = ProjectRuntime::new(dir.path().to_path_buf());
        let mut files = Map::new();
        files.insert(
            "next.config.js".into(),
            Value::String("module.exports = {}".into()),
        );
        files.insert(
            "app/layout.js".into(),
            Value::String("'use client';\nexport default function Layout ({ children }) { return children }".into()),
        );
        let info = rt
            .create_project_with_id_and_files_and_template(
                "proj_layout_1234abcd",
                "Layout Next",
                "frontend",
                &files,
                Value::Null,
                false,
            )
            .await
            .unwrap();
        let layout = tokio::fs::read_to_string(Path::new(&info.path).join("app/layout.js"))
            .await
            .unwrap();
        assert!(layout.starts_with("'use client'\nimport './globals.css'"));
        assert!(!Path::new(&info.path).join("app/layout.tsx").exists());
    }

    #[test]
    fn metadata_launch_uses_command_cwd_and_preferred_port() {
        let dir = tempfile::tempdir().unwrap();
        let rt = ProjectRuntime::new(dir.path().to_path_buf());
        let project = dir.path().join("custom");
        std::fs::create_dir_all(project.join("api")).unwrap();
        std::fs::write(
            project.join(".world-meta.json"),
            r#"{"runtime":{"backend":{"command":"node server.js","cwd":"api","port":32123}}}"#,
        )
        .unwrap();

        let launch = rt.resolve_runtime_launch("custom", &project).unwrap();
        assert_eq!(launch.cwd, project.join("api").canonicalize().unwrap());
        assert_eq!(launch.port, 32123);
        assert_eq!(launch.node_env, "production");
        match launch.command {
            RuntimeCommand::Shell { command } => assert_eq!(command, "node server.js"),
            RuntimeCommand::NextDev { .. } => panic!("expected custom runtime command"),
        }
    }

    #[test]
    fn standalone_output_overrides_legacy_backend_command() {
        let dir = tempfile::tempdir().unwrap();
        let rt = ProjectRuntime::new(dir.path().to_path_buf());
        let project = dir.path().join("standalone");
        std::fs::create_dir_all(project.join(".next/standalone")).unwrap();
        std::fs::write(project.join(".next/standalone/server.js"), "// standalone").unwrap();
        std::fs::write(
            project.join(".world-meta.json"),
            r#"{"runtime":{"backend":{"command":"npm run dev","cwd":"ignored"}}}"#,
        )
        .unwrap();

        let launch = rt.resolve_runtime_launch("standalone", &project).unwrap();
        assert_eq!(launch.cwd, project.join(".next/standalone"));
        assert_eq!(launch.node_env, "production");
        match launch.command {
            RuntimeCommand::Shell { command } => assert_eq!(command, "node server.js"),
            RuntimeCommand::NextDev { .. } => panic!("expected standalone runtime command"),
        }
    }

    #[test]
    fn configured_port_is_rewritten_only_after_fallback() {
        assert_eq!(
            replace_configured_port("npm run dev -- --port 3000", Some(3000), 4173),
            "npm run dev -- --port $PORT"
        );
        assert_eq!(
            replace_configured_port("npm run dev -- --port 3000", Some(3000), 3000),
            "npm run dev -- --port 3000"
        );
    }

    #[tokio::test]
    async fn custom_node_runtime_runs_with_electron_project_environment() {
        if bundled_node().or_else(|| which("node")).is_none() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let rt = ProjectRuntime::new(dir.path().to_path_buf());
        let project = dir.path().join("runtime-project");
        tokio::fs::create_dir_all(&project).await.unwrap();
        tokio::fs::write(
            project.join("server.js"),
            "const http = require('http'); http.createServer((_, res) => res.end(process.env.THE_WORLD_PROJECT_ID + ':' + process.env.PORT)).listen(process.env.PORT, process.env.HOSTNAME);",
        )
        .await
        .unwrap();

        let info = rt.start_dev("runtime-project").await.unwrap();
        let mut status = Value::Null;
        for _ in 0..30 {
            status = rt.status("runtime-project").await.unwrap();
            if status["status"] == "running" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(status["status"], "running");
        let body = reqwest::get(&info.url).await.unwrap().text().await.unwrap();
        assert_eq!(body, format!("runtime-project:{}", info.port));
        assert!(rt.stop_dev("runtime-project").await.unwrap());
    }
}
