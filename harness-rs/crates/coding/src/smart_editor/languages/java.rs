use super::{name_field, node_text, ExportScope, LanguageProfile};
use crate::smart_editor::SymbolKind;
use tree_sitter::Node;

pub(crate) static PROFILE: LanguageProfile = LanguageProfile {
    grammar: || tree_sitter_java::LANGUAGE.into(),
    kind_for_node: |kind| match kind {
        "class_declaration" | "enum_declaration" | "record_declaration" => Some(SymbolKind::Type),
        "interface_declaration" => Some(SymbolKind::Interface),
        "method_declaration" | "constructor_declaration" | "compact_constructor_declaration" => {
            Some(SymbolKind::Method)
        }
        "field_declaration" | "constant_declaration" | "local_variable_declaration" => {
            Some(SymbolKind::Variable)
        }
        "enum_constant" => Some(SymbolKind::Variable),
        "import_declaration" => Some(SymbolKind::Import),
        "package_declaration" => Some(SymbolKind::Module),
        _ => None,
    },
    is_import: |kind| kind == "import_declaration",
    is_declarator: |kind| kind == "variable_declarator",
    symbol_name: |node, source| match node.kind() {
        "field_declaration" | "constant_declaration" | "local_variable_declaration" => {
            single_declarator_name(node, source)
        }
        "package_declaration" => package_name(node, source),
        _ => name_field(node, source).map(ToOwned::to_owned).or_else(|| {
            (node.kind() == "import_declaration")
                .then(|| import_text(node, source))
                .flatten()
        }),
    },
    declaration_parent: None,
    import_names: None,
    // Members are exported only when `public` is present, except that
    // interface and annotation-type members are implicitly public. Explicit
    // `private` interface methods stay non-exported.
    export_scope: ExportScope::Any,
    is_exported: |node, source| {
        if has_modifier(node, source, "private") {
            return false;
        }
        has_modifier(node, source, "public")
            || (node.kind() == "enum_constant"
                && node
                    .parent()
                    .is_some_and(|parent| parent.kind() == "enum_body"))
            || node.parent().is_some_and(|parent| {
                matches!(parent.kind(), "interface_body" | "annotation_type_body")
            })
    },
    identifier_kinds: &["identifier", "type_identifier"],
    reserved_words: &[
        "_",
        "abstract",
        "assert",
        "boolean",
        "break",
        "byte",
        "case",
        "catch",
        "char",
        "class",
        "const",
        "continue",
        "default",
        "do",
        "double",
        "else",
        "enum",
        "extends",
        "false",
        "final",
        "finally",
        "float",
        "for",
        "goto",
        "if",
        "implements",
        "import",
        "instanceof",
        "int",
        "interface",
        "long",
        "native",
        "new",
        "null",
        "package",
        "private",
        "protected",
        "public",
        "return",
        "short",
        "static",
        "strictfp",
        "super",
        "switch",
        "synchronized",
        "this",
        "throw",
        "throws",
        "transient",
        "true",
        "try",
        "void",
        "volatile",
        "while",
    ],
};

/// Java declarations may contain several field/local declarators. Only index
/// a declaration when exactly one clean identifier can be attributed to the
/// whole declaration; multi-declarator declarations are skipped to avoid
/// duplicate or ambiguous entries. Enum constants are single-name nodes and
/// go through `symbol_name` directly.
fn single_declarator_name(node: Node<'_>, source: &str) -> Option<String> {
    let mut cursor = node.walk();
    let declarators = node
        .children_by_field_name("declarator", &mut cursor)
        .collect::<Vec<_>>();
    if declarators.len() != 1 {
        return None;
    }
    let name = declarators[0].child_by_field_name("name")?;
    if name.kind() != "identifier" {
        return None;
    }
    node_text(name, source).map(ToOwned::to_owned)
}

/// Package declarations have no `name` field; the dotted package name is the
/// first identifier/scoped identifier child.
fn package_name(node: Node<'_>, source: &str) -> Option<String> {
    let mut cursor = node.walk();
    let name = node.named_children(&mut cursor).find_map(|child| {
        matches!(child.kind(), "identifier" | "scoped_identifier")
            .then(|| node_text(child, source))
            .flatten()
    });
    name.map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
}

fn import_text(node: Node<'_>, source: &str) -> Option<String> {
    let mut cursor = node.walk();
    let imported = node.named_children(&mut cursor).find_map(|child| {
        matches!(child.kind(), "identifier" | "scoped_identifier")
            .then(|| node_text(child, source))
            .flatten()
    });
    imported.map(|name| name.trim().to_owned())
}

fn has_modifier(node: Node<'_>, source: &str, expected: &str) -> bool {
    let mut cursor = node.walk();
    let found = node
        .children(&mut cursor)
        .filter(|child| child.kind() == "modifiers")
        .filter_map(|modifiers| node_text(modifiers, source))
        .any(|text| text.split_whitespace().any(|token| token == expected));
    found
}
