//! Dump every builtin tool's name/description/input_schema as one JSON file,
//! for reproducing real provider requests against live endpoints.
//!
//! Run: cargo run -p worldbase-tools --example dump_tools -- /tmp/tools.json

use serde_json::json;
use std::path::PathBuf;

fn main() -> anyhow::Result<()> {
    let out_path = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("tools.json"));
    let mut tools = Vec::new();
    for tool in worldbase_tools::builtin_tools() {
        tools.push(json!({
            "name": tool.name(),
            "description": tool.description(),
            "schema": tool.input_schema(),
        }));
    }
    let payload = json!({ "count": tools.len(), "tools": tools });
    std::fs::write(&out_path, serde_json::to_string_pretty(&payload)?)?;
    println!("wrote {} tools to {}", tools.len(), out_path.display());
    Ok(())
}
