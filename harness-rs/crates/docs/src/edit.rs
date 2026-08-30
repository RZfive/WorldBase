//! 文档编辑实现（基础层）：
//! - docx 写入：自研最小 OOXML 打包
//! - xlsx 写入：自研最小 SpreadsheetML 打包
//! - csv / markdown / json / txt 写入：直接写文本
//!
//! 重编辑（PDF 插图、Office 模板生成）按架构文档在桌面侧由 TS 注入补齐。

use anyhow::{Context, Result};
use std::io::Write;
use std::path::Path;

#[derive(Debug, Clone)]
pub enum DocBlock {
    Heading(String, u32),
    Paragraph(String),
    Bullet(String),
}

#[derive(Debug, Clone)]
pub struct Sheet {
    pub name: String,
    pub rows: Vec<Vec<String>>,
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
