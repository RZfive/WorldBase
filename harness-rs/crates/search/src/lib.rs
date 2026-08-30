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

/// 将用户友好的 glob（如 `**/*.rs`、`src/*.ts`）编译为 regex。
/// `**/` → 任意层级目录（可跨 0 层）；`*` → 单段内任意；`?` → 单字符。
fn glob_regex(pattern: &str) -> Result<Regex> {
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
    re.push('$');
    Ok(Regex::new(&re)?)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct GrepHit {
    pub path: String,
    pub line: u64,
    pub text: String,
}

/// 内容搜索（等价 ripgrep 单文件版）：正则或字面量，尊重 gitignore。
pub fn grep(root: &Path, pattern: &str, literal: bool, limit: usize) -> Result<Vec<GrepHit>> {
    let re = if literal {
        Regex::new(&regex::escape(pattern))?
    } else {
        Regex::new(pattern)?
    };
    let mut hits = Vec::new();

    let (tx, rx) = mpsc::channel::<GrepHit>();
    let walker = WalkBuilder::new(root).hidden(false).build_parallel();
    walker.run(|| {
        let tx = tx.clone();
        let re = re.clone();
        Box::new(move |entry| {
            if let Ok(e) = entry {
                let path = e.path().to_path_buf();
                if path.is_file() {
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
                        for (i, line) in text.lines().enumerate() {
                            if re.is_match(line) {
                                let hit = GrepHit {
                                    path: path.to_string_lossy().into_owned(),
                                    line: (i + 1) as u64,
                                    text: line.chars().take(500).collect(),
                                };
                                if tx.send(hit).is_err() {
                                    return WalkState::Quit;
                                }
                            }
                        }
                    }
                }
            }
            WalkState::Continue
        })
    });
    drop(tx);
    for hit in rx {
        hits.push(hit);
        if hits.len() >= limit {
            break;
        }
    }
    hits.sort_by(|a, b| (&a.path, a.line).cmp(&(&b.path, b.line)));
    Ok(hits)
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
}
