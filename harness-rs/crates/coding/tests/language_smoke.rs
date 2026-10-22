use std::path::Path;
use worldbase_coding::smart_editor::{
    delete_symbol, insert_after, parse_file, rename_symbol, replace_symbol, NodeSelector,
    SymbolKind, SymbolQuery,
};

fn assert_symbol(path: &str, source: &str, kind: SymbolKind, name: &str, parent: &[&str]) {
    let parsed = parse_file(Path::new(path), source).unwrap();
    assert!(!parsed.has_syntax_errors(), "{path} has syntax errors");
    let entry = parsed
        .find_symbol(&SymbolQuery::new(name).with_kind(kind))
        .unwrap_or_else(|error| panic!("{path}: {error}"));
    assert_eq!(
        entry.parent_path,
        parent.iter().map(|s| s.to_string()).collect::<Vec<_>>()
    );
    let selector = NodeSelector::new(kind.as_str()).with_name(name);
    assert!(
        parsed.find_node(&selector).is_ok(),
        "{path}: selector did not match"
    );
}

#[test]
fn python_parse_index_and_edit() {
    let source = "def add(a, b):\n    return a + b\n";
    assert_symbol("sample.py", source, SymbolKind::Function, "add", &[]);
    let parsed = parse_file(Path::new("sample.py"), source).unwrap();
    let query = SymbolQuery::new("add").with_kind(SymbolKind::Function);
    let replaced = replace_symbol(&parsed, &query, "def add(a, b):\n    return a + b + 1").unwrap();
    assert!(replaced.edited_source.contains("a + b + 1"));
    let renamed = rename_symbol(&parsed, &query, "sum_values").unwrap();
    assert!(renamed.edited_source.contains("def sum_values"));
    let inserted = insert_after(&parsed, &query, "def sub(a, b):\n    return a - b").unwrap();
    assert!(inserted.edited_source.contains("def sub"));
    let deleted = delete_symbol(&parsed, &query).unwrap();
    assert!(!deleted.edited_source.contains("def add"));
}

#[test]
fn go_parse_index_and_edit() {
    let source = "package main\n\nfunc add(a int, b int) int {\n\treturn a + b\n}\n";
    assert_symbol("main.go", source, SymbolKind::Function, "add", &[]);
    let parsed = parse_file(Path::new("main.go"), source).unwrap();
    let query = SymbolQuery::new("add").with_kind(SymbolKind::Function);
    let replaced = replace_symbol(
        &parsed,
        &query,
        "func add(a int, b int) int {\n\treturn a + b + 1\n}",
    )
    .unwrap();
    assert!(replaced.edited_source.contains("a + b + 1"));
    let renamed = rename_symbol(&parsed, &query, "sum").unwrap();
    assert!(renamed.edited_source.contains("func sum"));
}

#[test]
fn rust_parse_index_and_edit() {
    let source = "pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n";
    assert_symbol("lib.rs", source, SymbolKind::Function, "add", &[]);
    let parsed = parse_file(Path::new("lib.rs"), source).unwrap();
    let query = SymbolQuery::new("add").with_kind(SymbolKind::Function);
    let replaced = replace_symbol(
        &parsed,
        &query,
        "pub fn add(a: i32, b: i32) -> i32 {\n    a + b + 1\n}",
    )
    .unwrap();
    assert!(replaced.edited_source.contains("a + b + 1"));
    let renamed = rename_symbol(&parsed, &query, "sum").unwrap();
    assert!(renamed.edited_source.contains("fn sum"));
}

#[test]
fn java_parse_index_and_edit() {
    let source = "public class Main {\n    public static int add(int a, int b) {\n        return a + b;\n    }\n}\n";
    assert_symbol("Main.java", source, SymbolKind::Type, "Main", &[]);
    let parsed = parse_file(Path::new("Main.java"), source).unwrap();
    assert_symbol("Main.java", source, SymbolKind::Method, "add", &["Main"]);
    let query = SymbolQuery::new("add")
        .with_kind(SymbolKind::Method)
        .with_parent("Main");
    let replaced = replace_symbol(
        &parsed,
        &query,
        "public static int add(int a, int b) {\n        return a + b + 1;\n    }",
    )
    .unwrap();
    assert!(replaced.edited_source.contains("a + b + 1"));
    let renamed = rename_symbol(&parsed, &query, "sum").unwrap();
    assert!(renamed.edited_source.contains("int sum"));
}
