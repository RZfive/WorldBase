//! Language-specific syntax profiles for non-frontend languages.
//!
//! The frontend TypeScript family keeps its existing dedicated indexing path
//! because it has special handling for arrow functions and variable
//! declarators. The profiles below provide the same declarations/editing
//! metadata for Python, Go, Rust, and Java.

pub(crate) mod go;
pub(crate) mod java;
pub(crate) mod python;
pub(crate) mod rust;

use super::{LanguageId, SymbolKind};
use tree_sitter::{Language, Node};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExportScope {
    /// Public visibility is a convention at the module/top level only.
    TopLevel,
    /// Visibility is determined per node (Rust/Go/Java modifiers or naming).
    Any,
}

pub(crate) struct LanguageProfile {
    pub grammar: fn() -> Language,
    pub kind_for_node: fn(&str) -> Option<SymbolKind>,
    pub is_import: fn(&str) -> bool,
    /// Nodes that are part of a larger declaration and must not be edited in
    /// isolation (for example a Go `var_spec` inside `var_declaration`).
    pub is_declarator: fn(&str) -> bool,
    pub symbol_name: fn(Node<'_>, &str) -> Option<String>,
    /// Extra path segment inserted between the enclosing declaration path and
    /// the symbol itself. Go uses this to nest methods under their receiver.
    pub declaration_parent: Option<fn(Node<'_>, &str) -> Option<String>>,
    /// Import declarations that bind several names. Returning an empty list
    /// falls back to [`LanguageProfile::symbol_name`].
    pub import_names: Option<fn(Node<'_>, &str) -> Vec<String>>,
    pub is_exported: fn(Node<'_>, &str) -> bool,
    pub export_scope: ExportScope,
    pub identifier_kinds: &'static [&'static str],
    pub reserved_words: &'static [&'static str],
}

pub(crate) fn profile(language: LanguageId) -> &'static LanguageProfile {
    match language {
        LanguageId::Python => &python::PROFILE,
        LanguageId::Go => &go::PROFILE,
        LanguageId::Rust => &rust::PROFILE,
        LanguageId::Java => &java::PROFILE,
        LanguageId::JavaScript | LanguageId::TypeScript | LanguageId::Tsx => {
            unreachable!("frontend languages use the dedicated frontend path")
        }
    }
}

pub(crate) fn node_text<'source>(node: Node<'_>, source: &'source str) -> Option<&'source str> {
    source.get(node.byte_range())
}

pub(crate) fn name_field<'source>(node: Node<'_>, source: &'source str) -> Option<&'source str> {
    node.child_by_field_name("name")
        .and_then(|name| node_text(name, source))
}
