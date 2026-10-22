use std::path::Path;
use worldbase_coding::smart_editor::{
    delete_symbol, insert_after, parse_file, rename_symbol, replace_symbol, SymbolKind, SymbolQuery,
};

fn parse(source: &str) -> worldbase_coding::smart_editor::ParsedFile {
    let parsed = parse_file(Path::new("Main.java"), source).unwrap();
    assert!(!parsed.has_syntax_errors(), "fixture has syntax errors");
    parsed
}

fn symbol(
    parsed: &worldbase_coding::smart_editor::ParsedFile,
    kind: SymbolKind,
    name: &str,
    parent: &[&str],
) -> worldbase_coding::smart_editor::SymbolEntry {
    parsed
        .find_symbol(
            &SymbolQuery::new(name)
                .with_kind(kind)
                .with_parent_path(parent.iter().map(|segment| segment.to_string())),
        )
        .unwrap_or_else(|error| panic!("missing {kind} `{name}`: {error}"))
}

#[test]
fn indexes_classes_interfaces_enums_records_and_modules() {
    let source = r#"package com.example.app;

import java.util.List;

public class Outer {
    public static class Nested {
    }

    interface Inner {
    }

    enum Mode {
        ON, OFF
    }

    record Pair(int left, int right) {
    }
}
"#;
    let parsed = parse(source);

    let module = symbol(&parsed, SymbolKind::Module, "com.example.app", &[]);
    assert_eq!(module.kind, SymbolKind::Module);

    let outer = symbol(&parsed, SymbolKind::Type, "Outer", &[]);
    assert!(outer.exported);
    assert!(outer.parent_path.is_empty());

    let nested = symbol(&parsed, SymbolKind::Type, "Nested", &["Outer"]);
    assert_eq!(nested.kind, SymbolKind::Type);
    let inner = symbol(&parsed, SymbolKind::Interface, "Inner", &["Outer"]);
    assert_eq!(inner.kind, SymbolKind::Interface);
    let mode = symbol(&parsed, SymbolKind::Type, "Mode", &["Outer"]);
    assert_eq!(mode.kind, SymbolKind::Type);
    let pair = symbol(&parsed, SymbolKind::Type, "Pair", &["Outer"]);
    assert_eq!(pair.kind, SymbolKind::Type);

    let imported = symbol(&parsed, SymbolKind::Import, "java.util.List", &[]);
    assert_eq!(imported.kind, SymbolKind::Import);
}

#[test]
fn indexes_methods_and_constructors_with_parent_paths() {
    let source = r#"class Widget {
    Widget() {
    }

    Widget(int size) {
        this.size = size;
    }

    int size;

    void run() {
    }

    static class Inner {
        void nestedRun() {
        }
    }
}
"#;
    let parsed = parse(source);

    let constructors = parsed.find_symbols(
        &SymbolQuery::new("Widget")
            .with_kind(SymbolKind::Method)
            .with_parent("Widget"),
    );
    assert_eq!(constructors.len(), 2, "both constructors are indexed");
    assert!(constructors
        .iter()
        .all(|entry| entry.kind == SymbolKind::Method));

    symbol(&parsed, SymbolKind::Method, "run", &["Widget"]);
    symbol(
        &parsed,
        SymbolKind::Method,
        "nestedRun",
        &["Widget", "Inner"],
    );
}

#[test]
fn marks_public_and_private_declarations() {
    let source = r#"class PackagePrivate {
    public int visible;
    private int hidden;
    public void shown() {
    }
    private void concealed() {
    }
}

public interface Contract {
    int MAX = 10;
    void run();
}
"#;
    let parsed = parse(source);

    let holder = symbol(&parsed, SymbolKind::Type, "PackagePrivate", &[]);
    assert!(!holder.exported, "package-private classes are not exported");
    assert!(
        symbol(
            &parsed,
            SymbolKind::Variable,
            "visible",
            &["PackagePrivate"]
        )
        .exported
    );
    assert!(!symbol(&parsed, SymbolKind::Variable, "hidden", &["PackagePrivate"]).exported);
    assert!(symbol(&parsed, SymbolKind::Method, "shown", &["PackagePrivate"]).exported);
    assert!(
        !symbol(
            &parsed,
            SymbolKind::Method,
            "concealed",
            &["PackagePrivate"]
        )
        .exported
    );

    let contract = symbol(&parsed, SymbolKind::Interface, "Contract", &[]);
    assert!(contract.exported);
    assert!(
        symbol(&parsed, SymbolKind::Variable, "MAX", &["Contract"]).exported,
        "interface fields are implicitly public"
    );
    assert!(
        symbol(&parsed, SymbolKind::Method, "run", &["Contract"]).exported,
        "interface methods are implicitly public"
    );
}

#[test]
fn indexes_only_unambiguous_single_variable_fields() {
    let source = r#"class Fields {
    private int count;
    public String name = "value";
    int first, second;

    void method() {
        int local = 1;
    }
}
"#;
    let parsed = parse(source);
    let variables = parsed
        .symbols()
        .into_iter()
        .filter(|entry| entry.kind == SymbolKind::Variable)
        .collect::<Vec<_>>();

    assert_eq!(
        variables
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>(),
        ["count", "name"]
    );
    assert_eq!(variables[0].parent_path, ["Fields"]);
    assert!(!variables[0].exported);
    assert!(variables[1].exported);
}

#[test]
fn replaces_inserts_and_deletes_java_declarations() {
    let source = r#"public class Service {
    public int add(int a, int b) {
        return a + b;
    }

    public int sub(int a, int b) {
        return a - b;
    }
}
"#;
    let parsed = parse(source);
    let add = SymbolQuery::new("add")
        .with_kind(SymbolKind::Method)
        .with_parent("Service");

    let replaced = replace_symbol(
        &parsed,
        &add,
        "public int add(int a, int b) {\n        return a + b + 1;\n    }",
    )
    .unwrap();
    assert!(replaced.edited_source.contains("return a + b + 1;"));

    let inserted = insert_after(
        &parsed,
        &add,
        "public int multiply(int a, int b) {\n    return a * b;\n}",
    )
    .unwrap();
    let reparsed = parse_file(Path::new("Main.java"), &inserted.edited_source).unwrap();
    assert!(!reparsed.has_syntax_errors());
    assert!(inserted.edited_source.contains("public int multiply"));

    let sub = SymbolQuery::new("sub")
        .with_kind(SymbolKind::Method)
        .with_parent("Service");
    let deleted = delete_symbol(&parsed, &sub).unwrap();
    let reparsed = parse_file(Path::new("Main.java"), &deleted.edited_source).unwrap();
    assert!(!reparsed.has_syntax_errors());
    assert!(!deleted.edited_source.contains("public int sub"));
}

#[test]
fn renames_references_but_not_strings_or_comments() {
    let source = r#"class Calculator {
    int compute(int value) {
        return value;
    }

    int apply() {
        return compute(2);
    }

    String label() {
        return "compute";
    }

    // compute is intentionally mentioned here
}
"#;
    let parsed = parse(source);
    let query = SymbolQuery::new("compute")
        .with_kind(SymbolKind::Method)
        .with_parent("Calculator");

    let renamed = rename_symbol(&parsed, &query, "calculate").unwrap();
    let edited = renamed.edited_source;
    assert!(edited.contains("int calculate(int value)"));
    assert!(edited.contains("return calculate(2);"));
    assert!(edited.contains("\"compute\""));
    assert!(edited.contains("// compute is intentionally mentioned here"));
    let reparsed = parse_file(Path::new("Main.java"), &edited).unwrap();
    assert!(!reparsed.has_syntax_errors());

    let reserved = rename_symbol(&parsed, &query, "class").unwrap_err();
    assert!(reserved.to_string().contains("reserved word"));
}

#[test]
fn rejects_ambiguous_duplicate_names() {
    let source = r#"class Duplicate {
    void run() {
    }

    void run(int value) {
    }
}
"#;
    let parsed = parse(source);
    let error = parsed
        .find_symbol(&SymbolQuery::new("run").with_kind(SymbolKind::Method))
        .unwrap_err();
    assert!(error.to_string().contains("ambiguous"));
}

#[test]
fn rejects_invalid_syntax_and_edits_that_introduce_syntax_errors() {
    let broken = parse_file(
        Path::new("Broken.java"),
        "public class Broken {\n    void run( {\n}\n",
    )
    .unwrap();
    assert!(broken.has_syntax_errors());

    let parsed = parse("public class Valid {\n    void run() {\n    }\n}\n");
    let query = SymbolQuery::new("run")
        .with_kind(SymbolKind::Method)
        .with_parent("Valid");
    let error = replace_symbol(&parsed, &query, "void run( {\n    }\n}").unwrap_err();
    assert!(error.to_string().contains("syntax errors"));
}
