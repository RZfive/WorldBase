//! 文档编辑实现（基础层）：
//! - docx 写入：自研最小 OOXML 打包
//! - xlsx 写入：自研最小 SpreadsheetML 打包
//! - csv / markdown / json / txt 写入：直接写文本
//!
//! 复杂模板编辑仍由桌面侧注入；本层提供跨端基础文本 Office 生成。

use anyhow::{Context, Result};
use std::io::Write;
use std::path::Path;

#[derive(Debug, Clone)]
pub enum DocBlock {
    Heading(String, u32),
    Paragraph(String),
    Bold(String),
    Bullet(String),
}

#[derive(Debug, Clone)]
pub struct Sheet {
    pub name: String,
    pub rows: Vec<Vec<String>>,
}

#[derive(Debug, Clone)]
pub struct Slide {
    pub title: String,
    pub content: Vec<String>,
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

pub fn write_docx(path: &Path, blocks: &[DocBlock]) -> Result<()> {
    let mut body = String::new();
    for block in blocks {
        match block {
            DocBlock::Heading(text, level) => {
                body.push_str(&format!(
                    "<w:p><w:pPr><w:pStyle w:val=\"Heading{}\"/></w:pPr><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
                    level, xml_escape(text)
                ));
            }
            DocBlock::Paragraph(text) => {
                body.push_str(&format!(
                    "<w:p><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
                    xml_escape(text)
                ));
            }
            DocBlock::Bold(text) => {
                body.push_str(&format!(
                    "<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
                    xml_escape(text)
                ));
            }
            DocBlock::Bullet(text) => {
                body.push_str(&format!(
                    "<w:p><w:pPr><w:numPr><w:ilvl w:val=\"0\"/></w:numPr></w:pPr><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
                    xml_escape(text)
                ));
            }
        }
    }

    let document_xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}<w:sectPr/></w:body></w:document>"#
    );
    let content_types = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#;
    let rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#;

    let file = std::fs::File::create(path).with_context(|| format!("create {}", path.display()))?;
    let mut zip = zip::ZipWriter::new(file);
    let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
    zip.start_file("[Content_Types].xml", options)?;
    zip.write_all(content_types.as_bytes())?;
    zip.start_file("_rels/.rels", options)?;
    zip.write_all(rels.as_bytes())?;
    zip.start_file("word/document.xml", options)?;
    zip.write_all(document_xml.as_bytes())?;
    zip.finish()?;
    Ok(())
}

pub fn write_xlsx(path: &Path, sheets: &[Sheet]) -> Result<()> {
    let mut sheets_xml = String::new();
    let mut sheet_files = String::new();
    for (i, sheet) in sheets.iter().enumerate() {
        let mut rows_xml = String::new();
        for (r, row) in sheet.rows.iter().enumerate() {
            let mut cells = String::new();
            for (c, cell) in row.iter().enumerate() {
                let col = column_name(c)?;
                cells.push_str(&format!(
                    "<c r=\"{col}{}\" t=\"inlineStr\"><is><t xml:space=\"preserve\">{}</t></is></c>",
                    r + 1,
                    xml_escape(cell)
                ));
            }
            rows_xml.push_str(&format!("<row r=\"{}\">{cells}</row>", r + 1));
        }
        let sheet_id = i + 1;
        sheet_files.push_str(&format!(
            "<sheet name=\"{}\" sheetId=\"{sheet_id}\" r:id=\"rId{sheet_id}\"/>",
            xml_escape(&sheet.name)
        ));
        sheets_xml.push_str(&format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData>{rows_xml}</sheetData></worksheet>"
        ));
    }

    let workbook_xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>{sheet_files}</sheets></workbook>"#
    );
    let mut workbook_rels = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#,
    );
    for i in 1..=sheets.len() {
        workbook_rels.push_str(&format!(
            "<Relationship Id=\"rId{i}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet{i}.xml\"/>"
        ));
    }
    workbook_rels.push_str("</Relationships>");

    let content_types = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>{}</Types>"#,
        (1..=sheets.len())
            .map(|i| format!(
                "<Override PartName=\"/xl/worksheets/sheet{i}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>"
            ))
            .collect::<String>()
    );

    let file = std::fs::File::create(path).with_context(|| format!("create {}", path.display()))?;
    let mut zip = zip::ZipWriter::new(file);
    let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
    zip.start_file("[Content_Types].xml", options)?;
    zip.write_all(content_types.as_bytes())?;
    zip.start_file("_rels/.rels", options)?;
    zip.write_all(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#
            .as_bytes(),
    )?;
    zip.start_file("xl/workbook.xml", options)?;
    zip.write_all(workbook_xml.as_bytes())?;
    zip.start_file("xl/_rels/workbook.xml.rels", options)?;
    zip.write_all(workbook_rels.as_bytes())?;
    for (i, sheet_xml) in sheets_xml.split("<?xml").enumerate().skip(1) {
        let idx = i; // sheet 序号
        zip.start_file(format!("xl/worksheets/sheet{idx}.xml"), options)?;
        zip.write_all(format!("<?xml{sheet_xml}").as_bytes())?;
    }
    zip.finish()?;
    Ok(())
}

/// Write a small, self-contained PowerPoint package containing text slides.
/// The generated OOXML is intentionally minimal but is accepted by common
/// readers and is sufficient for the local_write_file office contract.
pub fn write_pptx(path: &Path, slides: &[Slide]) -> Result<()> {
    anyhow::ensure!(
        !slides.is_empty(),
        "PowerPoint files require at least one slide"
    );

    let mut slide_files = String::new();
    let mut slide_rels = String::new();
    let mut slide_entries = String::new();
    for (index, _slide) in slides.iter().enumerate() {
        let number = index + 1;
        slide_files.push_str(&format!(
            "<Override PartName=\"/ppt/slides/slide{number}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slide+xml\"/>"
        ));
        // rId1 is reserved for the slide master relationship.  Keep slide
        // references aligned with presentation.xml's sldId entries.
        slide_rels.push_str(&format!(
            "<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide{number}.xml\"/>",
            number + 1
        ));
        slide_entries.push_str(&format!(
            "<p:sldId id=\"{}\" r:id=\"rId{}\"/>",
            255 + number,
            number + 1
        ));
    }

    let content_types = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>{slide_files}</Types>"#
    );
    let presentation = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>{slide_entries}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle/></p:presentation>"#
    );
    let presentation_rels = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>{slide_rels}</Relationships>"#
    );
    let master = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name=""><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>"#;
    let master_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>"#;
    let layout = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name=""><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"#;
    let layout_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>"#;
    let theme = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="WorldBase"><a:themeElements><a:clrScheme name="Default"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F1F1F"/></a:dk2><a:lt2><a:srgbClr val="F7F7F7"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Default"><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/></a:minorFont></a:fontScheme><a:fmtScheme name="Default"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme></a:themeElements></a:theme>"#;

    let file = std::fs::File::create(path).with_context(|| format!("create {}", path.display()))?;
    let mut zip = zip::ZipWriter::new(file);
    let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
    for (name, content) in [
        ("[Content_Types].xml", content_types),
        ("_rels/.rels", r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>"#.to_string()),
        ("ppt/presentation.xml", presentation),
        ("ppt/_rels/presentation.xml.rels", presentation_rels),
        ("ppt/slideMasters/slideMaster1.xml", master.to_string()),
        ("ppt/slideMasters/_rels/slideMaster1.xml.rels", master_rels.to_string()),
        ("ppt/slideLayouts/slideLayout1.xml", layout.to_string()),
        ("ppt/slideLayouts/_rels/slideLayout1.xml.rels", layout_rels.to_string()),
        ("ppt/theme/theme1.xml", theme.to_string()),
    ] {
        zip.start_file(name, options)?;
        zip.write_all(content.as_bytes())?;
    }
    for (index, slide) in slides.iter().enumerate() {
        let number = index + 1;
        let mut body = String::new();
        body.push_str(&text_shape(
            2,
            457200,
            274638,
            11287200,
            914400,
            &slide.title,
            2800,
        ));
        let content = slide.content.join("\n");
        body.push_str(&text_shape(
            3, 457200, 1371600, 11287200, 4800600, &content, 1800,
        ));
        let xml = format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name=""><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>{body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"#
        );
        zip.start_file(format!("ppt/slides/slide{number}.xml"), options)?;
        zip.write_all(xml.as_bytes())?;
        zip.start_file(format!("ppt/slides/_rels/slide{number}.xml.rels"), options)?;
        zip.write_all(format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>"#).as_bytes())?;
    }
    zip.finish()?;
    Ok(())
}

fn text_shape(id: u32, x: u32, y: u32, cx: u32, cy: u32, text: &str, size: u32) -> String {
    let paragraphs = text
        .lines()
        .map(|line| {
            format!(
                "<a:p><a:r><a:rPr lang=\"en-US\" sz=\"{size}\"/><a:t>{}</a:t></a:r><a:endParaRPr lang=\"en-US\" sz=\"{size}\"/></a:p>",
                xml_escape(line)
            )
        })
        .collect::<String>();
    format!(
        "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"Text {id}\"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>{paragraphs}</p:txBody></p:sp>"
    )
}

fn column_name(mut col: usize) -> Result<String> {
    let mut out = Vec::new();
    loop {
        out.push(b'A' + (col % 26) as u8);
        if col < 26 {
            break;
        }
        col = col / 26 - 1;
    }
    out.reverse();
    String::from_utf8(out).context("column name")
}

pub fn write_csv(path: &Path, header: &[String], rows: &[Vec<String>]) -> Result<()> {
    let mut out = String::new();
    out.push_str(&header.join(","));
    out.push('\n');
    for row in rows {
        out.push_str(&row.join(","));
        out.push('\n');
    }
    std::fs::write(path, out)?;
    Ok(())
}

pub fn write_text(path: &Path, content: &str) -> Result<()> {
    std::fs::write(path, content)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn column_names() {
        assert_eq!(column_name(0).unwrap(), "A");
        assert_eq!(column_name(25).unwrap(), "Z");
        assert_eq!(column_name(26).unwrap(), "AA");
    }
}
