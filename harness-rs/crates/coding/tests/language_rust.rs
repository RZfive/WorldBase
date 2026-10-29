use std::path::Path;
use worldbase_coding::smart_editor::{
    delete_symbol, insert_after, parse_file, rename_symbol, replace_symbol, ParsedFile, SymbolKind,
    SymbolQuery,
};

const INDEX_SOURCE: &str = r#"use std::collections::HashMap;
pub use crate::api::Widget;

pub struct Public;
struct Private;

pub struct Wrapper<T> {
    value: T,
}

pub fn public_fn() {}

fn private_fn() {}

pub fn first<T: Clone>(items: &[T]) -> Option<T> {
    items.first().cloned()
}

pub mod api {
    pub struct Widget<T> {
        pub value: T,
    }

    pub enum Mode {
        On,
        Off,
    }

    pub trait Render {
        fn render(&self) -> String;
    }

    impl<T: Clone> Widget<T> {
        pub fn new(value: T) -> Self {
            Self { value }
        }

        fn secret(&self) -> T {
            self.value.clone()
        }
    }

    impl<T: Clone> Render for Widget<T> {
        fn render(&self) -> String {
            format!("{:?}", self.value)
        }
    }

    pub type Alias<T> = Widget<T>;
    pub const MAX: usize = 10;
    static COUNT: usize = 0;
}

mod internal {
    pub fn visible() {}

    fn inaccessible() {}
}

pub struct Gadget;

impl Gadget {
    pub fn spin(&self) {}
}

macro_rules! double {
    ($value:expr) => {
        $value * 2
    };
}
"#;

fn parsed(source: &str) -> ParsedFile {
    let parsed = parse_file(Path::new("lib.rs"), source).unwrap();
    assert!(!parsed.has_syntax_errors(), "fixture must parse cleanly");
    parsed
}

fn assert_symbol(
    parsed: &ParsedFile,
    name: &str,
    kind: SymbolKind,
    parent: &[&str],
    exported: bool,
) {
    let query = SymbolQuery::new(name)
        .with_kind(kind)
        .with_parent_path(parent.iter().copied());
    let entry = parsed
        .find_symbol(&query)
        .unwrap_or_else(|error| panic!("{name}: {error}"));
    assert_eq!(entry.name, name);
    assert_eq!(entry.kind, kind);
    assert_eq!(
        entry.parent_path,
        parent
            .iter()
            .map(|part| part.to_string())
            .collect::<Vec<_>>()
    );
    assert_eq!(entry.exported, exported, "{name} export flag");
}

#[test]
fn indexes_rust_items_with_kinds_parent_paths_and_visibility() {
    let parsed = parsed(INDEX_SOURCE);

    assert_symbol(&parsed, "api", SymbolKind::Module, &[], true);
    assert_symbol(&parsed, "Widget", SymbolKind::Type, &["api"], true);
    assert_symbol(&parsed, "Mode", SymbolKind::Type, &["api"], true);
    assert_symbol(&parsed, "Render", SymbolKind::Type, &["api"], true);
    assert_symbol(&parsed, "Alias", SymbolKind::Type, &["api"], true);
    assert_symbol(&parsed, "MAX", SymbolKind::Variable, &["api"], true);
    assert_symbol(
        &parsed,
        "new",
        SymbolKind::Function,
        &["api", "Widget<T>"],
        true,
    );
    assert_symbol(
        &parsed,
        "secret",
        SymbolKind::Function,
        &["api", "Widget<T>"],
        false,
    );
    assert_symbol(
        &parsed,
        "render",
        SymbolKind::Function,
        &["api", "Render"],
        true,
    );
    assert_symbol(
        &parsed,
        "render",
        SymbolKind::Function,
        &["api", "Widget<T> as Render"],
        true,
    );

    assert_symbol(&parsed, "Public", SymbolKind::Type, &[], true);
    assert_symbol(&parsed, "Private", SymbolKind::Type, &[], false);
    assert_symbol(&parsed, "public_fn", SymbolKind::Function, &[], true);
    assert_symbol(&parsed, "private_fn", SymbolKind::Function, &[], false);
    assert_symbol(&parsed, "Wrapper", SymbolKind::Type, &[], true);
    assert_symbol(&parsed, "first", SymbolKind::Function, &[], true);
    assert_symbol(&parsed, "spin", SymbolKind::Function, &["Gadget"], true);
    assert_symbol(&parsed, "double", SymbolKind::Function, &[], false);

    assert_symbol(&parsed, "internal", SymbolKind::Module, &[], false);
    assert_symbol(
        &parsed,
        "visible",
        SymbolKind::Function,
        &["internal"],
        true,
    );
    assert_symbol(
        &parsed,
        "inaccessible",
        SymbolKind::Function,
        &["internal"],
        false,
    );

    let imports = parsed.find_symbols(&SymbolQuery::new("std::collections::HashMap"));
    assert_eq!(imports.len(), 1);
    assert_eq!(imports[0].kind, SymbolKind::Import);
    assert!(!imports[0].exported);

    let reexport = parsed
        .find_symbol(&SymbolQuery::new("crate::api::Widget").with_kind(SymbolKind::Import))
        .unwrap();
    assert!(reexport.exported, "pub use should be exported");
}

#[test]
fn impl_symbols_distinguish_inherent_and_trait_implementations() {
    let source = r#"struct Gadget;

impl Gadget {
    fn spin(&self) {}
}

impl core::fmt::Display for Gadget {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(formatter, "gadget")
    }
}
"#;
    let parsed = parsed(source);

    assert_symbol(&parsed, "spin", SymbolKind::Function, &["Gadget"], false);
    assert_symbol(
        &parsed,
        "fmt",
        SymbolKind::Function,
        &["Gadget as core::fmt::Display"],
        true,
    );

    let inherent = parsed.find_symbols(&SymbolQuery::new("Gadget").with_kind(SymbolKind::Type));
    assert_eq!(
        inherent.len(),
        2,
        "the struct and inherent impl are indexed by type name"
    );
    let trait_impl = parsed
        .find_symbol(&SymbolQuery::new("Gadget as core::fmt::Display").with_kind(SymbolKind::Type))
        .unwrap();
    assert_eq!(trait_impl.kind, SymbolKind::Type);
}

#[test]
fn replace_insert_delete_and_rename_keep_the_file_parseable() {
    let source = r#"fn greet(name: &str) -> String {
    format!("greet {name}")
}

fn main() {
    let message = greet("world");
    println!("{message}"); // greet stays in this comment
}
"#;
    let parsed = parsed(source);
    let query = SymbolQuery::new("greet").with_kind(SymbolKind::Function);

    let replaced = replace_symbol(
        &parsed,
        &query,
        "fn greet(name: &str) -> String {\n    format!(\"hi {name}\")\n}",
    )
    .unwrap();
    assert!(replaced.edited_source.contains("format!(\"hi {name}\")"));

    let inserted = insert_after(&parsed, &query, "fn farewell() {}").unwrap();
    assert!(inserted.edited_source.contains("\nfn farewell() {}"));
    assert!(inserted
        .edited_source
        .contains("fn main() {\n    let message = greet"));

    let deleted = delete_symbol(&parsed, &query).unwrap();
    assert!(!deleted.edited_source.contains("fn greet"));
    assert!(deleted.edited_source.contains("fn main"));

    let renamed = rename_symbol(&parsed, &query, "welcome").unwrap();
    assert!(renamed.edited_source.contains("fn welcome(name: &str)"));
    assert!(renamed.edited_source.contains("welcome(\"world\")"));
    assert!(renamed.edited_source.contains("\"greet {name}\""));
    assert!(renamed
        .edited_source
        .contains("// greet stays in this comment"));
}

#[test]
fn renames_methods_and_type_references() {
    let source = r#"struct Gadget;

impl Gadget {
    fn spin(&self) {
        helper();
    }
}

struct Widget;

fn helper() -> Widget {
    let gadget = Gadget;
    gadget.spin();
    Widget
}
"#;
    let parsed = parsed(source);

    let renamed = rename_symbol(
        &parsed,
        &SymbolQuery::new("spin")
            .with_kind(SymbolKind::Function)
            .with_parent("Gadget"),
        "rotate",
    )
    .unwrap();
    assert!(renamed.edited_source.contains("fn rotate(&self)"));
    assert!(renamed.edited_source.contains("gadget.rotate()"));

    let renamed_type = rename_symbol(
        &parsed,
        &SymbolQuery::new("Widget").with_kind(SymbolKind::Type),
        "Sprocket",
    )
    .unwrap();
    assert!(renamed_type.edited_source.contains("struct Sprocket;"));
    assert!(renamed_type
        .edited_source
        .contains("fn helper() -> Sprocket"));
    assert!(renamed_type.edited_source.contains("    Sprocket\n}"));

    let ambiguous = parsed
        .find_symbol(&SymbolQuery::new("Gadget").with_kind(SymbolKind::Type))
        .unwrap_err();
    assert!(
        ambiguous.to_string().contains("ambiguous"),
        "struct and impl share a name, so a bare type query must be rejected: {ambiguous}"
    );
}

#[test]
fn rejects_ambiguous_duplicate_names() {
    let parsed = parsed("fn dup() {}\n\nfn dup() {}\n");
    let error = parsed
        .find_symbol(&SymbolQuery::new("dup").with_kind(SymbolKind::Function))
        .unwrap_err();
    assert!(error.to_string().contains("ambiguous"), "{error}");
}

#[test]
fn rejects_syntax_errors_and_reserved_renames() {
    let broken = parse_file(Path::new("lib.rs"), "fn broken( {\n").unwrap();
    assert!(broken.has_syntax_errors());

    let parsed = parsed("fn greet() {}\n");
    let query = SymbolQuery::new("greet").with_kind(SymbolKind::Function);
    let error = replace_symbol(&parsed, &query, "fn greet( {\n").unwrap_err();
    assert!(error.to_string().contains("syntax errors"), "{error}");

    let reserved = rename_symbol(&parsed, &query, "fn").unwrap_err();
    assert!(reserved.to_string().contains("reserved word"), "{reserved}");
}

#[test]
fn indexes_generic_functions_and_types() {
    let source = r#"pub struct Wrapper<T> {
    value: T,
}

pub fn identity<T>(value: T) -> T {
    value
}
"#;
    let parsed = parsed(source);

    assert_symbol(&parsed, "Wrapper", SymbolKind::Type, &[], true);
    assert_symbol(&parsed, "identity", SymbolKind::Function, &[], true);
}
