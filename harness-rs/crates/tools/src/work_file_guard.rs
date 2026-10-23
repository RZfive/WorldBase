//! File-level routing for mixed workspaces.
//!
//! One folder may contain both office documents and source code. The folder is
//! only a root; the target file type decides whether a change belongs to the
//! document flow (`doc_draft`) or the coding flow (`coding_edit` /
//! `coding_apply`). This mirrors `apps/electron/src/shared/work-file-kind.ts`.

use anyhow::Result;
use serde_json::{json, Value};

/// Generic write tools attach before/after content for code review. Electron
/// skips diff rendering when either side is larger than this cap.
pub(crate) const MAX_WRITE_DIFF_BYTES: usize = 64 * 1024;

const DOCUMENT_EXTENSIONS: &[&str] = &["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx"];

const SURFACE_SENSITIVE_TEXT_EXTENSIONS: &[&str] = &["md", "markdown", "mdx", "txt", "csv", "tsv"];

const CODE_EXTENSIONS: &[&str] = &[
    "ts",
    "tsx",
    "mts",
    "cts",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "vue",
    "svelte",
    "astro",
    "py",
    "pyi",
    "go",
    "java",
    "kt",
    "kts",
    "scala",
    "rs",
    "rb",
    "php",
    "cs",
    "fs",
    "fsx",
    "c",
    "cc",
    "cpp",
    "cxx",
    "h",
    "hh",
    "hpp",
    "hxx",
    "m",
    "mm",
    "swift",
    "dart",
    "json",
    "jsonc",
    "json5",
    "yaml",
    "yml",
    "toml",
    "ini",
    "cfg",
    "conf",
    "xml",
    "plist",
    "gradle",
    "properties",
    "html",
    "htm",
    "css",
    "scss",
    "sass",
    "less",
    "sql",
    "graphql",
    "gql",
    "sh",
    "bash",
    "zsh",
    "fish",
    "ps1",
    "bat",
    "cmd",
    "lua",
    "r",
    "pl",
    "ex",
    "exs",
    "erl",
    "hrl",
    "clj",
    "cljs",
    "groovy",
    "sol",
    "zig",
    "nim",
    "v",
];

const ASSET_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "tiff", "mp3", "wav", "ogg", "flac",
    "m4a", "aac", "mp4", "mov", "webm", "avi", "mkv", "zip", "tar", "gz", "tgz", "bz2", "xz", "7z",
    "rar", "woff", "woff2", "ttf", "otf", "eot", "db", "sqlite", "sqlite3", "lock",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorkFileKind {
    Document,
    /// Markdown/plain text follows the surface that opened it. Generic Rust
    /// write tools treat it as reviewable text (a coding diff).
    MarkdownText,
    Code,
    Asset,
    Unknown,
}

/// Extension extraction matches the Electron classifier: trim, accept both
/// `/` and `\` separators, lowercase, and ignore dotfiles/trailing dots.
pub(crate) fn work_file_extension(file_path: &str) -> String {
    let normalized = file_path.trim().replace('\\', "/");
    let name = normalized.rsplit('/').next().unwrap_or("");
    match name.rfind('.') {
        Some(dot) if dot > 0 && dot + 1 < name.len() => name[dot + 1..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

pub(crate) fn classify_work_file(file_path: &str) -> WorkFileKind {
    let extension = work_file_extension(file_path);
    if extension.is_empty() {
        return WorkFileKind::Unknown;
    }
    if DOCUMENT_EXTENSIONS.contains(&extension.as_str()) {
        return WorkFileKind::Document;
    }
    if SURFACE_SENSITIVE_TEXT_EXTENSIONS.contains(&extension.as_str()) {
        return WorkFileKind::MarkdownText;
    }
    if CODE_EXTENSIONS.contains(&extension.as_str()) {
        return WorkFileKind::Code;
    }
    if ASSET_EXTENSIONS.contains(&extension.as_str()) {
        return WorkFileKind::Asset;
    }
    WorkFileKind::Unknown
}

pub(crate) fn is_document_path(file_path: &str) -> bool {
    classify_work_file(file_path) == WorkFileKind::Document
}

pub(crate) fn is_code_path(file_path: &str) -> bool {
    classify_work_file(file_path) == WorkFileKind::Code
}

/// Markdown/text is a document only when a document surface opened it. The
/// native Rust write tools are not document writers, so they treat it as
/// reviewable text and attach the generic diff payload.
pub(crate) fn is_generic_diff_path(file_path: &str) -> bool {
    matches!(
        classify_work_file(file_path),
        WorkFileKind::Code | WorkFileKind::MarkdownText
    )
}

fn file_name(file_path: &str) -> &str {
    file_path
        .split(['/', '\\'])
        .filter(|part| !part.is_empty())
        .next_back()
        .unwrap_or("document")
}

/// Shared guard for every direct text write. Office/PDF packages must go
/// through the document flow; rebuilding them from text destroys media and
/// styles. Keep one message so all write tools give the same `doc_draft` hint.
pub(crate) fn assert_direct_write_allowed(file_path: &str) -> Result<()> {
    if !is_document_path(file_path) {
        return Ok(());
    }
    anyhow::bail!(
        "「{}」是 Office/PDF 文档，文本写入工具无法处理（会损坏文件）。修改已有文档请使用 doc_draft 生成草稿；新建文档请使用 doc_write。",
        file_name(file_path)
    );
}

pub(crate) fn assert_coding_target(file_path: &str) -> Result<()> {
    if is_document_path(file_path) {
        anyhow::bail!(
            "「{}」是文档文件，编码工具无法编辑；请使用 doc_draft 生成修改草稿。",
            file_name(file_path)
        );
    }
    Ok(())
}

pub(crate) fn assert_document_target(file_path: &str) -> Result<()> {
    if is_code_path(file_path) {
        anyhow::bail!(
            "「{}」是代码文件，文档草稿工具无法处理；请使用 coding_edit 或 coding_apply 修改代码。",
            file_name(file_path)
        );
    }
    Ok(())
}

/// Whether a generic write to this path should activate coding mode. Text
/// formats such as Markdown/CSV are reviewable code-side edits when no
/// document surface was selected.
pub(crate) fn is_coding_activation_path(file_path: &str) -> bool {
    matches!(
        classify_work_file(file_path),
        WorkFileKind::Code | WorkFileKind::MarkdownText
    )
}

/// Add `before_content` / `after_content` / `content_truncated` to a generic
/// write result for reviewable text files. Document and asset targets keep
/// their existing result shape.
pub(crate) fn attach_write_diff(
    result: &mut Value,
    file_path: &str,
    before: Option<&str>,
    after: &str,
) {
    if !is_generic_diff_path(file_path) {
        return;
    }
    let Some(object) = result.as_object_mut() else {
        return;
    };
    let before = before.unwrap_or("");
    if before.len() > MAX_WRITE_DIFF_BYTES || after.len() > MAX_WRITE_DIFF_BYTES {
        object.insert("content_truncated".into(), json!(true));
        return;
    }
    object.insert("before_content".into(), json!(before));
    object.insert("after_content".into(), json!(after));
    object.insert("content_truncated".into(), json!(false));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_document_code_text_and_asset_extensions() {
        assert_eq!(
            classify_work_file("docs/report.DOCX"),
            WorkFileKind::Document
        );
        assert_eq!(
            classify_work_file("docs/export.PDF"),
            WorkFileKind::Document
        );
        assert_eq!(classify_work_file("src/Main.TSX"), WorkFileKind::Code);
        assert_eq!(classify_work_file("scripts/run.SH"), WorkFileKind::Code);
        assert_eq!(classify_work_file("README.md"), WorkFileKind::MarkdownText);
        assert_eq!(
            classify_work_file("data/table.CSV"),
            WorkFileKind::MarkdownText
        );
        assert_eq!(classify_work_file("assets/logo.PNG"), WorkFileKind::Asset);
        assert_eq!(classify_work_file("LICENSE"), WorkFileKind::Unknown);
    }

    #[test]
    fn accepts_windows_separators_and_ignores_dotfiles() {
        assert_eq!(
            classify_work_file(r"C:\Users\me\project\src\App.TS"),
            WorkFileKind::Code
        );
        assert_eq!(
            classify_work_file(r"C:\Users\me\docs\季度报告.PPTX"),
            WorkFileKind::Document
        );
        assert_eq!(work_file_extension(r"src\app.ts"), "ts");
        assert_eq!(work_file_extension(".env"), "");
        assert_eq!(work_file_extension("archive.tar.gz"), "gz");
    }

    #[test]
    fn guards_cross_document_and_code_targets() {
        let document_error = assert_coding_target("docs/report.docx").unwrap_err();
        assert!(document_error.to_string().contains("doc_draft"));

        let code_error = assert_document_target("src/main.ts").unwrap_err();
        let message = code_error.to_string();
        assert!(message.contains("coding_edit"));
        assert!(message.contains("coding_apply"));

        assert!(assert_direct_write_allowed("src/main.ts").is_ok());
        let direct = assert_direct_write_allowed(r"docs\report.PDF").unwrap_err();
        assert!(direct.to_string().contains("doc_draft"));
    }

    #[test]
    fn attaches_diff_payload_and_reports_truncation() {
        let mut result = json!({ "success": true, "file_path": "src/main.ts" });
        attach_write_diff(&mut result, "src/main.ts", Some("old"), "new");
        assert_eq!(result["before_content"], "old");
        assert_eq!(result["after_content"], "new");
        assert_eq!(result["content_truncated"], false);

        let oversized = "x".repeat(MAX_WRITE_DIFF_BYTES + 1);
        let mut truncated = json!({ "success": true });
        attach_write_diff(&mut truncated, "src/main.ts", Some("old"), &oversized);
        assert_eq!(truncated["content_truncated"], true);
        assert!(truncated.get("before_content").is_none());
        assert!(truncated.get("after_content").is_none());

        let mut document = json!({ "success": true });
        attach_write_diff(&mut document, "docs/report.docx", Some("old"), "new");
        assert!(document.get("before_content").is_none());
        assert!(document.get("content_truncated").is_none());
    }
}
