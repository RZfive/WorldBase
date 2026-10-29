use std::path::Path;
use worldbase_coding::smart_editor::{
    parse_file, rename_symbol, LanguageId, ParsedFile, SymbolKind, SymbolQuery,
};

fn parse(path: &str, source: &str) -> ParsedFile {
    let parsed = parse_file(Path::new(path), source).unwrap_or_else(|error| {
        panic!("parse {path}: {error}");
    });
    assert!(
        !parsed.has_syntax_errors(),
        "{path} fixture has syntax errors"
    );
    parsed
}

fn symbol(
    parsed: &ParsedFile,
    name: &str,
    kind: SymbolKind,
    parent: &[&str],
) -> worldbase_coding::smart_editor::SymbolEntry {
    parsed
        .find_symbol(
            &SymbolQuery::new(name)
                .with_kind(kind)
                .with_parent_path(parent.iter().copied()),
        )
        .unwrap_or_else(|error| panic!("missing {kind} `{name}` under {parent:?}: {error}"))
}

#[test]
fn go_methods_use_receiver_parent_paths_and_imports_stay_structured() {
    let source = r#"package sample

import (
	"fmt"
	alias "example.com/pkg"
	. "example.com/dot"
	_ "example.com/blank"
)

type ID = string

type Base struct{}

type Alias struct{}

type User struct {
	Base
	*Alias
	Name string
}

func (u User) Greet() string {
	return fmt.Sprintf("Greet")
}

func (u *User) Rename(name string) {
	// Rename stays in this comment
	u.Name = name
}

func describe(user User) string {
	return user.Greet()
}
"#;
    let parsed = parse("sample.go", source);
    assert_eq!(parsed.language, LanguageId::Go);

    let greet = symbol(&parsed, "Greet", SymbolKind::Method, &["User"]);
    assert!(greet.exported);
    let rename = symbol(&parsed, "Rename", SymbolKind::Method, &["User"]);
    assert!(rename.exported);
    assert!(source[greet.byte_range()].starts_with("func (u User) Greet("));
    assert!(source[rename.byte_range()].starts_with("func (u *User) Rename("));

    let id = symbol(&parsed, "ID", SymbolKind::Type, &[]);
    assert!(id.exported);
    let base = symbol(&parsed, "Base", SymbolKind::Type, &[]);
    assert!(base.exported);

    for name in ["fmt", "alias"] {
        assert_eq!(
            parsed
                .find_symbols(&SymbolQuery::new(name).with_kind(SymbolKind::Import))
                .len(),
            1,
            "{name} import"
        );
    }
    for name in ["example.com/dot", "example.com/blank"] {
        let import = symbol(&parsed, name, SymbolKind::Import, &[]);
        assert!(!import.exported);
    }

    let renamed_method = rename_symbol(
        &parsed,
        &SymbolQuery::new("Greet")
            .with_kind(SymbolKind::Method)
            .with_parent("User"),
        "Welcome",
    )
    .unwrap();
    assert!(renamed_method
        .edited_source
        .contains("func (u User) Welcome() string"));
    assert!(renamed_method.edited_source.contains("user.Welcome()"));
    assert!(renamed_method.edited_source.contains("\"Greet\""));
    assert!(renamed_method
        .edited_source
        .contains("// Rename stays in this comment"));

    let renamed_type = rename_symbol(
        &parsed,
        &SymbolQuery::new("User").with_kind(SymbolKind::Type),
        "Account",
    )
    .unwrap();
    assert!(renamed_type.edited_source.contains("type Account struct"));
    assert!(renamed_type
        .edited_source
        .contains("func (u Account) Greet()"));
    assert!(renamed_type
        .edited_source
        .contains("func (u *Account) Rename("));
    assert!(renamed_type
        .edited_source
        .contains("describe(user Account)"));
    let reparsed = parse_file(Path::new("sample.go"), &renamed_type.edited_source).unwrap();
    assert!(!reparsed.has_syntax_errors());

    let renamed_base = rename_symbol(
        &parsed,
        &SymbolQuery::new("Base").with_kind(SymbolKind::Type),
        "Root",
    )
    .unwrap();
    assert!(renamed_base.edited_source.contains("type Root struct{}"));
    assert!(renamed_base
        .edited_source
        .contains("type User struct {\n\tRoot"));
}

#[test]
fn rust_distinguishes_inherent_and_trait_impls_and_flattens_use_groups() {
    let source = r#"use std::collections::{HashMap, HashSet as Set, nested::{Alpha, Beta}};
use demo::*;
pub use crate::api::Widget;
pub(crate) use crate::internal::Secret;

pub(crate) struct Restricted;
pub(crate) fn hidden() {}

pub trait PublicTrait {
    fn required(&self);
}

pub(crate) trait CrateTrait {
    fn crate_only(&self);
}

struct Gadget;

impl Gadget {
    pub fn spin(&self) {}
    pub(crate) fn internal(&self) {}
    fn secret(&self) {}
}

impl core::fmt::Display for Gadget {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(formatter, "Gadget")
    }
}
"#;
    let parsed = parse("lib.rs", source);
    assert_eq!(parsed.language, LanguageId::Rust);

    let inherent = symbol(&parsed, "spin", SymbolKind::Function, &["Gadget"]);
    assert!(inherent.exported);
    let internal = symbol(&parsed, "internal", SymbolKind::Function, &["Gadget"]);
    assert!(!internal.exported, "pub(crate) is crate-visible only");
    let secret = symbol(&parsed, "secret", SymbolKind::Function, &["Gadget"]);
    assert!(!secret.exported);
    let displayed = symbol(
        &parsed,
        "fmt",
        SymbolKind::Function,
        &["Gadget as core::fmt::Display"],
    );
    assert!(
        displayed.exported,
        "trait impl methods follow the trait contract"
    );

    let impls = parsed.find_symbols(&SymbolQuery::new("Gadget").with_kind(SymbolKind::Type));
    assert_eq!(impls.len(), 2, "struct and inherent impl only: {impls:#?}");
    let trait_impl = parsed
        .find_symbol(&SymbolQuery::new("Gadget as core::fmt::Display").with_kind(SymbolKind::Type))
        .unwrap();
    assert!(!trait_impl.exported);

    assert!(!symbol(&parsed, "Restricted", SymbolKind::Type, &[]).exported);
    assert!(!symbol(&parsed, "hidden", SymbolKind::Function, &[]).exported);
    assert!(
        symbol(&parsed, "required", SymbolKind::Function, &["PublicTrait"]).exported,
        "public trait methods are exported"
    );
    assert!(
        !symbol(&parsed, "crate_only", SymbolKind::Function, &["CrateTrait"]).exported,
        "pub(crate) trait methods are not exported"
    );

    for (name, exported) in [
        ("std::collections::HashMap", false),
        ("Set", false),
        ("std::collections::nested::Alpha", false),
        ("std::collections::nested::Beta", false),
        ("demo::*", false),
        ("crate::api::Widget", true),
        ("crate::internal::Secret", false),
    ] {
        let import = symbol(&parsed, name, SymbolKind::Import, &[]);
        assert_eq!(import.exported, exported, "{name}");
    }
    assert!(
        !parsed
            .symbols()
            .iter()
            .any(|entry| entry.kind == SymbolKind::Import
                && entry.name.contains("std::collections::{")),
        "nested groups must not be indexed as one blob"
    );
}

#[test]
fn java_indexes_clean_fields_locals_nested_types_and_implicit_public_members() {
    let source = r#"package com.example;

import java.util.List;

public class Outer {
    private int count;
    public String name = "value";
    int first, second;
    int[] values;

    public Outer() {
    }

    public void run(int size) {
        int local = 1;
        int left, right = 2;
        String text = "run";
        // run stays in this comment
        size = local + text.length();
    }

    public static class Nested {
        int nested;

        void nestedRun() {
        }
    }

    public interface Inner {
        int MAX = 1;

        void ping();

        class Deep {
        }
    }

    public enum Mode {
        ON,
        OFF;

        void modeRun() {
        }
    }

    public record Pair(int left, int right) {
        int sum() {
            return left + right;
        }
    }
}
"#;
    let parsed = parse("Outer.java", source);
    assert_eq!(parsed.language, LanguageId::Java);

    let count = symbol(&parsed, "count", SymbolKind::Variable, &["Outer"]);
    assert!(!count.exported);
    let name = symbol(&parsed, "name", SymbolKind::Variable, &["Outer"]);
    assert!(name.exported);
    let values = symbol(&parsed, "values", SymbolKind::Variable, &["Outer"]);
    assert!(!values.exported);
    assert!(parsed
        .find_symbols(&SymbolQuery::new("first").with_kind(SymbolKind::Variable))
        .is_empty());
    assert!(parsed
        .find_symbols(&SymbolQuery::new("second").with_kind(SymbolKind::Variable))
        .is_empty());

    let local = symbol(&parsed, "local", SymbolKind::Variable, &["Outer", "run"]);
    assert!(!local.exported);
    assert!(parsed
        .find_symbols(&SymbolQuery::new("left").with_kind(SymbolKind::Variable))
        .is_empty());
    assert!(parsed
        .find_symbols(&SymbolQuery::new("right").with_kind(SymbolKind::Variable))
        .is_empty());

    symbol(&parsed, "Outer", SymbolKind::Method, &["Outer"]);
    symbol(&parsed, "run", SymbolKind::Method, &["Outer"]);
    symbol(&parsed, "Nested", SymbolKind::Type, &["Outer"]);
    symbol(
        &parsed,
        "nested",
        SymbolKind::Variable,
        &["Outer", "Nested"],
    );
    symbol(
        &parsed,
        "nestedRun",
        SymbolKind::Method,
        &["Outer", "Nested"],
    );
    assert!(symbol(&parsed, "Nested", SymbolKind::Type, &["Outer"]).exported);

    let inner = symbol(&parsed, "Inner", SymbolKind::Interface, &["Outer"]);
    assert!(inner.exported);
    assert!(symbol(&parsed, "Deep", SymbolKind::Type, &["Outer", "Inner"]).exported);
    assert!(symbol(&parsed, "MAX", SymbolKind::Variable, &["Outer", "Inner"]).exported);
    assert!(symbol(&parsed, "ping", SymbolKind::Method, &["Outer", "Inner"]).exported);

    let mode = symbol(&parsed, "Mode", SymbolKind::Type, &["Outer"]);
    assert!(mode.exported);
    assert!(symbol(&parsed, "ON", SymbolKind::Variable, &["Outer", "Mode"]).exported);
    assert!(symbol(&parsed, "OFF", SymbolKind::Variable, &["Outer", "Mode"]).exported);
    assert!(!symbol(&parsed, "modeRun", SymbolKind::Method, &["Outer", "Mode"]).exported);

    let pair = symbol(&parsed, "Pair", SymbolKind::Type, &["Outer"]);
    assert!(pair.exported);
    symbol(&parsed, "sum", SymbolKind::Method, &["Outer", "Pair"]);

    let renamed = rename_symbol(
        &parsed,
        &SymbolQuery::new("local")
            .with_kind(SymbolKind::Variable)
            .with_parent_path(["Outer", "run"]),
        "amount",
    )
    .unwrap();
    assert!(renamed.edited_source.contains("int amount = 1;"));
    assert!(renamed.edited_source.contains("size = amount +"));
    assert!(renamed.edited_source.contains("\"run\""));
    assert!(renamed
        .edited_source
        .contains("// run stays in this comment"));
    let reparsed = parse_file(Path::new("Outer.java"), &renamed.edited_source).unwrap();
    assert!(!reparsed.has_syntax_errors());
}

#[test]
fn python_handles_relative_imports_async_decorated_symbols_and_nested_exports() {
    let source = r#"from . import sibling
from ..pkg import mod, other as alias
import os, sys
import numpy as np

MAX_SIZE = 10
_private = 1


async def load():
    """Docstring stays untouched."""
    local = 1

    async def inner():
        return local

    return inner


@decorator
async def decorated():
    return 2


@decorator
class Service:
    """Another docstring."""

    attr = 1

    def run(self):
        return attr
"#;
    let parsed = parse("sample.py", source);
    assert_eq!(parsed.language, LanguageId::Python);

    for name in ["sibling", "mod", "alias", "os", "sys", "np"] {
        let import = symbol(&parsed, name, SymbolKind::Import, &[]);
        assert!(import.exported, "{name}");
    }
    assert!(
        !parsed
            .symbols()
            .iter()
            .any(|entry| entry.kind == SymbolKind::Import
                && matches!(entry.name.as_str(), "." | "*")),
        "relative imports must expose the imported binding"
    );

    for name in ["MAX_SIZE", "load", "decorated", "Service"] {
        assert!(
            symbol(
                &parsed,
                name,
                if name == "MAX_SIZE" {
                    SymbolKind::Variable
                } else if name == "Service" {
                    SymbolKind::Type
                } else {
                    SymbolKind::Function
                },
                &[]
            )
            .exported,
            "{name}"
        );
    }
    assert!(!symbol(&parsed, "_private", SymbolKind::Variable, &[]).exported);
    assert!(!symbol(&parsed, "local", SymbolKind::Variable, &["load"]).exported);
    assert!(!symbol(&parsed, "inner", SymbolKind::Function, &["load"]).exported);
    assert!(!symbol(&parsed, "attr", SymbolKind::Variable, &["Service"]).exported);
    assert!(!symbol(&parsed, "run", SymbolKind::Function, &["Service"]).exported);

    let decorated_functions =
        parsed.find_symbols(&SymbolQuery::new("decorated").with_kind(SymbolKind::Function));
    assert_eq!(decorated_functions.len(), 1);
    let decorated_classes =
        parsed.find_symbols(&SymbolQuery::new("Service").with_kind(SymbolKind::Type));
    assert_eq!(decorated_classes.len(), 1);
    assert_eq!(
        parsed
            .find_symbols(&SymbolQuery::new("load").with_kind(SymbolKind::Function))
            .len(),
        1
    );
}
