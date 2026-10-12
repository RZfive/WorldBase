//! 手术式 Office 编辑：复制原包 → 只改目标 XML → 其余部件原样保留。
//!
//! 与 `edit.rs` 的全文重建不同，这里以「原文件 + 操作列表」为输入：
//! media / theme / styles 等未触及部件按字节复制，图片与既有样式因此
//! 不会因为一次 AI 修改而丢失。段落定位使用 `parse` 暴露的稳定索引
//! （document-order 元素序，包含空段落）。

use anyhow::{Context, Result, bail};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::edit::{text_shape, xml_escape};
use crate::parse;

const EMU_PER_INCH: f64 = 914400.0;
const RELATIONSHIP_NAMESPACE: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
const IMAGE_RELATIONSHIP_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
const SLIDE_RELATIONSHIP_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";

/// 段落样式（docx 插入用），与 `edit::DocBlock` 语义对齐。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParagraphStyle {
    Plain,
    Heading(u32),
    Bullet,
    Bold,
}

/// 一条对原文件的保真编辑操作。
#[derive(Debug, Clone, PartialEq)]
pub enum OfficeOp {
    DocxReplaceText {
        /// document-order `w:p` 索引（0 基，含空段落），对齐 parse 的 docxParagraphIndex
        paragraph_index: usize,
        after_text: String,
        expect_before: Option<String>,
    },
    DocxInsertParagraphAfter {
        /// 索引基于前一条操作应用后的状态；`usize::MAX` 表示追加到文末
        paragraph_index: usize,
        text: String,
        style: ParagraphStyle,
    },
    DocxDeleteParagraph {
        paragraph_index: usize,
    },
    DocxInsertImage {
        paragraph_index: usize,
        image_path: PathBuf,
        width_inches: Option<f64>,
    },
    PptxReplaceText {
        /// 1 基幻灯片序号（演示顺序，来自 presentation.xml sldIdLst）
        slide: u32,
        /// 该 slide 内 document-order `a:p` 索引（0 基，含空段落）
        paragraph_index: usize,
        after_text: String,
        expect_before: Option<String>,
    },
    PptxInsertImage {
        slide: u32,
        image_path: PathBuf,
        width_inches: Option<f64>,
    },
    PptxInsertSlideAfter {
        /// 0 表示插到最前；1 表示插到第 1 页之后
        index: u32,
        title: String,
        content: Vec<String>,
    },
    PptxDeleteSlide {
        index: u32,
    },
}

impl OfficeOp {
    pub fn family(&self) -> &'static str {
        match self {
            Self::DocxReplaceText { .. }
            | Self::DocxInsertParagraphAfter { .. }
            | Self::DocxDeleteParagraph { .. }
            | Self::DocxInsertImage { .. } => "docx",
            Self::PptxReplaceText { .. }
            | Self::PptxInsertImage { .. }
            | Self::PptxInsertSlideAfter { .. }
            | Self::PptxDeleteSlide { .. } => "pptx",
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::DocxReplaceText { .. } => "docx_replace_text",
            Self::DocxInsertParagraphAfter { .. } => "docx_insert_paragraph_after",
            Self::DocxDeleteParagraph { .. } => "docx_delete_paragraph",
            Self::DocxInsertImage { .. } => "docx_insert_image",
            Self::PptxReplaceText { .. } => "pptx_replace_text",
            Self::PptxInsertImage { .. } => "pptx_insert_image",
            Self::PptxInsertSlideAfter { .. } => "pptx_insert_slide_after",
            Self::PptxDeleteSlide { .. } => "pptx_delete_slide",
        }
    }
}

/// 把 `source` 复制为 `output` 并按顺序应用 `ops`，写后做完整性自检。
pub fn apply_ops(source: &Path, output: &Path, ops: &[OfficeOp]) -> Result<()> {
    anyhow::ensure!(!ops.is_empty(), "没有可应用的编辑操作");
    let family = ops[0].family();
    anyhow::ensure!(
        ops.iter().all(|op| op.family() == family),
        "一次编辑只能包含同一种文档格式的操作（docx 或 pptx）"
    );

    let mut package = ZipPackage::load(source)?;
    match family {
        "docx" => apply_docx_ops(&mut package, ops)?,
        "pptx" => apply_pptx_ops(&mut package, ops)?,
        other => bail!("不支持的手术式编辑格式: {other}"),
    }
    package.save(output)?;
    verify_package(output, family)?;
    Ok(())
}

/// 判断 zip 部件是否为图片媒体（dataLossRisk 检测用）。
pub fn is_media_part(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let is_media_directory = lower.starts_with("ppt/media/")
        || lower.starts_with("word/media/")
        || lower.starts_with("xl/media/");
    let extension = lower.rsplit('.').next().unwrap_or("");
    is_media_directory
        && matches!(
            extension,
            "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" | "tiff" | "tif" | "emf" | "wmf" | "svg"
        )
}

/// 统计文件内的图片媒体部件数量（全文重建会全部丢失的部分）。
pub fn count_media_parts(path: &Path) -> Result<usize> {
    let package = ZipPackage::load(path)?;
    Ok(package
        .entries
        .iter()
        .filter(|(name, _)| is_media_part(name))
        .count())
}

// ---------------------------------------------------------------------------
// Zip package：加载到内存 → 修改 → 原样写回（保序）
// ---------------------------------------------------------------------------

struct ZipPackage {
    entries: Vec<(String, Vec<u8>)>,
}

impl ZipPackage {
    fn load(source: &Path) -> Result<Self> {
        let file =
            std::fs::File::open(source).with_context(|| format!("open {}", source.display()))?;
        let mut archive = zip::ZipArchive::new(file)
            .with_context(|| format!("read zip {}", source.display()))?;
        let mut entries = Vec::with_capacity(archive.len());
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index)?;
            if entry.is_dir() {
                continue;
            }
            let name = entry.name().to_string();
            let mut bytes = Vec::with_capacity(entry.size() as usize);
            entry.read_to_end(&mut bytes)?;
            entries.push((name, bytes));
        }
        Ok(Self { entries })
    }

    fn get(&self, name: &str) -> Option<&[u8]> {
        self.entries
            .iter()
            .find(|(existing, _)| existing == name)
            .map(|(_, bytes)| bytes.as_slice())
    }

    fn get_string(&self, name: &str) -> Option<String> {
        self.get(name).map(|bytes| String::from_utf8_lossy(bytes).into_owned())
    }

    fn set(&mut self, name: &str, bytes: Vec<u8>) {
        if let Some(slot) = self.entries.iter_mut().find(|(existing, _)| existing == name) {
            slot.1 = bytes;
        } else {
            self.entries.push((name.to_string(), bytes));
        }
    }

    fn remove(&mut self, name: &str) -> bool {
        let before = self.entries.len();
        self.entries.retain(|(existing, _)| existing != name);
        self.entries.len() != before
    }

    fn names(&self) -> Vec<String> {
        self.entries.iter().map(|(name, _)| name.clone()).collect()
    }

    fn save(&self, output: &Path) -> Result<()> {
        let file =
            std::fs::File::create(output).with_context(|| format!("create {}", output.display()))?;
        let mut writer = zip::ZipWriter::new(file);
        let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
        for (name, bytes) in &self.entries {
            writer
                .start_file(name.as_str(), options)
                .with_context(|| format!("zip entry {name}"))?;
            writer.write_all(bytes)?;
        }
        writer.finish()?;
        Ok(())
    }
}

fn verify_package(output: &Path, family: &str) -> Result<()> {
    let package = ZipPackage::load(output)?;
    match family {
        "docx" => {
            let document = package
                .get_string("word/document.xml")
                .context("校验失败：输出缺少 word/document.xml")?;
            anyhow::ensure!(
                document.contains("</w:document>"),
                "校验失败：document.xml 结构不完整"
            );
        }
        "pptx" => {
            let presentation = package
                .get_string("ppt/presentation.xml")
                .context("校验失败：输出缺少 ppt/presentation.xml")?;
            anyhow::ensure!(
                presentation.contains("</p:presentation>"),
                "校验失败：presentation.xml 结构不完整"
            );
            let declared = presentation
                .match_indices("<p:sldId ")
                .count();
            let resolved = resolve_slide_parts(&package)?.len();
            anyhow::ensure!(
                declared == resolved,
                "校验失败：sldIdLst 声明 {decl} 页但实际存在 {resolved} 个 slide 部件",
                decl = declared
            );
        }
        other => bail!("不支持的校验格式: {other}"),
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// docx 手术
// ---------------------------------------------------------------------------

fn apply_docx_ops(package: &mut ZipPackage, ops: &[OfficeOp]) -> Result<()> {
    let mut xml = package
        .get_string("word/document.xml")
        .context("docx missing word/document.xml")?;
    let mut drawing_sequence = 0usize;

    for op in ops {
        match op {
            OfficeOp::DocxReplaceText { paragraph_index, after_text, expect_before } => {
                let spans = parse::scan_ooxml_elements(&xml, "<w:p", "</w:p>");
                let (start, end) = paragraph_span(&spans, *paragraph_index)?;
                let paragraph = xml[start..end].to_string();
                let current = parse::extract_xml_tag_text(&paragraph, "w:t");
                ensure_expect_before(expect_before, &current)?;
                xml.replace_range(start..end, &replace_docx_paragraph_text(&paragraph, after_text));
            }
            OfficeOp::DocxInsertParagraphAfter { paragraph_index, text, style } => {
                let element = docx_paragraph_xml(text, *style);
                insert_after_docx_paragraph(&mut xml, *paragraph_index, &element)?;
            }
            OfficeOp::DocxDeleteParagraph { paragraph_index } => {
                let spans = parse::scan_ooxml_elements(&xml, "<w:p", "</w:p>");
                let (start, end) = paragraph_span(&spans, *paragraph_index)?;
                xml.replace_range(start..end, "");
            }
            OfficeOp::DocxInsertImage { paragraph_index, image_path, width_inches } => {
                drawing_sequence += 1;
                insert_docx_image(
                    package,
                    &mut xml,
                    *paragraph_index,
                    image_path,
                    *width_inches,
                    drawing_sequence,
                )?;
            }
            other => bail!("内部错误：{} 操作进入了 docx 手术分支", other.kind()),
        }
    }

    package.set("word/document.xml", xml.into_bytes());
    Ok(())
}

fn paragraph_span(spans: &[(usize, usize)], index: usize) -> Result<(usize, usize)> {
    spans.get(index).copied().ok_or_else(|| {
        anyhow::anyhow!(
            "段落索引 {index} 越界：文档共有 {} 个段落（索引从 0 开始）",
            spans.len()
        )
    })
}

/// 段内文本替换：首 `<w:t>` 写入新文本，其余 `<w:t>` 清空（保留 run 结构）。
fn replace_docx_paragraph_text(paragraph: &str, after_text: &str) -> String {
    let mut updated = paragraph.to_string();
    let spans = parse::scan_ooxml_elements(paragraph, "<w:t", "</w:t>");
    if spans.is_empty() {
        let run = format!(
            "<w:r><w:t xml:space=\"preserve\">{}</w:t></w:r>",
            xml_escape(after_text)
        );
        if let Some(position) = updated.rfind("</w:p>") {
            updated.insert_str(position, &run);
        } else {
            // 自闭合段落 `<w:p/>`：展开为完整元素
            if let Some(position) = updated.rfind("/>") {
                updated.replace_range(position..position + 2, ">");
                updated.push_str(&run);
                updated.push_str("</w:p>");
            }
        }
        return updated;
    }

    for (start, end) in spans.iter().rev() {
        let replacement = if *start == spans[0].0 {
            format!("<w:t xml:space=\"preserve\">{}</w:t>", xml_escape(after_text))
        } else {
            "<w:t xml:space=\"preserve\"/>".to_string()
        };
        updated.replace_range(*start..*end, &replacement);
    }
    updated
}

fn docx_paragraph_xml(text: &str, style: ParagraphStyle) -> String {
    let escaped = xml_escape(text);
    let properties = match style {
        ParagraphStyle::Heading(level) => {
            format!("<w:pPr><w:pStyle w:val=\"Heading{level}\"/></w:pPr>")
        }
        ParagraphStyle::Bullet => {
            "<w:pPr><w:numPr><w:ilvl w:val=\"0\"/></w:numPr></w:pPr>".to_string()
        }
        ParagraphStyle::Plain | ParagraphStyle::Bold => String::new(),
    };
    let bold = if style == ParagraphStyle::Bold { "<w:rPr><w:b/></w:rPr>" } else { "" };
    format!("<w:p>{properties}<w:r>{bold}<w:t xml:space=\"preserve\">{escaped}</w:t></w:r></w:p>")
}

fn insert_after_docx_paragraph(
    xml: &mut String,
    paragraph_index: usize,
    element: &str,
) -> Result<()> {
    let spans = parse::scan_ooxml_elements(xml, "<w:p", "</w:p>");
    if let Some((_, end)) = spans.get(paragraph_index).copied() {
        xml.insert_str(end, element);
        return Ok(());
    }
    // usize::MAX = 追加到文档末尾；其余越界索引一律报错。
    anyhow::ensure!(
        paragraph_index == usize::MAX,
        "段落索引 {paragraph_index} 越界：文档共有 {} 个段落",
        spans.len()
    );
    match xml.rfind("</w:body>") {
        Some(position) => xml.insert_str(position, element),
        None => xml.push_str(element),
    }
    Ok(())
}

struct ImageBlob {
    bytes: Vec<u8>,
    mime: &'static str,
    extension: &'static str,
    width: u32,
    height: u32,
}

/// 仅依赖文件头的 PNG/JPEG 尺寸探测，避免引入重量级图像解码依赖。
fn read_image(path: &Path) -> Result<ImageBlob> {
    let bytes = std::fs::read(path)
        .with_context(|| format!("read image {}", path.display()))?;
    if bytes.len() >= 24 && bytes[..8] == [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] {
        let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
        let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
        anyhow::ensure!(width > 0 && height > 0, "PNG 图片尺寸无效: {}", path.display());
        return Ok(ImageBlob { bytes, mime: "image/png", extension: "png", width, height });
    }
    if bytes.len() >= 4 && bytes[..2] == [0xFF, 0xD8] {
        if let Some((width, height)) = probe_jpeg_dimensions(&bytes) {
            return Ok(ImageBlob { bytes, mime: "image/jpeg", extension: "jpg", width, height });
        }
        bail!("无法解析 JPEG 图片尺寸: {}", path.display());
    }
    bail!("仅支持 PNG 和 JPEG 图片: {}", path.display());
}

fn probe_jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut cursor = 2usize;
    while cursor + 9 <= bytes.len() {
        if bytes[cursor] != 0xFF {
            cursor += 1;
            continue;
        }
        let marker = bytes[cursor + 1];
        if (0xC0..=0xCF).contains(&marker) && ![0xC4, 0xC8, 0xCC].contains(&marker) {
            let height = u16::from_be_bytes(bytes[cursor + 5..cursor + 7].try_into().ok()?) as u32;
            let width = u16::from_be_bytes(bytes[cursor + 7..cursor + 9].try_into().ok()?) as u32;
            return Some((width, height));
        }
        let is_standalone = (0xD0..=0xD9).contains(&marker) || marker == 0x01;
        if is_standalone {
            cursor += 2;
            continue;
        }
        let length = u16::from_be_bytes(bytes.get(cursor + 2..cursor + 4)?.try_into().ok()?) as usize;
        cursor += 2 + length;
    }
    None
}

fn next_media_name(package: &ZipPackage, directory: &str, extension: &str) -> String {
    let mut index = 1;
    while package
        .get(&format!("{directory}/edit-image-{index}.{extension}"))
        .is_some()
    {
        index += 1;
    }
    format!("edit-image-{index}.{extension}")
}

fn ensure_content_type_default(xml: &str, extension: &str, mime: &str) -> Result<String> {
    let probe = format!("Extension=\"{extension}\"");
    if xml.contains(&probe) {
        return Ok(xml.to_string());
    }
    let element = format!("<Default Extension=\"{extension}\" ContentType=\"{mime}\"/>");
    match xml.find("</Types>") {
        Some(position) => {
            let mut updated = xml.to_string();
            updated.insert_str(position, &element);
            Ok(updated)
        }
        None => bail!("[Content_Types].xml 结构无效"),
    }
}

fn append_relationship(xml: &str, relationship: &str) -> Result<String> {
    match xml.find("</Relationships>") {
        Some(position) => {
            let mut updated = xml.to_string();
            updated.insert_str(position, relationship);
            Ok(updated)
        }
        None => bail!("relationships XML 结构无效"),
    }
}

const WORD_IMAGE_PARAGRAPH_TEMPLATE: &str = concat!(
    "<w:p><w:r><w:drawing>",
    "<wp:inline xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\">",
    "<wp:extent cx=\"{CX}\" cy=\"{CY}\"/>",
    "<wp:docPr id=\"{ID}\" name=\"{NAME}\"/>",
    "<a:graphic xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\">",
    "<a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">",
    "<pic:pic xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">",
    "<pic:nvPicPr><pic:cNvPr id=\"{ID}\" name=\"{NAME}\"/><pic:cNvPicPr/></pic:nvPicPr>",
    "<pic:blipFill><a:blip r:embed=\"{RID}\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>",
    "<pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{CX}\" cy=\"{CY}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr>",
    "</pic:pic></a:graphicData></a:graphic>",
    "</wp:inline></w:drawing></w:r></w:p>"
);

fn insert_docx_image(
    package: &mut ZipPackage,
    xml: &mut String,
    paragraph_index: usize,
    image_path: &Path,
    width_inches: Option<f64>,
    drawing_sequence: usize,
) -> Result<()> {
    let image = read_image(image_path)?;
    let media_name = next_media_name(package, "word/media", image.extension);
    package.set(&format!("word/media/{media_name}"), image.bytes.clone());

    let rels_path = "word/_rels/document.xml.rels";
    let rels_xml = package.get_string(rels_path).unwrap_or_else(|| {
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
             <Relationships xmlns=\"{RELATIONSHIP_NAMESPACE}\"></Relationships>"
        )
    });
    let relationship_id = next_relationship_id(&rels_xml);
    let updated_rels = append_relationship(
        &rels_xml,
        &format!(
            "<Relationship Id=\"{relationship_id}\" Type=\"{IMAGE_RELATIONSHIP_TYPE}\" Target=\"media/{media_name}\"/>"
        ),
    )?;
    package.set(rels_path, updated_rels.into_bytes());

    let content_types = package
        .get_string("[Content_Types].xml")
        .context("docx missing [Content_Types].xml")?;
    let updated_content_types =
        ensure_content_type_default(&content_types, image.extension, image.mime)?;
    package.set("[Content_Types].xml", updated_content_types.into_bytes());

    let width_in = width_inches.unwrap_or(4.0).clamp(0.5, 6.5);
    let height_in = width_in * (image.height as f64 / image.width as f64);
    let element = WORD_IMAGE_PARAGRAPH_TEMPLATE
        .replace("{CX}", &format!("{}", (width_in * EMU_PER_INCH) as u64))
        .replace("{CY}", &format!("{}", (height_in * EMU_PER_INCH) as u64))
        .replace("{ID}", &format!("{}", 10000 + drawing_sequence))
        .replace("{NAME}", &xml_escape(&media_name))
        .replace("{RID}", &relationship_id);
    insert_after_docx_paragraph(xml, paragraph_index, &element)?;
    Ok(())
}

fn next_relationship_id(rels_xml: &str) -> String {
    let mut used = std::collections::HashSet::new();
    let mut cursor = 0;
    while let Some(relative_start) = rels_xml[cursor..].find("<Relationship ") {
        let start = cursor + relative_start;
        let Some(end) = rels_xml[start..].find('>') else {
            break;
        };
        let element = &rels_xml[start..=start + end];
        if let Some(id) = attribute_value(element, "Id") {
            used.insert(id);
        }
        cursor = start + 1;
    }
    let mut index = 1;
    while used.contains(&format!("rId{index}")) {
        index += 1;
    }
    format!("rId{index}")
}

fn attribute_value(element: &str, name: &str) -> Option<String> {
    let probe = format!("{name}=");
    let position = element.find(&probe)?;
    let rest = element[position + probe.len()..].trim_start();
    let delimiter = rest.chars().next()?;
    if delimiter != '"' && delimiter != '\'' {
        return None;
    }
    let end = rest[1..].find(delimiter)? + 1;
    Some(rest[1..end].to_string())
}

// ---------------------------------------------------------------------------
// pptx 手术
// ---------------------------------------------------------------------------

/// 按 presentation.xml 的 sldIdLst 顺序解析 slide 部件路径。
fn resolve_slide_parts(package: &ZipPackage) -> Result<Vec<String>> {
    let presentation = package
        .get_string("ppt/presentation.xml")
        .context("pptx missing ppt/presentation.xml")?;
    let rels_xml = package
        .get_string("ppt/_rels/presentation.xml.rels")
        .unwrap_or_default();

    let mut target_by_rid = std::collections::HashMap::new();
    let mut cursor = 0;
    while let Some(relative_start) = rels_xml[cursor..].find("<Relationship ") {
        let start = cursor + relative_start;
        let Some(end) = rels_xml[start..].find('>') else {
            break;
        };
        let element = &rels_xml[start..=start + end];
        if let (Some(id), Some(target)) = (
            attribute_value(element, "Id"),
            attribute_value(element, "Target"),
        ) {
            target_by_rid.insert(id, target);
        }
        cursor = start + 1;
    }

    let mut ordered = Vec::new();
    if let Some((list_start, list_end)) = section_bounds(&presentation, "<p:sldIdLst>", "</p:sldIdLst>")
    {
        let list = &presentation[list_start..list_end];
        let mut tag_cursor = 0;
        while let Some(relative_start) = list[tag_cursor..].find("<p:sldId ") {
            let start = tag_cursor + relative_start;
            let Some(tag_end) = list[start..].find('>') else {
                break;
            };
            let element = &list[start..=start + tag_end];
            let rid = attribute_value(element, "r:id")
                .or_else(|| attribute_value(element, "id"));
            if let Some(rid) = rid {
                if let Some(target) = target_by_rid.get(&rid) {
                    ordered.push(normalize_part_target("ppt", target));
                }
            }
            tag_cursor = start + 1;
        }
    }

    if ordered.is_empty() {
        // 兜底：文件序号顺序（生成器产物或 sldIdLst 缺失的非标准包）
        let mut names: Vec<(u32, String)> = package
            .names()
            .into_iter()
            .filter_map(|name| parse_slide_number(&name).map(|number| (number, name)))
            .collect();
        names.sort_by_key(|(number, _)| *number);
        ordered = names.into_iter().map(|(_, name)| name).collect();
    }
    Ok(ordered)
}

fn parse_slide_number(name: &str) -> Option<u32> {
    let rest = name.strip_prefix("ppt/slides/slide")?;
    let number = rest.strip_suffix(".xml")?;
    number.parse().ok()
}

fn normalize_part_target(base: &str, target: &str) -> String {
    let trimmed = target.trim();
    if let Some(rest) = trimmed.strip_prefix('/') {
        return rest.to_string();
    }
    let mut parts: Vec<&str> = Vec::new();
    for segment in trimmed.split('/') {
        match segment {
            "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    format!("{base}/{}", parts.join("/"))
}

fn section_bounds(xml: &str, open: &str, close: &str) -> Option<(usize, usize)> {
    let start = xml.find(open)? + open.len();
    let end = xml[start..].find(close)? + start;
    Some((start, end))
}

fn slide_rels_part(slide_part: &str) -> String {
    match slide_part.rsplit_once('/') {
        Some((directory, file)) => format!("{directory}/_rels/{file}.rels"),
        None => format!("_rels/{slide_part}.rels"),
    }
}

fn apply_pptx_ops(package: &mut ZipPackage, ops: &[OfficeOp]) -> Result<()> {
    let slide_parts = resolve_slide_parts(package)?;
    let mut pic_sequence = 0usize;

    for op in ops {
        match op {
            OfficeOp::PptxReplaceText { slide, paragraph_index, after_text, expect_before } => {
                let slide_part = slide_part_at(&slide_parts, *slide)?;
                let mut xml = package
                    .get_string(&slide_part)
                    .with_context(|| format!("read {slide_part}"))?;
                let spans = parse::scan_ooxml_elements(&xml, "<a:p", "</a:p>");
                let (start, end) = paragraph_span(&spans, *paragraph_index)?;
                let paragraph = xml[start..end].to_string();
                let current = parse::extract_xml_tag_text_trimmed_parts(&paragraph, "a:t");
                ensure_expect_before(expect_before, &current)?;
                xml.replace_range(start..end, &replace_pptx_paragraph_text(&paragraph, after_text));
                package.set(&slide_part, xml.into_bytes());
            }
            OfficeOp::PptxInsertImage { slide, image_path, width_inches } => {
                let slide_part = slide_part_at(&slide_parts, *slide)?;
                pic_sequence += 1;
                insert_pptx_image(package, &slide_part, image_path, *width_inches, pic_sequence)?;
            }
            OfficeOp::PptxInsertSlideAfter { index, title, content } => {
                insert_pptx_slide(package, *index, title, content)?;
            }
            OfficeOp::PptxDeleteSlide { index } => {
                delete_pptx_slide(package, *index)?;
            }
            other => bail!("内部错误：{} 操作进入了 pptx 手术分支", other.kind()),
        }
    }
    Ok(())
}

fn slide_part_at(slide_parts: &[String], slide: u32) -> Result<String> {
    let index = slide as usize;
    slide_parts.get(index.wrapping_sub(1)).cloned().ok_or_else(|| {
        anyhow::anyhow!(
            "幻灯片序号 {slide} 越界：演示共有 {} 页（从 1 开始）",
            slide_parts.len()
        )
    })
}

/// 首个 `<a:r>` 写入新文本，其余 run 删除（保留 endParaRPr / 段属性）。
fn replace_pptx_paragraph_text(paragraph: &str, after_text: &str) -> String {
    let mut updated = paragraph.to_string();
    let run_spans = parse::scan_ooxml_elements(paragraph, "<a:r", "</a:r>");
    if run_spans.is_empty() {
        let run = format!(
            "<a:r><a:t xml:space=\"preserve\">{}</a:t></a:r>",
            xml_escape(after_text)
        );
        if let Some(position) = updated.rfind("</a:p>") {
            updated.insert_str(position, &run);
        } else if let Some(position) = updated.rfind("/>") {
            updated.replace_range(position..position + 2, ">");
            updated.push_str(&run);
            updated.push_str("</a:p>");
        }
        return updated;
    }

    // 先删后面的 run（降序），再改首 run 的文本。
    for (start, end) in run_spans.iter().skip(1).rev() {
        updated.replace_range(*start..*end, "");
    }
    if let Some((start, end)) = run_spans.first() {
        let first_run = &paragraph[*start..*end];
        let text_spans = parse::scan_ooxml_elements(first_run, "<a:t", "</a:t>");
        let mut replaced = first_run.to_string();
        if let Some((text_start, text_end)) = text_spans.first() {
            replaced.replace_range(
                *text_start..*text_end,
                &format!("<a:t xml:space=\"preserve\">{}</a:t>", xml_escape(after_text)),
            );
        } else if let Some(position) = replaced.rfind("</a:r>") {
            replaced.insert_str(
                position,
                &format!("<a:t xml:space=\"preserve\">{}</a:t>", xml_escape(after_text)),
            );
        }
        updated.replace_range(*start..*end, &replaced);
    }
    updated
}

fn insert_pptx_image(
    package: &mut ZipPackage,
    slide_part: &str,
    image_path: &Path,
    width_inches: Option<f64>,
    pic_sequence: usize,
) -> Result<()> {
    let image = read_image(image_path)?;
    let media_name = next_media_name(package, "ppt/media", image.extension);
    package.set(&format!("ppt/media/{media_name}"), image.bytes.clone());

    let rels_part = slide_rels_part(slide_part);
    let rels_xml = package.get_string(&rels_part).unwrap_or_else(|| {
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
             <Relationships xmlns=\"{RELATIONSHIP_NAMESPACE}\"></Relationships>"
        )
    });
    let relationship_id = next_relationship_id(&rels_xml);
    let updated_rels = append_relationship(
        &rels_xml,
        &format!(
            "<Relationship Id=\"{relationship_id}\" Type=\"{IMAGE_RELATIONSHIP_TYPE}\" Target=\"../media/{media_name}\"/>"
        ),
    )?;
    package.set(&rels_part, updated_rels.into_bytes());

    let content_types = package
        .get_string("[Content_Types].xml")
        .context("pptx missing [Content_Types].xml")?;
    let updated_content_types =
        ensure_content_type_default(&content_types, image.extension, image.mime)?;
    package.set("[Content_Types].xml", updated_content_types.into_bytes());

    let (slide_cx, slide_cy) = slide_dimensions(package);
    let width_in = width_inches.unwrap_or(4.0).clamp(0.5, 13.0);
    let width_emu = (width_in * EMU_PER_INCH) as u64;
    let height_emu = (width_in * (image.height as f64 / image.width as f64) * EMU_PER_INCH) as u64;
    let off_x = slide_cx.saturating_sub(width_emu) / 2;
    let off_y = slide_cy.saturating_sub(height_emu + 274320);
    let drawing_id = 90_000 + pic_sequence;
    let element = format!(
        "<p:pic><p:nvPicPr><p:cNvPr id=\"{drawing_id}\" name=\"{name}\"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>\
         <p:blipFill><a:blip r:embed=\"{rid}\"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>\
         <p:spPr><a:xfrm><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm>\
         <a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr></p:pic>",
        name = xml_escape(&media_name),
        rid = relationship_id,
        x = off_x,
        y = off_y,
        cx = width_emu,
        cy = height_emu,
    );

    let mut xml = package
        .get_string(slide_part)
        .with_context(|| format!("read {slide_part}"))?;
    match xml.rfind("</p:spTree>") {
        Some(position) => xml.insert_str(position, &element),
        None => bail!("{} 缺少 spTree，无法插入图片", slide_part),
    }
    package.set(slide_part, xml.into_bytes());
    Ok(())
}

fn slide_dimensions(package: &ZipPackage) -> (u64, u64) {
    package
        .get_string("ppt/presentation.xml")
        .and_then(|presentation| {
            let start = presentation.find("<p:sldSz")?;
            let end = presentation[start..].find('>')? + start;
            let element = &presentation[start..=end];
            let cx = attribute_value(element, "cx")?.parse().ok()?;
            let cy = attribute_value(element, "cy")?.parse().ok()?;
            Some((cx, cy))
        })
        .unwrap_or((12_192_000, 6_858_000))
}

fn insert_pptx_slide(
    package: &mut ZipPackage,
    index: u32,
    title: &str,
    content: &[String],
) -> Result<()> {
    let slide_parts = resolve_slide_parts(package)?;
    anyhow::ensure!(
        (index as usize) <= slide_parts.len(),
        "插入位置 {index} 越界：演示共有 {} 页",
        slide_parts.len()
    );

    let new_number = package
        .names()
        .iter()
        .filter_map(|name| parse_slide_number(name))
        .max()
        .unwrap_or(0)
        + 1;
    let new_part = format!("ppt/slides/slide{new_number}.xml");

    // Slide 正文复用生成器的最小模板。
    let slide = crate::edit::Slide {
        title: title.to_string(),
        content: content.to_vec(),
    };
    let body = format!(
        "{}{}",
        text_shape(2, 457200, 274638, 11287200, 914400, &slide.title, 2800),
        text_shape(
            3,
            457200,
            1371600,
            11287200,
            4800600,
            &slide.content.join("\n"),
            1800
        )
    );
    let xml = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <p:sld xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" \
         xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" \
         xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\">\
         <p:cSld name=\"\"><p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>{body}</p:spTree></p:cSld>\
         <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"
    );
    package.set(&new_part, xml.into_bytes());

    let layout_target = package
        .names()
        .iter()
        .find(|name| {
            let lower = name.to_ascii_lowercase();
            lower.starts_with("ppt/slideLayouts/slideLayout")
                && lower.ends_with(".xml")
        })
        .map(|layout| layout.trim_start_matches("ppt/").to_string())
        .unwrap_or_else(|| "slideLayouts/slideLayout1.xml".to_string());
    let new_rels = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <Relationships xmlns=\"{RELATIONSHIP_NAMESPACE}\">\
         <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout\" Target=\"../{layout_target}\"/>\
         </Relationships>"
    );
    package.set(&slide_rels_part(&new_part), new_rels.into_bytes());

    // [Content_Types].xml Override
    let content_types = package
        .get_string("[Content_Types].xml")
        .context("pptx missing [Content_Types].xml")?;
    let override_element = format!(
        "<Override PartName=\"/{new_part}\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slide+xml\"/>"
    );
    let updated_content_types = match content_types.find("</Types>") {
        Some(position) => {
            let mut updated = content_types;
            updated.insert_str(position, &override_element);
            updated
        }
        None => bail!("[Content_Types].xml 结构无效"),
    };
    package.set("[Content_Types].xml", updated_content_types.into_bytes());

    // presentation.xml.rels：新关系
    let rels_part = "ppt/_rels/presentation.xml.rels";
    let rels_xml = package
        .get_string(rels_part)
        .context("pptx missing presentation rels")?;
    let relationship_id = next_relationship_id(&rels_xml);
    let updated_rels = append_relationship(
        &rels_xml,
        &format!(
            "<Relationship Id=\"{relationship_id}\" Type=\"{SLIDE_RELATIONSHIP_TYPE}\" Target=\"slides/slide{new_number}.xml\"/>"
        ),
    )?;
    package.set(rels_part, updated_rels.into_bytes());

    // presentation.xml：sldIdLst 按位置插入
    let presentation_part = "ppt/presentation.xml";
    let mut presentation = package
        .get_string(presentation_part)
        .context("pptx missing ppt/presentation.xml")?;
    let (list_start, list_end) = section_bounds(&presentation, "<p:sldIdLst>", "</p:sldIdLst>")
        .context("presentation.xml 缺少 sldIdLst")?;
    let max_sld_id = presentation
        .match_indices("<p:sldId ")
        .filter_map(|(position, _)| {
            let element_end = presentation[position..].find('>')? + position;
            attribute_value(&presentation[position..=element_end], "id")?.parse::<u64>().ok()
        })
        .max()
        .unwrap_or(255);
    let new_sld_id = format!(
        "<p:sldId id=\"{}\" r:id=\"{relationship_id}\"/>",
        max_sld_id + 1
    );

    let list = presentation[list_start..list_end].to_string();
    let tag_spans = scan_tag_elements(&list, "<p:sldId ");
    let insert_at = if index == 0 {
        0
    } else {
        tag_spans
            .get(index as usize - 1)
            .map(|(_, end)| *end)
            .unwrap_or(list.len())
    };
    let mut new_list = String::with_capacity(list.len() + new_sld_id.len());
    new_list.push_str(&list[..insert_at]);
    new_list.push_str(&new_sld_id);
    new_list.push_str(&list[insert_at..]);
    presentation.replace_range(list_start..list_end, &new_list);
    package.set(presentation_part, presentation.into_bytes());
    Ok(())
}

/// 自闭合/带属性标签（如 `<p:sldId id="256" r:id="rId2"/>`）的跨度扫描。
fn scan_tag_elements(xml: &str, prefix: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut cursor = 0;
    while let Some(relative_start) = xml[cursor..].find(prefix) {
        let start = cursor + relative_start;
        let after_name = xml.as_bytes().get(start + prefix.len()).copied();
        if !matches!(
            after_name,
            Some(b'>') | Some(b'/') | Some(b' ') | Some(b'\t') | Some(b'\r') | Some(b'\n')
        ) {
            cursor = start + 1;
            continue;
        }
        match xml[start..].find('>') {
            Some(tag_end) => {
                let end = start + tag_end + 1;
                spans.push((start, end));
                cursor = end;
            }
            None => break,
        }
    }
    spans
}

fn delete_pptx_slide(package: &mut ZipPackage, index: u32) -> Result<()> {
    let slide_parts = resolve_slide_parts(package)?;
    anyhow::ensure!(
        slide_parts.len() > 1,
        "不能删除最后一页幻灯片：演示至少需要保留一页"
    );
    let slide_part = slide_part_at(&slide_parts, index)?;

    // presentation.xml：移除对应 sldId
    let presentation_part = "ppt/presentation.xml";
    let mut presentation = package
        .get_string(presentation_part)
        .context("pptx missing ppt/presentation.xml")?;
    let (list_start, list_end) = section_bounds(&presentation, "<p:sldIdLst>", "</p:sldIdLst>")
        .context("presentation.xml 缺少 sldIdLst")?;
    let list = presentation[list_start..list_end].to_string();
    let tag_spans = scan_tag_elements(&list, "<p:sldId");
    let target_index = index as usize - 1;
    anyhow::ensure!(
        target_index < tag_spans.len(),
        "幻灯片序号 {index} 越界"
    );
    let (tag_start, tag_end) = tag_spans[target_index];
    let mut new_list = String::with_capacity(list.len());
    new_list.push_str(&list[..tag_start]);
    new_list.push_str(&list[tag_end..]);
    presentation.replace_range(list_start..list_end, &new_list);
    package.set(presentation_part, presentation.into_bytes());

    // presentation.xml.rels：移除指向该 slide 的关系
    let rels_part = "ppt/_rels/presentation.xml.rels";
    if let Some(rels_xml) = package.get_string(rels_part) {
        let target_suffix = slide_part.trim_start_matches("ppt/");
        let mut updated = rels_xml.clone();
        let mut cursor = 0;
        while let Some(relative_start) = updated[cursor..].find("<Relationship ") {
            let start = cursor + relative_start;
            let Some(end) = updated[start..].find('>') else {
                break;
            };
            let element = updated[start..=start + end].to_string();
            let matches = attribute_value(&element, "Target")
                .map(|target| target.ends_with(target_suffix))
                .unwrap_or(false);
            if matches {
                updated.replace_range(start..=start + end, "");
                break;
            }
            cursor = start + 1;
        }
        package.set(rels_part, updated.into_bytes());
    }

    // [Content_Types].xml：移除 Override
    if let Some(content_types) = package.get_string("[Content_Types].xml") {
        let probe = format!("<Override PartName=\"/{slide_part}\" ");
        if let Some(start) = content_types.find(&probe) {
            let relative = content_types[start..]
                .find("/>")
                .context("[Content_Types].xml 结构无效")?;
            let end = start + relative + 2;
            let mut updated = content_types.clone();
            updated.replace_range(start..end, "");
            package.set("[Content_Types].xml", updated.into_bytes());
        }
    }

    // 移除 slide 部件与它的 rels；media 保留（可能被其他页面/母版共享）。
    package.remove(&slide_part);
    package.remove(&slide_rels_part(&slide_part));
    Ok(())
}

// ---------------------------------------------------------------------------
// 共用
// ---------------------------------------------------------------------------

fn ensure_expect_before(expect: &Option<String>, current: &str) -> Result<()> {
    if let Some(expect) = expect {
        let normalized_expect = normalize_whitespace(expect);
        let normalized_current = normalize_whitespace(current);
        anyhow::ensure!(
            !normalized_expect.is_empty() && normalized_current.contains(&normalized_expect),
            "段落锚文本不匹配：期望包含「{expect}」，实际段落内容为「{current}」"
        );
    }
    Ok(())
}

fn normalize_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TINY_PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
        0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
        0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78,
        0x9C, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
        0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    fn write_docx_fixture(path: &Path) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
        for (name, content) in [
            ("[Content_Types].xml", concat!(
                "<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">",
                "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>",
                "<Default Extension=\"xml\" ContentType=\"application/xml\"/>",
                "<Default Extension=\"png\" ContentType=\"image/png\"/>",
                "</Types>")),
            ("word/document.xml", concat!(
                "<?xml version=\"1.0\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><w:body>",
                "<w:p><w:r><w:t>第一段</w:t></w:r></w:p>",
                "<w:p><w:r><w:t>第二段 &amp; 细节</w:t></w:r></w:p>",
                "<w:p><w:r><w:t>带图上方</w:t><w:t>拼接</w:t></w:r></w:p>",
                "<w:p><w:r><w:drawing><wp:inline xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\"><a:graphic xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><pic:pic xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><pic:blipFill><a:blip r:embed=\"rId10\"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>",
                "</w:body></w:document>")),
            ("word/_rels/document.xml.rels", concat!(
                "<?xml version=\"1.0\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
                "<Relationship Id=\"rId10\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"media/image1.png\"/>",
                "</Relationships>")),
        ] {
            zip.start_file(name, options).unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.start_file("word/media/image1.png", options).unwrap();
        zip.write_all(TINY_PNG).unwrap();
        zip.finish().unwrap();
    }

    fn write_pptx_fixture(path: &Path) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
        for (name, content) in [
            ("[Content_Types].xml", concat!(
                "<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">",
                "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>",
                "<Default Extension=\"xml\" ContentType=\"application/xml\"/>",
                "<Default Extension=\"png\" ContentType=\"image/png\"/>",
                "<Override PartName=\"/ppt/presentation.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml\"/>",
                "<Override PartName=\"/ppt/slides/slide1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slide+xml\"/>",
                "<Override PartName=\"/ppt/slides/slide2.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slide+xml\"/>",
                "</Types>")),
            ("ppt/presentation.xml", concat!(
                "<?xml version=\"1.0\"?><p:presentation xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\">",
                "<p:sldIdLst><p:sldId id=\"256\" r:id=\"rId2\"/><p:sldId id=\"257\" r:id=\"rId3\"/></p:sldIdLst>",
                "<p:sldSz cx=\"12192000\" cy=\"6858000\"/></p:presentation>")),
            ("ppt/_rels/presentation.xml.rels", concat!(
                "<?xml version=\"1.0\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
                "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster\" Target=\"slideMasters/slideMaster1.xml\"/>",
                "<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide1.xml\"/>",
                "<Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide2.xml\"/>",
                "</Relationships>")),
            ("ppt/slides/slide1.xml", concat!(
                "<?xml version=\"1.0\"?><p:sld xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\">",
                "<p:cSld><p:spTree><a:p><a:r><a:t>封面</a:t></a:r></a:p><a:p><a:r><a:t>副标题</a:t></a:r></a:p></p:spTree></p:cSld></p:sld>")),
            ("ppt/slides/slide2.xml", concat!(
                "<?xml version=\"1.0\"?><p:sld xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\">",
                "<p:cSld><p:spTree><p:pic><p:blipFill><a:blip r:embed=\"rId1\"/></p:blipFill></p:pic>",
                "<a:p><a:r><a:rPr lang=\"zh-CN\"/><a:t>第二页 </a:t></a:r><a:r><a:t>原文</a:t></a:r></a:p></p:spTree></p:cSld></p:sld>")),
            ("ppt/slides/_rels/slide2.xml.rels", concat!(
                "<?xml version=\"1.0\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
                "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"../media/image1.png\"/>",
                "</Relationships>")),
        ] {
            zip.start_file(name, options).unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.start_file("ppt/media/image1.png", options).unwrap();
        zip.write_all(TINY_PNG).unwrap();
        zip.finish().unwrap();
    }

    fn temp_dir(name: &str) -> tempfile::TempDir {
        tempfile::tempdir().unwrap_or_else(|_| {
            panic!("tempdir unavailable for {name}")
        })
    }

    #[test]
    fn docx_ops_preserve_media_and_apply_text_edits() {
        let dir = temp_dir("docx-ops");
        let source = dir.path().join("source.docx");
        let output = dir.path().join("draft.docx");
        write_docx_fixture(&source);
        let media_before = std::fs::read(&source).unwrap();

        let image_path = dir.path().join("new.png");
        std::fs::write(&image_path, TINY_PNG).unwrap();

        apply_ops(
            &source,
            &output,
            &[
                OfficeOp::DocxReplaceText {
                    paragraph_index: 1,
                    after_text: "第二段改写".into(),
                    expect_before: Some("第二段".into()),
                },
                OfficeOp::DocxInsertParagraphAfter {
                    paragraph_index: 0,
                    text: "新插入段".into(),
                    style: ParagraphStyle::Bold,
                },
                OfficeOp::DocxDeleteParagraph { paragraph_index: 3 },
                OfficeOp::DocxInsertImage {
                    paragraph_index: usize::MAX,
                    image_path: image_path.clone(),
                    width_inches: Some(3.0),
                },
            ],
        )
        .unwrap();

        // media 原字节保留 + 新增图片
        let package = ZipPackage::load(&output).unwrap();
        assert_eq!(package.get("word/media/image1.png"), Some(TINY_PNG));
        assert!(package.get("word/media/edit-image-1.png").is_some());

        let parsed = crate::parse_file(&output).unwrap();
        let paragraphs = parsed["paragraphs"].as_array().unwrap();
        assert_eq!(paragraphs[0], json!("第一段"));
        assert_eq!(paragraphs[1], json!("新插入段"));
        assert_eq!(paragraphs[2], json!("第二段改写"));
        assert_eq!(parsed["imageCount"], json!(2));

        // 新图片尺寸按 3in 宽、1x1 比例 → EMU；fixture 已占用 rId10，新关系取 rId1
        let document = package.get_string("word/document.xml").unwrap();
        assert!(document.contains("cx=\"2743200\""), "3in EMU width present");
        assert!(document.contains("r:embed=\"rId1\""), "new relationship referenced");
        // 锚文本不匹配要报错
        let rejected = apply_ops(
            &source,
            &dir.path().join("bad.docx"),
            &[OfficeOp::DocxReplaceText {
                paragraph_index: 0,
                after_text: "x".into(),
                expect_before: Some("不存在的锚".into()),
            }],
        );
        assert!(rejected.is_err());
        let _ = media_before;
    }

    #[test]
    fn pptx_ops_preserve_media_and_apply_structure_edits() {
        let dir = temp_dir("pptx-ops");
        let source = dir.path().join("source.pptx");
        let output = dir.path().join("draft.pptx");
        write_pptx_fixture(&source);

        let image_path = dir.path().join("new.png");
        std::fs::write(&image_path, TINY_PNG).unwrap();

        apply_ops(
            &source,
            &output,
            &[
                OfficeOp::PptxReplaceText {
                    slide: 2,
                    paragraph_index: 0,
                    after_text: "第二页改写".into(),
                    expect_before: Some("第二页".into()),
                },
                OfficeOp::PptxInsertImage {
                    slide: 1,
                    image_path: image_path.clone(),
                    width_inches: Some(4.0),
                },
                OfficeOp::PptxInsertSlideAfter {
                    index: 2,
                    title: "总结".into(),
                    content: vec!["要点一".into()],
                },
                OfficeOp::PptxDeleteSlide { index: 2 },
            ],
        )
        .unwrap();

        let package = ZipPackage::load(&output).unwrap();
        // 原 slide2 的 media 字节保留，slide1 新增一张图
        assert_eq!(package.get("ppt/media/image1.png"), Some(TINY_PNG));
        assert!(package.get("ppt/media/edit-image-1.png").is_some());

        // 删除了原第 2 页，插入新页 → 剩 2 页，顺序为 [原1, 新页]
        let parts = resolve_slide_parts(&package).unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0], "ppt/slides/slide1.xml");
        assert_eq!(parts[1], "ppt/slides/slide3.xml");
        let slide1 = package.get_string(&parts[0]).unwrap();
        assert!(slide1.contains("封面"));
        assert!(slide1.contains("r:embed=\"rId1\""), "slide1 references new image rel");
        assert!(
            package
                .get_string("ppt/slides/_rels/slide1.xml.rels")
                .unwrap_or_default()
                .contains("edit-image-1.png"),
            "slide1 rels point at the new media"
        );
        let slide2 = package.get_string(&parts[1]).unwrap();
        assert!(slide2.contains("总结"));
        assert!(package.get("ppt/slides/slide2.xml").is_none(), "deleted slide part removed");

        let parsed = crate::parse_file(&output).unwrap();
        assert_eq!(parsed["slides"], json!(2));
        let second = &parsed["items"][1];
        assert_eq!(second["paragraphs"][0], json!("总结"));
        assert_eq!(second["paragraphs"][1], json!("要点一"));

        // sldIdLst 与 slide 部件一致（verify_package 已跑过，这里再显式断言一次）
        let presentation = package.get_string("ppt/presentation.xml").unwrap();
        assert_eq!(presentation.match_indices("<p:sldId ").count(), 2);

        let rejected = apply_ops(
            &source,
            &dir.path().join("bad.pptx"),
            &[OfficeOp::PptxReplaceText {
                slide: 9,
                paragraph_index: 0,
                after_text: "x".into(),
                expect_before: None,
            }],
        );
        assert!(rejected.is_err());
    }

    #[test]
    fn media_counter_and_probe_helpers() {
        let dir = temp_dir("helpers");
        let source = dir.path().join("doc.docx");
        write_docx_fixture(&source);
        assert_eq!(count_media_parts(&source).unwrap(), 1);
        assert!(is_media_part("ppt/media/image1.PNG"));
        assert!(!is_media_part("ppt/slides/slide1.xml"));

        let image = read_image(&dir.path().join("missing.png"));
        assert!(image.is_err());
        let png_path = dir.path().join("t.png");
        std::fs::write(&png_path, TINY_PNG).unwrap();
        let blob = read_image(&png_path).unwrap();
        assert_eq!((blob.width, blob.height), (1, 1));
        assert_eq!(blob.mime, "image/png");
    }
}
