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

/// input.slides = [{title, content: string[]}]
fn slides_from_input(input: &Value) -> Result<Vec<worldbase_docs::edit::Slide>> {
    let Some(value) = input.get("slides") else {
        return Ok(Vec::new());
    };
    let raw_slides = value
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("slides must be an array"))?;
    raw_slides
        .iter()
        .enumerate()
        .map(|(index, slide)| {
            let slide = slide
                .as_object()
                .ok_or_else(|| anyhow::anyhow!("slides[{index}] must be an object"))?;
            let title = slide
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let content = slide
                .get("content")
                .and_then(Value::as_array)
                .map(|lines| {
                    lines
                        .iter()
                        .map(|line| match line {
                            Value::String(text) => text.clone(),
                            Value::Null => String::new(),
                            other => other.to_string(),
                        })
                        .collect()
                })
                .unwrap_or_default();
            Ok(worldbase_docs::edit::Slide { title, content })
        })
        .collect()
}

/// input.sheets = [{name, rows}] (multi-sheet) with the single-sheet
/// `rows` + `sheet_name` arguments as the fallback, mirroring doc_write.
fn sheets_from_input(input: &Value) -> Result<Vec<worldbase_docs::edit::Sheet>> {
    if let Some(value) = input.get("sheets") {
        let raw_sheets = value
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("sheets must be an array"))?;
        return raw_sheets
            .iter()
            .enumerate()
            .map(|(index, sheet)| {
                let sheet = sheet
                    .as_object()
                    .ok_or_else(|| anyhow::anyhow!("sheets[{index}] must be an object"))?;
                let name = sheet
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("Sheet")
                    .to_string();
                let rows = rows_array(&Value::Object(sheet.clone()), "rows")?;
                Ok(worldbase_docs::edit::Sheet { name, rows })
            })
            .collect();
    }
    Ok(vec![worldbase_docs::edit::Sheet {
        name: optional_string_alias(input, &["sheet_name", "sheetName"])?
            .unwrap_or_else(|| "Sheet1".to_string()),
        rows: rows_array(input, "rows")?,
    }])
}

pub struct DocDraftTool;

#[async_trait]
impl Tool for DocDraftTool {
    fn name(&self) -> &str {
        "doc_draft"
    }
    fn description(&self) -> &str {
        "为已打开的文档生成完整修改草稿（不改动原文件）：kind=markdown/text/docx/xlsx/pptx。用户会在工作区实时预览草稿，并自行决定保存到原文件或另存为副本。修改用户文档时必须使用本工具而不是直接覆写文件。"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "artifact_id": { "type": "string", "description": "目标文档的 artifact id（list_documents 可查）；与 file_path 二选一" },
                "file_path": { "type": "string", "description": "目标文档的绝对路径；尚未导入过的文件会自动导入" },
                "kind": { "type": "string", "enum": ["markdown", "text", "docx", "xlsx", "pptx"], "description": "草稿内容格式，必须与文档原格式一致" },
                "content": { "type": "string", "description": "markdown/text 全文内容" },
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
                },
                "rows": { "type": "array", "items": { "type": "array" }, "description": "xlsx 单表行数据（无 sheets 时生效）" },
                "sheet_name": { "type": "string", "description": "xlsx 单表名称，默认 Sheet1" },
                "sheets": {
                    "type": "array",
                    "description": "xlsx 多表内容",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": { "type": "string" },
                            "rows": { "type": "array", "items": { "type": "array" } }
                        },
                        "required": ["name", "rows"]
                    }
                },
                "slides": {
                    "type": "array",
                    "description": "pptx 幻灯片内容",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": { "type": "string" },
                            "content": { "type": "array", "items": { "type": "string" } }
                        },
                        "required": ["title"]
                    }
                }
            },
            "required": ["kind"]
        })
    }
    fn domain(&self) -> &str {
        "core"
    }
    fn electron_native(&self) -> bool {
        true
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let artifact_id = optional_string_alias(&input, &["artifact_id", "artifactId"])?;
        let file_path = optional_string_alias(&input, &["file_path", "filePath"])?;
        let kind = strict_required_string(&input, "kind")?;

        let content = match kind {
            "markdown" => {
                let body = strict_required_string(&input, "content")?;
                crate::document_artifacts::DraftContent::Text {
                    kind: "md",
                    body: body.to_string(),
                }
            }
            "text" => {
                let body = strict_required_string(&input, "content")?;
                crate::document_artifacts::DraftContent::Text {
                    kind: "text",
                    body: body.to_string(),
                }
            }
            "docx" => crate::document_artifacts::DraftContent::Docx(blocks_from_input(&input)?),
            "xlsx" => crate::document_artifacts::DraftContent::Xlsx(sheets_from_input(&input)?),
            "pptx" => crate::document_artifacts::DraftContent::Pptx(slides_from_input(&input)?),
            other => anyhow::bail!("unsupported doc draft kind: {other}"),
        };

        let staged = crate::document_artifacts::stage_document_draft(
            &services.workspace,
            artifact_id.as_deref(),
            file_path.as_deref(),
            content,
        )?;

        // Notify the desktop workspace so the tab switches to the draft
        // preview immediately. The host channel carries absolute paths; a
        // missed notification is non-fatal (the user can still apply later).
        let stream = services.current_stream.lock().unwrap().clone();
        let notification = json!({
            "artifactId": staged.get("artifactId"),
            "filePath": staged.get("filePath"),
            "draftPath": staged.get("draftPath"),
            "fileType": staged.get("fileType"),
            "sourceSha256": staged.get("sourceSha256"),
            "createdAt": staged.get("createdAt"),
        });
        let _ = services
            .host
            .request(
                &stream,
                "document.draftStaged",
                notification,
                std::time::Duration::from_secs(15),
            )
            .await;

        Ok(json!({
            "success": true,
            "artifactId": staged.get("artifactId"),
            "draftPath": staged.get("draftPath"),
            "fileType": staged.get("fileType"),
            "note": "修改草稿已生成，等待用户在工作区预览并决定保存到原文件或另存为。请勿直接覆写原文件。"
        }))
    }
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

    #[test]
    fn doc_draft_schema_advertises_target_and_formats() {
        let schema = DocDraftTool.input_schema();
        let properties = schema["properties"].as_object().expect("doc_draft properties");
        assert!(properties.contains_key("artifact_id"));
        assert!(properties.contains_key("file_path"));
        assert_eq!(
            properties["kind"]["enum"],
            json!(["markdown", "text", "docx", "xlsx", "pptx"])
        );
        assert!(properties.contains_key("sheets"));
        assert!(properties.contains_key("slides"));
    }
}
