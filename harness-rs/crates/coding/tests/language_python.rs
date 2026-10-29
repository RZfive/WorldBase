use std::path::Path;
use worldbase_coding::smart_editor::{
    delete_symbol, insert_after, parse_file, rename_symbol, replace_symbol, NodeSelector,
    SymbolKind, SymbolQuery,
};

fn symbol<'a>(
    symbols: &'a [worldbase_coding::smart_editor::SymbolEntry],
    name: &str,
    kind: SymbolKind,
) -> &'a worldbase_coding::smart_editor::SymbolEntry {
    symbols
        .iter()
        .find(|entry| entry.name == name && entry.kind == kind)
        .unwrap_or_else(|| panic!("missing {kind} symbol `{name}`"))
}

#[test]
fn indexes_python_functions_classes_variables_and_nested_parent_paths() {
    let source = r#"import os
from pathlib import Path

MAX_SIZE = 10
_private = 1
value: int = 2
a, b = (1, 2)

def helper(x):
    total = x
    return total

def _helper_internal():
    return 0

class Service:
    def run(self):
        return helper(1)

    class Inner:
        def ping(self):
            return "pong"

async def load():
    return 1

@decorator
def decorated():
    return 2

@decorator
class Decorated:
    pass
"#;
    let parsed = parse_file(Path::new("sample.py"), source).unwrap();
    assert!(!parsed.has_syntax_errors());
    let entries = parsed.symbols();

    assert!(entries.iter().any(|entry| entry.kind == SymbolKind::Import));
    let max_size = symbol(&entries, "MAX_SIZE", SymbolKind::Variable);
    assert!(max_size.exported);
    assert_eq!(max_size.parent_path, Vec::<String>::new());
    let private = symbol(&entries, "_private", SymbolKind::Variable);
    assert!(!private.exported);
    assert!(symbol(&entries, "value", SymbolKind::Variable).exported);
    assert!(!entries
        .iter()
        .any(|entry| entry.name == "a" || entry.name == "a, b"));
    assert!(!entries.iter().any(|entry| entry.name == "obj.attr"));

    let helper = symbol(&entries, "helper", SymbolKind::Function);
    assert!(helper.exported);
    assert_eq!(helper.parent_path, Vec::<String>::new());
    let total = symbol(&entries, "total", SymbolKind::Variable);
    assert_eq!(total.parent_path, vec!["helper"]);
    let private_helper = symbol(&entries, "_helper_internal", SymbolKind::Function);
    assert!(!private_helper.exported);

    let service = symbol(&entries, "Service", SymbolKind::Type);
    assert!(service.exported);
    let run = symbol(&entries, "run", SymbolKind::Function);
    println!(
        "DEBUG nested run exported={} total exported={}",
        run.exported, total.exported
    );
    assert_eq!(run.parent_path, vec!["Service"]);
    let inner = symbol(&entries, "Inner", SymbolKind::Type);
    assert_eq!(inner.parent_path, vec!["Service"]);
    let ping = symbol(&entries, "ping", SymbolKind::Function);
    assert_eq!(ping.parent_path, vec!["Service", "Inner"]);

    let load = symbol(&entries, "load", SymbolKind::Function);
    assert!(load.exported);
    let decorated = symbol(&entries, "decorated", SymbolKind::Function);
    assert!(decorated.exported);
    let decorated_class = symbol(&entries, "Decorated", SymbolKind::Type);
    assert!(decorated_class.exported);
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.name == "decorated" && entry.kind == SymbolKind::Function)
            .count(),
        1,
        "decorated definitions must not be indexed twice"
    );

    let selector = NodeSelector::new(SymbolKind::Function.as_str()).with_name("helper");
    assert!(parsed.find_node(&selector).is_ok());
}

#[test]
fn replaces_inserts_deletes_and_renames_python_functions() {
    let source = r#"def add(a, b):
    return a + b

def run():
    # add stays in comments
    note = "add stays in strings"
    return add(1, 2)
"#;
    let parsed = parse_file(Path::new("sample.py"), source).unwrap();
    let query = SymbolQuery::new("add").with_kind(SymbolKind::Function);

    let replaced = replace_symbol(&parsed, &query, "def add(a, b):\n    return a - b").unwrap();
    assert!(replaced.edited_source.contains("return a - b"));

    let inserted = insert_after(&parsed, &query, "def multiply(a, b):\n    return a * b").unwrap();
    assert!(inserted
        .edited_source
        .contains("\ndef multiply(a, b):\n    return a * b\n"));
    assert!(inserted.edited_source.contains("def run():"));

    let deleted = delete_symbol(&parsed, &query).unwrap();
    assert!(!deleted.edited_source.contains("def add(a, b):"));
    assert!(deleted.edited_source.contains("def run():"));

    let renamed = rename_symbol(&parsed, &query, "sum_values").unwrap();
    assert!(renamed.edited_source.contains("def sum_values(a, b):"));
    assert!(renamed.edited_source.contains("return sum_values(1, 2)"));
    assert!(renamed.edited_source.contains("# add stays in comments"));
    assert!(renamed
        .edited_source
        .contains("note = \"add stays in strings\""));
}

#[test]
fn renames_python_assignment_variables_and_skips_unpacking_targets() {
    let source = r#"MAX_SIZE = 10

def read():
    return MAX_SIZE
"#;
    let parsed = parse_file(Path::new("vars.py"), source).unwrap();
    let query = SymbolQuery::new("MAX_SIZE").with_kind(SymbolKind::Variable);
    let renamed = rename_symbol(&parsed, &query, "LIMIT").unwrap();
    assert!(renamed.edited_source.contains("LIMIT = 10"));
    assert!(renamed.edited_source.contains("return LIMIT"));

    let replaced = replace_symbol(&parsed, &query, "MAX_SIZE = 20").unwrap();
    assert!(replaced.edited_source.contains("MAX_SIZE = 20"));
    let inserted = insert_after(&parsed, &query, "MIN_SIZE = 1").unwrap();
    assert!(inserted.edited_source.contains("\nMIN_SIZE = 1\n"));
    let deleted = delete_symbol(&parsed, &query).unwrap();
    assert!(!deleted.edited_source.contains("MAX_SIZE = 10"));
    assert!(deleted.edited_source.contains("def read():"));

    let unpacked = parse_file(Path::new("unpacked.py"), "left, right = (1, 2)\n").unwrap();
    assert!(unpacked
        .find_symbol(&SymbolQuery::new("left, right").with_kind(SymbolKind::Variable))
        .is_err());
    assert!(unpacked
        .find_symbol(&SymbolQuery::new("left").with_kind(SymbolKind::Variable))
        .is_err());

    let attribute = parse_file(Path::new("attribute.py"), "obj.attr = 1\n").unwrap();
    assert!(attribute
        .find_symbol(&SymbolQuery::new("obj.attr").with_kind(SymbolKind::Variable))
        .is_err());
}

#[test]
fn decorated_python_functions_remain_editable_and_single_indexed() {
    let source = r#"@decorator
def decorated(value):
    return value

@decorator
class Decorated:
    pass
"#;
    let parsed = parse_file(Path::new("decorated.py"), source).unwrap();
    let replaced = replace_symbol(
        &parsed,
        &SymbolQuery::new("decorated").with_kind(SymbolKind::Function),
        "def decorated(value):\n    return value + 1",
    )
    .unwrap();
    assert!(replaced.edited_source.starts_with("@decorator\n"));
    assert!(replaced.edited_source.contains("return value + 1"));
    let extended = replace_symbol(
        &parsed,
        &SymbolQuery::new("Decorated").with_kind(SymbolKind::Type),
        "class Decorated:\n    marker = True",
    )
    .unwrap();
    assert!(extended.edited_source.contains("marker = True"));
    assert!(extended.edited_source.contains("@decorator"));
}

#[test]
fn rejects_ambiguous_python_symbols_and_syntax_errors() {
    let ambiguous = "def duplicate():\n    pass\n\ndef duplicate():\n    return 1\n";
    let parsed = parse_file(Path::new("duplicate.py"), ambiguous).unwrap();
    let error = parsed
        .find_symbol(&SymbolQuery::new("duplicate").with_kind(SymbolKind::Function))
        .unwrap_err();
    assert!(error.to_string().contains("ambiguous symbol"));

    let valid = "def add(a, b):\n    return a + b\n";
    let parsed = parse_file(Path::new("invalid.py"), valid).unwrap();
    let error = replace_symbol(
        &parsed,
        &SymbolQuery::new("add").with_kind(SymbolKind::Function),
        "def add(a, b:",
    )
    .unwrap_err();
    assert!(error.to_string().contains("syntax errors"));

    let broken = parse_file(Path::new("broken.py"), "def broken(:\n    pass\n").unwrap();
    assert!(broken.has_syntax_errors());
}
