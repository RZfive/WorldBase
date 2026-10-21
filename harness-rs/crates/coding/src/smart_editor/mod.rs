//! Frontend-first semantic parsing for JavaScript, TypeScript, and TSX.

mod edit;
mod index;

pub use edit::{delete_symbol, insert_after, rename_symbol, replace_symbol};
pub use index::{SymbolEntry, SymbolKind, SymbolQuery};

use anyhow::{Context, Result};
use std::{ops::Range, path::Path};
use tree_sitter::{Language, Node, Parser, Tree};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LanguageId {
    JavaScript,
    TypeScript,
    Tsx,
}

impl LanguageId {
    /// Resolve a supported frontend language from its file extension.
    pub fn from_path(path: &Path) -> Result<Self> {
        let extension = path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase);

        match extension.as_deref() {
            Some("js" | "jsx" | "mjs" | "cjs") => Ok(Self::JavaScript),
            Some("ts" | "mts" | "cts") => Ok(Self::TypeScript),
            Some("tsx") => Ok(Self::Tsx),
            Some(extension) => anyhow::bail!(
                "unsupported frontend source extension .{extension}: {}",
                path.display()
            ),
            None => anyhow::bail!(
                "frontend source path has no file extension: {}",
                path.display()
            ),
        }
    }

    fn grammar(self) -> Language {
        match self {
            Self::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            Self::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Self::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
        }
    }
}

#[derive(Debug)]
pub struct ParsedFile {
    pub path: std::path::PathBuf,
    pub source: String,
    pub language: LanguageId,
    pub tree: Tree,
}

impl ParsedFile {
    /// Whether tree-sitter found error or missing nodes anywhere in the tree.
    pub fn has_syntax_errors(&self) -> bool {
        self.tree.root_node().has_error()
    }

    /// Find every syntax node matching a selector in source order.
    pub fn find_nodes(&self, selector: &NodeSelector) -> Vec<NodeRange> {
        let mut ranges = Vec::new();
        let mut stack = vec![self.tree.root_node()];

        while let Some(node) = stack.pop() {
            if selector.matches(node, &self.source) {
                ranges.push(NodeRange::from_node(node));
            }

            let mut cursor = node.walk();
            let mut children = node.children(&mut cursor).collect::<Vec<_>>();
            children.reverse();
            stack.extend(children);
        }

        ranges
    }

    /// Find exactly one syntax node, returning an error for zero or multiple
    /// matches. Non-unique matches are rejected so callers cannot silently
    /// select the wrong declaration.
    pub fn find_node(&self, selector: &NodeSelector) -> Result<NodeRange> {
        let ranges = self.find_nodes(selector);
        match ranges.len() {
            0 => anyhow::bail!("no syntax node matched {}", selector.describe()),
            1 => Ok(ranges.into_iter().next().expect("one range")),
            count => anyhow::bail!(
                "expected exactly one syntax node, but {} matched {}",
                count,
                selector.describe()
            ),
        }
    }

    /// Build an in-memory semantic replacement proposal. The edited source is
    /// parsed again before it is returned, and no file or command is touched.
    pub fn propose_semantic_edit(
        &self,
        selector: &NodeSelector,
        replacement: impl Into<String>,
    ) -> Result<SemanticEdit> {
        propose_semantic_edit(self, selector, replacement)
    }
}

/// A compact selector over tree-sitter node kind and an optional syntax name.
///
/// Names use the grammar's `name` field. Common anonymous function forms also
/// inherit the name from their variable declarator, object property, or
/// assignment target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeSelector {
    pub kind: String,
    pub name: Option<String>,
}

impl NodeSelector {
    pub fn new(kind: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            name: None,
        }
    }

    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    fn matches(&self, node: Node<'_>, source: &str) -> bool {
        if node.kind() != self.kind {
            return false;
        }
        match &self.name {
            Some(expected) => node_name(node, source) == Some(expected.as_str()),
            None => true,
        }
    }

    fn describe(&self) -> String {
        match &self.name {
            Some(name) => format!("kind `{}` and name `{name}`", self.kind),
            None => format!("kind `{}`", self.kind),
        }
    }
}

/// Byte and row/column bounds for a selected tree-sitter node.
///
/// Rows and columns are zero-based, matching tree-sitter positions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeRange {
    pub start_byte: usize,
    pub end_byte: usize,
    pub start_row: usize,
    pub start_column: usize,
    pub end_row: usize,
    pub end_column: usize,
}

impl NodeRange {
    pub fn byte_range(&self) -> Range<usize> {
        self.start_byte..self.end_byte
    }

    fn from_node(node: Node<'_>) -> Self {
        let start = node.start_position();
        let end = node.end_position();
        Self {
            start_byte: node.start_byte(),
            end_byte: node.end_byte(),
            start_row: start.row,
            start_column: start.column,
            end_row: end.row,
            end_column: end.column,
        }
    }
}

/// A validated, in-memory semantic replacement proposal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemanticEdit {
    pub file_path: std::path::PathBuf,
    pub byte_range: Range<usize>,
    pub original_snippet: String,
    pub replacement: String,
    pub edited_source: String,
}

/// Alias kept for callers that name the proposal type by its role.
pub type EditProposal = SemanticEdit;

/// Generate a replacement only when the selector identifies exactly one node.
///
/// Multiline replacements inherit the selected node's line-leading whitespace
/// and the source file's newline style. The resulting source must parse without
/// tree-sitter error or missing nodes.
pub fn propose_semantic_edit(
    parsed: &ParsedFile,
    selector: &NodeSelector,
    replacement: impl Into<String>,
) -> Result<SemanticEdit> {
    let range = parsed.find_node(selector)?;
    let byte_range = range.byte_range();
    let original_snippet = parsed
        .source
        .get(byte_range.clone())
        .context("selected syntax node range is not valid UTF-8 source bounds")?
        .to_string();
    let requested_replacement = replacement.into();
    let replacement =
        preserve_multiline_formatting(&parsed.source, byte_range.start, &requested_replacement);

    if replacement == original_snippet {
        anyhow::bail!("semantic edit rejected: replacement is a no-op");
    }

    let mut edited_source =
        String::with_capacity(parsed.source.len() - original_snippet.len() + replacement.len());
    edited_source.push_str(&parsed.source[..byte_range.start]);
    edited_source.push_str(&replacement);
    edited_source.push_str(&parsed.source[byte_range.end..]);

    let edited = parse_file(&parsed.path, &edited_source)
        .with_context(|| format!("re-parse edited source for {}", parsed.path.display()))?;
    if edited.has_syntax_errors() {
        anyhow::bail!(
            "semantic edit rejected: replacement introduces syntax errors in {}",
            parsed.path.display()
        );
    }

    Ok(SemanticEdit {
        file_path: parsed.path.clone(),
        byte_range,
        original_snippet,
        replacement,
        edited_source,
    })
}

/// Parse an in-memory frontend source file with the grammar selected by its
/// extension. This function never reads or writes the filesystem.
pub fn parse_file(path: &Path, source: &str) -> Result<ParsedFile> {
    let language = LanguageId::from_path(path)?;
    let mut parser = Parser::new();
    parser
        .set_language(&language.grammar())
        .with_context(|| format!("load {:?} grammar for {}", language, path.display()))?;
    let tree = parser
        .parse(source, None)
        .with_context(|| format!("parse {}", path.display()))?;

    Ok(ParsedFile {
        path: path.to_path_buf(),
        source: source.to_string(),
        language,
        tree,
    })
}

fn node_name<'source>(node: Node<'_>, source: &'source str) -> Option<&'source str> {
    if let Some(name) = field_text(node, source, "name") {
        return Some(name);
    }

    if !matches!(
        node.kind(),
        "arrow_function" | "function_expression" | "generator_function" | "function"
    ) {
        return None;
    }

    let parent = node.parent()?;
    match parent.kind() {
        "variable_declarator" => field_text(parent, source, "name"),
        "pair" | "property" => field_text(parent, source, "key"),
        "assignment_expression" => field_text(parent, source, "left"),
        _ => None,
    }
}

fn field_text<'source>(node: Node<'_>, source: &'source str, field: &str) -> Option<&'source str> {
    let child = node.child_by_field_name(field)?;
    source.get(child.byte_range())
}

fn preserve_multiline_formatting(source: &str, start_byte: usize, replacement: &str) -> String {
    let newline = detect_newline(source);
    let normalized = replacement.replace("\r\n", "\n").replace('\r', "\n");
    let indentation = leading_indentation(source, start_byte);
    let mut formatted = String::with_capacity(normalized.len() + indentation.len() * 4);

    for (index, line) in normalized.split('\n').enumerate() {
        if index > 0 {
            formatted.push_str(newline);
            if !line.is_empty() {
                formatted.push_str(&indentation);
            }
        }
        formatted.push_str(line);
    }

    formatted
}

fn detect_newline(source: &str) -> &'static str {
    let bytes = source.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        match byte {
            b'\n' => return "\n",
            b'\r' if bytes.get(index + 1) == Some(&b'\n') => return "\r\n",
            b'\r' => return "\r",
            _ => {}
        }
    }
    "\n"
}

fn leading_indentation(source: &str, start_byte: usize) -> String {
    let line_start = source[..start_byte]
        .rfind(['\n', '\r'])
        .map(|index| index + 1)
        .unwrap_or(0);
    source[line_start..start_byte]
        .chars()
        .take_while(|character| matches!(character, ' ' | '\t'))
        .collect()
}
