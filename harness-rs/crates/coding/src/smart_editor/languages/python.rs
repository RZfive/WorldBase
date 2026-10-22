use super::{name_field, node_text, ExportScope, LanguageProfile};
use crate::smart_editor::SymbolKind;
use tree_sitter::{Language, Node};

pub(crate) static PROFILE: LanguageProfile = LanguageProfile {
    grammar: || tree_sitter_python::LANGUAGE.into(),
    kind_for_node: |kind| match kind {
        "function_definition" => Some(SymbolKind::Function),
        "class_definition" => Some(SymbolKind::Type),
        "import_statement" | "import_from_statement" => Some(SymbolKind::Import),
        "assignment" | "annotated_assignment" => Some(SymbolKind::Variable),
        _ => None,
    },
    is_import: |kind| matches!(kind, "import_statement" | "import_from_statement"),
    is_declarator: |kind| matches!(kind, "assignment" | "annotated_assignment"),
    symbol_name: symbol_name_for,
    export_scope: ExportScope::TopLevel,
    is_exported: is_exported_for,
    identifier_kinds: &["identifier"],
    reserved_words: &[
        "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class",
        "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global",
        "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return",
        "try", "while", "with", "yield",
    ],
};

fn symbol_name_for(node: Node<'_>, source: &str) -> Option<String> {
    if matches!(node.kind(), "assignment" | "annotated_assignment") {
        let left = node.child_by_field_name("left")?;
        if left.kind() != "identifier" {
            return None;
        }
        return node_text(left, source).map(ToOwned::to_owned);
    }
    name_field(node, source).map(ToOwned::to_owned)
}

fn is_exported_for(node: Node<'_>, source: &str) -> bool {
    let Some(name) = symbol_name_for(node, source) else {
        return false;
    };
    !name.starts_with('_') && is_module_level(node)
}

fn is_module_level(node: Node<'_>) -> bool {
    let Some(mut parent) = node.parent() else {
        return false;
    };
    while parent.kind() == "decorated_definition" {
        let Some(next) = parent.parent() else {
            return false;
        };
        parent = next;
    }
    if parent.kind() == "expression_statement" {
        let Some(next) = parent.parent() else {
            return false;
        };
        parent = next;
    }
    parent.kind() == "module"
}

#[allow(dead_code)]
fn _assert_language(_: Language, _: Node<'_>) -> crate::smart_editor::LanguageId {
    crate::smart_editor::LanguageId::Python
}
