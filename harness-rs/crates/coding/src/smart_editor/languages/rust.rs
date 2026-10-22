use super::{name_field, node_text, ExportScope, LanguageProfile};
use crate::smart_editor::SymbolKind;
use tree_sitter::Node;

/// Profile for Rust syntax trees.
///
/// `impl_item` symbols are named from the `type` field (`Foo` in both
/// `impl Foo` and `impl Display for Foo`). Trait impls therefore group their
/// methods under the implemented type, matching inherent impls. The trade-off
/// is that a type declaration and its impl blocks share a name, so callers
/// selecting a type should include a kind or parent filter when an impl is
/// present in the same file.
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
        "impl_item" => node
            .child_by_field_name("type")
            .and_then(|ty| node_text(ty, source))
            .map(str::trim)
            .map(ToOwned::to_owned),
        "use_declaration" => node
            .child_by_field_name("argument")
            .and_then(|argument| node_text(argument, source))
            .map(str::trim)
            .map(ToOwned::to_owned),
        _ => name_field(node, source).map(ToOwned::to_owned),
    },
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

fn is_exported_for(node: Node<'_>, source: &str) -> bool {
    if let Some(visibility) = (0..node.child_count())
        .filter_map(|index| node.child(index))
        .find(|child| child.kind() == "visibility_modifier")
    {
        return source
            .get(visibility.byte_range())
            .is_some_and(|text| text.trim_start().starts_with("pub"));
    }

    // Trait items inherit the trait's visibility because trait members are
    // implicitly public once the trait is public.
    let mut parent = node.parent();
    while let Some(ancestor) = parent {
        if ancestor.kind() == "trait_item" {
            return is_exported_for(ancestor, source);
        }
        if matches!(
            ancestor.kind(),
            "impl_item" | "mod_item" | "struct_item" | "enum_item"
        ) {
            return false;
        }
        parent = ancestor.parent();
    }
    false
}
