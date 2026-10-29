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
    declaration_parent: None,
    import_names: Some(import_names_for),
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

fn import_names_for(node: Node<'_>, source: &str) -> Vec<String> {
    let mut names = Vec::new();
    match node.kind() {
        "import_statement" => collect_bound_names(node, source, &mut names),
        "import_from_statement" => {
            let mut cursor = node.walk();
            for child in node.children_by_field_name("name", &mut cursor) {
                collect_imported_name(child, source, &mut names);
            }
            if names.is_empty() {
                let module_range = node
                    .child_by_field_name("module_name")
                    .map(|module| module.byte_range());
                for child in node.named_children(&mut cursor) {
                    if module_range
                        .as_ref()
                        .is_some_and(|range| range == &child.byte_range())
                    {
                        continue;
                    }
                    if matches!(
                        child.kind(),
                        "dotted_name" | "aliased_import" | "wildcard_import"
                    ) {
                        collect_imported_name(child, source, &mut names);
                    }
                }
            }
        }
        _ => {}
    }
    names.dedup();
    names
}

fn collect_bound_names(node: Node<'_>, source: &str, names: &mut Vec<String>) {
    let mut cursor = node.walk();
    for child in node.children_by_field_name("name", &mut cursor) {
        match child.kind() {
            "dotted_name" => {
                if let Some(text) = node_text(child, source) {
                    let binding = text.split('.').next().unwrap_or(text).trim();
                    if !binding.is_empty() {
                        names.push(binding.to_string());
                    }
                }
            }
            _ => collect_imported_name(child, source, names),
        }
    }
}

fn collect_imported_name(node: Node<'_>, source: &str, names: &mut Vec<String>) {
    let name = match node.kind() {
        "wildcard_import" => Some("*".to_string()),
        "aliased_import" => node
            .child_by_field_name("alias")
            .and_then(|alias| node_text(alias, source))
            .or_else(|| {
                node.child_by_field_name("name")
                    .and_then(|name| node_text(name, source))
            })
            .map(ToOwned::to_owned),
        _ => node_text(node, source)
            .map(str::trim)
            .map(ToOwned::to_owned),
    };
    if let Some(name) = name.filter(|name| !name.is_empty()) {
        names.push(name);
    }
}

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
