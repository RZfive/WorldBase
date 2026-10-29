use std::path::{Path, PathBuf};
use worldbase_coding::project_index::{ProjectIndex, SourceFile};
use worldbase_coding::smart_editor::SymbolKind;

fn source(path: &str, text: &str) -> SourceFile {
    SourceFile {
        path: PathBuf::from(path),
        source: text.to_string(),
    }
}

fn ts_index() -> ProjectIndex {
    ProjectIndex::from_sources(vec![
        source(
            "src/math.ts",
            "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
        ),
        source(
            "src/app.ts",
            "import { add } from './math';\n\nexport function useAdd(): number {\n  return add(1, 2);\n}\n",
        ),
    ])
    .unwrap()
}

#[test]
fn indexes_ts_symbols_and_relative_imports() {
    let index = ts_index();
    assert_eq!(
        index.find_symbols("add", Some(SymbolKind::Function)).len(),
        1
    );
    assert_eq!(
        index.imports_of(Path::new("src/app.ts")),
        vec![&PathBuf::from("src/math.ts")]
    );
    assert_eq!(
        index.importers_of(Path::new("src/math.ts")),
        vec![&PathBuf::from("src/app.ts")]
    );
}

#[test]
fn context_includes_imports_and_importers() {
    let index = ts_index();
    let context = index.context_for(&[PathBuf::from("src/math.ts")], 1);
    assert!(context.contains(&PathBuf::from("src/math.ts")));
    assert!(context.contains(&PathBuf::from("src/app.ts")));
}

#[test]
fn cross_file_rename_updates_declaration_and_references() {
    let index = ts_index();
    let plan = index
        .rename_plan("add", Some(SymbolKind::Function), "sum")
        .unwrap();
    let math = plan
        .iter()
        .find(|file| file.path == Path::new("src/math.ts"))
        .unwrap();
    let app = plan
        .iter()
        .find(|file| file.path == Path::new("src/app.ts"))
        .unwrap();
    assert!(math.after.contains("function sum"));
    assert!(app.after.contains("import { sum }"));
    assert!(app.after.contains("return sum(1, 2)"));
}

#[test]
fn ambiguous_rename_is_rejected() {
    let index = ProjectIndex::from_sources(vec![
        source("a.ts", "export function dup() { return 1; }\n"),
        source("b.ts", "export function dup() { return 2; }\n"),
    ])
    .unwrap();
    let error = index
        .rename_plan("dup", Some(SymbolKind::Function), "next")
        .unwrap_err();
    assert!(error.to_string().contains("2 matching declarations"));
}

#[test]
fn python_relative_imports_and_rename() {
    let index = ProjectIndex::from_sources(vec![
        source("pkg/util.py", "def helper() -> int:\n    return 1\n"),
        source(
            "pkg/main.py",
            "from .util import helper\n\ndef run() -> int:\n    return helper()\n",
        ),
    ])
    .unwrap();
    assert_eq!(
        index.imports_of(Path::new("pkg/main.py")),
        vec![&PathBuf::from("pkg/util.py")]
    );
    let plan = index
        .rename_plan("helper", Some(SymbolKind::Function), "assist")
        .unwrap();
    assert_eq!(plan.len(), 2);
    assert!(plan.iter().any(|file| file.after.contains("def assist")));
    assert!(plan
        .iter()
        .any(|file| file.after.contains("return assist()")));
}

#[test]
fn go_and_rust_files_index_without_relative_import_noise() {
    let go = ProjectIndex::from_sources(vec![
        source("main.go", "package main\n\nfunc main() {}\n"),
        source(
            "util.go",
            "package main\n\nfunc helper() int { return 1 }\n",
        ),
    ])
    .unwrap();
    assert_eq!(
        go.find_symbols("helper", Some(SymbolKind::Function)).len(),
        1
    );

    let rust = ProjectIndex::from_sources(vec![
        source("src/lib.rs", "mod util;\n\npub fn run() {}\n"),
        source("src/util.rs", "pub fn helper() -> i32 { 1 }\n"),
    ])
    .unwrap();
    assert_eq!(
        rust.imports_of(Path::new("src/lib.rs")),
        vec![&PathBuf::from("src/util.rs")]
    );
    assert_eq!(
        rust.find_symbols("helper", Some(SymbolKind::Function))
            .len(),
        1
    );
}

#[test]
fn java_class_import_resolves_by_stem() {
    let index = ProjectIndex::from_sources(vec![
        source(
            "src/Main.java",
            "import com.example.Util;\n\npublic class Main {\n  public static void main(String[] args) { Util.helper(); }\n}\n",
        ),
        source(
            "src/Util.java",
            "package com.example;\n\npublic class Util {\n  public static int helper() { return 1; }\n}\n",
        ),
    ])
    .unwrap();
    assert_eq!(
        index.imports_of(Path::new("src/Main.java")),
        vec![&PathBuf::from("src/Util.java")]
    );
    assert_eq!(index.find_symbols("Util", Some(SymbolKind::Type)).len(), 1);
}

#[test]
fn syntax_errors_do_not_abort_indexing() {
    let index = ProjectIndex::from_sources(vec![
        source("src/bad.ts", "export function broken( {\n"),
        source("src/good.ts", "export function ok() { return 1; }\n"),
    ])
    .unwrap();
    assert_eq!(index.parse_errors().len(), 1);
    assert_eq!(
        index.find_symbols("ok", Some(SymbolKind::Function)).len(),
        1
    );
}
