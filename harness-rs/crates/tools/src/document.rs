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
        let mut parsed = worldbase_docs::parse_file(&full)?;
        let artifact =
            crate::document_artifacts::import_parsed_document(&services.workspace, &full, &parsed)?;
        if let Some(result) = parsed.as_object_mut() {
            result.insert("artifact_id".into(), json!(artifact.id));
            result.insert("artifactId".into(), json!(artifact.id));
        }
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
                "sheetName": { "type": "string", "description": "xlsx 工作表名称别名，默认 Sheet1" },
                "blocks": {
                    "type": "array",
                    "description": "docx 文档块；type 可为 heading、paragraph、bullet 或 bold",
                    "items": {
                        "type": "object",
                        "properties": {
                            "type": { "type": "string", "enum": ["heading", "paragraph", "bullet", "bold"] },
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
        let path = strict_required_string(&input, "path")?;
        let kind = strict_required_string(&input, "kind")?;
        let full = services.workspace_path(path);
        services.ensure_workspace_path(&full)?;
        if let Some(parent) = full.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        match kind {
            "markdown" | "text" | "json" => {
                let content = strict_required_string(&input, "content")?;
                worldbase_docs::edit::write_text(&full, content)?;
            }
            "csv" => {
                let header = string_array(&input, "header")?;
                let rows = rows_array(&input, "rows")?;
                worldbase_docs::edit::write_csv(&full, &header, &rows)?;
            }
            "docx" => {
                let blocks = blocks_from_input(&input)?;
                worldbase_docs::edit::write_docx(&full, &blocks)?;
            }
            "xlsx" => {
                let sheets = vec![worldbase_docs::edit::Sheet {
                    name: optional_string_alias(&input, &["sheet_name", "sheetName"])?
                        .unwrap_or_else(|| "Sheet1".to_string()),
                    rows: rows_array(&input, "rows")?,
                }];
                worldbase_docs::edit::write_xlsx(&full, &sheets)?;
            }
            other => anyhow::bail!("unsupported doc kind: {other}"),
        }
        Ok(json!({ "path": path, "kind": kind, "written": true }))
    }
}

fn strict_required_string<'a>(input: &'a Value, key: &str) -> Result<&'a str> {
    match input.get(key) {
        Some(Value::String(value)) => Ok(value),
        Some(_) => anyhow::bail!("{key} must be a string"),
        None => anyhow::bail!("missing {key}"),
    }
}

fn optional_string_alias(input: &Value, aliases: &[&str]) -> Result<Option<String>> {
    let Some((key, value)) = aliases
        .iter()
        .find_map(|key| input.get(*key).map(|value| (*key, value)))
    else {
        return Ok(None);
    };
    match value {
        Value::String(value) if !value.trim().is_empty() => Ok(Some(value.to_string())),
        Value::String(_) => anyhow::bail!("{key} must not be empty"),
        _ => anyhow::bail!("{key} must be a string"),
    }
}

fn string_array(input: &Value, key: &str) -> Result<Vec<String>> {
    let Some(value) = input.get(key) else {
        return Ok(Vec::new());
    };
    let values = value
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("{key} must be an array of strings"))?;
    values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            value
                .as_str()
                .map(ToOwned::to_owned)
                .ok_or_else(|| anyhow::anyhow!("{key}[{index}] must be a string"))
        })
        .collect()
}

fn rows_array(input: &Value, key: &str) -> Result<Vec<Vec<String>>> {
    let Some(value) = input.get(key) else {
        return Ok(Vec::new());
    };
    let rows = value
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("{key} must be a two-dimensional array"))?;
    rows.iter()
        .enumerate()
        .map(|(row_index, row)| {
            let cells = row
                .as_array()
                .ok_or_else(|| anyhow::anyhow!("{key}[{row_index}] must be an array"))?;
            Ok(cells.iter().map(value_to_cell).collect())
        })
        .collect()
}

fn value_to_cell(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// input.blocks = [{type: heading|paragraph|bullet|bold, text, level?}]
fn blocks_from_input(input: &Value) -> Result<Vec<worldbase_docs::edit::DocBlock>> {
    let Some(value) = input.get("blocks") else {
        let mut blocks = Vec::new();
        if let Some(content) = input.get("content").and_then(Value::as_str) {
            for para in content.split("\n\n") {
                blocks.push(worldbase_docs::edit::DocBlock::Paragraph(para.into()));
            }
        }
        return Ok(blocks);
    };
    let raw_blocks = value
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("blocks must be an array"))?;
    let mut blocks = Vec::new();
    for (index, b) in raw_blocks.iter().enumerate() {
        let b = b
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("blocks[{index}] must be an object"))?;
        let text = b
            .get("text")
            .map(|value| {
                value
                    .as_str()
                    .map(ToOwned::to_owned)
                    .ok_or_else(|| anyhow::anyhow!("blocks[{index}].text must be a string"))
            })
            .transpose()?
            .unwrap_or_default();
        let block_type = b
            .get("type")
            .map(|value| {
                value
                    .as_str()
                    .map(ToOwned::to_owned)
                    .ok_or_else(|| anyhow::anyhow!("blocks[{index}].type must be a string"))
            })
            .transpose()?
            .unwrap_or_else(|| "paragraph".to_string());
        let level = b
            .get("level")
            .map(|value| {
                let level = value.as_u64().ok_or_else(|| {
                    anyhow::anyhow!("blocks[{index}].level must be a non-negative integer")
                })?;
                u32::try_from(level)
                    .map_err(|_| anyhow::anyhow!("blocks[{index}].level is out of range"))
            })
            .transpose()?
            .unwrap_or(1);
        match block_type.as_str() {
            "heading" => blocks.push(worldbase_docs::edit::DocBlock::Heading(text, level)),
            "paragraph" => blocks.push(worldbase_docs::edit::DocBlock::Paragraph(text)),
            "bullet" => blocks.push(worldbase_docs::edit::DocBlock::Bullet(text)),
            "bold" => blocks.push(worldbase_docs::edit::DocBlock::Bold(text)),
            other => anyhow::bail!(
                "blocks[{index}].type must be heading, paragraph, bullet, or bold (got {other})"
            ),
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
            json!(["heading", "paragraph", "bullet", "bold"])
        );
    }
}
