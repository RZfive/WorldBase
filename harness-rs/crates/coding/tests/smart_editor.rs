use std::path::{Path, PathBuf};
use worldbase_coding::smart_editor::{
    parse_file, LanguageId, NodeSelector, SymbolKind, SymbolQuery,
};

#[test]
fn parses_typescript_function_and_returns_unique_node_range() {
    let source =
        "export function add(left: number, right: number): number {\n  return left + right;\n}\n";
    let parsed = parse_file(Path::new("src/math.ts"), source).unwrap();

    assert_eq!(parsed.language, LanguageId::TypeScript);
    assert_eq!(parsed.path, Path::new("src/math.ts"));
    assert_eq!(parsed.source, source);
    assert!(!parsed.has_syntax_errors());

    let selector = NodeSelector::new("function_declaration").with_name("add");
    let node = parsed.find_node(&selector).unwrap();
    assert_eq!(
        &source[node.byte_range()],
        "function add(left: number, right: number): number {\n  return left + right;\n}"
    );
    assert_eq!(node.start_row, 0);
    assert_eq!(node.start_column, 7);
    assert_eq!(node.end_row, 2);
    assert_eq!(node.end_column, 1);
}

#[test]
fn parses_javascript_declarations_and_arrow_functions() {
    let source = "function greet(name) {\n  return `Hello ${name}`;\n}\n\nconst double = (value) => value * 2;\n";
    let parsed = parse_file(Path::new("src/utils.js"), source).unwrap();

    assert_eq!(parsed.language, LanguageId::JavaScript);
    assert!(!parsed.has_syntax_errors());

    let function = parsed
        .find_node(&NodeSelector::new("function_declaration").with_name("greet"))
        .unwrap();
    assert_eq!(
        &source[function.byte_range()],
        "function greet(name) {\n  return `Hello ${name}`;\n}"
    );

    let arrow = parsed
        .find_node(&NodeSelector::new("arrow_function").with_name("double"))
        .unwrap();
    assert_eq!(&source[arrow.byte_range()], "(value) => value * 2");
}

#[test]
fn parses_tsx_component_and_jsx_nodes() {
    let source = "type Props = { name: string };\n\nexport function Greeting({ name }: Props) {\n  return <section><h1>Hello {name}</h1></section>;\n}\n";
    let parsed = parse_file(Path::new("src/Greeting.tsx"), source).unwrap();

    assert_eq!(parsed.language, LanguageId::Tsx);
    assert!(!parsed.has_syntax_errors());
    parsed
        .find_node(&NodeSelector::new("function_declaration").with_name("Greeting"))
        .unwrap();
    let jsx = parsed.find_nodes(&NodeSelector::new("jsx_element"));
    assert!(!jsx.is_empty(), "TSX grammar should expose JSX elements");
}

#[test]
fn rejects_non_unique_name_matches() {
    let source = "function duplicate() {}\nfunction duplicate() { return 1; }\n";
    let parsed = parse_file(Path::new("src/duplicate.js"), source).unwrap();
    let error = parsed
        .find_node(&NodeSelector::new("function_declaration").with_name("duplicate"))
        .unwrap_err();
    assert!(error.to_string().contains("2 matched"));
}

#[test]
fn rejects_unsupported_extensions() {
    let error = parse_file(Path::new("README.md"), "# not frontend source").unwrap_err();
    assert!(error
        .to_string()
        .contains("unsupported source extension"));
}

#[test]
fn detects_syntax_errors_without_failing_parse() {
    let source = "export function broken( {\n  return 1;\n}\n";
    let parsed = parse_file(Path::new("src/broken.ts"), source).unwrap();

    assert_eq!(parsed.language, LanguageId::TypeScript);
    assert!(parsed.has_syntax_errors());
}

#[test]
fn proposes_typescript_function_replacement() {
    let source =
        "export function add(left: number, right: number): number {\n  return left + right;\n}\n";
    let parsed = parse_file(Path::new("src/math.ts"), source).unwrap();
    let selector = NodeSelector::new("function_declaration").with_name("add");
    let replacement =
        "function add(left: number, right: number): number {\n  return left * right;\n}";

    let proposal = parsed
        .propose_semantic_edit(&selector, replacement)
        .unwrap();

    assert_eq!(proposal.file_path, Path::new("src/math.ts"));
    assert_eq!(
        proposal.original_snippet,
        &source[proposal.byte_range.clone()]
    );
    assert_eq!(proposal.replacement, replacement);
    assert_eq!(
        proposal.edited_source,
        "export function add(left: number, right: number): number {\n  return left * right;\n}\n"
    );
}

#[test]
fn proposes_tsx_jsx_node_replacement() {
    let source = "export function App() {\n  return <div>Old</div>;\n}\n";
    let parsed = parse_file(Path::new("src/App.tsx"), source).unwrap();
    let selector = NodeSelector::new("jsx_element");

    let proposal = parsed
        .propose_semantic_edit(&selector, "<section>New</section>")
        .unwrap();

    assert_eq!(proposal.original_snippet, "<div>Old</div>");
    assert_eq!(proposal.replacement, "<section>New</section>");
    assert_eq!(
        proposal.edited_source,
        "export function App() {\n  return <section>New</section>;\n}\n"
    );
}

#[test]
fn preserves_indentation_and_crlf_newline_style() {
    let source =
        "export function outer() {\r\n  function inner() {\r\n    return 1;\r\n  }\r\n}\r\n";
    let parsed = parse_file(Path::new("src/nested.ts"), source).unwrap();
    let selector = NodeSelector::new("function_declaration").with_name("inner");
    let replacement = "function inner() {\n  return 2;\n}";

    let proposal = parsed
        .propose_semantic_edit(&selector, replacement)
        .unwrap();

    assert_eq!(
        proposal.replacement,
        "function inner() {\r\n    return 2;\r\n  }"
    );
    assert_eq!(
        proposal.edited_source,
        "export function outer() {\r\n  function inner() {\r\n    return 2;\r\n  }\r\n}\r\n"
    );
}

#[test]
fn rejects_duplicate_and_missing_selector_matches() {
    let source = "function duplicate() {}\nfunction duplicate() { return 1; }\n";
    let parsed = parse_file(Path::new("src/duplicate.js"), source).unwrap();

    let duplicate = parsed
        .propose_semantic_edit(
            &NodeSelector::new("function_declaration").with_name("duplicate"),
            "function duplicate() { return 2; }",
        )
        .unwrap_err();
    assert!(duplicate.to_string().contains("2 matched"));

    let missing = parsed
        .propose_semantic_edit(
            &NodeSelector::new("function_declaration").with_name("missing"),
            "function missing() {}",
        )
        .unwrap_err();
    assert!(missing.to_string().contains("no syntax node matched"));
}

#[test]
fn rejects_invalid_and_noop_replacements() {
    let source = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
    let parsed = parse_file(Path::new("src/math.ts"), source).unwrap();
    let selector = NodeSelector::new("function_declaration").with_name("add");

    let invalid = parsed
        .propose_semantic_edit(
            &selector,
            "function add(a: number, b: number): number {\n  return a + b;",
        )
        .unwrap_err();
    assert!(invalid.to_string().contains("syntax errors"));

    let noop = parsed
        .propose_semantic_edit(
            &selector,
            "function add(a: number, b: number): number {\n  return a + b;\n}",
        )
        .unwrap_err();
    assert!(noop.to_string().contains("no-op"));
}

#[test]
fn indexes_typescript_symbols_with_kinds_parents_and_export_flags() {
    let source = r#"import React, { useState as use } from "react";
interface Props { name: string }
type Alias = string;
enum Color { Red }
export function greet(name: string) {
  return name;
}
class Widget {
  label = "x";
  render() {
    function helper() {}
    return this.label;
  }
}
const double = (value: number) => value * 2;
export const config = {
  load: async () => 1,
};
export default Widget;
"#;
    let parsed = parse_file(Path::new("src/symbols.ts"), source).unwrap();
    let symbols = parsed.symbols();

    let find = |name: &str, kind: SymbolKind| {
        symbols
            .iter()
            .find(|entry| entry.name == name && entry.kind == kind)
            .unwrap_or_else(|| panic!("missing {kind} symbol {name}"))
    };

    let react = find("React", SymbolKind::Import);
    assert!(!react.exported);
    assert_eq!(
        &source[react.byte_range()],
        "import React, { useState as use } from \"react\";"
    );
    find("use", SymbolKind::Import);

    let props = find("Props", SymbolKind::Interface);
    assert!(!props.exported);
    assert_eq!(
        &source[props.byte_range()],
        "interface Props { name: string }"
    );

    let alias = find("Alias", SymbolKind::Type);
    assert_eq!(&source[alias.byte_range()], "type Alias = string;");
    find("Color", SymbolKind::Type);

    let greet = find("greet", SymbolKind::Function);
    assert!(greet.exported);
    assert_eq!(greet.parent_path, Vec::<String>::new());
    assert_eq!(
        &source[greet.byte_range()],
        "function greet(name: string) {\n  return name;\n}"
    );

    let widget = find("Widget", SymbolKind::Type);
    assert!(!widget.exported);
    assert_eq!(&source[widget.byte_range()], "class Widget {\n  label = \"x\";\n  render() {\n    function helper() {}\n    return this.label;\n  }\n}");

    let label = find("label", SymbolKind::Variable);
    assert_eq!(label.parent_path, vec!["Widget"]);
    assert_eq!(&source[label.byte_range()], "label = \"x\"");

    let render = find("render", SymbolKind::Method);
    assert_eq!(render.parent_path, vec!["Widget"]);
    let helper = find("helper", SymbolKind::Function);
    assert_eq!(helper.parent_path, vec!["Widget", "render"]);

    let double = find("double", SymbolKind::Function);
    assert_eq!(
        &source[double.byte_range()],
        "const double = (value: number) => value * 2;"
    );

    let config = find("config", SymbolKind::Variable);
    assert!(config.exported);
    let load = find("load", SymbolKind::Function);
    assert_eq!(load.parent_path, vec!["config"]);
    assert!(!load.exported);

    let default_export = find("default", SymbolKind::Export);
    assert!(default_export.exported);
    assert_eq!(
        &source[default_export.byte_range()],
        "export default Widget;"
    );
}

#[test]
fn resolves_symbols_with_parent_paths_and_reports_missing_candidates() {
    let source = "class Widget {\n  render() {\n    function helper() {}\n  }\n}\n";
    let parsed = parse_file(Path::new("src/widget.ts"), source).unwrap();

    let render = parsed
        .find_symbol(
            &SymbolQuery::new("render")
                .with_kind(SymbolKind::Method)
                .with_parent("Widget"),
        )
        .unwrap();
    assert_eq!(render.start_row, 1);

    let helper = parsed
        .find_symbol(&SymbolQuery::new("helper").with_parent("Widget.render"))
        .unwrap();
    assert_eq!(helper.parent_path, vec!["Widget", "render"]);

    assert!(parsed
        .find_symbol(&SymbolQuery::new("render").with_parent("Other"))
        .unwrap_err()
        .to_string()
        .contains("no symbol matched"));

    let missing = parsed
        .find_symbol(&SymbolQuery::new("missing"))
        .unwrap_err()
        .to_string();
    assert!(missing.contains("no symbol matched"));
    assert!(missing.contains("indexed declarations include"));
    assert!(missing.contains("method `render`"));
}

#[test]
fn reports_ambiguous_symbols_with_kinds_and_ranges() {
    let source = "function duplicate() {}\nfunction duplicate() { return 1; }\n";
    let parsed = parse_file(Path::new("src/duplicate.js"), source).unwrap();
    let error = parsed
        .find_symbol(&SymbolQuery::new("duplicate").with_kind(SymbolKind::Function))
        .unwrap_err()
        .to_string();

    assert!(error.contains("ambiguous symbol"));
    assert!(error.contains("2 matches"));
    assert!(error.contains("function `duplicate`"));
    assert!(error.contains("lines 1-1"));
    assert!(error.contains("lines 2-2"));
}

#[test]
fn inserts_after_a_symbol_and_preserves_indentation_and_newlines() {
    let source = "export function one() {\n  return 1;\n}\n\nfunction two() {}\n";
    let parsed = parse_file(Path::new("src/insert.ts"), source).unwrap();
    let proposal = parsed
        .insert_after(
            &SymbolQuery::new("one").with_kind(SymbolKind::Function),
            "function three() {\n  return 3;\n}",
        )
        .unwrap();

    assert_eq!(proposal.byte_range.start, proposal.byte_range.end);
    assert_eq!(proposal.original_snippet, "");
    assert_eq!(
        proposal.edited_source,
        "export function one() {\n  return 1;\n}\nfunction three() {\n  return 3;\n}\n\nfunction two() {}\n"
    );

    let class_source = "class Box {\n  one() {}\n}\n";
    let class_parsed = parse_file(Path::new("src/box.ts"), class_source).unwrap();
    let method = class_parsed
        .insert_after(
            &SymbolQuery::new("one")
                .with_kind(SymbolKind::Method)
                .with_parent("Box"),
            "two() {\n  return 2;\n}",
        )
        .unwrap();
    assert_eq!(
        method.edited_source,
        "class Box {\n  one() {}\n  two() {\n    return 2;\n  }\n}\n"
    );
}

#[test]
fn inserts_with_crlf_newline_style() {
    let source = "function one() {\r\n  return 1;\r\n}\r\n";
    let parsed = parse_file(Path::new("src/crlf.ts"), source).unwrap();
    let proposal = parsed
        .insert_after(&SymbolQuery::new("one"), "function two() {\n  return 2;\n}")
        .unwrap();

    assert_eq!(
        proposal.edited_source,
        "function one() {\r\n  return 1;\r\n}\r\nfunction two() {\r\n  return 2;\r\n}\r\n"
    );
}

#[test]
fn deletes_full_declarations_and_rejects_unsafe_declarators() {
    let source = "const keep = 1;\nexport function remove() {\n  return 2;\n}\nconst tail = 3;\n";
    let parsed = parse_file(Path::new("src/delete.ts"), source).unwrap();
    let proposal = parsed
        .delete_symbol(&SymbolQuery::new("remove").with_kind(SymbolKind::Function))
        .unwrap();

    assert_eq!(
        proposal.original_snippet,
        "export function remove() {\n  return 2;\n}\n"
    );
    assert_eq!(proposal.replacement, "");
    assert_eq!(proposal.edited_source, "const keep = 1;\nconst tail = 3;\n");

    let class_source = "class Box {\n  one() {}\n  two() {}\n}\n";
    let class_parsed = parse_file(Path::new("src/box.ts"), class_source).unwrap();
    let method = class_parsed
        .delete_symbol(
            &SymbolQuery::new("one")
                .with_kind(SymbolKind::Method)
                .with_parent("Box"),
        )
        .unwrap();
    assert_eq!(method.edited_source, "class Box {\n  two() {}\n}\n");

    let field_source = "class Fields {\n  value = 1;\n  next = 2;\n}\n";
    let field_parsed = parse_file(Path::new("src/fields.ts"), field_source).unwrap();
    let field = field_parsed
        .delete_symbol(
            &SymbolQuery::new("value")
                .with_kind(SymbolKind::Variable)
                .with_parent("Fields"),
        )
        .unwrap();
    assert_eq!(field.edited_source, "class Fields {\n  next = 2;\n}\n");

    let field_insert = field_parsed
        .insert_after(
            &SymbolQuery::new("value")
                .with_kind(SymbolKind::Variable)
                .with_parent("Fields"),
            "other = 3;",
        )
        .unwrap();
    assert_eq!(
        field_insert.edited_source,
        "class Fields {\n  value = 1;\n  other = 3;\n  next = 2;\n}\n"
    );

    let multi = "const a = 1, b = 2;\n";
    let multi_parsed = parse_file(Path::new("src/multi.ts"), multi).unwrap();
    let error = multi_parsed
        .delete_symbol(&SymbolQuery::new("b").with_kind(SymbolKind::Variable))
        .unwrap_err()
        .to_string();
    assert!(error.contains("unsafe"));
}

#[test]
fn renames_declarations_and_same_file_identifiers() {
    let source = "const count = 1;\nfunction show() {\n  return count + count;\n}\n";
    let parsed = parse_file(Path::new("src/rename.ts"), source).unwrap();
    let proposal = parsed
        .rename_symbol(
            &SymbolQuery::new("count").with_kind(SymbolKind::Variable),
            "total",
        )
        .unwrap();

    assert_eq!(
        proposal.edited_source,
        "const total = 1;\nfunction show() {\n  return total + total;\n}\n"
    );
    assert_eq!(proposal.replacement, "total");

    let method_source = "class Box {\n  run() { return this.run; }\n}\n";
    let method_parsed = parse_file(Path::new("src/method.ts"), method_source).unwrap();
    let method = method_parsed
        .rename_symbol(
            &SymbolQuery::new("run")
                .with_kind(SymbolKind::Method)
                .with_parent("Box"),
            "execute",
        )
        .unwrap();
    assert_eq!(
        method.edited_source,
        "class Box {\n  execute() { return this.execute; }\n}\n"
    );

    let type_source = "type Foo = string;\nconst value: Foo = \"x\";\n";
    let type_parsed = parse_file(Path::new("src/type.ts"), type_source).unwrap();
    let type_rename = type_parsed
        .rename_symbol(&SymbolQuery::new("Foo").with_kind(SymbolKind::Type), "Bar")
        .unwrap();
    assert_eq!(
        type_rename.edited_source,
        "type Bar = string;\nconst value: Bar = \"x\";\n"
    );

    let import_source = "import { useState as use } from \"react\";\nconst [value] = use(0);\n";
    let import_parsed = parse_file(Path::new("src/import.ts"), import_source).unwrap();
    let import_rename = import_parsed
        .rename_symbol(
            &SymbolQuery::new("use").with_kind(SymbolKind::Import),
            "hook",
        )
        .unwrap();
    assert_eq!(
        import_rename.edited_source,
        "import { useState as hook } from \"react\";\nconst [value] = hook(0);\n"
    );
    assert_eq!(import_rename.original_snippet, "use");
}

#[test]
fn rejects_invalid_noop_and_unsupported_edits() {
    let source = "function one() {}\n";
    let parsed = parse_file(Path::new("src/edit.ts"), source).unwrap();

    let noop_rename = parsed
        .rename_symbol(&SymbolQuery::new("one"), "one")
        .unwrap_err();
    assert!(
        noop_rename.to_string().contains("no-op") || noop_rename.to_string().contains("already")
    );

    let invalid_rename = parsed
        .rename_symbol(&SymbolQuery::new("one"), "1invalid")
        .unwrap_err();
    assert!(invalid_rename.to_string().contains("not a valid"));

    let reserved_rename = parsed
        .rename_symbol(&SymbolQuery::new("one"), "class")
        .unwrap_err();
    assert!(reserved_rename.to_string().contains("reserved word"));

    let empty_insert = parsed
        .insert_after(&SymbolQuery::new("one"), "  \n\r\n")
        .unwrap_err();
    assert!(empty_insert.to_string().contains("inserted text is empty"));

    let broken_insert = parsed
        .insert_after(&SymbolQuery::new("one"), "function broken( {")
        .unwrap_err();
    assert!(broken_insert.to_string().contains("syntax errors"));

    let mut unsupported = parse_file(Path::new("src/edit.ts"), source).unwrap();
    unsupported.path = PathBuf::from("src/edit.md");
    for error in [
        unsupported
            .insert_after(&SymbolQuery::new("one"), "function two() {}")
            .unwrap_err(),
        unsupported
            .delete_symbol(&SymbolQuery::new("one"))
            .unwrap_err(),
        unsupported
            .rename_symbol(&SymbolQuery::new("one"), "two")
            .unwrap_err(),
    ] {
        assert!(error
            .to_string()
            .contains("unsupported source extension"));
    }
}
