//! worldbase CLI：chat / run / projects / serve。
//!
//! chat 与 run 走 in-process dispatcher（全能力）；serve 启动 axum WS/HTTP。

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use worldbase_core::dispatcher::ConnectionContext;
use worldbase_core::Hub;
use worldbase_project_runtime::{list_manifests, load_manifest, validate_manifest};
use worldbase_protocol::event::{EventFrame, EventKind};
use worldbase_protocol::types::{AppManifest, Capabilities};

#[derive(Parser)]
#[command(name = "worldbase")]
#[command(about = "WorldBase Rust Harness CLI", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// 对话（一次性消息或交互 REPL）
    Chat {
        /// 消息（省略则进入交互模式）
        message: Option<String>,
        /// 工作区目录
        #[arg(short, long, default_value = ".")]
        workspace: PathBuf,
        /// 会话标题（交互模式下复用）
        #[arg(short, long, default_value = "CLI 会话")]
        title: String,
    },
    /// 立即运行一个任务（独立会话）
    Run {
        #[arg(long)]
        task: String,
        #[arg(short, long, default_value = ".")]
        workspace: PathBuf,
    },
    /// 项目管理
    Projects {
        #[arg(default_value = "ls")]
        action: String,
        #[arg(short, long, default_value = ".")]
        workspace: PathBuf,
    },
    /// 应用能力清单
    App {
        #[command(subcommand)]
        command: AppCommand,
    },
}

#[derive(Subcommand)]
enum AppCommand {
    /// 校验 manifest 文件或项目目录
    Validate { path: PathBuf },
    /// 列出目录下的应用
    List { dir: PathBuf },
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive(tracing::Level::WARN.into()),
        )
        .with_writer(std::io::stderr)
        .init();

    let cli = Cli::parse();
    match cli.command {
        Commands::Chat {
            message,
            workspace,
            title,
        } => match message {
            Some(msg) => one_shot(&workspace, &title, &msg).await?,
            None => repl(&workspace, &title).await?,
        },
        Commands::Run { task, workspace } => {
            one_shot(&workspace, "[任务]", &task).await?;
        }
        Commands::Projects { action, workspace } => {
            let hub = build_hub(&workspace).await?;
            match action.as_str() {
                "ls" => {
                    let projects = hub.projects.list_projects()?;
                    if projects.is_empty() {
                        println!("（无项目）");
                    }
                    for p in &projects {
                        println!("{}\t{}\t{}", p.id, p.kind, p.path);
                    }
                }
                other => anyhow::bail!("unknown projects action: {other}"),
            }
        }
        Commands::App { command } => match command {
            AppCommand::Validate { path } => match validate_app(&path) {
                Ok(errors) if errors.is_empty() => println!("valid\t{}", path.display()),
                Ok(errors) => {
                    for error in errors {
                        eprintln!("error: {error}");
                    }
                    std::process::exit(1);
                }
                Err(error) => {
                    eprintln!("error: {error:#}");
                    std::process::exit(1);
                }
            },
            AppCommand::List { dir } => {
                for entry in collect_app_entries(&dir)? {
                    println!(
                        "{}\t{}\t{}\t{}",
                        entry.app_id,
                        entry.name,
                        entry.version,
                        entry.path.display()
                    );
                }
            }
        },
    }
    Ok(())
}

fn manifest_path(path: &Path) -> Result<PathBuf> {
    if path.is_file() {
        return Ok(path.to_path_buf());
    }
    if path.is_dir() {
        let candidate = path.join(".worldbase/app-capabilities.json");
        if candidate.is_file() {
            return Ok(candidate);
        }
        anyhow::bail!("app manifest not found: {}", candidate.display());
    }
    anyhow::bail!("path not found: {}", path.display())
}

fn validate_app(path: &Path) -> Result<Vec<String>> {
    let manifest_path = manifest_path(path)?;
    let text = std::fs::read_to_string(&manifest_path)
        .with_context(|| format!("read app manifest {}", manifest_path.display()))?;
    let manifest: AppManifest = serde_json::from_str(&text)
        .with_context(|| format!("parse app manifest {}", manifest_path.display()))?;
    let mut errors = match validate_manifest(&manifest) {
        Ok(()) => Vec::new(),
        Err(errors) => errors,
    };
    if errors.is_empty() && path.is_dir() {
        if let Err(error) = load_manifest(path) {
            errors.push(error.to_string());
        }
    }
    Ok(errors)
}

struct AppListEntry {
    app_id: String,
    name: String,
    version: String,
    path: PathBuf,
}

fn collect_app_entries(dir: &Path) -> Result<Vec<AppListEntry>> {
    anyhow::ensure!(dir.is_dir(), "not a directory: {}", dir.display());
    Ok(list_manifests(dir)?
        .into_iter()
        .map(|(project_id, manifest)| AppListEntry {
            app_id: manifest.app.id,
            name: manifest.app.name,
            version: manifest.app.version,
            path: dir.join(project_id),
        })
        .collect())
}

async fn build_hub(workspace: &PathBuf) -> Result<Arc<Hub>> {
    let workspace = workspace
        .canonicalize()
        .unwrap_or_else(|_| workspace.clone());
    // 运行时数据不入工作区：`$WORLDBASE_HOME/app.sqlite` 或 `~/.the-world/app.sqlite`
    let store = Arc::new(worldbase_memory::Store::open_default()?);
    Hub::new(workspace, store)
}

async fn one_shot(workspace: &PathBuf, title: &str, message: &str) -> Result<()> {
    let hub = build_hub(workspace).await?;
    let ctx = ConnectionContext::new(Capabilities::cli());
    let conv = hub.store.create_conversation(title, None)?;

    let mut events = hub.event_tx.subscribe();
    let result = worldbase_core::dispatcher::dispatch(
        &hub,
        &ctx,
        worldbase_protocol::method::CHAT_SEND,
        serde_json::json!({ "conversationId": conv.id, "text": message }),
    )
    .await
    .map_err(|e| anyhow::anyhow!("{}", e.message))?;
    let stream_id = result["streamId"]
        .as_str()
        .or_else(|| result["stream_id"].as_str())
        .unwrap_or_default()
        .to_string();

    // 等待流结束（Done/Error 事件）
    loop {
        let frame = match events.recv().await {
            Ok(f) => f,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(_) => break,
        };
        if frame.stream_id != stream_id {
            continue;
        }
        print_event(&frame);
        if matches!(frame.kind, EventKind::Done { .. } | EventKind::Error { .. }) {
            break;
        }
    }
    Ok(())
}

async fn repl(workspace: &PathBuf, title: &str) -> Result<()> {
    let hub = build_hub(workspace).await?;
    let ctx = ConnectionContext::new(Capabilities::cli());
    let conv = hub.store.create_conversation(title, None)?;
    println!(
        "🤖 WorldBase CLI（会话 {}）— 输入 /quit 退出",
        &conv.id[..8]
    );

    let mut events = hub.event_tx.subscribe();
    loop {
        print!("> ");
        use std::io::Write;
        std::io::stdout().flush()?;
        let mut line = String::new();
        if std::io::stdin().read_line(&mut line)? == 0 {
            break;
        }
        let text = line.trim();
        if text.is_empty() {
            continue;
        }
        if text == "/quit" || text == "/exit" {
            break;
        }

        let result = worldbase_core::dispatcher::dispatch(
            &hub,
            &ctx,
            worldbase_protocol::method::CHAT_SEND,
            serde_json::json!({ "conversationId": conv.id, "text": text }),
        )
        .await
        .map_err(|e| anyhow::anyhow!("{}", e.message))?;
        let stream_id = result["streamId"]
            .as_str()
            .or_else(|| result["stream_id"].as_str())
            .unwrap_or_default()
            .to_string();

        loop {
            let frame = match events.recv().await {
                Ok(f) => f,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            };
            if frame.stream_id != stream_id {
                continue;
            }
            print_event(&frame);
            if matches!(frame.kind, EventKind::Done { .. } | EventKind::Error { .. }) {
                break;
            }
        }
    }
    Ok(())
}

fn print_event(frame: &EventFrame) {
    match &frame.kind {
        EventKind::Delta { text } => {
            print!("{text}");
            use std::io::Write;
            let _ = std::io::stdout().flush();
        }
        EventKind::ToolCall { name, .. } => println!("\n[工具调用] {name}"),
        EventKind::ToolResult {
            name,
            content,
            is_error,
            ..
        } => {
            let tag = if *is_error { "错误" } else { "完成" };
            let short: String = content.chars().take(120).collect();
            println!("[工具{name} {tag}] {short}");
        }
        EventKind::PermissionRequest {
            tool_name,
            args_summary,
            ..
        } => {
            println!("[权限询问] {tool_name} {args_summary}（CLI 模式按拒绝处理）");
        }
        EventKind::AssistantMessage { .. } => println!(),
        EventKind::Usage {
            total_cost,
            total_input_tokens,
            total_output_tokens,
            ..
        } => println!(
            "[用量] input={total_input_tokens} output={total_output_tokens} cost={total_cost:.6}"
        ),
        EventKind::Done { .. } => println!(),
        EventKind::Error { message } => println!("\n[错误] {message}"),
        EventKind::Start { model } => println!("[模型] {model}"),
        EventKind::Notice { text } => println!("[通知] {text}"),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_manifest() -> serde_json::Value {
        serde_json::json!({
            "schemaVersion": 1,
            "app": {
                "id": "worldbase.local.demo",
                "name": "Demo",
                "version": "0.1.0",
                "trustLevel": "untrusted"
            },
            "runtime": { "kind": "managed_project" },
            "capabilities": [{
                "id": "example.search",
                "operation": "example.search",
                "risk": "read",
                "inputSchema": { "type": "object" }
            }]
        })
    }

    fn write_project_manifest(root: &Path, manifest: &serde_json::Value) {
        let manifest_dir = root.join(".worldbase");
        std::fs::create_dir_all(&manifest_dir).unwrap();
        std::fs::write(
            manifest_dir.join("app-capabilities.json"),
            serde_json::to_string_pretty(manifest).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn validate_accepts_a_manifest_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("app-capabilities.json");
        std::fs::write(&path, serde_json::to_string(&valid_manifest()).unwrap()).unwrap();
        assert!(validate_app(&path).unwrap().is_empty());
    }

    #[test]
    fn validate_accepts_a_project_directory() {
        let temp = tempfile::tempdir().unwrap();
        write_project_manifest(temp.path(), &valid_manifest());
        assert!(validate_app(temp.path()).unwrap().is_empty());
    }

    #[test]
    fn validate_reports_each_manifest_error() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("app-capabilities.json");
        let invalid = serde_json::json!({
            "schemaVersion": 2,
            "app": { "id": "bad id!", "version": "" },
            "runtime": { "kind": "managed_project" },
            "capabilities": []
        });
        std::fs::write(&path, serde_json::to_string(&invalid).unwrap()).unwrap();
        let errors = validate_app(&path).unwrap();
        assert!(errors.iter().any(|error| error.contains("schemaVersion")));
        assert!(errors.iter().any(|error| error.contains("invalid app id")));
        assert!(errors.iter().any(|error| error.contains("app.version")));
        assert!(errors.iter().any(|error| error.contains("capability")));
    }

    #[test]
    fn validate_rejects_missing_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let error = validate_app(temp.path()).unwrap_err();
        assert!(error.to_string().contains("app manifest not found"));
    }

    #[test]
    fn list_prints_app_identity_and_path() {
        let temp = tempfile::tempdir().unwrap();
        let alpha = temp.path().join("proj_alpha");
        let beta = temp.path().join("proj_beta");
        write_project_manifest(&alpha, &valid_manifest());
        let mut beta_manifest = valid_manifest();
        beta_manifest["app"]["id"] = serde_json::json!("worldbase.local.beta");
        beta_manifest["app"]["name"] = serde_json::json!("Beta");
        write_project_manifest(&beta, &beta_manifest);

        let entries = collect_app_entries(temp.path()).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].app_id, "worldbase.local.demo");
        assert_eq!(entries[0].name, "Demo");
        assert_eq!(entries[0].version, "0.1.0");
        assert_eq!(entries[0].path, alpha);
        assert_eq!(entries[1].app_id, "worldbase.local.beta");
        assert_eq!(entries[1].name, "Beta");
        assert_eq!(entries[1].path, beta);
    }
}
