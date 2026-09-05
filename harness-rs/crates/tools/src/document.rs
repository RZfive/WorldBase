//! 文档工具：doc_parse / doc_write。

use super::{require_str, Tool, ToolServices};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};

pub struct DocParseTool;

#[async_trait]
impl Tool for DocParseTool {
    fn name(&self) -> &str {
        "doc_parse"
    }
    fn description(&self) -> &str {
        "解析文档（xlsx/pdf/docx/pptx/csv/json/md/txt）为结构化文本"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "path": { "type": "string" } },
            "required": ["path"]
        })
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let path = require_str(&input, "path")?;
        let full = services.workspace_path(path);
        services.ensure_workspace_path(&full)?;
        let parsed = worldbase_docs::parse_file(&full)?;
        Ok(parsed)
    }
}

pub struct DocWriteTool;

#[async_trait]
impl Tool for DocWriteTool {
    fn name(&self) -> &str {
        "doc_write"
    }
    fn description(&self) -> &str {
        "写入文档：kind=markdown/csv/docx/xlsx"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" },
                "kind": { "type": "string", "enum": ["markdown", "csv", "docx", "xlsx", "text", "json"] },
                "content": { "type": "string", "description": "markdown/text/json 内容" },
                "header": { "type": "array", "items": { "type": "string" }, "description": "csv 表头" },
                "rows": { "type": "array", "items": { "type": "array" }, "description": "csv/xlsx 行" },
                "sheet_name": { "type": "string", "description": "xlsx 工作表名称，默认 Sheet1" },
                "blocks": {
                    "type": "array",
                    "description": "docx 文档块；type 可为 heading、paragraph 或 bullet",
                    "items": {
                        "type": "object",
                        "properties": {
                            "type": { "type": "string", "enum": ["heading", "paragraph", "bullet"] },
                            "text": { "type": "string" },
                            "level": { "type": "integer", "description": "heading 层级，默认 1" }
                        },
                        "required": ["text"]
                    }
                }
            },
            "required": ["path", "kind"]
        })
    }
    fn permission(&self) -> &str {
        "ask"
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let path = require_str(&input, "path")?;
        let kind = require_str(&input, "kind")?;
        let full = services.workspace_path(path);
        services.ensure_workspace_path(&full)?;
        if let Some(parent) = full.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        match kind {
            "markdown" | "text" | "json" => {
                let content = require_str(&input, "content")?;
                worldbase_docs::edit::write_text(&full, content)?;
            }
            "csv" => {
                let header: Vec<String> = input["header"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .map(|v| v.as_str().unwrap_or_default().into())
                            .collect()
                    })
                    .unwrap_or_default();
                let rows: Vec<Vec<String>> = input["rows"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .map(|r| {
                                r.as_array()
                                    .map(|c| c.iter().map(|v| value_to_cell(v)).collect())
                                    .unwrap_or_default()
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                worldbase_docs::edit::write_csv(&full, &header, &rows)?;
            }
            "docx" => {
                let blocks = blocks_from_input(&input)?;
                worldbase_docs::edit::write_docx(&full, &blocks)?;
            }
            "xlsx" => {
                let sheets = vec![worldbase_docs::edit::Sheet {
                    name: input["sheet_name"].as_str().unwrap_or("Sheet1").into(),
                    rows: input["rows"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .map(|r| {
                                    r.as_array()
                                        .map(|c| c.iter().map(|v| value_to_cell(v)).collect())
                                        .unwrap_or_default()
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                }];
                worldbase_docs::edit::write_xlsx(&full, &sheets)?;
            }
            other => anyhow::bail!("unsupported doc kind: {other}"),
        }
        Ok(json!({ "path": path, "kind": kind, "written": true }))
    }
}

fn value_to_cell(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// input.blocks = [{type: heading|paragraph|bullet, text, level?}]
fn blocks_from_input(input: &Value) -> Result<Vec<worldbase_docs::edit::DocBlock>> {
    let mut blocks = Vec::new();
    for b in input["blocks"].as_array().cloned().unwrap_or_default() {
        let text = b["text"].as_str().unwrap_or_default().to_string();
        match b["type"].as_str().unwrap_or("paragraph") {
            "heading" => blocks.push(worldbase_docs::edit::DocBlock::Heading(
                text,
                b["level"].as_u64().unwrap_or(1) as u32,
            )),
            "bullet" => blocks.push(worldbase_docs::edit::DocBlock::Bullet(text)),
            _ => blocks.push(worldbase_docs::edit::DocBlock::Paragraph(text)),
        }
    }
    if blocks.is_empty() {
        if let Some(content) = input["content"].as_str() {
            for para in content.split("\n\n") {
                blocks.push(worldbase_docs::edit::DocBlock::Paragraph(para.into()));
            }
        }
    }
    Ok(blocks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doc_write_schema_advertises_format_specific_fields() {
        let schema = DocWriteTool.input_schema();
        let properties = schema["properties"]
            .as_object()
            .expect("doc_write properties");
        assert!(properties.contains_key("sheet_name"));
        assert!(properties.contains_key("blocks"));
        assert_eq!(
            properties["blocks"]["items"]["properties"]["type"]["enum"],
            json!(["heading", "paragraph", "bullet"])
        );
    }
}
