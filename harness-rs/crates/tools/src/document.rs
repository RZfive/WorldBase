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
        "写入文档：kind=markdown/csv/docx/xlsx。目标路径若是已导入或已存在的 Office 文档会被拒绝——修改已有文档必须使用 doc_draft 生成草稿。"
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
        crate::document_artifacts::ensure_document_write_allowed(&services.workspace, &full)?;
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

/// doc_draft 的修改语义说明：`ops` 为保真编辑（复制原文件后做手术，图片与
/// 样式保留）；`content/blocks/slides/sheets` 为全文重建（对含图片的文档会被
/// 标记 dataLossRisk）。修改已有文档时优先使用 ops。
#[async_trait]
impl Tool for DocDraftTool {
    fn name(&self) -> &str {
        "doc_draft"
    }
    fn description(&self) -> &str {
        "为已打开的文档生成修改草稿（不改动原文件）。修改已有 docx/pptx 时必须优先使用 ops 操作列表（保真编辑，图片/表格/样式保留）；全文重建（blocks/slides）会导致原文档图片丢失，仅限从空内容重写时使用。用户会在工作区实时预览草稿和变更清单，并自行决定保存到原文件或另存为副本。"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "artifact_id": { "type": "string", "description": "目标文档的 artifact id（list_documents 可查）；与 file_path 二选一" },
                "file_path": { "type": "string", "description": "目标文档的绝对路径；尚未导入过的文件会自动导入" },
                "kind": { "type": "string", "enum": ["markdown", "text", "docx", "xlsx", "pptx"], "description": "草稿内容格式，必须与文档原格式一致" },
                "summary": { "type": "string", "description": "一句话向用户说明本次改了什么（仅展示用）" },
                "ops": {
                    "type": "array",
                    "description": "保真编辑操作列表（推荐）。与 content/blocks/slides/sheets 互斥。多条 op 按顺序应用，段落索引基于前一条应用后的状态。docx 段落索引为 0 基 document 序（含空段落，见 doc_parse 的 paragraphMetadata.docxParagraphIndex）；pptx 的 slide 为 1 基页码、paragraphIndex 为页内 0 基 a:p 序（见 doc_parse 的 paragraphItems）。",
                    "items": {
                        "type": "object",
                        "properties": {
                            "op": { "type": "string", "enum": [
                                "docx_replace_text", "docx_insert_paragraph_after", "docx_delete_paragraph", "docx_insert_image",
                                "pptx_replace_text", "pptx_insert_image", "pptx_insert_slide_after", "pptx_delete_slide"
                            ] },
                            "paragraphIndex": { "type": "integer", "description": "docx：0 基段落索引；insert_paragraph_after 传 -1 表示追加到文末" },
                            "slide": { "type": "integer", "description": "pptx：1 基页码（演示顺序）" },
                            "index": { "type": "integer", "description": "pptx_insert_slide_after：0=插到最前，N=插到第 N 页之后；pptx_delete_slide：1 基页码" },
                            "afterText": { "type": "string", "description": "replace 后的新文本" },
                            "expectBefore": { "type": "string", "description": "可选锚文本：目标段落当前内容需包含它，防改错位置" },
                            "text": { "type": "string", "description": "插入的段落文本" },
                            "heading": { "type": "boolean", "description": "docx_insert_paragraph_after：作为标题插入" },
                            "level": { "type": "integer", "description": "heading 层级，默认 1" },
                            "bold": { "type": "boolean", "description": "docx_insert_paragraph_after：加粗" },
                            "bullet": { "type": "boolean", "description": "docx_insert_paragraph_after：列表项" },
                            "image_path": { "type": "string", "description": "要插入的本地 PNG/JPEG 图片绝对路径" },
                            "widthInches": { "type": "number", "description": "插图宽度（英寸），docx 默认 4、pptx 默认 4" },
                            "title": { "type": "string", "description": "pptx_insert_slide_after：新页标题" },
                            "content": { "type": "array", "items": { "type": "string" }, "description": "pptx_insert_slide_after：新页正文行" }
                        },
                        "required": ["op"]
                    }
                },
                "content": { "type": "string", "description": "markdown/text 全文内容（全文重建模式）" },
                "blocks": {
                    "type": "array",
                    "description": "docx 文档块（全文重建模式，图片会丢失）；type 可为 heading、paragraph、bullet 或 bold",
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
                    "description": "xlsx 多表内容（全文重建模式）",
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
                    "description": "pptx 幻灯片内容（全文重建模式，原图片会丢失；仅当用户明确要求整份重做 PPT 时使用）",
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
        let summary = optional_string_alias(&input, &["summary"])?;

        let has_full_text = ["content", "blocks", "slides", "sheets", "rows"]
            .iter()
            .any(|key| input.get(key).map(|value| !value.is_null()).unwrap_or(false));
        let ops = office_ops_from_input(&input)?;

        let content = if !ops.is_empty() {
            anyhow::ensure!(
                !has_full_text,
                "ops 与 content/blocks/slides/sheets 不能同时提供；修改已有文档请只用 ops"
            );
            crate::document_artifacts::DraftContent::OfficeOps(ops)
        } else {
            match kind {
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
            }
        };

        let staged = crate::document_artifacts::stage_document_draft(
            &services.workspace,
            artifact_id.as_deref(),
            file_path.as_deref(),
            content,
            summary,
        )?;

        // Notify the desktop workspace so the tab switches to the draft
        // preview immediately. The host channel carries absolute paths; a
        // missed notification is non-fatal (the user can still apply later),
        // but it is surfaced to the model and logged instead of being silent.
        let stream = services.current_stream.lock().unwrap().clone();
        let notification = json!({
            "artifactId": staged.get("artifactId"),
            "filePath": staged.get("filePath"),
            "draftPath": staged.get("draftPath"),
            "fileType": staged.get("fileType"),
            "sourceSha256": staged.get("sourceSha256"),
            "createdAt": staged.get("createdAt"),
            "changes": staged.get("changes"),
            "dataLossRisk": staged.get("dataLossRisk"),
            "summary": staged.get("summary"),
        });
        let notified = match services
            .host
            .request(
                &stream,
                "document.draftStaged",
                notification,
                std::time::Duration::from_secs(15),
            )
            .await
        {
            Ok(_) => true,
            Err(error) => {
                tracing::warn!(?error, "document.draftStaged notification failed");
                false
            }
        };

        let mut result = json!({
            "success": true,
            "artifactId": staged.get("artifactId"),
            "draftPath": staged.get("draftPath"),
            "fileType": staged.get("fileType"),
            "notified": notified,
            "changes": staged.get("changes"),
            "dataLossRisk": staged.get("dataLossRisk"),
            "note": if notified {
                "修改草稿已生成，工作区已切换到草稿预览。等待用户决定保存到原文件或另存为，请勿直接覆写原文件。"
            } else {
                "修改草稿已生成，但工作区通知未送达（用户稍后仍可在文档页看到草稿）。请勿直接覆写原文件。"
            }
        });
        if staged.get("dataLossRisk").map(|value| !value.is_null()).unwrap_or(false) {
            if let Some(object) = result.as_object_mut() {
                object.insert(
                    "warning".into(),
                    json!("原文件包含图片等媒体内容，当前全文重建草稿保存后会丢失它们；请改用 ops 操作列表做保真编辑，或明确告知用户损失。"),
                );
            }
        }
        Ok(result)
    }
}

/// input.ops → OfficeOp（字段别名与 -1 追加语义在此归一）。
fn office_ops_from_input(input: &Value) -> Result<Vec<worldbase_docs::ops::OfficeOp>> {
    let Some(raw_ops) = input.get("ops").filter(|value| !value.is_null()) else {
        return Ok(Vec::new());
    };
    let raw_ops = raw_ops
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("ops must be an array"))?;
    raw_ops
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let op = value
                .as_object()
                .ok_or_else(|| anyhow::anyhow!("ops[{index}] must be an object"))?;
            let kind = op
                .get("op")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("ops[{index}].op is required"))?;

            let paragraph_index = |keys: &[&str]| -> Result<usize> {
                for key in keys {
                    if let Some(value) = op.get(*key) {
                        let number = value
                            .as_i64()
                            .ok_or_else(|| anyhow::anyhow!("ops[{index}].{key} must be an integer"))?;
                        return Ok(if number < 0 {
                            usize::MAX
                        } else {
                            usize::try_from(number)
                                .map_err(|_| anyhow::anyhow!("ops[{index}].{key} is out of range"))?
                        });
                    }
                }
                anyhow::bail!("ops[{index}] missing paragraphIndex")
            };
            let slide_number = |keys: &[&str]| -> Result<u32> {
                for key in keys {
                    if let Some(value) = op.get(*key) {
                        let number = value
                            .as_u64()
                            .ok_or_else(|| anyhow::anyhow!("ops[{index}].{key} must be a positive integer"))?;
                        return Ok(u32::try_from(number)
                            .map_err(|_| anyhow::anyhow!("ops[{index}].{key} is out of range"))?);
                    }
                }
                anyhow::bail!("ops[{index}] missing {keys:?}")
            };
            let text = |keys: &[&str]| -> Result<String> {
                for key in keys {
                    if let Some(value) = op.get(*key) {
                        return value
                            .as_str()
                            .map(ToOwned::to_owned)
                            .ok_or_else(|| anyhow::anyhow!("ops[{index}].{key} must be a string"));
                    }
                }
                anyhow::bail!("ops[{index}] missing {keys:?}")
            };
            let optional_text = |keys: &[&str]| -> Result<Option<String>> {
                for key in keys {
                    if op.get(*key).map(|value| !value.is_null()).unwrap_or(false) {
                        return Ok(Some(text(&[key])?));
                    }
                }
                Ok(None)
            };
            let optional_number = |keys: &[&str]| -> Result<Option<f64>> {
                for key in keys {
                    if let Some(value) = op.get(*key) {
                        return value
                            .as_f64()
                            .map(Some)
                            .ok_or_else(|| anyhow::anyhow!("ops[{index}].{key} must be a number"));
                    }
                }
                Ok(None)
            };
            let image_path = |keys: &[&str]| -> Result<std::path::PathBuf> {
                Ok(std::path::PathBuf::from(text(keys)?))
            };
            let string_array = |keys: &[&str]| -> Result<Vec<String>> {
                for key in keys {
                    if let Some(value) = op.get(*key) {
                        return value
                            .as_array()
                            .map(|values| {
                                values
                                    .iter()
                                    .map(|item| match item {
                                        Value::String(text) => text.clone(),
                                        Value::Null => String::new(),
                                        other => other.to_string(),
                                    })
                                    .collect()
                            })
                            .ok_or_else(|| anyhow::anyhow!("ops[{index}].{key} must be a string array"));
                    }
                }
                Ok(Vec::new())
            };

            match kind {
                "docx_replace_text" => Ok(worldbase_docs::ops::OfficeOp::DocxReplaceText {
                    paragraph_index: paragraph_index(&["paragraphIndex", "paragraph_index"])?,
                    after_text: text(&["afterText", "after_text", "text"])?,
                    expect_before: optional_text(&["expectBefore", "expect_before"])?,
                }),
                "docx_insert_paragraph_after" => {
                    let style = if op.get("heading").and_then(Value::as_bool).unwrap_or(false) {
                        worldbase_docs::ops::ParagraphStyle::Heading(
                            op.get("level").and_then(Value::as_u64).unwrap_or(1).min(6) as u32,
                        )
                    } else if op.get("bullet").and_then(Value::as_bool).unwrap_or(false) {
                        worldbase_docs::ops::ParagraphStyle::Bullet
                    } else if op.get("bold").and_then(Value::as_bool).unwrap_or(false) {
                        worldbase_docs::ops::ParagraphStyle::Bold
                    } else {
                        worldbase_docs::ops::ParagraphStyle::Plain
                    };
                    Ok(worldbase_docs::ops::OfficeOp::DocxInsertParagraphAfter {
                        paragraph_index: paragraph_index(&["paragraphIndex", "paragraph_index"])?,
                        text: text(&["text"])?,
                        style,
                    })
                }
                "docx_delete_paragraph" => Ok(worldbase_docs::ops::OfficeOp::DocxDeleteParagraph {
                    paragraph_index: paragraph_index(&["paragraphIndex", "paragraph_index"])?,
                }),
                "docx_insert_image" => Ok(worldbase_docs::ops::OfficeOp::DocxInsertImage {
                    paragraph_index: paragraph_index(&["paragraphIndex", "paragraph_index"])?,
                    image_path: image_path(&["image_path", "imagePath", "path"])?,
                    width_inches: optional_number(&["widthInches", "width_inches"])?,
                }),
                "pptx_replace_text" => Ok(worldbase_docs::ops::OfficeOp::PptxReplaceText {
                    slide: slide_number(&["slide", "slideIndex", "slide_index"])?,
                    paragraph_index: paragraph_index(&["paragraphIndex", "paragraph_index"])?,
                    after_text: text(&["afterText", "after_text", "text"])?,
                    expect_before: optional_text(&["expectBefore", "expect_before"])?,
                }),
                "pptx_insert_image" => Ok(worldbase_docs::ops::OfficeOp::PptxInsertImage {
                    slide: slide_number(&["slide", "slideIndex", "slide_index"])?,
                    image_path: image_path(&["image_path", "imagePath", "path"])?,
                    width_inches: optional_number(&["widthInches", "width_inches"])?,
                }),
                "pptx_insert_slide_after" => Ok(worldbase_docs::ops::OfficeOp::PptxInsertSlideAfter {
                    index: slide_number(&["index"])?,
                    title: op
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    content: string_array(&["content"])?,
                }),
                "pptx_delete_slide" => Ok(worldbase_docs::ops::OfficeOp::PptxDeleteSlide {
                    index: slide_number(&["index", "slide"])?,
                }),
                other => anyhow::bail!(
                    "ops[{index}].op 不支持: {other}（可用 docx_replace_text / docx_insert_paragraph_after / docx_delete_paragraph / docx_insert_image / pptx_replace_text / pptx_insert_image / pptx_insert_slide_after / pptx_delete_slide）"
                ),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use crate::compat_tools::LocalWriteFileTool;

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
        assert!(properties.contains_key("ops"), "fidelity ops list exposed");
        assert!(properties.contains_key("summary"));
        assert_eq!(
            properties["kind"]["enum"],
            json!(["markdown", "text", "docx", "xlsx", "pptx"])
        );
        assert!(properties.contains_key("sheets"));
        assert!(properties.contains_key("slides"));
    }

    #[test]
    fn doc_draft_ops_parsing_normalizes_aliases() {
        let ops = office_ops_from_input(&json!({
            "ops": [
                { "op": "pptx_replace_text", "slide": 2, "paragraphIndex": 3, "afterText": "新文案", "expectBefore": "旧文案" },
                { "op": "docx_insert_paragraph_after", "paragraphIndex": -1, "text": "追加段", "heading": true, "level": 2 },
                { "op": "pptx_delete_slide", "index": 4 },
                { "op": "docx_insert_image", "paragraphIndex": 7, "imagePath": "/tmp/a.png", "widthInches": 3.5 }
            ]
        }))
        .unwrap();
        assert_eq!(ops.len(), 4);
        assert_eq!(
            ops[0],
            worldbase_docs::ops::OfficeOp::PptxReplaceText {
                slide: 2,
                paragraph_index: 3,
                after_text: "新文案".into(),
                expect_before: Some("旧文案".into()),
            }
        );
        assert_eq!(
            ops[1],
            worldbase_docs::ops::OfficeOp::DocxInsertParagraphAfter {
                paragraph_index: usize::MAX,
                text: "追加段".into(),
                style: worldbase_docs::ops::ParagraphStyle::Heading(2),
            }
        );
        assert_eq!(
            ops[2],
            worldbase_docs::ops::OfficeOp::PptxDeleteSlide { index: 4 }
        );
        match &ops[3] {
            worldbase_docs::ops::OfficeOp::DocxInsertImage { paragraph_index, image_path, width_inches } => {
                assert_eq!(*paragraph_index, 7);
                assert_eq!(image_path, &std::path::PathBuf::from("/tmp/a.png"));
                assert_eq!(*width_inches, Some(3.5));
            }
            other => panic!("unexpected op: {other:?}"),
        }
    }

    #[test]
    fn doc_draft_rejects_unknown_ops_and_mixed_content() {
        assert!(office_ops_from_input(&json!({
            "ops": [{ "op": "pptx_set_theme" }]
        }))
        .is_err());

        // ops 与全文内容互斥的校验发生在 execute；这里验证解析层不吞错。
        assert!(office_ops_from_input(&json!({
            "ops": [{ "op": "docx_replace_text" }]
        }))
        .is_err());
    }

    // -------------------------------------------------------------------
    // Tool-level E2E：doc_draft ops 全链路 + 直写守卫
    // -------------------------------------------------------------------

    const TINY_PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
        0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
        0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78,
        0x9C, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
        0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    fn e2e_services(root: &Path) -> ToolServices {
        use std::sync::Arc;
        let workspace = root.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let store = Arc::new(worldbase_memory::Store::open(&root.join("store.sqlite")).unwrap());
        ToolServices {
            host: Arc::new(crate::host_bridge::HostBridge::new()),
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
            projects: Arc::new(worldbase_project_runtime::ProjectRuntime::new(root.join("projects"))),
            group_collaboration: None,
            subagent_runtime: None,
        }
    }

    /// 含图两页 pptx（slide2 带图片与双 run 段落）。
    fn write_media_pptx(path: &Path) {
        use std::io::Write as _;
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
        for (name, content) in [
            ("[Content_Types].xml", "<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Default Extension=\"png\" ContentType=\"image/png\"/><Override PartName=\"/ppt/presentation.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml\"/><Override PartName=\"/ppt/slides/slide1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slide+xml\"/><Override PartName=\"/ppt/slides/slide2.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slide+xml\"/></Types>"),
            ("ppt/presentation.xml", "<?xml version=\"1.0\"?><p:presentation xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"><p:sldIdLst><p:sldId id=\"256\" r:id=\"rId2\"/><p:sldId id=\"257\" r:id=\"rId3\"/></p:sldIdLst><p:sldSz cx=\"12192000\" cy=\"6858000\"/></p:presentation>"),
            ("ppt/_rels/presentation.xml.rels", "<?xml version=\"1.0\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster\" Target=\"slideMasters/slideMaster1.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide1.xml\"/><Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide2.xml\"/></Relationships>"),
            ("ppt/slides/slide1.xml", "<?xml version=\"1.0\"?><p:sld xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><p:cSld><p:spTree><a:p><a:r><a:t>封面</a:t></a:r></a:p></p:spTree></p:cSld></p:sld>"),
            ("ppt/slides/slide2.xml", concat!(
                "<?xml version=\"1.0\"?><p:sld xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">",
                "<p:cSld><p:spTree><p:pic><p:blipFill><a:blip r:embed=\"rId1\"/></p:blipFill></p:pic>",
                "<a:p><a:r><a:t>第二页 </a:t></a:r><a:r><a:t>原文</a:t></a:r></a:p></p:spTree></p:cSld></p:sld>")),
            ("ppt/slides/_rels/slide2.xml.rels", "<?xml version=\"1.0\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"../media/image1.png\"/></Relationships>"),
        ] {
            zip.start_file(name, options).unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.start_file("ppt/media/image1.png", options).unwrap();
        zip.write_all(TINY_PNG).unwrap();
        zip.finish().unwrap();
    }

    #[tokio::test]
    async fn doc_draft_pptx_ops_end_to_end_preserves_media() {
        let temp = tempfile::tempdir().unwrap();
        let tool_services = e2e_services(temp.path());
        let workspace = tool_services.workspace.clone();
        let source = workspace.join("deck.pptx");
        write_media_pptx(&source);

        // 尚未导入过的文件：doc_draft 应自动导入并完成 ops 草稿。
        let result = DocDraftTool
            .execute(
                json!({
                    "file_path": source.to_str().unwrap(),
                    "kind": "pptx",
                    "summary": "改第 2 页标题",
                    "ops": [
                        { "op": "pptx_replace_text", "slide": 2, "paragraphIndex": 0, "afterText": "第二页改写", "expectBefore": "第二页" }
                    ]
                }),
                &tool_services,
            )
            .await
            .unwrap();

        assert_eq!(result["success"], true);
        assert_eq!(result["changes"]["counts"]["modified"], 1);
        assert!(result["dataLossRisk"].is_null(), "ops drafts never lose media");
        assert_eq!(result["notified"], false, "fixture host bridge is unwired");
        assert!(result["note"].as_str().unwrap().contains("未送达") || result["note"].as_str().unwrap().contains("草稿"));

        let draft_path = std::path::PathBuf::from(result["draftPath"].as_str().unwrap());
        assert!(draft_path.is_file());
        assert_eq!(
            worldbase_docs::ops::count_media_parts(&draft_path).unwrap(),
            1,
            "media survives into the ops draft"
        );

        let parsed = worldbase_docs::parse_file(&draft_path).unwrap();
        assert_eq!(parsed["items"][1]["paragraphs"][0], json!("第二页改写"));

        // 原文件未被触碰。
        assert_eq!(
            worldbase_docs::ops::count_media_parts(&source).unwrap(),
            1
        );
        let source_parsed = worldbase_docs::parse_file(&source).unwrap();
        assert_eq!(source_parsed["items"][1]["paragraphs"][0], json!("第二页原文"));

        // getDocumentDraft 链路（渲染层补拉路径）能取回带 changes 的记录。
        let record = crate::document_artifacts::get_document_draft(
            &workspace,
            source.to_str().unwrap(),
        )
        .unwrap();
        assert_eq!(record["changes"]["counts"]["modified"], 1);
    }

    #[tokio::test]
    async fn local_write_file_refuses_existing_office_document() {
        let temp = tempfile::tempdir().unwrap();
        let tool_services = e2e_services(temp.path());
        let source = tool_services.workspace.join("deck.pptx");
        write_media_pptx(&source);

        let blocked = LocalWriteFileTool
            .execute(
                json!({
                    "file_path": source.to_str().unwrap(),
                    "office_data": { "type": "pptx", "slides": [{ "title": "重建", "content": ["全文重建"] }] }
                }),
                &tool_services,
            )
            .await;
        let message = format!("{}", blocked.unwrap_err());
        assert!(message.contains("doc_draft"), "guidance to doc_draft: {message}");
    }
}
