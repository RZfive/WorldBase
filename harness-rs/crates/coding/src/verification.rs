//! Project verification profile detection and command execution planning.

#[path = "verification/go.rs"]
mod go;
#[path = "verification/java.rs"]
mod java;
#[path = "verification/python.rs"]
mod python;
#[path = "verification/rust.rs"]
mod rust;

use crate::model::{
    PackageManager, ProjectKind, VerificationCheckKind, VerificationCommand, VerificationProfile,
};
use anyhow::{Context, Result};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    fs,
    path::{Component, Path, PathBuf},
};

/// Plan verification commands for a project without executing anything.
///
/// Frontend/Node is currently the only implemented profile. A missing
/// `package.json` is a normal result, not a detection failure.
pub fn detect_profile(root: &Path) -> Result<VerificationProfile> {
    let package_json_path = root.join("package.json");
    if !package_json_path.is_file() {
        for detector in [rust::detect, go::detect, python::detect, java::detect] {
            if let Some(profile) = detector(root)? {
                return Ok(profile);
            }
        }
        return Ok(VerificationProfile {
            project_kind: ProjectKind::Unknown,
            package_manager: None,
            root: root.to_path_buf(),
            commands: Vec::new(),
            source:
                "No supported project manifest was found; no verification commands were planned."
                    .to_string(),
        });
    }

    let package_json = fs::read_to_string(&package_json_path)
        .with_context(|| format!("read {}", package_json_path.display()))?;
    let package: Value = serde_json::from_str(&package_json)
        .with_context(|| format!("parse {}", package_json_path.display()))?;
    let scripts = package.get("scripts").and_then(Value::as_object);
    let (package_manager, lockfile) = detect_package_manager(root);

    let script_candidates = [
        (
            VerificationCheckKind::Typecheck,
            &["typecheck", "type-check"][..],
        ),
        (VerificationCheckKind::Lint, &["lint"][..]),
        (VerificationCheckKind::Test, &["test"][..]),
        (VerificationCheckKind::Build, &["build"][..]),
    ];
    let mut commands = Vec::new();
    let mut detected_scripts = Vec::new();

    for (kind, candidates) in script_candidates {
        let Some((script_name, script_body)) = scripts.and_then(|scripts| {
            candidates.iter().find_map(|candidate| {
                scripts
                    .get(*candidate)
                    .and_then(Value::as_str)
                    .map(|body| (*candidate, body))
            })
        }) else {
            continue;
        };

        detected_scripts.push(script_name);
        commands.push(VerificationCommand {
            kind,
            program: package_manager_program(package_manager).into(),
            args: vec!["run".into(), script_name.into()],
            required: true,
            description: format!(
                "Run package.json script `{script_name}` with {} (declared as `{script_body}`).",
                package_manager_name(package_manager)
            ),
        });
    }

    let detected_scripts = if detected_scripts.is_empty() {
        "none".to_string()
    } else {
        detected_scripts.join(", ")
    };
    let manager_source = match lockfile {
        Some(lockfile) => format!(
            "package manager {} selected from {lockfile}",
            package_manager_name(package_manager)
        ),
        None => format!(
            "package manager {} defaulted because no supported lockfile was found",
            package_manager_name(package_manager)
        ),
    };

    Ok(VerificationProfile {
        project_kind: ProjectKind::FrontendNode,
        package_manager: Some(package_manager),
        root: root.to_path_buf(),
        commands,
        source: format!(
            "Frontend Node project detected from package.json; {manager_source}; verification scripts: {detected_scripts}."
        ),
    })
}

/// Select the smallest safe verification profile for a set of changed files.
///
/// This function is pure: it never reads the filesystem. Relative paths are
/// interpreted as project-relative, while absolute paths outside `profile.root`
/// are ignored. Code-only non-entry changes drop the build command; entry
/// points, config/style changes, and unrecognized non-doc files keep it
/// conservatively. Manifest or lockfile changes always retain the full profile.
pub fn select_minimal_profile(
    profile: &VerificationProfile,
    changed_files: &[PathBuf],
) -> VerificationProfile {
    if changed_files.is_empty() {
        return profile.clone();
    }

    let mut normalized = BTreeSet::new();
    for path in changed_files {
        if let Some(relative) = normalize_changed_path(&profile.root, path) {
            normalized.insert(relative);
        }
    }
    if normalized.is_empty() {
        return profile.clone();
    }

    let mut changes = ChangeFlags::default();
    for path in &normalized {
        changes.observe(path);
    }
    let file_count = normalized.len();

    let commands = if changes.docs_only() {
        Vec::new()
    } else if changes.manifest {
        profile.commands.clone()
    } else {
        let filtered = profile
            .commands
            .iter()
            .filter(|command| changes.keeps(command.kind))
            .cloned()
            .collect::<Vec<_>>();
        if filtered.is_empty() {
            fallback_commands(profile)
        } else {
            filtered
        }
    };

    let mut selected = profile.clone();
    selected.commands = commands;
    selected.source = minimal_source(&profile.source, file_count);
    selected
}

#[derive(Default)]
struct ChangeFlags {
    docs: bool,
    code: bool,
    compiled: bool,
    test_file: bool,
    style: bool,
    config: bool,
    test_config: bool,
    entry_point: bool,
    manifest: bool,
    other: bool,
}

impl ChangeFlags {
    fn observe(&mut self, path: &Path) {
        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            self.other = true;
            return;
        };
        let file_name = file_name.to_ascii_lowercase();
        let extension = path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();

        if is_manifest(&file_name) {
            self.manifest = true;
            return;
        }
        if is_docs_or_image(&extension) {
            self.docs = true;
            return;
        }

        let test_file = is_test_file(path);
        let style = is_style(&extension);
        let config = is_config(&file_name);
        let test_config = is_test_config(&file_name);
        let code = is_code(&extension) && !config;
        let compiled = is_compiled_code(&extension);

        self.test_file |= test_file;
        self.style |= style;
        self.config |= config;
        self.test_config |= test_config;
        self.code |= code;
        self.compiled |= compiled;
        if code && !test_file && is_entry_point(path) {
            self.entry_point = true;
        }
        if !(test_file || style || config || code) {
            self.other = true;
        }
    }

    fn docs_only(&self) -> bool {
        self.docs
            && !self.manifest
            && !(self.code
                || self.test_file
                || self.style
                || self.config
                || self.test_config
                || self.other)
    }

    fn keeps(&self, kind: VerificationCheckKind) -> bool {
        match kind {
            VerificationCheckKind::Typecheck => {
                self.code || self.test_file || self.config || self.other
            }
            VerificationCheckKind::Lint => {
                self.code || self.test_file || self.style || self.config || self.other
            }
            VerificationCheckKind::Test => self.code || self.test_file || self.test_config,
            VerificationCheckKind::Build => {
                self.style
                    || self.config
                    || self.other
                    || self.compiled
                    || (self.code && self.entry_point)
            }
            VerificationCheckKind::Format | VerificationCheckKind::Custom => true,
        }
    }
}

fn fallback_commands(profile: &VerificationProfile) -> Vec<VerificationCommand> {
    profile
        .commands
        .iter()
        .filter(|command| command.required)
        .cloned()
        .collect()
}

fn minimal_source(source: &str, file_count: usize) -> String {
    let base = source
        .split_once(" (minimal: ")
        .map(|(base, _)| base)
        .unwrap_or(source);
    format!("{base} (minimal: {file_count} file(s))")
}

fn normalize_changed_path(root: &Path, path: &Path) -> Option<PathBuf> {
    let relative = if path.is_absolute() {
        path.strip_prefix(root).ok()?.to_path_buf()
    } else {
        path.to_path_buf()
    };
    normalize_relative_path(&relative)
}

fn normalize_relative_path(path: &Path) -> Option<PathBuf> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => normalized.push(part),
            Component::ParentDir => {
                if !normalized.pop() {
                    return None;
                }
            }
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    if normalized.as_os_str().is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn is_manifest(file_name: &str) -> bool {
    matches!(
        file_name,
        "package.json"
            | "Cargo.toml"
            | "Cargo.lock"
            | "go.mod"
            | "go.sum"
            | "go.work"
            | "pyproject.toml"
            | "setup.py"
            | "setup.cfg"
            | "requirements.txt"
            | "uv.lock"
            | "poetry.lock"
            | "pom.xml"
            | "build.gradle"
            | "build.gradle.kts"
            | "settings.gradle"
            | "settings.gradle.kts"
            | "gradle.properties"
            | "pnpm-lock.yaml"
            | "package-lock.json"
            | "yarn.lock"
            | "bun.lockb"
            | "bun.lock"
            | "npm-shrinkwrap.json"
    )
}

fn is_docs_or_image(extension: &str) -> bool {
    matches!(
        extension,
        "md" | "mdx"
            | "txt"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "svg"
            | "webp"
            | "avif"
            | "ico"
            | "bmp"
            | "tiff"
    )
}

fn is_code(extension: &str) -> bool {
    matches!(
        extension,
        "ts" | "tsx"
            | "js"
            | "jsx"
            | "mjs"
            | "cjs"
            | "mts"
            | "cts"
            | "py"
            | "pyi"
            | "go"
            | "rs"
            | "java"
    )
}

fn is_compiled_code(extension: &str) -> bool {
    matches!(extension, "go" | "rs" | "java")
}

fn is_style(extension: &str) -> bool {
    matches!(extension, "css" | "scss" | "less" | "sass")
}

fn is_test_file(path: &Path) -> bool {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if file_name.contains(".test.") || file_name.contains(".spec.") {
        return true;
    }
    if (file_name.starts_with("test_") && file_name.ends_with(".py"))
        || file_name.ends_with("_test.py")
        || file_name.ends_with("_test.go")
    {
        return true;
    }
    path.components().any(|component| {
        component.as_os_str().to_str().is_some_and(|part| {
            part.eq_ignore_ascii_case("__tests__")
                || part.eq_ignore_ascii_case("tests")
                || part.eq_ignore_ascii_case("test")
        })
    })
}

fn is_config(file_name: &str) -> bool {
    let trimmed = file_name.trim_start_matches('.');
    (file_name.starts_with("tsconfig") && file_name.ends_with(".json"))
        || trimmed.starts_with("vite.config.")
        || trimmed.starts_with("next.config.")
        || trimmed.starts_with("eslint")
        || trimmed.starts_with("prettier")
        || is_test_config(file_name)
}

fn is_test_config(file_name: &str) -> bool {
    let trimmed = file_name.trim_start_matches('.');
    trimmed.starts_with("vitest")
        || trimmed.starts_with("jest")
        || trimmed.starts_with("playwright")
        || trimmed.starts_with("cypress")
}

fn is_entry_point(path: &Path) -> bool {
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(
        stem.as_str(),
        "main" | "index" | "app" | "_app" | "server" | "client"
    ) {
        return true;
    }
    path.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(|part| matches!(part, "app" | "pages"))
    })
}

/// Lockfile precedence follows the project runtime's existing installer
/// behavior (pnpm, then yarn, then npm), with Bun inserted before the npm
/// default and explicit npm lockfiles checked last.
fn detect_package_manager(root: &Path) -> (PackageManager, Option<&'static str>) {
    const LOCKFILES: [(&str, PackageManager); 6] = [
        ("pnpm-lock.yaml", PackageManager::Pnpm),
        ("yarn.lock", PackageManager::Yarn),
        ("bun.lockb", PackageManager::Bun),
        ("bun.lock", PackageManager::Bun),
        ("package-lock.json", PackageManager::Npm),
        ("npm-shrinkwrap.json", PackageManager::Npm),
    ];

    LOCKFILES
        .iter()
        .find(|(name, _)| root.join(name).is_file())
        .map(|(name, manager)| (*manager, Some(*name)))
        .unwrap_or((PackageManager::Npm, None))
}

fn package_manager_program(package_manager: PackageManager) -> &'static str {
    match package_manager {
        PackageManager::Pnpm => "pnpm",
        PackageManager::Npm => "npm",
        PackageManager::Yarn => "yarn",
        PackageManager::Bun => "bun",
    }
}

fn package_manager_name(package_manager: PackageManager) -> &'static str {
    match package_manager {
        PackageManager::Pnpm => "pnpm",
        PackageManager::Npm => "npm",
        PackageManager::Yarn => "yarn",
        PackageManager::Bun => "bun",
    }
}
