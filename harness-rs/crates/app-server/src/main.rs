//! Standalone Electron transport for the Rust harness.
//!
//! stdout is reserved for NDJSON JSON-RPC. Logs are sent to stderr so the
//! Electron client can safely parse every stdout line.

use anyhow::{Context, Result};
use std::path::PathBuf;
use std::sync::Arc;
use worldbase_app_server::run_stdio;
use worldbase_core::Hub;
use worldbase_memory::Store;
use worldbase_protocol::types::Capabilities;

fn argument(name: &str) -> Option<String> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == name {
            return args.next();
        }
    }
    None
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

    let workspace = argument("--workspace")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let workspace = workspace
        .canonicalize()
        .unwrap_or_else(|_| workspace.clone());

    // Electron passes its user-data directory so Rust and TS share settings
    // and conversation state during the migration period.
    if let Some(data_dir) = argument("--data-dir") {
        std::env::set_var("WORLDBASE_HOME", data_dir);
    }
    let store = Arc::new(Store::open_default().context("open Rust harness store")?);
    let hub = Hub::new(workspace, store).context("initialize Rust harness")?;
    hub.start_background();
    run_stdio(hub, Capabilities::desktop()).await
}
