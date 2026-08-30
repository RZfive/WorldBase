//! 文档解析实现。

use anyhow::{Context, Result};
use calamine::Reader;
use serde_json::{json, Value};

pub fn xlsx(path: &std::path::Path) -> Result<Value> {
    let mut workbook = calamine::open_workbook_auto(path)
        .with_context(|| format!("open xlsx {}", path.display()))?;
    let mut sheets = Vec::new();
    for name in workbook.sheet_names() {
        let Ok(range) = workbook.worksheet_range(&name) else {
            continue;
        };
        let rows: Vec<Value> = range
            .rows()
            .take(1000)
            .map(|row: &[calamine::Data]| {
                Value::Array(
                    row.iter()
                        .map(|cell| match cell {
                            calamine::Data::Empty => Value::Null,
                            calamine::Data::Float(f) => {
                                if f.fract() == 0.0 {
                                    json!(*f as i64)
                                } else {
                                    json!(f)
                                }
                            }
                            calamine::Data::Int(i) => json!(i),
                            calamine::Data::String(s) => json!(s),
                            other => json!(other.to_string()),
                        })
                        .collect(),
                )
            })
            .collect();
        sheets.push(json!({ "name": name, "rows": rows }));
    }
    Ok(json!({ "kind": "xlsx", "sheets": sheets, "text": sheets_text(&sheets) }))
}

fn sheets_text(sheets: &[Value]) -> String {
    let mut out = String::new();
    for sheet in sheets {
        out.push_str(&format!("## {}\n", sheet["name"].as_str().unwrap_or("")));
        if let Some(rows) = sheet["rows"].as_array() {
            for row in rows {
                if let Some(cells) = row.as_array() {
                    let line: Vec<String> = cells
                        .iter()
                        .map(|c| c.as_str().unwrap_or("").to_string())
                        .collect();
                    out.push_str(&line.join("\t"));
                    out.push('\n');
                }
            }
        }
    }
    out
}

pub fn pdf(path: &std::path::Path) -> Result<Value> {
    let doc =
        lopdf::Document::load(path).with_context(|| format!("load pdf {}", path.display()))?;
    let mut text = String::new();
    for page_id in doc.get_pages().keys() {
        if let Ok(content) = doc.extract_text(&[*page_id]) {
            text.push_str(&content);
            text.push('\n');
        }
    }
    Ok(json!({ "kind": "pdf", "text": text.trim(), "pages": doc.get_pages().len() }))
}

pub fn docx(path: &std::path::Path) -> Result<Value> {
    let file =
        std::fs::File::open(path).with_context(|| format!("open docx {}", path.display()))?;
    let mut archive = zip::ZipArchive::new(file)?;
    let mut document_xml = String::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        if entry.name() == "word/document.xml" {
            use std::io::Read;
            entry.read_to_string(&mut document_xml)?;
            break;
        }
    }
    anyhow::ensure!(!document_xml.is_empty(), "docx missing word/document.xml");

    let paragraphs = extract_docx_paragraphs(&document_xml);
    let text = paragraphs.join("\n");
    Ok(json!({ "kind": "docx", "text": text, "paragraphs": paragraphs.len() }))
}

/// 极简 OOXML 段落提取：按 <w:p> 切分，拼接 <w:t> 文本。
pub fn extract_docx_paragraphs(xml: &str) -> Vec<String> {
    let mut paragraphs = Vec::new();
    for para_xml in xml.split("<w:p ").chain(xml.split("<w:p>").skip(1)) {
        let mut text = String::new();
        let mut rest = para_xml;
        while let Some(start) = rest.find("<w:t") {
            let after = &rest[start..];
            let Some(tag_end) = after.find('>') else {
                break;
            };
            let body = &after[tag_end + 1..];
            let Some(end) = body.find("</w:t>") else {
                break;
            };
            text.push_str(&body[..end]);
            rest = &body[end + 6..];
        }
        if !text.trim().is_empty() {
            paragraphs.push(text);
        }
    }
    paragraphs
}

pub fn csv(path: &std::path::Path) -> Result<Value> {
    let content = std::fs::read_to_string(path)?;
    let mut rows = Vec::new();
    let mut header: Option<Vec<String>> = None;
    for (i, line) in content.lines().enumerate() {
        let cells: Vec<String> = line.split(',').map(|s| s.trim().to_string()).collect();
        if i == 0 {
            header = Some(cells);
        } else if !line.trim().is_empty() {
            rows.push(json!(cells));
        }
    }
    Ok(json!({
        "kind": "csv",
        "header": header.unwrap_or_default(),
        "rows": rows,
        "text": content,
    }))
}

pub fn json_file(path: &std::path::Path) -> Result<Value> {
    let content = std::fs::read_to_string(path)?;
    let value: Value = serde_json::from_str(&content).context("parse json")?;
    Ok(json!({ "kind": "json", "text": content, "data": value }))
}

pub fn markdown(path: &std::path::Path) -> Result<Value> {
    let content = std::fs::read_to_string(path)?;
    let headings: Vec<String> = content
        .lines()
        .filter(|l| l.starts_with('#'))
        .map(String::from)
        .collect();
    Ok(json!({
        "kind": "markdown",
        "text": content,
        "headings": headings,
    }))
}

pub fn plain(path: &std::path::Path) -> Result<Value> {
    let content = std::fs::read_to_string(path)?;
    Ok(json!({ "kind": "text", "text": content }))
}
