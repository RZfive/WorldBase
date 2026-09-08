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
                        .map(|cell| match cell {
                            Value::String(value) => value.clone(),
                            Value::Null => String::new(),
                            value => value.to_string(),
                        })
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
    let page_count = doc.get_pages().len();
    let mut page_items = Vec::with_capacity(page_count);
    let mut text = String::new();
    // Keep `pages` as the historical numeric count.  The richer per-page
    // payload lives in `items`, matching the existing PPTX parser contract
    // (`slides` count + `items` array) without breaking old callers.
    for page_number in doc.get_pages().keys() {
        let page_number = *page_number;
        let page_text = doc
            .extract_text(&[page_number])
            .unwrap_or_default()
            .trim()
            .to_string();
        text.push_str(&page_text);
        text.push('\n');
        page_items.push(json!({
            "number": page_number,
            "text": page_text,
        }));
    }
    Ok(json!({
        "kind": "pdf",
        "text": text.trim(),
        "pages": page_count,
        "items": page_items,
    }))
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

    let paragraph_details = extract_docx_paragraph_details(&document_xml);
    let paragraphs: Vec<String> = paragraph_details
        .iter()
        .map(|paragraph| paragraph.text.clone())
        .collect();
    let paragraph_metadata: Vec<Value> = paragraph_details
        .iter()
        .map(|paragraph| {
            json!({
                "docxPart": "word/document.xml",
                "docxParagraphIndex": paragraph.source_index,
                // Keep the raw parser contract aligned with Electron's
                // Word parser, which always exposes a string (empty when a
                // paragraph has no explicit style) rather than JSON null.
                "paragraphStyle": paragraph.style.as_deref().unwrap_or_default(),
                "type": paragraph.node_type,
                "level": paragraph.level,
            })
        })
        .collect();
    let text = paragraphs.join("\n");
    Ok(json!({
        "kind": "docx",
        "text": text,
        "paragraphs": paragraphs,
        "paragraphMetadata": paragraph_metadata,
    }))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DocxParagraph {
    text: String,
    /// Zero-based index in `word/document.xml`, including empty paragraphs.
    /// This is useful for source-aware editing and matches the Electron node
    /// parser's `docxParagraphIndex` metadata.
    source_index: usize,
    style: Option<String>,
    node_type: &'static str,
    level: u8,
}

/// Extract paragraph text from OOXML while retaining source metadata.
///
/// A plain `str::split("<w:p")` is tempting here, but it also matches
/// `<w:pPr>` and mixes the remainder of the document into the first
/// paragraph.  This scanner recognizes only real `w:p` elements and finds
/// each matching closing tag before extracting its text runs.
fn extract_docx_paragraph_details(xml: &str) -> Vec<DocxParagraph> {
    let mut paragraphs = Vec::new();
    let mut cursor = 0;
    let mut source_index = 0;

    while let Some(relative_start) = xml[cursor..].find("<w:p") {
        let start = cursor + relative_start;
        let after_name = xml.as_bytes().get(start + 4).copied();
        // Do not treat `<w:pPr>` (or another similarly prefixed element) as
        // a paragraph.  Attributes and self-closing tags are valid here.
        if !matches!(
            after_name,
            Some(b'>') | Some(b'/') | Some(b' ') | Some(b'\t') | Some(b'\r') | Some(b'\n')
        ) {
            cursor = start + 3;
            continue;
        }

        let Some(open_end) = find_xml_tag_end(xml, start) else {
            break;
        };
        let opening_tag = &xml[start..=open_end];
        let content_start = open_end + 1;
        let self_closing = opening_tag.trim_end().ends_with("/>");
        let (content_end, next_cursor) = if self_closing {
            (content_start, content_start)
        } else {
            let Some(relative_close) = xml[content_start..].find("</w:p>") else {
                // Malformed/truncated XML: do not fabricate a paragraph from
                // the rest of the document.
                break;
            };
            let content_end = content_start + relative_close;
            (content_end, content_end + "</w:p>".len())
        };
        let paragraph_xml = &xml[content_start..content_end];
        let text = extract_xml_tag_text(paragraph_xml, "w:t");
        let style = find_xml_tag_fragment(paragraph_xml, "w:pStyle")
            .and_then(|tag| extract_xml_attribute(tag, &["w:val", "val"]));
        let level = style.as_deref().and_then(docx_heading_level).unwrap_or(0);
        let is_list = contains_xml_tag(paragraph_xml, "w:numPr");
        let node_type = if level > 0 {
            "heading"
        } else if is_list {
            "list_item"
        } else {
            "paragraph"
        };

        // Match the Electron parser: empty paragraphs are not exposed as
        // selectable nodes, but still advance the source paragraph index.
        if !text.trim().is_empty() {
            paragraphs.push(DocxParagraph {
                text,
                source_index,
                style,
                node_type,
                level,
            });
        }
        source_index += 1;
        cursor = next_cursor;
    }

    paragraphs
}

/// Extract non-empty OOXML paragraph text.  Kept public for callers that only
/// need the backward-compatible string representation.
pub fn extract_docx_paragraphs(xml: &str) -> Vec<String> {
    extract_docx_paragraph_details(xml)
        .into_iter()
        .map(|paragraph| paragraph.text)
        .collect()
}

fn find_xml_tag_end(xml: &str, start: usize) -> Option<usize> {
    let bytes = xml.as_bytes();
    let mut quote = None;
    for (offset, byte) in bytes.iter().enumerate().skip(start + 1) {
        match quote {
            Some(delimiter) if *byte == delimiter => quote = None,
            Some(_) => {}
            None if *byte == b'\'' || *byte == b'"' => quote = Some(*byte),
            None if *byte == b'>' => return Some(offset),
            None => {}
        }
    }
    None
}

fn find_xml_tag_fragment<'a>(xml: &'a str, tag_name: &str) -> Option<&'a str> {
    let mut cursor = 0;
    while let Some(relative_start) = xml[cursor..].find(&format!("<{tag_name}")) {
        let start = cursor + relative_start;
        let after_name = xml.as_bytes().get(start + tag_name.len() + 1).copied();
        if !matches!(
            after_name,
            Some(b'>') | Some(b'/') | Some(b' ') | Some(b'\t') | Some(b'\r') | Some(b'\n')
        ) {
            cursor = start + tag_name.len() + 1;
            continue;
        }
        let end = find_xml_tag_end(xml, start)?;
        return Some(&xml[start..=end]);
    }
    None
}

fn contains_xml_tag(xml: &str, tag_name: &str) -> bool {
    find_xml_tag_fragment(xml, tag_name).is_some()
}

fn extract_xml_attribute(tag: &str, names: &[&str]) -> Option<String> {
    for name in names {
        let mut cursor = 0;
        while let Some(relative_start) = tag[cursor..].find(name) {
            let start = cursor + relative_start;
            let has_boundary = start == 0
                || tag[..start]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_whitespace);
            if !has_boundary {
                cursor = start + name.len();
                continue;
            }
            let after_name = &tag[start + name.len()..];
            let after_name = after_name.trim_start_matches(char::is_whitespace);
            let Some(after_equals) = after_name.strip_prefix('=') else {
                cursor = start + name.len();
                continue;
            };
            let after_equals = after_equals.trim_start_matches(char::is_whitespace);
            let Some(delimiter) = after_equals.chars().next() else {
                return None;
            };
            if delimiter != '\'' && delimiter != '"' {
                return None;
            }
            let value = &after_equals[delimiter.len_utf8()..];
            let end = value.find(delimiter)?;
            return Some(decode_xml_text(&value[..end]));
        }
    }
    None
}

fn extract_xml_tag_text(xml: &str, tag_name: &str) -> String {
    let mut text = String::new();
    let mut cursor = 0;
    while let Some(relative_start) = xml[cursor..].find(&format!("<{tag_name}")) {
        let start = cursor + relative_start;
        let after_name = xml.as_bytes().get(start + tag_name.len() + 1).copied();
        if !matches!(
            after_name,
            Some(b'>') | Some(b'/') | Some(b' ') | Some(b'\t') | Some(b'\r') | Some(b'\n')
        ) {
            cursor = start + tag_name.len() + 1;
            continue;
        }
        let Some(tag_end) = find_xml_tag_end(xml, start) else {
            break;
        };
        let body_start = tag_end + 1;
        let close_tag = format!("</{tag_name}>");
        let Some(relative_end) = xml[body_start..].find(&close_tag) else {
            break;
        };
        let body_end = body_start + relative_end;
        text.push_str(&decode_xml_text(&xml[body_start..body_end]));
        cursor = body_end + close_tag.len();
    }
    text
}

fn docx_heading_level(style: &str) -> Option<u8> {
    let lower = style.to_ascii_lowercase();
    // Match Electron's `/heading\s*([1-6])/i` behavior rather than requiring
    // the style value to start with "Heading".  Word templates often prefix
    // built-in styles (for example, "My Heading 2").
    let mut cursor = 0;
    while let Some(relative_start) = lower[cursor..].find("heading") {
        let start = cursor + relative_start;
        let suffix = lower[start + "heading".len()..].trim_start();
        if let Some(level) = suffix.chars().next().and_then(|value| value.to_digit(10)) {
            let level = level as u8;
            if (1..=6).contains(&level) {
                return Some(level);
            }
        }
        cursor = start + "heading".len();
    }
    None
}

pub fn pptx(path: &std::path::Path) -> Result<Value> {
    let file =
        std::fs::File::open(path).with_context(|| format!("open pptx {}", path.display()))?;
    let mut archive = zip::ZipArchive::new(file)?;
    let mut slide_names: Vec<String> = archive
        .file_names()
        .filter(|name| {
            name.starts_with("ppt/slides/slide")
                && name.ends_with(".xml")
                && slide_number(name).is_some()
        })
        .map(ToOwned::to_owned)
        .collect();
    slide_names.sort_by_key(|name| slide_number(name).unwrap_or(u32::MAX));

    let mut slides = Vec::new();
    let mut text = String::new();
    for (index, name) in slide_names.iter().enumerate() {
        let mut entry = archive.by_name(name)?;
        let mut xml = String::new();
        use std::io::Read;
        entry.read_to_string(&mut xml)?;
        let paragraphs = extract_pptx_paragraphs(&xml);
        let slide = index + 1;
        text.push_str(&format!("## 幻灯片 {slide}\n"));
        for paragraph in &paragraphs {
            text.push_str(paragraph);
            text.push('\n');
        }
        slides.push(json!({ "number": slide, "paragraphs": paragraphs }));
    }
    anyhow::ensure!(!slides.is_empty(), "pptx contains no slides");
    Ok(json!({
        "kind": "pptx",
        "text": text.trim(),
        "slides": slides.len(),
        "items": slides,
    }))
}

fn slide_number(name: &str) -> Option<u32> {
    name.strip_prefix("ppt/slides/slide")?
        .strip_suffix(".xml")?
        .parse()
        .ok()
}

pub fn extract_pptx_paragraphs(xml: &str) -> Vec<String> {
    let mut paragraphs = Vec::new();
    let mut cursor = 0;
    while let Some(relative_start) = xml[cursor..].find("<a:p") {
        let start = cursor + relative_start;
        let after_name = xml.as_bytes().get(start + 4).copied();
        // `<a:pPr>` and similar tags are not paragraphs.  The previous
        // split-based implementation treated them as paragraph starts and
        // consequently duplicated all following text.
        if !matches!(
            after_name,
            Some(b'>') | Some(b'/') | Some(b' ') | Some(b'\t') | Some(b'\r') | Some(b'\n')
        ) {
            cursor = start + 3;
            continue;
        }

        let Some(open_end) = find_xml_tag_end(xml, start) else {
            break;
        };
        let opening_tag = &xml[start..=open_end];
        let content_start = open_end + 1;
        if opening_tag.trim_end().ends_with("/>") {
            cursor = content_start;
            continue;
        }
        let Some(relative_close) = xml[content_start..].find("</a:p>") else {
            break;
        };
        let content_end = content_start + relative_close;
        let text = extract_xml_tag_text_trimmed_parts(&xml[content_start..content_end], "a:t");
        if !text.trim().is_empty() {
            paragraphs.push(text.trim().to_string());
        }
        cursor = content_end + "</a:p>".len();
    }
    paragraphs
}

/// Extract text from repeated XML tags while applying the same per-run
/// trimming as Electron's PPTX parser.  Word text runs intentionally use the
/// raw helper above because `xml:space="preserve"` is meaningful there.
fn extract_xml_tag_text_trimmed_parts(xml: &str, tag_name: &str) -> String {
    let mut text = String::new();
    let mut cursor = 0;
    while let Some(relative_start) = xml[cursor..].find(&format!("<{tag_name}")) {
        let start = cursor + relative_start;
        let after_name = xml.as_bytes().get(start + tag_name.len() + 1).copied();
        if !matches!(
            after_name,
            Some(b'>') | Some(b'/') | Some(b' ') | Some(b'\t') | Some(b'\r') | Some(b'\n')
        ) {
            cursor = start + tag_name.len() + 1;
            continue;
        }
        let Some(tag_end) = find_xml_tag_end(xml, start) else {
            break;
        };
        let body_start = tag_end + 1;
        let close_tag = format!("</{tag_name}>");
        let Some(relative_end) = xml[body_start..].find(&close_tag) else {
            break;
        };
        let body_end = body_start + relative_end;
        text.push_str(decode_xml_text(&xml[body_start..body_end]).trim());
        cursor = body_end + close_tag.len();
    }
    text
}

fn decode_xml_text(value: &str) -> String {
    // OOXML text commonly contains the five XML named entities, but exported
    // files also use decimal/hex numeric entities.  Decode one entity at a
    // time so `&amp;lt;` becomes the literal `&lt;`, just like an XML parser,
    // rather than being decoded twice by chained string replacements.
    let mut decoded = String::with_capacity(value.len());
    let mut cursor = 0;
    while let Some(relative_start) = value[cursor..].find('&') {
        let start = cursor + relative_start;
        decoded.push_str(&value[cursor..start]);
        let Some(relative_end) = value[start..].find(';') else {
            decoded.push_str(&value[start..]);
            return decoded;
        };
        let end = start + relative_end;
        let entity = &value[start + 1..end];
        if let Some(character) = decode_xml_entity(entity) {
            decoded.push(character);
        } else {
            decoded.push_str(&value[start..=end]);
        }
        cursor = end + 1;
    }
    decoded.push_str(&value[cursor..]);
    decoded
}

fn decode_xml_entity(entity: &str) -> Option<char> {
    match entity {
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "amp" => Some('&'),
        value
            if value
                .strip_prefix("#x")
                .or_else(|| value.strip_prefix("#X"))
                .is_some() =>
        {
            let digits = value
                .strip_prefix("#x")
                .or_else(|| value.strip_prefix("#X"))?;
            u32::from_str_radix(digits, 16)
                .ok()
                .and_then(char::from_u32)
        }
        value if value.strip_prefix('#').is_some() => value
            .strip_prefix('#')?
            .parse::<u32>()
            .ok()
            .and_then(char::from_u32),
        _ => None,
    }
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
