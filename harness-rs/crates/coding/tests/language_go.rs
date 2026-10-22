use std::path::Path;
use worldbase_coding::smart_editor::{
    delete_symbol, insert_after, parse_file, rename_symbol, replace_symbol, LanguageId, SymbolKind,
    SymbolQuery,
};

const INDEX_SOURCE: &str = r#"package sample

import (
	"fmt"
	alias "example.com/pkg"
)

type User struct {
	Name string
}

type Greeter interface {
	Greet() string
}

type ID = string

const MaxLimit = 100

var DefaultLimit = 10

func NewUser(name string) User {
	return User{Name: name}
}

func (u User) Greet() string {
	return fmt.Sprintf("hello %s", u.Name)
}

func (u *User) rename(name string) {
	u.Name = name
}

func helper() {}
"#;

fn parsed(source: &str) -> worldbase_coding::smart_editor::ParsedFile {
    let file = parse_file(Path::new("sample.go"), source).unwrap();
    assert_eq!(file.language, LanguageId::Go);
    assert!(!file.has_syntax_errors(), "sample source has syntax errors");
    file
}

#[test]
fn indexes_package_functions_methods_and_types() {
    let file = parsed(INDEX_SOURCE);
    let symbols = file.symbols();

    let new_user = file
        .find_symbol(&SymbolQuery::new("NewUser").with_kind(SymbolKind::Function))
        .unwrap();
    assert!(new_user.exported);
    assert_eq!(new_user.parent_path, Vec::<String>::new());
    assert!(file.source[new_user.byte_range()].starts_with("func NewUser("));

    let greet = file
        .find_symbol(&SymbolQuery::new("Greet").with_kind(SymbolKind::Method))
        .unwrap();
    assert!(greet.exported);
    assert_eq!(greet.parent_path, vec!["User"]);
    assert!(file.source[greet.byte_range()].starts_with("func (u User) Greet("));

    let rename = file
        .find_symbol(&SymbolQuery::new("rename").with_kind(SymbolKind::Method))
        .unwrap();
    assert!(!rename.exported);
    assert_eq!(rename.parent_path, vec!["User"]);
    assert!(file.source[rename.byte_range()].starts_with("func (u *User) rename("));

    for type_name in ["User", "Greeter", "ID"] {
        let entry = file
            .find_symbol(&SymbolQuery::new(type_name).with_kind(SymbolKind::Type))
            .unwrap();
        assert!(entry.exported, "{type_name}");
        assert_eq!(entry.parent_path, Vec::<String>::new());
    }
    assert_eq!(
        file.find_symbols(&SymbolQuery::new("User").with_kind(SymbolKind::Type))
            .len(),
        1,
        "type_declaration must not duplicate its type_spec"
    );

    let max_limit = file
        .find_symbol(&SymbolQuery::new("MaxLimit").with_kind(SymbolKind::Variable))
        .unwrap();
    assert!(max_limit.exported);
    let default_limit = file
        .find_symbol(&SymbolQuery::new("DefaultLimit").with_kind(SymbolKind::Variable))
        .unwrap();
    assert!(default_limit.exported);

    let helper = file
        .find_symbol(&SymbolQuery::new("helper").with_kind(SymbolKind::Function))
        .unwrap();
    assert!(!helper.exported);

    assert_eq!(symbols.len(), 11);
}

#[test]
fn index_imports_with_grouped_and_aliased_specs() {
    let file = parsed(INDEX_SOURCE);
    let imports = file.find_symbols(&SymbolQuery::new("fmt").with_kind(SymbolKind::Import));
    assert_eq!(imports.len(), 1);
    assert_eq!(imports[0].parent_path, Vec::<String>::new());
    assert!(file.source[imports[0].byte_range()].contains("\"fmt\""));

    let alias = file
        .find_symbol(&SymbolQuery::new("alias").with_kind(SymbolKind::Import))
        .unwrap();
    assert!(file.source[alias.byte_range()].contains("example.com/pkg"));
}

#[test]
fn exported_and_unexported_names_follow_go_export_rules() {
    let source = "\
package sample

func Exported() {}
func local() {}
func ExportedType() {}

type Upper struct{}
type lower struct{}
";
    let file = parsed(source);

    for (name, kind) in [
        ("Exported", SymbolKind::Function),
        ("local", SymbolKind::Function),
        ("Upper", SymbolKind::Type),
        ("lower", SymbolKind::Type),
    ] {
        let entry = file
            .find_symbol(&SymbolQuery::new(name).with_kind(kind))
            .unwrap();
        let expected = name.chars().next().is_some_and(char::is_uppercase);
        assert_eq!(entry.exported, expected, "{name}");
    }
}

#[test]
fn method_parent_path_includes_the_receiver_type() {
    let file = parsed(INDEX_SOURCE);
    let greet = file
        .find_symbol(
            &SymbolQuery::new("Greet")
                .with_kind(SymbolKind::Method)
                .with_parent("User"),
        )
        .unwrap();
    assert_eq!(greet.parent_path, vec!["User"]);

    let rename = file
        .find_symbol(
            &SymbolQuery::new("rename")
                .with_kind(SymbolKind::Method)
                .with_parent("User"),
        )
        .unwrap();
    assert_eq!(rename.parent_path, vec!["User"]);
}

#[test]
fn replaces_inserts_deletes_and_renames_functions() {
    let source = "\
package main

// add returns a sum.
func add(a, b int) int {
\treturn a + b
}

func legacy() int {
\treturn 0
}

func use() int {
\tlabel := \"add\"
\t// add stays in this comment
\treturn add(1, 2) + len(label)
}
";
    let file = parsed(source);

    let replaced = replace_symbol(
        &file,
        &SymbolQuery::new("add").with_kind(SymbolKind::Function),
        "func add(a, b int) int {\n\treturn a + b + 1\n}",
    )
    .unwrap();
    assert!(replaced.edited_source.contains("return a + b + 1"));
    assert!(replaced.edited_source.contains("func legacy"));

    let inserted = insert_after(
        &file,
        &SymbolQuery::new("add").with_kind(SymbolKind::Function),
        "func subtract(a, b int) int {\n\treturn a - b\n}",
    )
    .unwrap();
    assert!(inserted.edited_source.contains("func subtract"));
    let inserted_file = parse_file(Path::new("main.go"), &inserted.edited_source).unwrap();
    assert!(!inserted_file.has_syntax_errors());

    let deleted = delete_symbol(
        &file,
        &SymbolQuery::new("legacy").with_kind(SymbolKind::Function),
    )
    .unwrap();
    assert!(!deleted.edited_source.contains("func legacy"));
    let deleted_file = parse_file(Path::new("main.go"), &deleted.edited_source).unwrap();
    assert!(!deleted_file.has_syntax_errors());

    let renamed = rename_symbol(
        &file,
        &SymbolQuery::new("add").with_kind(SymbolKind::Function),
        "total",
    )
    .unwrap();
    assert!(renamed.edited_source.contains("func total"));
    assert!(renamed.edited_source.contains("total(1, 2)"));
    assert!(renamed.edited_source.contains("\"add\""));
    assert!(renamed
        .edited_source
        .contains("// add stays in this comment"));
    let renamed_file = parse_file(Path::new("main.go"), &renamed.edited_source).unwrap();
    assert!(!renamed_file.has_syntax_errors());
}

#[test]
fn replaces_and_renames_methods_and_type_references() {
    let source = "\
package sample

type User struct {
\tName string
}

func (u User) Greet() string {
\treturn \"hello\"
}

func useMethod(u User) string {
\treturn u.Greet()
}
";
    let file = parsed(source);

    let replaced = replace_symbol(
        &file,
        &SymbolQuery::new("Greet").with_kind(SymbolKind::Method),
        "func (u User) Greet() string {\n\treturn \"hi\"\n}",
    )
    .unwrap();
    assert!(replaced.edited_source.contains("return \"hi\""));

    let renamed = rename_symbol(
        &file,
        &SymbolQuery::new("Greet").with_kind(SymbolKind::Method),
        "Welcome",
    )
    .unwrap();
    assert!(renamed.edited_source.contains("func (u User) Welcome()"));
    assert!(renamed.edited_source.contains("u.Welcome()"));

    let type_renamed = rename_symbol(
        &file,
        &SymbolQuery::new("User").with_kind(SymbolKind::Type),
        "Account",
    )
    .unwrap();
    assert!(type_renamed.edited_source.contains("type Account struct"));
    assert!(type_renamed
        .edited_source
        .contains("func (u Account) Greet()"));
    assert!(type_renamed
        .edited_source
        .contains("func useMethod(u Account)"));
}

#[test]
fn deletes_var_and_const_declarations_through_their_parent() {
    let source = "\
package sample

const UnusedConst = 1

var UnusedVar = 2

func keep() {}
";
    let file = parsed(source);

    let deleted_const = delete_symbol(
        &file,
        &SymbolQuery::new("UnusedConst").with_kind(SymbolKind::Variable),
    )
    .unwrap();
    assert!(!deleted_const.edited_source.contains("UnusedConst"));
    assert!(deleted_const.edited_source.contains("func keep"));

    let deleted_var = delete_symbol(
        &file,
        &SymbolQuery::new("UnusedVar").with_kind(SymbolKind::Variable),
    )
    .unwrap();
    assert!(!deleted_var.edited_source.contains("UnusedVar"));
    let deleted_file = parse_file(Path::new("sample.go"), &deleted_var.edited_source).unwrap();
    assert!(!deleted_file.has_syntax_errors());
}

#[test]
fn rejects_ambiguous_duplicate_names() {
    let source = "\
package sample

func duplicate() {}

func duplicate() int {
\treturn 1
}
";
    let file = parsed(source);
    let error = file
        .find_symbol(&SymbolQuery::new("duplicate").with_kind(SymbolKind::Function))
        .unwrap_err()
        .to_string();
    assert!(error.contains("ambiguous symbol"));
    assert!(error.contains("2 matches"));

    let replace_error = replace_symbol(
        &file,
        &SymbolQuery::new("duplicate").with_kind(SymbolKind::Function),
        "func duplicate() {}",
    )
    .unwrap_err()
    .to_string();
    assert!(replace_error.contains("ambiguous symbol"));
}

#[test]
fn rejects_replacement_that_introduces_syntax_errors() {
    let source = "package main\n\nfunc add(a, b int) int {\n\treturn a + b\n}\n";
    let file = parsed(source);
    let error = replace_symbol(
        &file,
        &SymbolQuery::new("add").with_kind(SymbolKind::Function),
        "func add(a, b int) int {\n\treturn a +\n}",
    )
    .unwrap_err()
    .to_string();
    assert!(error.contains("syntax errors"));

    let broken = parse_file(Path::new("broken.go"), "package main\n\nfunc broken( {\n").unwrap();
    assert!(broken.has_syntax_errors());
}
