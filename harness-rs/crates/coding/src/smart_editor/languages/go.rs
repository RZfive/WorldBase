use super::{name_field, node_text, ExportScope, LanguageProfile};
use crate::smart_editor::SymbolKind;
use tree_sitter::Node;

pub(crate) static PROFILE: LanguageProfile = LanguageProfile {
    grammar: || tree_sitter_go::LANGUAGE.into(),
    kind_for_node: |kind| match kind {
        "function_declaration" => Some(SymbolKind::Function),
        "method_declaration" => Some(SymbolKind::Method),
        "type_spec" | "type_alias" => Some(SymbolKind::Type),
        "import_declaration" | "import_spec" => Some(SymbolKind::Import),
        "var_spec" | "const_spec" => Some(SymbolKind::Variable),
        _ => None,
    },
    is_import: |kind| kind == "import_spec",
    is_declarator: |kind| matches!(kind, "var_spec" | "const_spec"),
    symbol_name: go_symbol_name,
    export_scope: ExportScope::Any,
    is_exported: go_is_exported,
    identifier_kinds: &[
        "identifier",
        "field_identifier",
        "type_identifier",
        "package_identifier",
    ],
    reserved_words: &[
        "break",
        "case",
        "chan",
        "const",
        "continue",
        "default",
        "defer",
        "else",
        "fallthrough",
        "for",
        "func",
        "go",
        "goto",
        "if",
        "import",
        "interface",
        "map",
        "package",
        "range",
        "return",
        "select",
        "struct",
        "switch",
        "type",
        "var",
    ],
};

/// Go methods keep their simple name so selectors remain stable. The generic
/// indexer cannot attach a receiver type as `parent_path`; method entries are
/// therefore top-level and receiver resolution is left to the caller.
fn go_symbol_name(node: Node<'_>, source: &str) -> Option<String> {
    if node.kind() == "import_spec" {
        if let Some(alias) = name_field(node, source) {
            return Some(alias.to_string());
        }
        let path = node
            .child_by_field_name("path")
            .and_then(|path| node_text(path, source))?;
        return Some(trim_import_path(path).to_string());
    }
    name_field(node, source).map(ToOwned::to_owned)
}

fn go_is_exported(node: Node<'_>, source: &str) -> bool {
    go_symbol_name(node, source)
        .and_then(|name| name.chars().next())
        .is_some_and(char::is_uppercase)
}

fn trim_import_path(path: &str) -> &str {
    let path = path.trim();
    path.strip_prefix('"')
        .and_then(|path| path.strip_suffix('"'))
        .or_else(|| {
            path.strip_prefix('`')
                .and_then(|path| path.strip_suffix('`'))
        })
        .unwrap_or(path)
}
