//! 文档解析实现。

use anyhow::{Context, Result};
use calamine::Reader;
use serde_json::{json, Value};
use std::io::Read;

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
    let document_xml = read_zip_entry(&mut archive, "word/document.xml")
        .context("docx missing word/document.xml")?;
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
    let images = {
        let rels_xml = read_zip_entry(&mut archive, "word/_rels/document.xml.rels")
            .unwrap_or_default();
        extract_office_images(&document_xml, &rels_xml, "word/media/")
    };
    let mut text = paragraphs.join("\n");
    for image in &images {
        text.push_str(&format!("\n[图片 {}]", image["name"].as_str().unwrap_or("")));
    }
    Ok(json!({
        "kind": "docx",
        "text": text,
        "paragraphs": paragraphs,
        "paragraphMetadata": paragraph_metadata,
        "images": images,
        "imageCount": images.len(),
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

pub(crate) fn find_xml_tag_fragment<'a>(xml: &'a str, tag_name: &str) -> Option<&'a str> {
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

pub(crate) fn extract_xml_attribute(tag: &str, names: &[&str]) -> Option<String> {
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

pub(crate) fn extract_xml_tag_text(xml: &str, tag_name: &str) -> String {
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
    let mut image_count = 0usize;
    for (index, name) in slide_names.iter().enumerate() {
        let xml = read_zip_entry(&mut archive, name)
            .with_context(|| format!("read slide part {name}"))?;
        let rels_name = slide_rels_name(name);
        let rels_xml = read_zip_entry(&mut archive, &rels_name).unwrap_or_default();
        let paragraphs = extract_pptx_paragraphs(&xml);
        let paragraph_items = extract_pptx_paragraph_items(&xml)
            .into_iter()
            .map(|(paragraph_index, item_text)| {
                json!({ "paragraphIndex": paragraph_index, "text": item_text })
            })
            .collect::<Vec<_>>();
        let images = extract_office_images(&xml, &rels_xml, "ppt/media/");
        image_count += images.len();
        let slide = index + 1;
        text.push_str(&format!("## 幻灯片 {slide}\n"));
        for paragraph in &paragraphs {
            text.push_str(paragraph);
            text.push('\n');
        }
        for image in &images {
            text.push_str(&format!(
                "[图片 {}]\n",
                image["name"].as_str().unwrap_or("")
            ));
        }
        slides.push(json!({
            "number": slide,
            "paragraphs": paragraphs,
            "paragraphItems": paragraph_items,
            "images": images,
        }));
    }
    anyhow::ensure!(!slides.is_empty(), "pptx contains no slides");
    Ok(json!({
        "kind": "pptx",
        "text": text.trim(),
        "slides": slides.len(),
        "items": slides,
        "imageCount": image_count,
    }))
}

/// `ppt/slides/slide3.xml` → `ppt/slides/_rels/slide3.xml.rels`
fn slide_rels_name(slide_name: &str) -> String {
    match slide_name.rsplit_once('/') {
        Some((directory, file)) => format!("{directory}/_rels/{file}.rels"),
        None => format!("_rels/{slide_name}.rels"),
    }
}

/// Shared media/image extraction: resolve `r:embed`/`r:link` relationship ids
/// through a `.rels` document into zip part paths.  `media_prefix` is only
/// used to normalize `../media/x.png` style relative targets.
pub(crate) fn extract_office_images(xml: &str, rels_xml: &str, media_prefix: &str) -> Vec<Value> {
    let mut target_by_rid = std::collections::HashMap::new();
    let mut cursor = 0;
    while let Some(relative_start) = rels_xml[cursor..].find("<Relationship ") {
        let start = cursor + relative_start;
        let Some(end) = rels_xml[start..].find("/>") else {
            break;
        };
        let element = &rels_xml[start..start + end];
        if let (Some(id), Some(target)) = (
            extract_xml_attribute(element, &["Id", "id"]),
            extract_xml_attribute(element, &["Target", "target"]),
        ) {
            target_by_rid.insert(id, target);
        }
        cursor = start + end + 1;
    }

    let mut images = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for rid in collect_rid_references(xml, &["r:embed", "r:link"]) {
        if let Some(target) = target_by_rid.get(&rid) {
            let zip_path = normalize_media_target(target, media_prefix);
            if seen.insert(zip_path.clone()) {
                images.push(json!({
                    "name": zip_path.rsplit('/').next().unwrap_or(&zip_path),
                    "zipPath": zip_path,
                }));
            }
        }
    }
    images
}

/// Attribute-style relationship references (`r:embed="rId2"`) in document order.
fn collect_rid_references(xml: &str, rid_names: &[&str]) -> Vec<String> {
    let mut rids = Vec::new();
    for name in rid_names {
        let mut cursor = 0;
        while let Some(relative_start) = xml[cursor..].find(name) {
            let start = cursor + relative_start;
            let rest = &xml[start + name.len()..];
            let Some(rest) = rest.strip_prefix("=\"").or_else(|| rest.strip_prefix("='")) else {
                cursor = start + name.len();
                continue;
            };
            let Some(length) = rest.find(['"', '\'']) else {
                break;
            };
            rids.push(rest[..length].to_string());
            cursor = start + name.len() + 2 + length;
        }
    }
    rids
}

fn normalize_media_target(target: &str, media_prefix: &str) -> String {
    let trimmed = target.trim();
    if let Some(rest) = trimmed.strip_prefix("../") {
        return format!("{media_prefix}{rest}");
    }
    if let Some(rest) = trimmed.strip_prefix("/ppt/") {
        return format!("ppt/{rest}");
    }
    if let Some(rest) = trimmed.strip_prefix("/word/") {
        return format!("word/{rest}");
    }
    if trimmed.starts_with("media/") {
        return format!("{media_prefix}{}", trimmed.trim_start_matches("media/"));
    }
    trimmed.to_string()
}

fn read_zip_entry(archive: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Option<String> {
    let mut entry = archive.by_name(name).ok()?;
    let mut value = String::new();
    entry.read_to_string(&mut value).ok()?;
    Some(value)
}

fn slide_number(name: &str) -> Option<u32> {
    name.strip_prefix("ppt/slides/slide")?
        .strip_suffix(".xml")?
        .parse()
        .ok()
}

/// Byte spans (start, end-exclusive) of every `<prefix>…</close>` element in
/// document order, including self-closing ones.  `open_prefix` (e.g. `<w:p`)
/// must be followed by a name-boundary character so `<w:pPr` is not matched.
pub(crate) fn scan_ooxml_elements(
    xml: &str,
    open_prefix: &str,
    close_tag: &str,
) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut cursor = 0;
    while let Some(relative_start) = xml[cursor..].find(open_prefix) {
        let start = cursor + relative_start;
        let after_name = xml.as_bytes().get(start + open_prefix.len()).copied();
        if !matches!(
            after_name,
            Some(b'>') | Some(b'/') | Some(b' ') | Some(b'\t') | Some(b'\r') | Some(b'\n')
        ) {
            cursor = start + 1;
            continue;
        }

        let Some(open_end) = find_xml_tag_end(xml, start) else {
            break;
        };
        let opening_tag = &xml[start..=open_end];
        let content_start = open_end + 1;
        if opening_tag.trim_end().ends_with("/>") {
            spans.push((start, content_start));
            cursor = content_start;
            continue;
        }
        let Some(relative_close) = xml[content_start..].find(close_tag) else {
            break;
        };
        let end = content_start + relative_close + close_tag.len();
        spans.push((start, end));
        cursor = end;
    }
    spans
}

/// (document-order `<a:p>` index, trimmed text) pairs.  Empty and self-closing
/// paragraphs consume an index but are not emitted, so the indices stay stable
/// for source-aware (surgical) editing.
pub fn extract_pptx_paragraph_items(xml: &str) -> Vec<(usize, String)> {
    let mut items = Vec::new();
    for (index, (start, end)) in scan_ooxml_elements(xml, "<a:p", "</a:p>").into_iter().enumerate()
    {
        let text = extract_xml_tag_text_trimmed_parts(&xml[start..end], "a:t");
        if !text.trim().is_empty() {
            items.push((index, text.trim().to_string()));
        }
    }
    items
}

pub fn extract_pptx_paragraphs(xml: &str) -> Vec<String> {
    extract_pptx_paragraph_items(xml)
        .into_iter()
        .map(|(_, text)| text)
        .collect()
}

/// Extract text from repeated XML tags while applying the same per-run
/// trimming as Electron's PPTX parser.  Word text runs intentionally use the
/// raw helper above because `xml:space="preserve"` is meaningful there.
pub(crate) fn extract_xml_tag_text_trimmed_parts(xml: &str, tag_name: &str) -> String {
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
