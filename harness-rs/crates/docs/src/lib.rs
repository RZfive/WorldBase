//! 文档引擎：解析（xlsx/pdf/docx/pptx/md/csv/json/txt，全端）与基础编辑（docx/xlsx/csv/md 写入）。
//!
//! 解析用 Rust 生态：calamine（xlsx）、lopdf（pdf）、自研 OOXML 读取（docx/pptx）。

use anyhow::Result;
use serde_json::Value;

pub mod edit;
pub mod parse;

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
}
