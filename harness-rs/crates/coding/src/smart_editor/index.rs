//! Symbol index for JavaScript, TypeScript, TSX, Python, Go, Rust, and Java syntax trees.

use super::{field_text, languages, LanguageId, ParsedFile};
use anyhow::Result;
use std::ops::Range;
use tree_sitter::Node;

/// A coarse, language-neutral classification for an indexed declaration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SymbolKind {
    Module,
    Type,
    Interface,
    Function,
    Method,
    Variable,
    Import,
    Export,
    Unknown,
}

impl SymbolKind {
    /// Stable lowercase spelling used by tool selectors and diagnostics.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Module => "module",
            Self::Type => "type",
            Self::Interface => "interface",
            Self::Function => "function",
            Self::Method => "method",
            Self::Variable => "variable",
            Self::Import => "import",
            Self::Export => "export",
            Self::Unknown => "unknown",
        }
    }
}

impl std::fmt::Display for SymbolKind {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl std::str::FromStr for SymbolKind {
    type Err = anyhow::Error;

    /// Parse a selector kind.
    ///
    /// Canonical names are preferred, but common tree-sitter node kinds are
    /// accepted so callers migrating from [`super::NodeSelector`] do not have
    /// to translate `function_declaration` or `class_declaration` manually.
    fn from_str(value: &str) -> Result<Self> {
        let normalized = value.trim().to_ascii_lowercase();
        match normalized.as_str() {
            "module" | "program" => Ok(Self::Module),
            "type"
            | "class"
            | "enum"
            | "type_alias"
            | "class_declaration"
            | "abstract_class_declaration"
            | "type_alias_declaration"
            | "enum_declaration" => Ok(Self::Type),
            "interface" | "interface_declaration" => Ok(Self::Interface),
            "function"
            | "function_declaration"
            | "generator_function_declaration"
            | "arrow_function"
            | "function_expression"
            | "generator_function" => Ok(Self::Function),
            "method" | "method_definition" => Ok(Self::Method),
            "variable"
            | "variable_declarator"
            | "lexical_declaration"
            | "variable_declaration"
            | "public_field_definition" => Ok(Self::Variable),
            "import" | "import_statement" => Ok(Self::Import),
            "export" | "export_statement" => Ok(Self::Export),
            "unknown" => Ok(Self::Unknown),
            other => anyhow::bail!(
                "unsupported symbol kind `{other}`; expected one of {}",
                [
                    "module",
                    "type",
                    "interface",
                    "function",
                    "method",
                    "variable",
                    "import",
                    "export",
                    "unknown"
                ]
                .join(", ")
            ),
        }
    }
}

/// One declaration-like symbol discovered in a parsed source file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SymbolEntry {
    pub name: String,
    pub kind: SymbolKind,
    pub start_byte: usize,
    pub end_byte: usize,
    pub start_row: usize,
    pub start_column: usize,
    pub end_row: usize,
    pub end_column: usize,
    /// Enclosing named declaration path, e.g. `["Foo", "bar"]`.
    pub parent_path: Vec<String>,
    pub exported: bool,
}

impl SymbolEntry {
    pub fn byte_range(&self) -> Range<usize> {
        self.start_byte..self.end_byte
    }

    /// One-based line number for human-readable diagnostics.
    pub fn line(&self) -> usize {
        self.start_row + 1
    }
}

/// Filter for [`ParsedFile::find_symbols`] and [`ParsedFile::find_symbol`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SymbolQuery {
    pub kind: Option<SymbolKind>,
    pub name: String,
    pub parent: Option<Vec<String>>,
}

impl SymbolQuery {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            kind: None,
            name: name.into(),
            parent: None,
        }
    }

    pub fn with_kind(mut self, kind: SymbolKind) -> Self {
        self.kind = Some(kind);
        self
    }

    /// Set the parent path from a dotted (`Foo.bar`) or slash-separated
    /// (`Foo/bar`) string.
    pub fn with_parent(mut self, parent: impl AsRef<str>) -> Self {
        let segments = parent
            .as_ref()
            .split(['.', '/'])
            .filter(|segment| !segment.is_empty())
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        self.parent = Some(segments);
        self
    }

    pub fn with_parent_path<I, S>(mut self, parent: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.parent = Some(parent.into_iter().map(Into::into).collect());
        self
    }

    fn matches(&self, entry: &SymbolEntry) -> bool {
        self.name == entry.name
            && self.kind.is_none_or(|kind| kind == entry.kind)
            && self
                .parent
                .as_ref()
                .is_none_or(|parent| parent == &entry.parent_path)
    }
}

impl std::fmt::Display for SymbolQuery {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "name `{}`", self.name)?;
        if let Some(kind) = self.kind {
            write!(formatter, " and kind `{kind}`")?;
        }
        if let Some(parent) = &self.parent {
            write!(formatter, " under `{}`", parent.join("."))?;
        }
        Ok(())
    }
}

impl ParsedFile {
    /// Index every supported declaration in this file, in source order.
    pub fn symbols(&self) -> Vec<SymbolEntry> {
        collect_symbols(self)
    }

    /// Find every symbol matching a query.
    pub fn find_symbols(&self, query: &SymbolQuery) -> Vec<SymbolEntry> {
        self.symbols()
            .into_iter()
            .filter(|entry| query.matches(entry))
            .collect()
    }

    /// Find exactly one symbol.
    ///
    /// Zero matches and ambiguous matches are errors; this method never picks
    /// an arbitrary declaration.
    pub fn find_symbol(&self, query: &SymbolQuery) -> Result<SymbolEntry> {
        let matches = self.find_symbols(query);
        match matches.len() {
            0 => {
                let available = self
                    .symbols()
                    .into_iter()
                    .take(8)
                    .map(|entry| format!("{} `{}` (line {})", entry.kind, entry.name, entry.line()))
                    .collect::<Vec<_>>()
                    .join(", ");
                if available.is_empty() {
                    anyhow::bail!(
                        "no symbol matched {query}; the file contains no indexed declarations"
                    )
                }
                anyhow::bail!(
                    "no symbol matched {query}; indexed declarations include: {available}"
                )
            }
            1 => Ok(matches.into_iter().next().expect("one symbol")),
            count => {
                let candidates = matches
                    .iter()
                    .map(|entry| {
                        format!(
                            "{} `{}` at bytes {}..{} (lines {}-{})",
                            entry.kind,
                            entry.name,
                            entry.start_byte,
                            entry.end_byte,
                            entry.line(),
                            entry.end_row + 1
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n  - ");
                anyhow::bail!(
                    "ambiguous symbol {query}: {count} matches; narrow the selector by kind or parent:\n  - {candidates}"
                )
            }
        }
    }
}

fn collect_symbols(parsed: &ParsedFile) -> Vec<SymbolEntry> {
    let mut entries = Vec::new();
    if matches!(
        parsed.language,
        LanguageId::JavaScript | LanguageId::TypeScript | LanguageId::Tsx
    ) {
        visit(
            parsed.tree.root_node(),
            &[],
            false,
            &mut entries,
            &parsed.source,
        );
    } else {
        visit_generic(
            parsed.tree.root_node(),
            &[],
            false,
            &mut entries,
            &parsed.source,
            parsed.language,
        );
    }
    entries.sort_by_key(|entry| entry.start_byte);
    entries
}

fn visit_generic(
    node: Node<'_>,
    parents: &[String],
    _exported: bool,
    entries: &mut Vec<SymbolEntry>,
    source: &str,
    language: LanguageId,
) {
    let profile = languages::profile(language);
    let mut child_parents = parents.to_vec();
    if let Some(kind) = (profile.kind_for_node)(node.kind()) {
        let name = (profile.symbol_name)(node, source)
            .filter(|name| !name.is_empty())
            .or_else(|| {
                (profile.is_import)(node.kind())
                    .then(|| import_name(node, source))
                    .flatten()
            });
        if let Some(name) = name {
            let start = node.start_position();
            let end = node.end_position();
            let exported = match profile.export_scope {
                languages::ExportScope::TopLevel if !parents.is_empty() => false,
                _ => (profile.is_exported)(node, source),
            };
            entries.push(SymbolEntry {
                name: name.clone(),
                kind,
                start_byte: node.start_byte(),
                end_byte: node.end_byte(),
                start_row: start.row,
                start_column: start.column,
                end_row: end.row,
                end_column: end.column,
                parent_path: parents.to_vec(),
                exported,
            });
            child_parents.push(name);
        }
    }

    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        visit_generic(child, &child_parents, false, entries, source, language);
    }
}

fn import_name(node: Node<'_>, source: &str) -> Option<String> {
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        let text = source.get(child.byte_range())?.trim();
        if !text.is_empty() {
            return Some(text.to_string());
        }
    }
    source
        .get(node.byte_range())
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned)
}

fn visit(
    node: Node<'_>,
    parents: &[String],
    exported: bool,
    entries: &mut Vec<SymbolEntry>,
    source: &str,
) {
    match node.kind() {
        "export_statement" => {
            if let Some(declaration) = node.child_by_field_name("declaration") {
                // Index the inner declaration, not the export wrapper, but
                // remember that the declaration is publicly exported.
                visit(declaration, parents, true, entries, source);
            } else {
                emit_export_symbols(node, parents, entries, source);
                visit_named_children(node, parents, true, entries, source);
            }
        }
        "import_statement" => emit_import_symbols(node, parents, entries, source),
        "lexical_declaration" | "variable_declaration" => {
            let declarators = named_children(node)
                .into_iter()
                .filter(|child| child.kind() == "variable_declarator")
                .collect::<Vec<_>>();
            for declarator in &declarators {
                emit_variable_declarator(
                    *declarator,
                    Some(node),
                    declarators.len(),
                    parents,
                    exported,
                    entries,
                    source,
                );
            }
        }
        "variable_declarator" => {
            emit_variable_declarator(node, None, 1, parents, exported, entries, source)
        }
        "function_declaration" | "generator_function_declaration" => {
            emit_named_declaration(
                node,
                SymbolKind::Function,
                parents,
                exported,
                entries,
                source,
            );
        }
        "class_declaration" | "abstract_class_declaration" | "enum_declaration" => {
            emit_named_declaration(node, SymbolKind::Type, parents, exported, entries, source);
        }
        "interface_declaration" => {
            emit_named_declaration(
                node,
                SymbolKind::Interface,
                parents,
                exported,
                entries,
                source,
            );
        }
        "type_alias_declaration" => {
            emit_named_declaration(node, SymbolKind::Type, parents, exported, entries, source);
        }
        "method_definition" => {
            emit_named_declaration(node, SymbolKind::Method, parents, exported, entries, source);
        }
        "public_field_definition" => {
            let kind = if node
                .child_by_field_name("value")
                .is_some_and(is_function_value)
            {
                SymbolKind::Function
            } else {
                SymbolKind::Variable
            };
            emit_named_declaration(node, kind, parents, exported, entries, source);
        }
        "pair" | "property" => {
            let key = field_text(node, source, "key");
            let value_is_function = node
                .child_by_field_name("value")
                .is_some_and(is_function_value);
            if let (Some(key), true) = (key, value_is_function) {
                entries.push(entry(node, SymbolKind::Function, parents, exported, key));
                let mut child_parents = parents.to_vec();
                child_parents.push(key.to_string());
                visit_named_children(node, &child_parents, false, entries, source);
            } else {
                visit_named_children(node, parents, false, entries, source);
            }
        }
        "assignment_expression" => {
            let right_is_function = node
                .child_by_field_name("right")
                .is_some_and(is_function_value);
            if right_is_function {
                if let Some(left) = field_text(node, source, "left") {
                    let name = left.trim().to_string();
                    entries.push(entry(node, SymbolKind::Function, parents, exported, &name));
                    let mut child_parents = parents.to_vec();
                    child_parents.push(name);
                    visit_named_children(node, &child_parents, false, entries, source);
                    return;
                }
            }
            visit_named_children(node, parents, false, entries, source);
        }
        "arrow_function" | "function_expression" | "generator_function" | "function" => {
            // Named function values are already represented by their variable
            // declarator, object property, or assignment target. Still walk the
            // body so nested declarations receive the enclosing parent path.
            visit_named_children(node, parents, false, entries, source);
        }
        _ => visit_named_children(node, parents, false, entries, source),
    }
}

fn emit_named_declaration(
    node: Node<'_>,
    kind: SymbolKind,
    parents: &[String],
    exported: bool,
    entries: &mut Vec<SymbolEntry>,
    source: &str,
) {
    let Some(name) = field_text(node, source, "name") else {
        visit_named_children(node, parents, false, entries, source);
        return;
    };
    entries.push(entry(node, kind, parents, exported, name));
    let mut child_parents = parents.to_vec();
    child_parents.push(name.to_string());
    visit_named_children(node, &child_parents, false, entries, source);
}

fn emit_variable_declarator(
    node: Node<'_>,
    declaration: Option<Node<'_>>,
    declarator_count: usize,
    parents: &[String],
    exported: bool,
    entries: &mut Vec<SymbolEntry>,
    source: &str,
) {
    let Some(name) = field_text(node, source, "name") else {
        return;
    };
    let kind = if node
        .child_by_field_name("value")
        .is_some_and(is_function_value)
    {
        SymbolKind::Function
    } else {
        SymbolKind::Variable
    };
    let range_node = match declaration {
        Some(declaration) if declarator_count == 1 => declaration,
        _ => node,
    };
    entries.push(entry(range_node, kind, parents, exported, name));

    let mut child_parents = parents.to_vec();
    child_parents.push(name.to_string());
    if let Some(value) = node.child_by_field_name("value") {
        visit(value, &child_parents, false, entries, source);
    }
}

fn emit_import_symbols(
    node: Node<'_>,
    parents: &[String],
    entries: &mut Vec<SymbolEntry>,
    source: &str,
) {
    let mut names = Vec::new();
    if let Some(clause) = named_children(node)
        .into_iter()
        .find(|child| child.kind() == "import_clause")
    {
        for child in named_children(clause) {
            match child.kind() {
                "identifier" => {
                    if let Some(name) = source.get(child.byte_range()) {
                        names.push(name.to_string());
                    }
                }
                "namespace_import" => {
                    if let Some(identifier) = named_children(child)
                        .into_iter()
                        .find(|inner| inner.kind() == "identifier")
                    {
                        if let Some(name) = source.get(identifier.byte_range()) {
                            names.push(name.to_string());
                        }
                    }
                }
                "named_imports" => {
                    collect_import_specifier_names(child, &mut names, source);
                }
                _ => {}
            }
        }
    }

    if names.is_empty() {
        let fallback = field_text(node, source, "source")
            .map(trim_quotes)
            .unwrap_or("import");
        names.push(fallback.to_string());
    }

    for name in names {
        entries.push(entry(node, SymbolKind::Import, parents, false, &name));
    }
}

fn collect_import_specifier_names(node: Node<'_>, names: &mut Vec<String>, source: &str) {
    if node.kind() == "import_specifier" {
        if let Some(name) =
            field_text(node, source, "alias").or_else(|| field_text(node, source, "name"))
        {
            names.push(name.to_string());
        }
    }
    for child in named_children(node) {
        collect_import_specifier_names(child, names, source);
    }
}

fn emit_export_symbols(
    node: Node<'_>,
    parents: &[String],
    entries: &mut Vec<SymbolEntry>,
    source: &str,
) {
    let mut names = Vec::new();
    for child in named_children(node) {
        collect_export_specifier_names(child, &mut names, source);
    }
    if names.is_empty() {
        let fallback = field_text(node, source, "source")
            .map(trim_quotes)
            .unwrap_or("default");
        names.push(fallback.to_string());
    }
    for name in names {
        entries.push(entry(node, SymbolKind::Export, parents, true, &name));
    }
}

fn collect_export_specifier_names(node: Node<'_>, names: &mut Vec<String>, source: &str) {
    if node.kind() == "export_specifier" {
        if let Some(name) =
            field_text(node, source, "alias").or_else(|| field_text(node, source, "name"))
        {
            names.push(name.to_string());
        }
    }
    for child in named_children(node) {
        collect_export_specifier_names(child, names, source);
    }
}

fn entry(
    node: Node<'_>,
    kind: SymbolKind,
    parents: &[String],
    exported: bool,
    name: &str,
) -> SymbolEntry {
    let start = node.start_position();
    let end = node.end_position();
    SymbolEntry {
        name: name.to_string(),
        kind,
        start_byte: node.start_byte(),
        end_byte: node.end_byte(),
        start_row: start.row,
        start_column: start.column,
        end_row: end.row,
        end_column: end.column,
        parent_path: parents.to_vec(),
        exported,
    }
}

fn visit_named_children(
    node: Node<'_>,
    parents: &[String],
    exported: bool,
    entries: &mut Vec<SymbolEntry>,
    source: &str,
) {
    for child in named_children(node) {
        visit(child, parents, exported, entries, source);
    }
}

fn named_children(node: Node<'_>) -> Vec<Node<'_>> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor).collect()
}

fn is_function_value(node: Node<'_>) -> bool {
    matches!(
        node.kind(),
        "arrow_function" | "function_expression" | "generator_function" | "function"
    )
}

fn trim_quotes(value: &str) -> &str {
    value
        .trim()
        .trim_matches(|character| character == '"' || character == '\'' || character == '`')
}
