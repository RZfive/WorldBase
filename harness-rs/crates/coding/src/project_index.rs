//! Pure in-memory project index for cross-file coding plans.
//!
//! The index accepts source text from the caller; it never reads or writes the
//! filesystem. It reuses the per-file tree-sitter parser and exposes symbols,
//! relative import edges, context selection, and cross-file rename plans.

use crate::smart_editor::{languages, parse_file, LanguageId, ParsedFile, SymbolKind};
use anyhow::Result;
use regex::Regex;
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    ops::Range,
    path::{Component, Path, PathBuf},
    sync::OnceLock,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceFile {
    pub path: PathBuf,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectSymbol {
    pub file: PathBuf,
    pub name: String,
    pub kind: SymbolKind,
    pub start_byte: usize,
    pub end_byte: usize,
    pub start_row: usize,
    pub end_row: usize,
    pub parent_path: Vec<String>,
    pub exported: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditPlanFile {
    pub path: PathBuf,
    pub replacements: Vec<Range<usize>>,
    pub before: String,
    pub after: String,
}

#[derive(Debug, Default)]
pub struct ProjectIndex {
    files: BTreeMap<PathBuf, ParsedFile>,
    symbols: Vec<ProjectSymbol>,
    imports: BTreeMap<PathBuf, BTreeSet<PathBuf>>,
    reverse_imports: BTreeMap<PathBuf, BTreeSet<PathBuf>>,
    parse_errors: Vec<(PathBuf, String)>,
}

impl ProjectIndex {
    /// Build an index from caller-provided source text.
    pub fn from_sources(files: Vec<SourceFile>) -> Result<Self> {
        let mut index = Self::default();
        for file in files {
            let path = normalize_path(&file.path);
            let parsed = match parse_file(&path, &file.source) {
                Ok(parsed) => parsed,
                Err(error) => {
                    index.parse_errors.push((path, error.to_string()));
                    continue;
                }
            };
            if parsed.has_syntax_errors() {
                index
                    .parse_errors
                    .push((path.clone(), "file contains syntax errors".into()));
            }
            index
                .symbols
                .extend(parsed.symbols().into_iter().map(|entry| ProjectSymbol {
                    file: path.clone(),
                    name: entry.name,
                    kind: entry.kind,
                    start_byte: entry.start_byte,
                    end_byte: entry.end_byte,
                    start_row: entry.start_row,
                    end_row: entry.end_row,
                    parent_path: entry.parent_path,
                    exported: entry.exported,
                }));
            index.files.insert(path, parsed);
        }

        let known_paths = index.files.keys().cloned().collect::<BTreeSet<_>>();
        let mut imports = BTreeMap::new();
        for (path, parsed) in &index.files {
            let mut targets = BTreeSet::new();
            for spec in import_specs(parsed) {
                if let Some(target) = resolve_import(path, &spec, &known_paths, parsed.language) {
                    if target != *path {
                        targets.insert(target);
                    }
                }
            }
            imports.insert(path.clone(), targets);
        }
        let mut reverse_imports: BTreeMap<PathBuf, BTreeSet<PathBuf>> = BTreeMap::new();
        for (from, targets) in &imports {
            for target in targets {
                reverse_imports
                    .entry(target.clone())
                    .or_default()
                    .insert(from.clone());
            }
        }
        index.symbols.sort_by(|left, right| {
            left.file
                .cmp(&right.file)
                .then(left.start_byte.cmp(&right.start_byte))
                .then(left.name.cmp(&right.name))
        });
        index.imports = imports;
        index.reverse_imports = reverse_imports;
        Ok(index)
    }

    pub fn symbols(&self) -> &[ProjectSymbol] {
        &self.symbols
    }

    pub fn find_symbols(&self, name: &str, kind: Option<SymbolKind>) -> Vec<&ProjectSymbol> {
        self.symbols
            .iter()
            .filter(|symbol| symbol.name == name && kind.is_none_or(|kind| symbol.kind == kind))
            .collect()
    }

    pub fn imports_of(&self, path: &Path) -> Vec<&PathBuf> {
        self.imports
            .get(&normalize_path(path))
            .map(|targets| targets.iter().collect())
            .unwrap_or_default()
    }

    pub fn importers_of(&self, path: &Path) -> Vec<&PathBuf> {
        self.reverse_imports
            .get(&normalize_path(path))
            .map(|sources| sources.iter().collect())
            .unwrap_or_default()
    }

    /// Return changed files plus imports/importers within `max_hops`.
    pub fn context_for(&self, changed_files: &[PathBuf], max_hops: usize) -> Vec<PathBuf> {
        const MAX_CONTEXT_FILES: usize = 64;
        let mut queue = VecDeque::new();
        let mut visited = BTreeSet::new();
        for path in changed_files {
            let path = normalize_path(path);
            if self.files.contains_key(&path) && visited.insert(path.clone()) {
                queue.push_back((path, 0usize));
            }
        }
        while let Some((path, hops)) = queue.pop_front() {
            if hops >= max_hops || visited.len() >= MAX_CONTEXT_FILES {
                continue;
            }
            let mut neighbors = BTreeSet::new();
            if let Some(targets) = self.imports.get(&path) {
                neighbors.extend(targets.iter().cloned());
            }
            if let Some(sources) = self.reverse_imports.get(&path) {
                neighbors.extend(sources.iter().cloned());
            }
            for neighbor in neighbors {
                if visited.len() >= MAX_CONTEXT_FILES {
                    break;
                }
                if visited.insert(neighbor.clone()) {
                    queue.push_back((neighbor, hops + 1));
                }
            }
        }
        visited.into_iter().collect()
    }

    pub fn parse_errors(&self) -> &[(PathBuf, String)] {
        &self.parse_errors
    }

    /// Build a cross-file rename plan without writing anything.
    pub fn rename_plan(
        &self,
        name: &str,
        kind: Option<SymbolKind>,
        new_name: &str,
    ) -> Result<Vec<EditPlanFile>> {
        let new_name = new_name.trim();
        if new_name.is_empty() {
            anyhow::bail!("rename rejected: new name must not be empty");
        }
        if !is_simple_identifier(new_name) {
            anyhow::bail!("rename rejected: `{new_name}` is not a simple identifier");
        }
        let declarations = self.find_symbols(name, kind);
        match declarations.len() {
            0 => anyhow::bail!("rename rejected: no declaration named `{name}` was found"),
            1 => {}
            count => anyhow::bail!(
                "rename rejected: `{name}` has {count} matching declarations; narrow by kind"
            ),
        }

        let mut plans = Vec::new();
        for (path, parsed) in &self.files {
            let kinds = reference_kinds(parsed.language);
            let mut ranges = Vec::new();
            collect_identifier_ranges(
                parsed.tree.root_node(),
                &parsed.source,
                name,
                kinds,
                &mut ranges,
            );
            ranges.sort_by_key(|range| range.start);
            ranges.dedup();
            if ranges.is_empty() {
                continue;
            }
            let mut after =
                String::with_capacity(parsed.source.len() + ranges.len() * new_name.len());
            let mut cursor = 0;
            for range in &ranges {
                after.push_str(&parsed.source[cursor..range.start]);
                after.push_str(new_name);
                cursor = range.end;
            }
            after.push_str(&parsed.source[cursor..]);
            plans.push(EditPlanFile {
                path: path.clone(),
                replacements: ranges,
                before: parsed.source.clone(),
                after,
            });
        }
        plans.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(plans)
    }
}

fn reference_kinds(language: LanguageId) -> &'static [&'static str] {
    match language {
        LanguageId::JavaScript | LanguageId::TypeScript | LanguageId::Tsx => {
            &["identifier", "type_identifier"]
        }
        _ => languages::profile(language).identifier_kinds,
    }
}

fn collect_identifier_ranges(
    node: tree_sitter::Node<'_>,
    source: &str,
    name: &str,
    kinds: &[&str],
    ranges: &mut Vec<Range<usize>>,
) {
    if kinds.contains(&node.kind()) && source.get(node.byte_range()) == Some(name) {
        ranges.push(node.byte_range());
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        collect_identifier_ranges(child, source, name, kinds, ranges);
    }
}

fn is_simple_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_alphabetic())
        && chars.all(|character| character == '_' || character.is_alphanumeric())
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    normalized.push(component.as_os_str());
                }
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn import_specs(parsed: &ParsedFile) -> Vec<String> {
    let source = &parsed.source;
    let mut specs = Vec::new();
    match parsed.language {
        LanguageId::JavaScript | LanguageId::TypeScript | LanguageId::Tsx => {
            static TS_IMPORT: OnceLock<Regex> = OnceLock::new();
            let pattern = TS_IMPORT.get_or_init(|| {
                Regex::new(
                    r#"(?m)(?:from\s+|import\s*\(|require\s*\(\s*|import\s+)\s*['"]([^'"]+)['"]"#,
                )
                .expect("valid TS import regex")
            });
            for capture in pattern.captures_iter(source) {
                if let Some(spec) = capture.get(1) {
                    specs.push(spec.as_str().to_string());
                }
            }
        }
        LanguageId::Python => {
            static PY_IMPORT: OnceLock<Regex> = OnceLock::new();
            let pattern = PY_IMPORT.get_or_init(|| {
                Regex::new(r"(?m)^\s*(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))")
                    .expect("valid Python import regex")
            });
            for capture in pattern.captures_iter(source) {
                let spec = capture.get(1).or_else(|| capture.get(2));
                if let Some(spec) = spec {
                    specs.push(spec.as_str().to_string());
                }
            }
        }
        LanguageId::Go => {
            static GO_IMPORT: OnceLock<Regex> = OnceLock::new();
            let pattern = GO_IMPORT
                .get_or_init(|| Regex::new(r#""([^"]+)""#).expect("valid Go import regex"));
            if source.contains("import") {
                for capture in pattern.captures_iter(source) {
                    if let Some(spec) = capture.get(1) {
                        specs.push(spec.as_str().to_string());
                    }
                }
            }
        }
        LanguageId::Rust => {
            static RUST_MOD: OnceLock<Regex> = OnceLock::new();
            let pattern = RUST_MOD.get_or_init(|| {
                Regex::new(r"(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;")
                    .expect("valid Rust mod regex")
            });
            for capture in pattern.captures_iter(source) {
                if let Some(spec) = capture.get(1) {
                    specs.push(format!("mod:{}", spec.as_str()));
                }
            }
        }
        LanguageId::Java => {
            static JAVA_IMPORT: OnceLock<Regex> = OnceLock::new();
            let pattern = JAVA_IMPORT.get_or_init(|| {
                Regex::new(r"(?m)^\s*import\s+(?:static\s+)?([\w.]+)\s*;")
                    .expect("valid Java import regex")
            });
            for capture in pattern.captures_iter(source) {
                if let Some(spec) = capture.get(1) {
                    specs.push(spec.as_str().to_string());
                }
            }
        }
    }
    specs
}

fn resolve_import(
    from: &Path,
    spec: &str,
    known: &BTreeSet<PathBuf>,
    language: LanguageId,
) -> Option<PathBuf> {
    let parent = from.parent().unwrap_or_else(|| Path::new(""));
    if let Some(module) = spec.strip_prefix("mod:") {
        for candidate in [
            parent.join(format!("{module}.rs")),
            parent.join(module).join("mod.rs"),
        ] {
            let candidate = normalize_path(&candidate);
            if known.contains(&candidate) {
                return Some(candidate);
            }
        }
        return None;
    }

    if language == LanguageId::Java {
        let class_name = spec.rsplit('.').next()?;
        let matches = known
            .iter()
            .filter(|path| {
                path.file_stem()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name == class_name)
            })
            .cloned()
            .collect::<Vec<_>>();
        return (matches.len() == 1).then(|| matches[0].clone());
    }

    if language == LanguageId::Go {
        let package = spec.rsplit('/').next()?;
        let matches = known
            .iter()
            .filter(|path| {
                path.parent()
                    .and_then(|parent| parent.file_name())
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name == package)
            })
            .cloned()
            .collect::<Vec<_>>();
        return matches.into_iter().next();
    }

    if spec.starts_with('.') {
        let (base, module) = if language == LanguageId::Python {
            let dots = spec
                .chars()
                .take_while(|character| *character == '.')
                .count();
            let mut base = parent.to_path_buf();
            for _ in 1..dots {
                base = base.parent()?.to_path_buf();
            }
            (base, spec[dots..].replace('.', "/"))
        } else {
            (parent.to_path_buf(), spec.to_string())
        };
        let candidate = normalize_path(&base.join(module));
        if known.contains(&candidate) {
            return Some(candidate);
        }
        let extensions: &[&str] = match language {
            LanguageId::Python => &["py", "pyi"],
            LanguageId::JavaScript | LanguageId::TypeScript | LanguageId::Tsx => {
                &["ts", "tsx", "js", "jsx", "mjs", "cjs"]
            }
            _ => &[],
        };
        for extension in extensions {
            let candidate = candidate.with_extension(extension);
            if known.contains(&candidate) {
                return Some(candidate);
            }
        }
        for extension in extensions {
            let candidate = candidate.join(format!("index.{extension}"));
            if known.contains(&candidate) {
                return Some(candidate);
            }
        }
        let init = candidate.join("__init__.py");
        if known.contains(&init) {
            return Some(init);
        }
        return None;
    }

    None
}
