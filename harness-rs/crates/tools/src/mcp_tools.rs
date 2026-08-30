//! Rust-native MCP discovery and execution tools.
//!
//! These mirror Electron's MCP tool surface while keeping the actual network
//! connection inside the Rust harness. Electron supplies configuration and
//! answers permission cards; it does not execute a second MCP client in a
//! Rust-selected run.

use super::{require_str, Tool, ToolServices};
use anyhow::{bail, Result};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;
use worldbase_mcp_client::{build_local_tool_name, McpTool};

pub struct McpCallTool;

#[async_trait]
impl Tool for McpCallTool {
    fn name(&self) -> &str {
        "mcp_call"
    }

    fn description(&self) -> &str {
        "Call a tool exposed by a configured MCP server. Prefer a discovered mcp__... tool when available because it has the exact server schema."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "server": { "type": "string", "description": "Electron MCP server ID." },
                "tool": { "type": "string", "description": "Remote MCP tool name." },
                "arguments": { "type": "object", "description": "Arguments accepted by the remote MCP tool.", "additionalProperties": true }
            },
            "required": ["server", "tool"],
            "additionalProperties": false
        })
    }

    fn permission(&self) -> &str {
        "ask"
    }

    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let server = require_str(&input, "server")?;
        ensure_server_allowed(services, server)?;
        let tool = require_str(&input, "tool")?;
        let arguments = object_argument(&input, "arguments");
        let result = services.mcp.call_tool(server, tool, arguments).await?;
        Ok(normalize_tool_result(server, tool, None, result))
    }
}

pub struct McpListServersTool;

#[async_trait]
impl Tool for McpListServersTool {
    fn name(&self) -> &str {
        "mcp_list_servers"
    }

    fn description(&self) -> &str {
        "List configured MCP servers, connection state, and transport."
    }

    fn input_schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }

    async fn execute(&self, _input: Value, services: &ToolServices) -> Result<Value> {
        let allowed = services.allowed_mcp_server_ids();
        let mut state = services.mcp.state_snapshot().await;
        if let Some(allowed) = allowed.as_ref() {
            state.servers.retain(|server| allowed.contains(&server.id));
        }
        // Electron's builtin returns the complete MCPStateSnapshot (including
        // capabilities and updatedAt), not only a compact server list.
        Ok(serde_json::to_value(state)?)
    }
}

pub struct McpListResourcesTool;

#[async_trait]
impl Tool for McpListResourcesTool {
    fn name(&self) -> &str {
        "mcp_list_resources"
    }

    fn description(&self) -> &str {
        "List resources exposed by one MCP server or every authorized enabled MCP server."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "server_id": { "type": "string", "description": "Optional MCP server ID." } },
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        if let Some(server) = optional_server_id(&input) {
            ensure_server_allowed(services, server)?;
            let resources = services.mcp.list_resources(server).await?;
            let server_name = services
                .mcp
                .state_snapshot()
                .await
                .servers
                .into_iter()
                .find(|entry| entry.id == server)
                .map(|entry| entry.name)
                .unwrap_or_else(|| server.to_string());
            return Ok(json!({ "server": server_name, "server_id": server, "resources": resources }));
        }

        let allowed = services.allowed_mcp_server_ids();
        let mut servers = Vec::new();
        for server in services.mcp.list_server_info(allowed.as_ref()).await {
            if !server.enabled {
                continue;
            }
            let resources = services.mcp.list_resources(&server.id).await?;
            servers.push(json!({
                "server_id": server.id,
                "server": server.name,
                "resources": resources,
            }));
        }
        Ok(json!({ "servers": servers }))
    }
}

pub struct McpReadResourceTool;

#[async_trait]
impl Tool for McpReadResourceTool {
    fn name(&self) -> &str {
        "mcp_read_resource"
    }

    fn description(&self) -> &str {
        "Read a resource from an authorized MCP server."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "server_id": { "type": "string", "description": "MCP server ID." },
                "uri": { "type": "string", "description": "Resource URI." }
            },
            "required": ["server_id", "uri"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let server = server_id(&input)?;
        ensure_server_allowed(services, server)?;
        let uri = require_str(&input, "uri")?;
        let result = services.mcp.read_resource(server, uri).await?;
        Ok(json!({
            "server_id": server,
            "uri": uri,
            "contents": result.get("contents").cloned().unwrap_or(result),
        }))
    }
}

pub struct McpListPromptsTool;

#[async_trait]
impl Tool for McpListPromptsTool {
    fn name(&self) -> &str {
        "mcp_list_prompts"
    }

    fn description(&self) -> &str {
        "List prompt templates exposed by one MCP server or every authorized enabled MCP server."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "server_id": { "type": "string", "description": "Optional MCP server ID." } },
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        if let Some(server) = optional_server_id(&input) {
            ensure_server_allowed(services, server)?;
            let prompts = services.mcp.list_prompts(server).await?;
            let server_name = services
                .mcp
                .state_snapshot()
                .await
                .servers
                .into_iter()
                .find(|entry| entry.id == server)
                .map(|entry| entry.name)
                .unwrap_or_else(|| server.to_string());
            return Ok(json!({ "server": server_name, "server_id": server, "prompts": prompts }));
        }

        let allowed = services.allowed_mcp_server_ids();
        let mut servers = Vec::new();
        for server in services.mcp.list_server_info(allowed.as_ref()).await {
            if !server.enabled {
                continue;
            }
            let prompts = services.mcp.list_prompts(&server.id).await?;
            servers.push(json!({
                "server_id": server.id,
                "server": server.name,
                "prompts": prompts,
            }));
        }
        Ok(json!({ "servers": servers }))
    }
}

pub struct McpGetPromptTool;

#[async_trait]
impl Tool for McpGetPromptTool {
    fn name(&self) -> &str {
        "mcp_get_prompt"
    }

    fn description(&self) -> &str {
        "Expand a prompt template from an authorized MCP server."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "server_id": { "type": "string", "description": "MCP server ID." },
                "name": { "type": "string", "description": "Remote prompt name." },
                "arguments": { "type": "object", "description": "Prompt arguments.", "additionalProperties": true }
            },
            "required": ["server_id", "name"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let server = server_id(&input)?;
        ensure_server_allowed(services, server)?;
        let name = require_str(&input, "name")?;
        let result = services
            .mcp
            .get_prompt(server, name, object_argument(&input, "arguments"))
            .await?;
        Ok(json!({
            "server_id": server,
            "name": name,
            "description": result.get("description").cloned(),
            "messages": result.get("messages").cloned().unwrap_or_else(|| json!([])),
        }))
    }
}

/// Convert MCP tools discovered at the start of a run into regular Rust tools.
/// Their local names deliberately match Electron's historical `mcp__...`
/// format so existing allow lists and saved policies continue to work.
pub fn dynamic_mcp_tools(discovered: Vec<McpTool>) -> Vec<Arc<dyn Tool>> {
    let mut names = HashSet::new();
    discovered
        .into_iter()
        .filter_map(|tool| {
            let name = build_local_tool_name(&tool.server, &tool.name);
            if !names.insert(name.clone()) {
                return None;
            }
            Some(Arc::new(McpDynamicTool {
                name,
                server: tool.server,
                remote_name: tool.name,
                description: if tool.description.trim().is_empty() {
                    format!("[MCP:{}] MCP tool", tool.server_name)
                } else {
                    format!("[MCP:{}] {}", tool.server_name, tool.description)
                },
                input_schema: normalize_schema(tool.input_schema),
            }) as Arc<dyn Tool>)
        })
        .collect()
}

struct McpDynamicTool {
    name: String,
    server: String,
    remote_name: String,
    description: String,
    input_schema: Value,
}

#[async_trait]
impl Tool for McpDynamicTool {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> &str {
        &self.description
    }

    fn input_schema(&self) -> Value {
        self.input_schema.clone()
    }

    fn permission(&self) -> &str {
        "ask"
    }

    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        ensure_server_allowed(services, &self.server)?;
        let result = services
            .mcp
            .call_tool(&self.server, &self.remote_name, input)
            .await?;
        Ok(normalize_tool_result(
            &self.server,
            &self.remote_name,
            Some(&self.name),
            result,
        ))
    }
}

fn server_id(input: &Value) -> Result<&str> {
    input
        .get("server_id")
        .or_else(|| input.get("server"))
        .and_then(Value::as_str)
        .filter(|server| !server.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("server_id is required"))
}

fn optional_server_id(input: &Value) -> Option<&str> {
    input
        .get("server_id")
        .or_else(|| input.get("server"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|server| !server.is_empty())
}

fn ensure_server_allowed(services: &ToolServices, server: &str) -> Result<()> {
    if services.is_mcp_server_allowed(server) {
        return Ok(());
    }
    bail!("MCP server {server} is not authorized for this run")
}

fn object_argument(input: &Value, key: &str) -> Value {
    input
        .get(key)
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}))
}

fn normalize_tool_result(
    server: &str,
    tool: &str,
    local_name: Option<&str>,
    result: Value,
) -> Value {
    json!({
        "server_id": server,
        "tool": tool,
        "local_name": local_name,
        "is_error": result.get("isError").and_then(Value::as_bool).unwrap_or(false),
        "structured_content": result.get("structuredContent").cloned(),
        "content": result.get("content").filter(|value| value.is_array()).cloned().unwrap_or_else(|| json!([])),
    })
}

fn normalize_schema(value: Value) -> Value {
    if value.is_object() {
        value
    } else {
        json!({ "type": "object" })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dynamic_name_matches_electron_format_for_ascii_values() {
        assert_eq!(
            build_local_tool_name("local-server", "Search Files"),
            "mcp__local_server__search_files__p1lbp0"
        );
    }

    #[test]
    fn dynamic_name_preserves_electron_underscore_and_unicode_rules() {
        assert_eq!(
            build_local_tool_name("local__server", "__Search---Files__"),
            "mcp__local__server__search_files__je3jj6"
        );
        assert_eq!(
            build_local_tool_name(
                "  MCP \u{1f980} Server  ",
                "\u{591a}\u{8bed}\u{8a00}__\u{67e5}\u{627e}---\u{5de5}\u{5177}"
            ),
            "mcp__mcp_server__tool__3ovnyw"
        );
    }

    #[test]
    fn dynamic_tools_keep_schema_and_use_unique_names() {
        let tools = dynamic_mcp_tools(vec![McpTool {
            server: "server".into(),
            server_name: "Server".into(),
            name: "lookup".into(),
            description: "Lookup a record".into(),
            input_schema: json!({ "type": "object", "properties": { "id": { "type": "string" } } }),
        }]);
        assert_eq!(tools.len(), 1);
        assert!(tools[0].name().starts_with("mcp__server__lookup__"));
        assert_eq!(tools[0].permission(), "ask");
    }
}
