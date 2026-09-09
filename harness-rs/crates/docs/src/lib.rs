//! 文档引擎：解析（xlsx/pdf/docx/pptx/md/csv/json/txt，全端）与基础编辑（docx/xlsx/csv/md 写入）。
//!
//! 解析用 Rust 生态：calamine（xlsx）、lopdf（pdf）、自研 OOXML 读取（docx/pptx）。

use anyhow::Result;
use serde_json::Value;

pub mod edit;
pub mod parse;

/// Return whether the document engine has a parser for the path's extension.
///
/// This is intentionally kept next to `parse_file` so RPC callers can reject
/// unsupported user input as `INVALID_PARAMS` instead of surfacing a generic
/// internal parser error.  An extensionless path is treated as plain text,
/// matching `parse_file`.
pub fn is_supported_path(path: &std::path::Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "xlsx"
            | "xls"
            | "pdf"
            | "docx"
            | "doc"
            | "pptx"
            | "ppt"
            | "csv"
            | "json"
            | "md"
            | "markdown"
            | "txt"
            | "log"
            | ""
    )
}

/// 按扩展名解析文档为结构化文本。
pub fn parse_file(path: &std::path::Path) -> Result<Value> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "xlsx" | "xls" => parse::xlsx(path),
        "pdf" => parse::pdf(path),
        "docx" | "doc" => parse::docx(path),
        "pptx" | "ppt" => parse::pptx(path),
        "csv" => parse::csv(path),
        "json" => parse::json_file(path),
        "md" | "markdown" => parse::markdown(path),
        "txt" | "log" | "" => parse::plain(path),
        other => anyhow::bail!("unsupported document extension: {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_markdown_and_csv() {
        let dir = tempfile::tempdir().unwrap();
        let md = dir.path().join("t.md");
        std::fs::write(&md, "# 标题\n\n正文段落\n\n- 列表项\n").unwrap();
        let parsed = parse_file(&md).unwrap();
        assert_eq!(parsed["kind"], "markdown");
        assert!(parsed["text"].as_str().unwrap().contains("正文段落"));

        let csv = dir.path().join("t.csv");
        std::fs::write(&csv, "a,b\n1,2\n").unwrap();
        let parsed = parse_file(&csv).unwrap();
        assert_eq!(parsed["kind"], "csv");
        assert_eq!(parsed["rows"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn docx_write_and_parse_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.docx");
        edit::write_docx(
            &path,
            &[
                edit::DocBlock::Heading("会议纪要".into(), 1),
                edit::DocBlock::Paragraph("讨论了 Rust harness 迁移进度。".into()),
            ],
        )
        .unwrap();
        let parsed = parse_file(&path).unwrap();
        assert_eq!(parsed["kind"], "docx");
        let text = parsed["text"].as_str().unwrap();
        assert!(text.contains("会议纪要"));
        assert!(text.contains("Rust harness 迁移进度"));
    }

    #[test]
    fn docx_parse_returns_non_duplicate_paragraphs_and_source_metadata() {
        use std::io::Write;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("metadata.docx");
        let file = std::fs::File::create(&path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file(
                "word/document.xml",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        archive
            .write_all(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>标题 &amp; &#x4e2d;</w:t></w:r></w:p>
  <w:p><w:r><w:t>正文</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>列表项</w:t></w:r></w:p>
  <w:p><w:r/></w:p>
</w:body></w:document>"#
                    .as_bytes(),
            )
            .unwrap();
        archive.finish().unwrap();

        let parsed = parse_file(&path).unwrap();
        assert_eq!(parsed["paragraphs"], json!(["标题 & 中", "正文", "列表项"]));
        assert_eq!(parsed["text"], "标题 & 中\n正文\n列表项");

        let metadata = parsed["paragraphMetadata"].as_array().unwrap();
        assert_eq!(metadata.len(), 3);
        assert_eq!(metadata[0]["docxParagraphIndex"], 0);
        assert_eq!(metadata[0]["type"], "heading");
        assert_eq!(metadata[0]["level"], 1);
        assert_eq!(metadata[0]["paragraphStyle"], "Heading1");
        assert_eq!(metadata[1]["docxParagraphIndex"], 1);
        assert_eq!(metadata[1]["type"], "paragraph");
        assert_eq!(metadata[1]["paragraphStyle"], "");
        assert_eq!(metadata[2]["docxParagraphIndex"], 2);
        assert_eq!(metadata[2]["type"], "list_item");
    }

    #[test]
    fn docx_heading_detection_matches_prefixed_word_styles() {
        use std::io::Write;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("prefixed-heading.docx");
        let file = std::fs::File::create(&path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file(
                "word/document.xml",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        archive
            .write_all(
                r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
  <w:p><w:pPr><w:pStyle w:val="My Heading 2"/></w:pPr><w:r><w:t>自定义标题</w:t></w:r></w:p>
  <w:p><w:r><w:t>普通段落</w:t></w:r></w:p>
</w:body></w:document>"#
                    .as_bytes(),
            )
            .unwrap();
        archive.finish().unwrap();

        let parsed = parse_file(&path).unwrap();
        let metadata = parsed["paragraphMetadata"].as_array().unwrap();
        assert_eq!(metadata[0]["type"], "heading");
        assert_eq!(metadata[0]["level"], 2);
        assert_eq!(metadata[0]["paragraphStyle"], "My Heading 2");
        assert_eq!(metadata[1]["type"], "paragraph");
        assert_eq!(metadata[1]["paragraphStyle"], "");
    }

    #[test]
    fn pptx_parser_ignores_paragraph_properties_without_duplication() {
        let xml = r#"<p:txBody>
  <a:pPr/>
  <a:p><a:pPr/><a:r><a:t> Hello </a:t></a:r><a:r><a:t> world </a:t></a:r></a:p>
</p:txBody>"#;
        assert_eq!(parse::extract_pptx_paragraphs(xml), vec!["Helloworld"]);
    }

    #[test]
    fn xlsx_parser_keeps_rows_beyond_the_legacy_thousand_row_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("many-rows.xlsx");
        let rows: Vec<Vec<String>> = (0..1_001)
            .map(|index| vec![format!("row-{index}")])
            .collect();
        edit::write_xlsx(
            &path,
            &[edit::Sheet {
                name: "Sheet1".into(),
                rows,
            }],
        )
        .unwrap();

        let parsed = parse_file(&path).unwrap();
        assert_eq!(parsed["sheets"][0]["rows"].as_array().unwrap().len(), 1_001);
    }

    #[test]
    fn pdf_parse_preserves_numeric_page_count_and_exposes_page_items() {
        use lopdf::content::{Content, Operation};
        use lopdf::{dictionary, Document, Object, Stream};

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pages.pdf");
        let mut document = Document::with_version("1.5");
        let pages_id = document.new_object_id();
        let font_id = document.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Courier",
        });
        let resources_id = document.add_object(dictionary! {
            "Font" => dictionary! { "F1" => font_id },
        });

        let page_text = ["first page", "second page"];
        let mut page_ids = Vec::new();
        for content_text in page_text {
            let content = Content {
                operations: vec![
                    Operation::new("BT", vec![]),
                    Operation::new("Tf", vec!["F1".into(), 12.into()]),
                    Operation::new("Td", vec![72.into(), 700.into()]),
                    Operation::new("Tj", vec![Object::string_literal(content_text)]),
                    Operation::new("ET", vec![]),
                ],
            };
            let content_id =
                document.add_object(Stream::new(dictionary! {}, content.encode().unwrap()));
            let page_id = document.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "Contents" => content_id,
                "Resources" => resources_id,
                "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
            });
            page_ids.push(page_id);
        }
        document.objects.insert(
            pages_id,
            lopdf::Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => page_ids.iter().copied().map(Object::from).collect::<Vec<_>>(),
                "Count" => page_ids.len() as i64,
            }),
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        document.compress();
        document.save(&path).unwrap();

        let parsed = parse_file(&path).unwrap();
        assert_eq!(parsed["pages"], 2);
        let items = parsed["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["number"], 1);
        assert_eq!(items[1]["number"], 2);
        assert!(items[0]["text"].as_str().unwrap().contains("first page"));
        assert!(items[1]["text"].as_str().unwrap().contains("second page"));
        assert!(parsed["text"].as_str().unwrap().contains("first page"));
        assert!(parsed["text"].as_str().unwrap().contains("second page"));
    }

    #[test]
    fn xlsx_write_and_parse_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.xlsx");
        edit::write_xlsx(
            &path,
            &[edit::Sheet {
                name: "Sheet1".into(),
                rows: vec![
                    vec!["名称".into(), "数量".into()],
                    vec!["苹果".into(), "3".into()],
                ],
            }],
        )
        .unwrap();
        let parsed = parse_file(&path).unwrap();
        assert_eq!(parsed["kind"], "xlsx");
        let sheets = parsed["sheets"].as_array().unwrap();
        assert_eq!(sheets[0]["rows"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn parse_pptx_slide_text() {
        use std::io::Write;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("slides.pptx");
        let file = std::fs::File::create(&path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file(
                "ppt/slides/slide1.xml",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        archive
            .write_all(br#"<p:sld><a:p><a:r><a:t>Flutter &amp; Rust</a:t></a:r></a:p></p:sld>"#)
            .unwrap();
        archive.finish().unwrap();

        let parsed = parse_file(&path).unwrap();
        assert_eq!(parsed["kind"], "pptx");
        assert_eq!(parsed["slides"], 1);
        assert!(parsed["text"].as_str().unwrap().contains("Flutter & Rust"));
    }

    #[test]
    fn pptx_write_and_parse_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("generated.pptx");
        edit::write_pptx(
            &path,
            &[edit::Slide {
                title: "迁移进度".into(),
                content: vec!["Rust harness".into(), "Flutter client".into()],
            }],
        )
        .unwrap();
        let parsed = parse_file(&path).unwrap();
        assert_eq!(parsed["kind"], "pptx");
        assert_eq!(parsed["slides"], 1);
        assert!(parsed["text"].as_str().unwrap().contains("迁移进度"));
        assert!(parsed["text"].as_str().unwrap().contains("Flutter client"));
    }
}
