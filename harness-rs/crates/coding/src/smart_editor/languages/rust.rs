use super::{name_field, node_text, ExportScope, LanguageProfile};
use crate::smart_editor::SymbolKind;
use tree_sitter::Node;

/// Profile for Rust syntax trees.
///
/// `impl_item` symbols are named from the `type` field for inherent impls
/// (`Foo`) and use `Foo as Trait` for trait impls. Methods inherit that path,
/// so inherent and trait implementations no longer collide under one name.
/// A type declaration and its inherent impl still share a name; callers
/// selecting a type should include a kind or parent filter when necessary.
///
/// `scoped_identifier` is intentionally excluded from `identifier_kinds`.
/// Renames walk the identifier children of a scoped path (`foo::bar` contains
/// separate `identifier` nodes), so including the whole scoped node would only
/// risk replacing a full path with one identifier.
pub(crate) static PROFILE: LanguageProfile = LanguageProfile {
    grammar: || tree_sitter_rust::LANGUAGE.into(),
    kind_for_node: |kind| match kind {
        "function_item" | "function_signature_item" | "macro_definition" => {
            Some(SymbolKind::Function)
        }
        "struct_item" | "enum_item" | "trait_item" | "type_item" | "impl_item" => {
            Some(SymbolKind::Type)
        }
        "mod_item" => Some(SymbolKind::Module),
        "use_declaration" => Some(SymbolKind::Import),
        "const_item" | "static_item" => Some(SymbolKind::Variable),
        _ => None,
    },
    is_import: |kind| kind == "use_declaration",
    is_declarator: |_| false,
    symbol_name: |node, source| match node.kind() {
        "impl_item" => impl_name(node, source),
        "use_declaration" => node
            .child_by_field_name("argument")
            .and_then(|argument| node_text(argument, source))
            .map(str::trim)
            .map(ToOwned::to_owned),
        _ => name_field(node, source).map(ToOwned::to_owned),
    },
    declaration_parent: None,
    import_names: Some(use_import_names),
    export_scope: ExportScope::Any,
    is_exported: is_exported_for,
    identifier_kinds: &["identifier", "field_identifier", "type_identifier"],
    reserved_words: &[
        "abstract",
        "as",
        "async",
        "await",
        "become",
        "box",
        "break",
        "const",
        "continue",
        "crate",
        "do",
        "dyn",
        "else",
        "enum",
        "extern",
        "false",
        "final",
        "fn",
        "for",
        "gen",
        "if",
        "impl",
        "in",
        "let",
        "loop",
        "macro",
        "macro_rules",
        "match",
        "mod",
        "move",
        "mut",
        "override",
        "priv",
        "pub",
        "raw",
        "ref",
        "return",
        "safe",
        "self",
        "Self",
        "static",
        "struct",
        "super",
        "trait",
        "true",
        "try",
        "type",
        "typeof",
        "union",
        "unsafe",
        "unsized",
        "use",
        "virtual",
        "where",
        "while",
        "yield",
    ],
};

fn impl_name(node: Node<'_>, source: &str) -> Option<String> {
    let implemented = node
        .child_by_field_name("type")
        .and_then(|ty| node_text(ty, source))
        .map(str::trim)
        .filter(|name| !name.is_empty())?;
    match node
        .child_by_field_name("trait")
        .and_then(|trait_name| node_text(trait_name, source))
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        Some(trait_name) => Some(format!("{implemented} as {trait_name}")),
        None => Some(implemented.to_owned()),
    }
}

fn is_exported_for(node: Node<'_>, source: &str) -> bool {
    if let Some(visibility) = direct_visibility(node, source) {
        return visibility_is_public(visibility);
    }

    // Trait items inherit the trait's visibility because trait members are
    // implicitly public once the trait is public. Methods in a trait impl are
    // part of the trait's contract and are exported by the enclosing modules.
    let mut parent = node.parent();
    while let Some(ancestor) = parent {
        match ancestor.kind() {
            "trait_item" => return is_exported_for(ancestor, source),
            "impl_item" => {
                if ancestor.child_by_field_name("trait").is_some() {
                    return enclosing_modules_exported(ancestor, source);
                }
                return false;
            }
            "mod_item" | "struct_item" | "enum_item" => return false,
            _ => {}
        }
        parent = ancestor.parent();
    }
    false
}

fn direct_visibility<'source>(node: Node<'_>, source: &'source str) -> Option<&'source str> {
    (0..node.child_count())
        .filter_map(|index| node.child(index))
        .find(|child| child.kind() == "visibility_modifier")
        .and_then(|visibility| source.get(visibility.byte_range()))
        .map(str::trim)
}

fn visibility_is_public(visibility: &str) -> bool {
    visibility == "pub"
}

fn enclosing_modules_exported(node: Node<'_>, source: &str) -> bool {
    let mut parent = node.parent();
    while let Some(ancestor) = parent {
        if ancestor.kind() == "mod_item" && !is_exported_for(ancestor, source) {
            return false;
        }
        parent = ancestor.parent();
    }
    true
}

fn use_import_names(node: Node<'_>, source: &str) -> Vec<String> {
    let Some(argument) = node.child_by_field_name("argument") else {
        return Vec::new();
    };
    let mut names = Vec::new();
    collect_use_names(argument, "", source, &mut names);
    names.dedup();
    names
}

fn collect_use_names(node: Node<'_>, prefix: &str, source: &str, names: &mut Vec<String>) {
    match node.kind() {
        "use_list" => {
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                collect_use_names(child, prefix, source, names);
            }
        }
        "scoped_use_list" => {
            let next_prefix = node
                .child_by_field_name("path")
                .and_then(|path| node_text(path, source))
                .map(|path| join_use_path(prefix, path.trim()))
                .unwrap_or_else(|| prefix.to_owned());
            if let Some(list) = node.child_by_field_name("list") {
                collect_use_names(list, &next_prefix, source, names);
            }
        }
        "use_as_clause" => {
            let alias = node
                .child_by_field_name("alias")
                .and_then(|alias| node_text(alias, source))
                .map(str::trim)
                .filter(|alias| !alias.is_empty() && *alias != "_");
            let path = node
                .child_by_field_name("path")
                .and_then(|path| node_text(path, source))
                .map(str::trim)
                .unwrap_or_default();
            let name = alias
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| join_use_path(prefix, path));
            if !name.is_empty() {
                names.push(name);
            }
        }
        "identifier" | "scoped_identifier" | "crate" | "super" | "self" | "metavariable"
        | "use_wildcard" => {
            if let Some(text) = node_text(node, source).map(str::trim) {
                let name = join_use_path(prefix, text);
                if !name.is_empty() {
                    names.push(name);
                }
            }
        }
        _ => {
            let mut cursor = node.walk();
            let children = node.named_children(&mut cursor).collect::<Vec<_>>();
            if children.is_empty() {
                if let Some(text) = node_text(node, source).map(str::trim) {
                    let name = join_use_path(prefix, text);
                    if !name.is_empty() {
                        names.push(name);
                    }
                }
            } else {
                for child in children {
                    collect_use_names(child, prefix, source, names);
                }
            }
        }
    }
}

fn join_use_path(prefix: &str, path: &str) -> String {
    if path.is_empty() {
        return prefix.to_owned();
    }
    if prefix.is_empty() {
        return path.to_owned();
    }
    if path == "self" {
        return prefix.to_owned();
    }
    format!("{prefix}::{path}")
}
