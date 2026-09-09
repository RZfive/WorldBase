//! worldbase CLI：chat / run / projects / serve。
//!
//! chat 与 run 走 in-process dispatcher（全能力）；serve 启动 axum WS/HTTP。

use anyhow::Result;
use clap::{Parser, Subcommand};
use futures::StreamExt;
use std::path::PathBuf;
use std::sync::Arc;
use worldbase_core::dispatcher::ConnectionContext;
use worldbase_core::Hub;
use worldbase_protocol::event::{EventFrame, EventKind};
use worldbase_protocol::types::Capabilities;

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
    }
    Ok(())
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
