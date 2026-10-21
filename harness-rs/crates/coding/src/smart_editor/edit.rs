//! In-memory semantic edit strategies.
//!
//! Every function in this module only builds and validates a proposal. No
//! filesystem or process operation is performed here.

use super::index::{SymbolEntry, SymbolKind, SymbolQuery};
use super::{
    detect_newline, leading_indentation, parse_file, preserve_multiline_formatting, ParsedFile,
    SemanticEdit,
};
use anyhow::{Context, Result};
use regex::Regex;
use std::ops::Range;
use std::sync::OnceLock;
use tree_sitter::Node;

const RESERVED_WORDS: &[&str] = &[
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "enum",
    "export",
    "extends",
    "false",
    "finally",
    "for",
    "function",
    "if",
    "implements",
    "import",
    "in",
    "instanceof",
    "interface",
    "let",
    "new",
    "null",
    "package",
    "private",
    "protected",
    "public",
    "return",
    "static",
    "super",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "with",
    "yield",
];

impl ParsedFile {
    /// Replace one indexed symbol's full declaration range.
    ///
    /// This keeps the same indentation, newline, and re-parse guarantees as
    /// [`ParsedFile::propose_semantic_edit`].
    pub fn replace_symbol(
        &self,
        query: &SymbolQuery,
        replacement: impl Into<String>,
    ) -> Result<SemanticEdit> {
        replace_symbol(self, query, replacement)
    }

    /// Insert text after one indexed symbol, preserving the target line's
    /// indentation and the file's newline style.
    pub fn insert_after(
        &self,
        query: &SymbolQuery,
        text: impl Into<String>,
    ) -> Result<SemanticEdit> {
        insert_after(self, query, text)
    }

    /// Delete one indexed declaration, including its trailing newline.
    pub fn delete_symbol(&self, query: &SymbolQuery) -> Result<SemanticEdit> {
        delete_symbol(self, query)
    }

    /// Rename a declaration and same-file identifier references with the same
    /// text.
    pub fn rename_symbol(
        &self,
        query: &SymbolQuery,
        new_name: impl AsRef<str>,
    ) -> Result<SemanticEdit> {
        rename_symbol(self, query, new_name)
    }
}

/// Replace one indexed symbol's full declaration range.
pub fn replace_symbol(
    parsed: &ParsedFile,
    query: &SymbolQuery,
    replacement: impl Into<String>,
) -> Result<SemanticEdit> {
    ensure_supported(parsed)?;
    let entry = parsed.find_symbol(query)?;
    propose_range_edit(
        parsed,
        entry.byte_range(),
        replacement.into(),
        "semantic edit",
    )
}

/// Insert text after the selected symbol's containing statement or declaration.
pub fn insert_after(
    parsed: &ParsedFile,
    query: &SymbolQuery,
    text: impl Into<String>,
) -> Result<SemanticEdit> {
    ensure_supported(parsed)?;
    let entry = parsed.find_symbol(query)?;
    let node = node_for_entry(parsed, &entry)
        .with_context(|| format!("resolve indexed symbol `{}`", entry.name))?;
    let container = insertion_container(node)?;
    let insert_at = insertion_offset(&parsed.source, declaration_end(&parsed.source, container));
    let indentation = leading_indentation(&parsed.source, entry.start_byte);
    let insertion = format_insertion(&parsed.source, &indentation, &text.into())?;

    let mut edited_source = String::with_capacity(parsed.source.len() + insertion.len());
    edited_source.push_str(&parsed.source[..insert_at]);
    edited_source.push_str(&insertion);
    edited_source.push_str(&parsed.source[insert_at..]);
    validate_edited_source(parsed, &edited_source, "insert_after")?;

    Ok(SemanticEdit {
        file_path: parsed.path.clone(),
        byte_range: insert_at..insert_at,
        original_snippet: String::new(),
        replacement: insertion,
        edited_source,
    })
}

/// Delete one indexed declaration, including its trailing newline.
pub fn delete_symbol(parsed: &ParsedFile, query: &SymbolQuery) -> Result<SemanticEdit> {
    ensure_supported(parsed)?;
    let entry = parsed.find_symbol(query)?;
    let node = node_for_entry(parsed, &entry)
        .with_context(|| format!("resolve indexed symbol `{}`", entry.name))?;
    let container = deletion_container(node)?;
    let byte_range = deletion_span(&parsed.source, container);
    let original_snippet = parsed
        .source
        .get(byte_range.clone())
        .context("selected symbol range is not valid UTF-8 source bounds")?
        .to_string();

    let mut edited_source = String::with_capacity(parsed.source.len() - original_snippet.len());
    edited_source.push_str(&parsed.source[..byte_range.start]);
    edited_source.push_str(&parsed.source[byte_range.end..]);
    if edited_source == parsed.source {
        anyhow::bail!("delete rejected: deletion is a no-op");
    }
    validate_edited_source(parsed, &edited_source, "delete")?;

    Ok(SemanticEdit {
        file_path: parsed.path.clone(),
        byte_range,
        original_snippet,
        replacement: String::new(),
        edited_source,
    })
}

/// Rename one indexed declaration and same-file identifier references.
///
/// References are intentionally text-based: every `identifier` (plus
/// `type_identifier`, shorthand-property identifiers, and method property
/// identifiers) with the same text is renamed. Scoped symbol resolution is
/// outside this in-memory editor's contract.
pub fn rename_symbol(
    parsed: &ParsedFile,
    query: &SymbolQuery,
    new_name: impl AsRef<str>,
) -> Result<SemanticEdit> {
    ensure_supported(parsed)?;
    let new_name = new_name.as_ref().trim();
    validate_identifier(new_name)?;
    let entry = parsed.find_symbol(query)?;
    if !is_identifier(&entry.name) {
        anyhow::bail!(
            "rename rejected: selected symbol name `{}` is not a simple identifier",
            entry.name
        );
    }
    if entry.name == new_name {
        anyhow::bail!("rename rejected: `{new_name}` is already the selected symbol's name");
    }

    let declaration_name = declaration_name_node(parsed, &entry);
    let mut ranges = Vec::new();
    collect_reference_ranges(
        parsed.tree.root_node(),
        &parsed.source,
        &entry.name,
        entry.kind,
        &mut ranges,
    );
    if let Some(name_node) = declaration_name {
        if source_text(parsed, name_node) == Some(entry.name.as_str()) {
            ranges.push(name_node.byte_range());
        }
    }
    ranges.sort_by_key(|range| range.start);
    ranges.dedup();
    if ranges.is_empty() {
        anyhow::bail!(
            "rename rejected: no identifier named `{}` was found in {}",
            entry.name,
            parsed.path.display()
        );
    }

    let mut edited_source = String::with_capacity(parsed.source.len() + new_name.len());
    let mut cursor = 0;
    for range in &ranges {
        edited_source.push_str(&parsed.source[cursor..range.start]);
        edited_source.push_str(new_name);
        cursor = range.end;
    }
    edited_source.push_str(&parsed.source[cursor..]);
    if edited_source == parsed.source {
        anyhow::bail!("rename rejected: replacement is a no-op");
    }
    validate_edited_source(parsed, &edited_source, "rename")?;

    let (byte_range, original_snippet) = match declaration_name {
        Some(node) => (
            node.byte_range(),
            source_text(parsed, node).unwrap_or_default().to_string(),
        ),
        None => (entry.byte_range(), entry.name.clone()),
    };

    Ok(SemanticEdit {
        file_path: parsed.path.clone(),
        byte_range,
        original_snippet,
        replacement: new_name.to_string(),
        edited_source,
    })
}

fn ensure_supported(parsed: &ParsedFile) -> Result<()> {
    super::LanguageId::from_path(&parsed.path)?;
    Ok(())
}

fn propose_range_edit(
    parsed: &ParsedFile,
    byte_range: Range<usize>,
    requested_replacement: String,
    label: &str,
) -> Result<SemanticEdit> {
    let original_snippet = parsed
        .source
        .get(byte_range.clone())
        .context("selected symbol range is not valid UTF-8 source bounds")?
        .to_string();
    let replacement =
        preserve_multiline_formatting(&parsed.source, byte_range.start, &requested_replacement);
    if replacement == original_snippet {
        anyhow::bail!("{label} rejected: replacement is a no-op");
    }

    let mut edited_source =
        String::with_capacity(parsed.source.len() - original_snippet.len() + replacement.len());
    edited_source.push_str(&parsed.source[..byte_range.start]);
    edited_source.push_str(&replacement);
    edited_source.push_str(&parsed.source[byte_range.end..]);
    validate_edited_source(parsed, &edited_source, label)?;

    Ok(SemanticEdit {
        file_path: parsed.path.clone(),
        byte_range,
        original_snippet,
        replacement,
        edited_source,
    })
}

fn validate_edited_source(parsed: &ParsedFile, edited_source: &str, label: &str) -> Result<()> {
    let edited = parse_file(&parsed.path, edited_source)
        .with_context(|| format!("re-parse {label} result for {}", parsed.path.display()))?;
    if edited.has_syntax_errors() {
        anyhow::bail!(
            "{label} rejected: edit introduces syntax errors in {}",
            parsed.path.display()
        );
    }
    Ok(())
}

fn node_for_entry<'tree>(parsed: &'tree ParsedFile, entry: &SymbolEntry) -> Option<Node<'tree>> {
    let mut stack = vec![parsed.tree.root_node()];
    while let Some(node) = stack.pop() {
        if node.start_byte() == entry.start_byte && node.end_byte() == entry.end_byte {
            return Some(node);
        }
        let mut cursor = node.walk();
        stack.extend(node.named_children(&mut cursor));
    }
    None
}

fn insertion_container(node: Node<'_>) -> Result<Node<'_>> {
    let mut container = node;
    if node.kind() == "variable_declarator" {
        anyhow::bail!(
            "insert_after rejected: a variable declarator inside a multi-declarator statement is not a safe insertion target"
        );
    }
    if matches!(node.kind(), "pair" | "property") {
        anyhow::bail!(
            "insert_after rejected: an object property is not a safe insertion target; insert after its enclosing declaration instead"
        );
    }
    if node.kind() == "assignment_expression" {
        let parent = node
            .parent()
            .context("assignment expression has no parent statement")?;
        anyhow::ensure!(
            parent.kind() == "expression_statement",
            "insert_after rejected: assignment expression is not a standalone statement"
        );
        container = parent;
    }
    if let Some(parent) = container.parent() {
        if parent.kind() == "export_statement" {
            container = parent;
        }
        if matches!(
            parent.kind(),
            "for_statement" | "for_in_statement" | "for_of_statement"
        ) {
            anyhow::bail!(
                "insert_after rejected: the selected declaration is part of a loop header"
            );
        }
    }
    Ok(container)
}

fn deletion_container(node: Node<'_>) -> Result<Node<'_>> {
    if node.kind() == "variable_declarator" {
        anyhow::bail!(
            "delete rejected: a variable declarator without its own statement is unsafe; select a declaration with a single declarator"
        );
    }
    if matches!(node.kind(), "pair" | "property") {
        anyhow::bail!(
            "delete rejected: an object property is not a safe deletion target; delete its enclosing declaration instead"
        );
    }
    let mut container = node;
    if node.kind() == "assignment_expression" {
        let parent = node
            .parent()
            .context("assignment expression has no parent statement")?;
        anyhow::ensure!(
            parent.kind() == "expression_statement",
            "delete rejected: assignment expression is not a standalone statement"
        );
        container = parent;
    }
    if let Some(parent) = container.parent() {
        if parent.kind() == "export_statement" {
            container = parent;
        }
        if matches!(
            parent.kind(),
            "for_statement" | "for_in_statement" | "for_of_statement"
        ) {
            anyhow::bail!("delete rejected: the selected declaration is part of a loop header");
        }
    }
    Ok(container)
}

/// Class fields exclude their semicolon from the tree-sitter node range.
fn declaration_end(source: &str, node: Node<'_>) -> usize {
    let mut end = node.end_byte();
    if node.kind() == "public_field_definition" {
        let bytes = source.as_bytes();
        let mut cursor = end;
        while matches!(bytes.get(cursor), Some(b' ' | b'\t')) {
            cursor += 1;
        }
        if bytes.get(cursor) == Some(&b';') {
            end = cursor + 1;
        }
    }
    end
}

fn insertion_offset(source: &str, end: usize) -> usize {
    let bytes = source.as_bytes();
    let mut cursor = end;
    while matches!(bytes.get(cursor), Some(b' ' | b'\t')) {
        cursor += 1;
    }
    if cursor == bytes.len() || matches!(bytes.get(cursor), Some(b'\n' | b'\r')) {
        return cursor;
    }
    if source[cursor..].starts_with("//") {
        while cursor < bytes.len() && !matches!(bytes[cursor], b'\n' | b'\r') {
            cursor += 1;
        }
        return cursor;
    }
    end
}

fn deletion_span(source: &str, container: Node<'_>) -> Range<usize> {
    let mut start = container.start_byte();
    let line_start = source[..start]
        .rfind(['\n', '\r'])
        .map(|index| index + 1)
        .unwrap_or(0);
    if source[line_start..start]
        .chars()
        .all(|character| matches!(character, ' ' | '\t'))
    {
        start = line_start;
    }

    let bytes = source.as_bytes();
    let container_end = declaration_end(source, container);
    let mut end = container_end;
    while matches!(bytes.get(end), Some(b' ' | b'\t')) {
        end += 1;
    }
    if end < bytes.len() && !matches!(bytes[end], b'\n' | b'\r') {
        end = container_end;
    }
    if source[end..].starts_with("\r\n") {
        end += 2;
    } else if matches!(bytes.get(end), Some(b'\n' | b'\r')) {
        end += 1;
    }
    start..end
}

fn format_insertion(source: &str, indentation: &str, text: &str) -> Result<String> {
    let newline = detect_newline(source);
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut lines = normalized.split('\n').collect::<Vec<_>>();
    while lines.first().is_some_and(|line| line.trim().is_empty()) {
        lines.remove(0);
    }
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    if lines.is_empty() {
        anyhow::bail!("insert_after rejected: inserted text is empty");
    }

    let mut insertion = String::new();
    insertion.push_str(newline);
    for (index, line) in lines.iter().enumerate() {
        if index > 0 {
            insertion.push_str(newline);
        }
        if !line.is_empty() {
            insertion.push_str(indentation);
        }
        insertion.push_str(line);
    }
    Ok(insertion)
}

fn declaration_name_node<'tree>(
    parsed: &'tree ParsedFile,
    entry: &SymbolEntry,
) -> Option<Node<'tree>> {
    let node = node_for_entry(parsed, entry)?;
    match node.kind() {
        "lexical_declaration" | "variable_declaration" => {
            let declarator = named_child_of_kind(node, "variable_declarator")?;
            declarator.child_by_field_name("name")
        }
        "pair" | "property" => node.child_by_field_name("key"),
        "assignment_expression" => node.child_by_field_name("left"),
        _ => node
            .child_by_field_name("name")
            .or_else(|| find_identifier_with_text(node, &parsed.source, &entry.name)),
    }
}

fn find_identifier_with_text<'tree>(
    node: Node<'tree>,
    source: &str,
    name: &str,
) -> Option<Node<'tree>> {
    if reference_node_kind(node.kind(), SymbolKind::Unknown)
        && source.get(node.byte_range()) == Some(name)
    {
        return Some(node);
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if let Some(found) = find_identifier_with_text(child, source, name) {
            return Some(found);
        }
    }
    None
}

fn named_child_of_kind<'tree>(node: Node<'tree>, kind: &str) -> Option<Node<'tree>> {
    let mut cursor = node.walk();
    let found = node
        .named_children(&mut cursor)
        .find(|child| child.kind() == kind);
    found
}

fn collect_reference_ranges(
    node: Node<'_>,
    source: &str,
    name: &str,
    kind: SymbolKind,
    ranges: &mut Vec<Range<usize>>,
) {
    if reference_node_kind(node.kind(), kind) && source.get(node.byte_range()) == Some(name) {
        ranges.push(node.byte_range());
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        collect_reference_ranges(child, source, name, kind, ranges);
    }
}

fn reference_node_kind(node_kind: &str, symbol_kind: SymbolKind) -> bool {
    match node_kind {
        "identifier"
        | "type_identifier"
        | "shorthand_property_identifier"
        | "shorthand_property_identifier_pattern" => true,
        "property_identifier" | "private_property_identifier" => symbol_kind == SymbolKind::Method,
        _ => false,
    }
}

fn source_text<'source>(parsed: &'source ParsedFile, node: Node<'_>) -> Option<&'source str> {
    parsed.source.get(node.byte_range())
}

fn is_identifier(value: &str) -> bool {
    identifier_pattern().is_match(value) && !RESERVED_WORDS.contains(&value)
}

fn validate_identifier(value: &str) -> Result<()> {
    if value.is_empty() {
        anyhow::bail!("identifier must not be empty");
    }
    if RESERVED_WORDS.contains(&value) {
        anyhow::bail!("`{value}` is a reserved word and cannot be used as an identifier");
    }
    if !identifier_pattern().is_match(value) {
        anyhow::bail!("`{value}` is not a valid JavaScript/TypeScript identifier");
    }
    Ok(())
}

fn identifier_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"^[$_\p{XID_Start}][$_\p{XID_Continue}\u{200C}\u{200D}]*$")
            .expect("valid identifier pattern")
    })
}
