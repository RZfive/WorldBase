//! Glob/Grep 代码搜索（基于 ripgrep 的 `ignore` crate，尊重 .gitignore）。

use anyhow::Result;
use ignore::{WalkBuilder, WalkState};
use regex::Regex;
use std::path::{Path, PathBuf};
use std::sync::mpsc;

/// glob 模式匹配文件列表（递归，尊重 gitignore）。
pub fn glob(root: &Path, pattern: &str, limit: usize) -> Result<Vec<PathBuf>> {
    let matcher = glob_regex(pattern)?;
    let mut out = Vec::new();

    let (tx, rx) = mpsc::channel();
    let walker = WalkBuilder::new(root).hidden(false).build_parallel();
    walker.run(|| {
        let tx = tx.clone();
        let matcher = matcher.clone();
        Box::new(move |entry| {
            if let Ok(e) = entry {
                let path = e.path();
                if path.is_file() {
                    let rel = path.strip_prefix(root).unwrap_or(path);
                    if matcher.is_match(&rel.to_string_lossy())
                        && tx.send(path.to_path_buf()).is_ok()
                    {
                        // 继续遍历，由主线程限流
                    }
                }
            }
            WalkState::Continue
        })
    });
    drop(tx);
    for path in rx {
        out.push(path);
        if out.len() >= limit {
            break;
        }
    }
    out.sort();
    Ok(out)
}

fn is_ignored_dir(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "node_modules"
            | ".next"
            | "dist"
            | "build"
            | "coverage"
            | ".cache"
            | ".turbo"
            | ".output"
            | "__pycache__"
            | ".venv"
            | "venv"
    )
}

/// 将用户友好的 glob（如 `**/*.rs`、`src/*.ts`）编译为 regex。
/// `**/` → 任意层级目录（可跨 0 层）；`*` → 单段内任意；`?` → 单字符。
fn glob_regex(pattern: &str) -> Result<Regex> {
    let patterns = expand_brace_patterns(pattern);
    let branches = patterns
        .iter()
        .map(|pattern| glob_pattern_regex(pattern))
        .collect::<Vec<_>>();
    Regex::new(&format!("^(?:{})$", branches.join("|"))).map_err(Into::into)
}

fn expand_brace_patterns(pattern: &str) -> Vec<String> {
    let Some(start) = pattern.find('{') else {
        return vec![pattern.to_string()];
    };
    let Some(end) = pattern[start + 1..]
        .find('}')
        .map(|offset| start + 1 + offset)
    else {
        return vec![pattern.to_string()];
    };
    let alternatives = pattern[start + 1..end].split(',').collect::<Vec<_>>();
    if alternatives.len() < 2 {
        return vec![pattern.to_string()];
    }
    let prefix = &pattern[..start];
    let suffix = &pattern[end + 1..];
    alternatives
        .into_iter()
        .flat_map(|alternative| expand_brace_patterns(&format!("{prefix}{alternative}{suffix}")))
        .collect()
}

fn glob_pattern_regex(pattern: &str) -> String {
    let mut re = String::from("^");
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '*' {
            if chars.peek() == Some(&'*') {
                chars.next();
                if chars.peek() == Some(&'/') {
                    chars.next();
                    re.push_str("(?:.*/)?");
                } else {
                    re.push_str(".*");
                }
            } else {
                re.push_str("[^/]*");
            }
        } else if c == '?' {
            re.push_str("[^/]");
        } else {
            re.push_str(&regex::escape(&c.to_string()));
        }
    }
    re.trim_start_matches('^').to_string()
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct GrepHit {
    pub path: String,
    pub line: u64,
    pub text: String,
    pub context_before: Vec<String>,
    pub context_after: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct GrepOptions {
    pub literal: bool,
    pub case_sensitive: bool,
    pub include_pattern: Option<String>,
    pub output_mode: GrepOutputMode,
    pub max_results: usize,
    pub context_lines: usize,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum GrepOutputMode {
    #[default]
    Content,
    FilesWithMatches,
    Count,
}

#[derive(Debug, Clone, Default)]
pub struct GrepSummary {
    pub hits: Vec<GrepHit>,
    pub files: Vec<String>,
    pub counts: Vec<(String, usize)>,
    pub total_matches: usize,
    pub files_searched: usize,
    pub files_matched: usize,
    pub truncated: bool,
}

/// 内容搜索（等价 ripgrep 单文件版）：正则或字面量，尊重 gitignore。
pub fn grep(root: &Path, pattern: &str, literal: bool, limit: usize) -> Result<Vec<GrepHit>> {
    Ok(grep_with_options(
        root,
        pattern,
        GrepOptions {
            literal,
            case_sensitive: true,
            max_results: limit,
            ..GrepOptions::default()
        },
    )?
    .hits)
}

/// Search with the full Electron-compatible option set.
pub fn grep_with_options(root: &Path, pattern: &str, options: GrepOptions) -> Result<GrepSummary> {
    let max_results = options.max_results.max(1);
    let context_lines = options.context_lines.min(5);
    let expression = if options.literal {
        regex::escape(pattern)
    } else {
        pattern.to_string()
    };
    let re = regex::RegexBuilder::new(&expression)
        .case_insensitive(!options.case_sensitive)
        .build()?;
    let include = options
        .include_pattern
        .as_deref()
        .map(|pattern| {
            let expression = expand_brace_patterns(pattern)
                .into_iter()
                .map(|pattern| glob_pattern_regex(&pattern))
                .collect::<Vec<_>>();
            Regex::new(&format!("(?i:^(?:{})$)", expression.join("|")))
        })
        .transpose()?;
    let mut hits = Vec::new();
    let mut files = Vec::new();
    let mut counts = Vec::new();
    let mut total_matches = 0usize;
    let mut files_searched = 0usize;
    let mut files_matched = 0usize;
    let mut truncated = false;

    let (tx, rx) = mpsc::channel::<(PathBuf, Vec<String>)>();
    let walker = WalkBuilder::new(root).hidden(false).build_parallel();
    walker.run(|| {
        let tx = tx.clone();
        let include = include.clone();
        Box::new(move |entry| {
            if let Ok(e) = entry {
                let path = e.path().to_path_buf();
                if path.is_dir() {
                    if path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .map(is_ignored_dir)
                        .unwrap_or(false)
                    {
                        return WalkState::Skip;
                    }
                    return WalkState::Continue;
                }
                if path.is_file() {
                    if let Some(include) = &include {
                        let name = path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or_default();
                        if !include.is_match(name) {
                            return WalkState::Continue;
                        }
                    }
                    // 跳过二进制与超大文件
                    let Ok(meta) = std::fs::metadata(&path) else {
                        return WalkState::Continue;
                    };
                    if meta.len() > 4 * 1024 * 1024 {
                        return WalkState::Continue;
                    }
                    if let Ok(content) = std::fs::read(&path) {
                        if content.contains(&0u8) {
                            return WalkState::Continue;
                        }
                        let text = String::from_utf8_lossy(&content);
                        let lines = text.lines().map(ToOwned::to_owned).collect::<Vec<_>>();
                        if tx.send((path, lines)).is_err() {
                            return WalkState::Quit;
                        }
                    }
                }
            }
            WalkState::Continue
        })
    });
    drop(tx);
    for (path, lines) in rx {
        files_searched += 1;
        let mut matching_lines = Vec::new();
        for (index, line) in lines.iter().enumerate() {
            if re.is_match(line) {
                matching_lines.push(index);
            }
        }
        if matching_lines.is_empty() {
            continue;
        }
        if options.output_mode == GrepOutputMode::Content && hits.len() >= max_results {
            truncated = true;
            break;
        }
        files_matched += 1;
        total_matches += if options.output_mode == GrepOutputMode::FilesWithMatches {
            1
        } else {
            matching_lines.len()
        };
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        match options.output_mode {
            GrepOutputMode::FilesWithMatches => {
                if files.len() < max_results {
                    files.push(relative);
                } else {
                    truncated = true;
                    break;
                }
            }
            GrepOutputMode::Count => {
                if counts.len() < max_results {
                    counts.push((relative, matching_lines.len()));
                } else {
                    truncated = true;
                    break;
                }
            }
            GrepOutputMode::Content => {
                for index in matching_lines {
                    if hits.len() >= max_results {
                        truncated = true;
                        break;
                    }
                    let before_start = index.saturating_sub(context_lines);
                    let after_end = (index + context_lines + 1).min(lines.len());
                    hits.push(GrepHit {
                        path: relative.clone(),
                        line: (index + 1) as u64,
                        text: lines[index].chars().take(500).collect(),
                        context_before: lines[before_start..index].to_vec(),
                        context_after: lines[index + 1..after_end].to_vec(),
                    });
                }
            }
        }
    }
    hits.sort_by(|a, b| (&a.path, a.line).cmp(&(&b.path, b.line)));
    files.sort();
    counts.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(GrepSummary {
        hits,
        files,
        counts,
        total_matches,
        files_searched,
        files_matched,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, ()) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "fn main() {}\n// hello world\n").unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("sub/b.txt"), "hello grep\nsecond line\n").unwrap();
        (dir, ())
    }

    #[test]
    fn glob_finds_by_pattern() {
        let (dir, _) = setup();
        let hits = glob(dir.path(), "**/*.rs", 100).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].ends_with("a.rs"));

        let all = glob(dir.path(), "**/*", 100).unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn grep_literal_and_regex() {
        let (dir, _) = setup();
        let hits = grep(dir.path(), "hello world", true, 100).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, 2);

        let hits = grep(dir.path(), r"second \w+", false, 100).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, 2);
        assert!(hits[0].text.contains("second line"));
    }

    #[test]
    fn grep_options_match_electron_modes_and_context() {
        let (dir, _) = setup();
        let summary = grep_with_options(
            dir.path(),
            "HELLO",
            GrepOptions {
                literal: true,
                case_sensitive: false,
                include_pattern: Some("*.txt".into()),
                output_mode: GrepOutputMode::Content,
                max_results: 10,
                context_lines: 1,
            },
        )
        .unwrap();
        assert_eq!(summary.files_searched, 1);
        assert_eq!(summary.files_matched, 1);
        assert_eq!(summary.total_matches, 1);
        assert_eq!(summary.hits[0].path, "sub/b.txt");
        assert!(summary.hits[0]
            .context_after
            .iter()
            .any(|line| line == "second line"));

        let files = grep_with_options(
            dir.path(),
            "hello",
            GrepOptions {
                literal: true,
                output_mode: GrepOutputMode::FilesWithMatches,
                max_results: 10,
                ..GrepOptions::default()
            },
        )
        .unwrap();
        assert_eq!(files.files, vec!["a.rs", "sub/b.txt"]);

        let counts = grep_with_options(
            dir.path(),
            "hello",
            GrepOptions {
                literal: true,
                output_mode: GrepOutputMode::Count,
                max_results: 10,
                ..GrepOptions::default()
            },
        )
        .unwrap();
        assert_eq!(
            counts.counts,
            vec![("a.rs".into(), 1), ("sub/b.txt".into(), 1)]
        );
    }
}
