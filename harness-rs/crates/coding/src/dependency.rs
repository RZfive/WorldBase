//! Frontend dependency diagnosis and fix planning.
//!
//! Parses package manifests and package-manager errors into structured issues
//! and deterministic install/remove/update suggestions. This module never
//! executes package commands or touches the filesystem.

use crate::model::{Diagnostic, PackageManager};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::PathBuf;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DependencyKind {
    Runtime,
    Dev,
    Peer,
    Optional,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PackageManifest {
    pub name: Option<String>,
    pub package_manager: Option<PackageManager>,
    pub dependencies: BTreeMap<String, String>,
    pub dev_dependencies: BTreeMap<String, String>,
    pub peer_dependencies: BTreeMap<String, String>,
    pub optional_dependencies: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DependencyIssueKind {
    MissingPackage,
    MissingTypeDefinitions,
    VersionConflict,
    PeerDependency,
    UnresolvedImport,
    LockfileMismatch,
    Unknown,
}

impl DependencyIssueKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::MissingPackage => "missing_package",
            Self::MissingTypeDefinitions => "missing_type_definitions",
            Self::VersionConflict => "version_conflict",
            Self::PeerDependency => "peer_dependency",
            Self::UnresolvedImport => "unresolved_import",
            Self::LockfileMismatch => "lockfile_mismatch",
            Self::Unknown => "unknown",
        }
    }
}

impl std::fmt::Display for DependencyIssueKind {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.label())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DependencyFixAction {
    Install,
    InstallDev,
    Remove,
    Update,
    InstallAll,
    RegenerateLockfile,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyFix {
    pub action: DependencyFixAction,
    pub package: Option<String>,
    pub version: Option<String>,
    pub command: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyIssue {
    pub kind: DependencyIssueKind,
    pub package: Option<String>,
    pub spec: Option<String>,
    pub file: Option<PathBuf>,
    pub message: String,
    pub confidence: f32,
    pub suggested_fix: Option<DependencyFix>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyReport {
    pub issues: Vec<DependencyIssue>,
    pub affected_packages: Vec<String>,
    pub primary_kind: DependencyIssueKind,
    pub summary: String,
    pub commands: Vec<String>,
    pub has_issues: bool,
}

pub fn parse_package_manifest(value: &Value) -> anyhow::Result<PackageManifest> {
    let object = value
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("package manifest must be a JSON object"))?;

    let name = object
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned);
    let package_manager = object
        .get("packageManager")
        .and_then(Value::as_str)
        .and_then(parse_package_manager_field);

    Ok(PackageManifest {
        name,
        package_manager,
        dependencies: dependency_map(object.get("dependencies")),
        dev_dependencies: dependency_map(object.get("devDependencies")),
        peer_dependencies: dependency_map(object.get("peerDependencies")),
        optional_dependencies: dependency_map(object.get("optionalDependencies")),
    })
}

fn dependency_map(value: Option<&Value>) -> BTreeMap<String, String> {
    let mut dependencies = BTreeMap::new();
    if let Some(object) = value.and_then(Value::as_object) {
        for (name, version) in object {
            if let Some(version) = version.as_str() {
                dependencies.insert(name.clone(), version.to_string());
            }
        }
    }
    dependencies
}

fn parse_package_manager_field(value: &str) -> Option<PackageManager> {
    let name = value.trim().split('@').next()?.trim().to_ascii_lowercase();
    match name.as_str() {
        "pnpm" => Some(PackageManager::Pnpm),
        "npm" => Some(PackageManager::Npm),
        "yarn" => Some(PackageManager::Yarn),
        "bun" => Some(PackageManager::Bun),
        _ => None,
    }
}

pub fn detect_package_manager(
    manifest: Option<&PackageManifest>,
    lockfiles: &[&str],
) -> Option<PackageManager> {
    if let Some(package_manager) = manifest.and_then(|manifest| manifest.package_manager) {
        return Some(package_manager);
    }

    let mut has_npm_lockfile = false;
    let mut has_yarn_lockfile = false;
    let mut has_bun_lockfile = false;
    for lockfile in lockfiles {
        let file_name = std::path::Path::new(lockfile)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(lockfile)
            .to_ascii_lowercase();
        match file_name.as_str() {
            "pnpm-lock.yaml" => return Some(PackageManager::Pnpm),
            "package-lock.json" | "npm-shrinkwrap.json" => has_npm_lockfile = true,
            "yarn.lock" => has_yarn_lockfile = true,
            "bun.lockb" | "bun.lock" => has_bun_lockfile = true,
            _ => {}
        }
    }

    if has_npm_lockfile {
        Some(PackageManager::Npm)
    } else if has_yarn_lockfile {
        Some(PackageManager::Yarn)
    } else if has_bun_lockfile {
        Some(PackageManager::Bun)
    } else {
        None
    }
}

pub fn dependency_kind(manifest: &PackageManifest, package: &str) -> Option<DependencyKind> {
    if manifest.dependencies.contains_key(package) {
        Some(DependencyKind::Runtime)
    } else if manifest.dev_dependencies.contains_key(package) {
        Some(DependencyKind::Dev)
    } else if manifest.peer_dependencies.contains_key(package) {
        Some(DependencyKind::Peer)
    } else if manifest.optional_dependencies.contains_key(package) {
        Some(DependencyKind::Optional)
    } else {
        None
    }
}

pub fn has_dependency(manifest: &PackageManifest, package: &str) -> bool {
    dependency_kind(manifest, package).is_some()
}

pub fn analyze_dependency_diagnostics(
    diagnostics: &[Diagnostic],
    manifest: Option<&PackageManifest>,
    package_manager: Option<PackageManager>,
) -> DependencyReport {
    let mut analyzer = Analyzer::new(manifest, package_manager);
    for diagnostic in diagnostics {
        analyzer.analyze_diagnostic(diagnostic);
    }
    analyzer.finish()
}

pub fn analyze_package_manager_output(
    output: &str,
    manifest: Option<&PackageManifest>,
    package_manager: Option<PackageManager>,
) -> DependencyReport {
    let mut analyzer = Analyzer::new(manifest, package_manager);
    for line in output.lines() {
        analyzer.analyze_text(line, None);
    }
    analyzer.finish()
}

struct Analyzer<'a> {
    manifest: Option<&'a PackageManifest>,
    commands: CommandContext,
    issues: Vec<DependencyIssue>,
}

impl<'a> Analyzer<'a> {
    fn new(manifest: Option<&'a PackageManifest>, package_manager: Option<PackageManager>) -> Self {
        let explicit =
            package_manager.or_else(|| manifest.and_then(|manifest| manifest.package_manager));
        let commands = CommandContext {
            manager: explicit.unwrap_or(PackageManager::Pnpm),
            defaulted: explicit.is_none(),
        };
        Self {
            manifest,
            commands,
            issues: Vec::new(),
        }
    }

    fn analyze_diagnostic(&mut self, diagnostic: &Diagnostic) {
        let file = diagnostic.file.clone();
        let message = diagnostic.message.trim();
        let lower = message.to_ascii_lowercase();
        if diagnostic.code.as_deref() == Some("TS2307")
            || lower.contains("ts2307")
            || (lower.contains("cannot find module")
                && lower.contains("corresponding type declarations"))
        {
            self.analyze_ts2307(message, file);
            return;
        }

        let before = self.issues.len();
        if self.analyze_text(message, file.clone()) {
            return;
        }
        if self.issues.len() == before {
            if let Some(raw) = &diagnostic.raw {
                for line in raw.lines() {
                    let line = line.trim();
                    if !line.is_empty() && line != message {
                        self.analyze_text(line, file.clone());
                    }
                }
            }
        }
    }

    fn analyze_text(&mut self, text: &str, file: Option<PathBuf>) -> bool {
        let text = text.trim();
        if text.is_empty() {
            return false;
        }
        let lower = text.to_ascii_lowercase();

        if lower.contains("ts2307")
            || (lower.contains("cannot find module")
                && lower.contains("corresponding type declarations"))
        {
            self.analyze_ts2307(text, file);
            return true;
        }

        if let Some(spec) = missing_module_spec(text) {
            self.analyze_missing_module(&spec, text, file);
            return true;
        }
        if lower.contains("err_module_not_found") {
            self.push_issue(
                DependencyIssueKind::UnresolvedImport,
                None,
                None,
                file,
                text,
                0.4,
                None,
            );
            return true;
        }

        if is_peer_error(&lower, text) {
            self.analyze_peer(text, file);
            return true;
        }
        if is_version_conflict(&lower) {
            self.analyze_version_conflict(text, file);
            return true;
        }
        if is_lockfile_error(&lower) {
            self.analyze_lockfile(text, file);
            return true;
        }
        if is_dependency_related(&lower) && is_errorish(&lower) {
            self.analyze_unknown(text, file);
            return true;
        }

        false
    }

    fn analyze_missing_module(&mut self, spec: &str, message: &str, file: Option<PathBuf>) {
        if is_non_install_spec(spec) {
            self.push_issue(
                DependencyIssueKind::UnresolvedImport,
                None,
                Some(spec.to_string()),
                file,
                message,
                0.8,
                None,
            );
            return;
        }

        let package = package_base(spec);
        if package.is_empty() {
            self.push_issue(
                DependencyIssueKind::UnresolvedImport,
                None,
                Some(spec.to_string()),
                file,
                message,
                0.4,
                None,
            );
            return;
        }
        let dev = package.starts_with("@types/");
        let action = if dev {
            DependencyFixAction::InstallDev
        } else {
            DependencyFixAction::Install
        };
        let reason = if dev {
            format!("Missing type-definition package `{package}`; install it as a dev dependency.")
        } else {
            format!(
                "Missing package `{package}` referenced by a module-resolution error; install it."
            )
        };
        let fix = self.commands.fix(action, Some(&package), None, reason);
        self.push_issue(
            DependencyIssueKind::MissingPackage,
            Some(package),
            Some(spec.to_string()),
            file,
            message,
            0.8,
            fix,
        );
    }

    fn analyze_ts2307(&mut self, message: &str, file: Option<PathBuf>) {
        let Some(spec) = missing_module_spec(message) else {
            self.push_issue(
                DependencyIssueKind::Unknown,
                None,
                None,
                file,
                message,
                0.4,
                None,
            );
            return;
        };
        if is_non_install_spec(&spec) {
            self.push_issue(
                DependencyIssueKind::UnresolvedImport,
                None,
                Some(spec),
                file,
                message,
                0.8,
                None,
            );
            return;
        }

        let package = package_base(&spec);
        if package.starts_with("@types/") {
            let fix = self.commands.fix(
                DependencyFixAction::InstallDev,
                Some(&package),
                None,
                format!(
                    "Missing type-definition package `{package}`; install it as a dev dependency."
                ),
            );
            self.push_issue(
                DependencyIssueKind::MissingPackage,
                Some(package),
                Some(spec),
                file,
                message,
                0.8,
                fix,
            );
            return;
        }

        let is_runtime = self
            .manifest
            .and_then(|manifest| dependency_kind(manifest, &package))
            == Some(DependencyKind::Runtime);
        if is_runtime {
            let types = types_package(&package);
            let fix = self.commands.fix(
                DependencyFixAction::InstallDev,
                Some(&types),
                None,
                format!(
                    "Runtime package `{package}` has no type declarations; install `{types}` as a dev dependency."
                ),
            );
            self.push_issue(
                DependencyIssueKind::MissingTypeDefinitions,
                Some(package),
                Some(spec),
                file,
                message,
                0.95,
                fix,
            );
        } else {
            let fix = self.commands.fix(
                DependencyFixAction::Install,
                Some(&package),
                None,
                format!("Package `{package}` from TS2307 is not declared; install it."),
            );
            self.push_issue(
                DependencyIssueKind::MissingPackage,
                Some(package),
                Some(spec),
                file,
                message,
                0.8,
                fix,
            );
        }
    }

    fn analyze_peer(&mut self, message: &str, file: Option<PathBuf>) {
        let spec = peer_spec(message);
        let (package, version) = spec
            .as_deref()
            .map(split_package_spec)
            .map(|(package, version)| (Some(package_base(&package)), version))
            .unwrap_or((None, None));

        let action = package
            .as_deref()
            .map(|package| self.action_for_package(package))
            .unwrap_or(DependencyFixAction::Install);
        let fix = match package.as_deref() {
            Some(package) => {
                let reason = format!(
                    "Peer dependency `{package}` is missing or unmet; {} it.",
                    if action == DependencyFixAction::Update {
                        "update"
                    } else {
                        "install"
                    }
                );
                self.commands
                    .fix(action, Some(package), version.as_deref(), reason)
            }
            None => None,
        };
        self.push_issue(
            DependencyIssueKind::PeerDependency,
            package,
            spec,
            file,
            message,
            0.8,
            fix,
        );
    }

    fn analyze_version_conflict(&mut self, message: &str, file: Option<PathBuf>) {
        let spec = version_spec(message);
        let (package, version) = spec
            .as_deref()
            .map(split_package_spec)
            .map(|(package, version)| (Some(package_base(&package)), version))
            .unwrap_or((None, None));
        let action = package
            .as_deref()
            .map(|package| self.action_for_package(package))
            .unwrap_or(DependencyFixAction::Install);
        let fix = match package.as_deref() {
            Some(package) => {
                let reason =
                    format!("Version conflict for `{package}`; align it with the requested range.");
                self.commands
                    .fix(action, Some(package), version.as_deref(), reason)
            }
            None => None,
        };
        self.push_issue(
            DependencyIssueKind::VersionConflict,
            package,
            spec,
            file,
            message,
            0.8,
            fix,
        );
    }

    fn analyze_lockfile(&mut self, message: &str, file: Option<PathBuf>) {
        let fix = self.commands.fix(
            DependencyFixAction::RegenerateLockfile,
            None,
            None,
            "Lockfile is out of date or frozen; regenerate it with the package manager.".into(),
        );
        self.push_issue(
            DependencyIssueKind::LockfileMismatch,
            None,
            None,
            file,
            message,
            0.8,
            fix,
        );
    }

    fn analyze_unknown(&mut self, message: &str, file: Option<PathBuf>) {
        let spec = unknown_package_spec(message);
        let package = spec
            .as_deref()
            .map(package_base)
            .filter(|package| !package.is_empty() && !is_non_install_spec(package));
        let fix = package.as_deref().map(|package| {
            let action = self.action_for_package(package);
            let reason = format!(
                "Unrecognized dependency error for `{package}`; install it if it is the missing package."
            );
            self.commands.fix(action, Some(package), None, reason)
        });
        self.push_issue(
            DependencyIssueKind::Unknown,
            package,
            spec,
            file,
            message,
            0.4,
            fix.flatten(),
        );
    }

    fn action_for_package(&self, package: &str) -> DependencyFixAction {
        if self
            .manifest
            .is_some_and(|manifest| has_dependency(manifest, package))
        {
            DependencyFixAction::Update
        } else {
            DependencyFixAction::Install
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn push_issue(
        &mut self,
        kind: DependencyIssueKind,
        package: Option<String>,
        spec: Option<String>,
        file: Option<PathBuf>,
        message: &str,
        confidence: f32,
        suggested_fix: Option<DependencyFix>,
    ) {
        self.issues.push(DependencyIssue {
            kind,
            package,
            spec,
            file,
            message: message.to_string(),
            confidence,
            suggested_fix,
        });
    }

    fn finish(self) -> DependencyReport {
        let mut seen = HashSet::new();
        let mut issues = self
            .issues
            .into_iter()
            .filter(|issue| {
                seen.insert((
                    issue.kind,
                    issue.package.clone(),
                    issue.file.clone(),
                    issue.message.clone(),
                ))
            })
            .collect::<Vec<_>>();

        issues.sort_by(|left, right| {
            kind_priority(left.kind)
                .cmp(&kind_priority(right.kind))
                .then_with(|| right.confidence.total_cmp(&left.confidence))
                .then_with(|| left.package.cmp(&right.package))
                .then_with(|| left.message.cmp(&right.message))
                .then_with(|| left.file.cmp(&right.file))
        });

        let affected_packages = issues
            .iter()
            .filter_map(|issue| issue.package.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();

        let mut counts = BTreeMap::new();
        for issue in &issues {
            *counts.entry(issue.kind).or_insert(0usize) += 1;
        }
        let mut primary_kind = DependencyIssueKind::Unknown;
        let mut best_count = 0;
        for kind in [
            DependencyIssueKind::MissingPackage,
            DependencyIssueKind::MissingTypeDefinitions,
            DependencyIssueKind::VersionConflict,
            DependencyIssueKind::PeerDependency,
            DependencyIssueKind::UnresolvedImport,
            DependencyIssueKind::LockfileMismatch,
            DependencyIssueKind::Unknown,
        ] {
            let count = counts.get(&kind).copied().unwrap_or(0);
            if count > best_count {
                best_count = count;
                primary_kind = kind;
            }
        }

        let mut command_set = HashSet::new();
        let commands = issues
            .iter()
            .filter_map(|issue| issue.suggested_fix.as_ref())
            .map(|fix| fix.command.clone())
            .filter(|command| command_set.insert(command.clone()))
            .collect::<Vec<_>>();

        let summary = if issues.is_empty() {
            "No dependency issues detected.".to_string()
        } else {
            format!(
                "{} dependency issue(s) across {} package(s); primary kind: {}.",
                issues.len(),
                affected_packages.len(),
                primary_kind.label()
            )
        };

        DependencyReport {
            has_issues: !issues.is_empty(),
            issues,
            affected_packages,
            primary_kind,
            summary,
            commands,
        }
    }
}

#[derive(Clone, Copy)]
struct CommandContext {
    manager: PackageManager,
    defaulted: bool,
}

impl CommandContext {
    fn add(&self, package: &str, version: Option<&str>, dev: bool) -> String {
        let spec = match version.filter(|version| !version.is_empty()) {
            Some(version) => format!("{package}@{version}"),
            None => package.to_string(),
        };
        let arguments = match (self.manager, dev) {
            (PackageManager::Pnpm, true) => format!("-D {spec}"),
            (PackageManager::Npm, true) => format!("-D {spec}"),
            (PackageManager::Yarn, true) => format!("-D {spec}"),
            (PackageManager::Bun, true) => format!("-d {spec}"),
            (_, false) => spec,
        };
        let command = match self.manager {
            PackageManager::Pnpm => "pnpm add",
            PackageManager::Npm => "npm install",
            PackageManager::Yarn => "yarn add",
            PackageManager::Bun => "bun add",
        };
        format!("{command} {arguments}")
    }

    fn install(&self) -> String {
        match self.manager {
            PackageManager::Pnpm => "pnpm install".to_string(),
            PackageManager::Npm => "npm install".to_string(),
            PackageManager::Yarn => "yarn install".to_string(),
            PackageManager::Bun => "bun install".to_string(),
        }
    }

    fn remove(&self, package: &str) -> String {
        match self.manager {
            PackageManager::Pnpm => format!("pnpm remove {package}"),
            PackageManager::Npm => format!("npm uninstall {package}"),
            PackageManager::Yarn => format!("yarn remove {package}"),
            PackageManager::Bun => format!("bun remove {package}"),
        }
    }

    fn fix(
        &self,
        action: DependencyFixAction,
        package: Option<&str>,
        version: Option<&str>,
        reason: String,
    ) -> Option<DependencyFix> {
        let command = match action {
            DependencyFixAction::Install => self.add(package?, version, false),
            DependencyFixAction::InstallDev => self.add(package?, version, true),
            DependencyFixAction::Update => self.add(package?, version, false),
            DependencyFixAction::Remove => self.remove(package?),
            DependencyFixAction::InstallAll | DependencyFixAction::RegenerateLockfile => {
                self.install()
            }
        };
        let reason = if self.defaulted {
            format!("{reason} No package manager was detected; defaulted to pnpm.")
        } else {
            reason
        };
        Some(DependencyFix {
            action,
            package: package.map(ToOwned::to_owned),
            version: version.map(ToOwned::to_owned),
            command,
            reason,
        })
    }
}

fn kind_priority(kind: DependencyIssueKind) -> u8 {
    match kind {
        DependencyIssueKind::MissingPackage => 0,
        DependencyIssueKind::MissingTypeDefinitions => 1,
        DependencyIssueKind::VersionConflict => 2,
        DependencyIssueKind::PeerDependency => 3,
        DependencyIssueKind::UnresolvedImport => 4,
        DependencyIssueKind::LockfileMismatch => 5,
        DependencyIssueKind::Unknown => 6,
    }
}

fn missing_module_spec(text: &str) -> Option<String> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        Regex::new(
            r#"(?i)(?:cannot find (?:module|package)|can't resolve|failed to resolve import|could not resolve)\s+['"`](?P<spec>[^'"`]+)['"`]"#,
        )
        .expect("valid missing module pattern")
    });
    pattern
        .captures(text)
        .and_then(|captures| captures.name("spec"))
        .map(|spec| spec.as_str().trim().to_string())
}

fn is_peer_error(lower: &str, text: &str) -> bool {
    lower.contains("peer dep missing")
        || lower.contains("unmet peer dependency")
        || lower.contains("missing peer dependency")
        || lower.contains("conflicting peer dependency")
        || (lower.contains("eresolve") && lower.contains("dependenc"))
        || (peer_spec(text).is_some()
            && !lower.contains("could not resolve dependency")
            && !lower.contains("unable to resolve dependency tree")
            && !lower.contains("version mismatch"))
}

fn is_version_conflict(lower: &str) -> bool {
    lower.contains("unable to resolve dependency tree")
        || lower.contains("could not resolve dependency")
        || lower.contains("version mismatch")
        || lower.contains("conflicting peer dependency")
}

fn is_lockfile_error(lower: &str) -> bool {
    lower.contains("out of date")
        || lower.contains("frozen-lockfile")
        || lower.contains("err_pnpm_outdated_lockfile")
        || lower.contains("lockfile had changes")
        || lower.contains("lockfile needs to be updated")
        || lower.contains("lockfile is not up to date")
}

fn is_dependency_related(lower: &str) -> bool {
    lower.contains("dependenc")
        || lower.contains("package")
        || lower.contains("module")
        || lower.contains("peer")
        || lower.contains("lockfile")
}

fn is_errorish(lower: &str) -> bool {
    lower.contains("error")
        || lower.contains("fail")
        || lower.contains("cannot")
        || lower.contains("could not")
        || lower.contains("missing")
        || lower.contains("unmet")
        || lower.contains("mismatch")
        || lower.contains("out of date")
        || lower.contains("frozen")
        || lower.contains("eresolve")
}

fn peer_spec(text: &str) -> Option<String> {
    static EXPLICIT: OnceLock<Regex> = OnceLock::new();
    static BARE: OnceLock<Regex> = OnceLock::new();
    let explicit = EXPLICIT.get_or_init(|| {
        Regex::new(
            r#"(?i)(?:peer dep missing|unmet peer dependency|missing peer dependency|conflicting peer dependency|peer dependency)\s*[:\-]?\s*['"`]?(?P<spec>@?[^\s"'`,;)]+)"#,
        )
        .expect("valid peer dependency pattern")
    });
    if let Some(spec) = explicit
        .captures(text)
        .and_then(|captures| captures.name("spec"))
        .map(|spec| clean_spec(spec.as_str()))
    {
        return Some(spec);
    }

    let bare = BARE.get_or_init(|| {
        Regex::new(r#"(?i)\bpeer\s+['"`]?(?P<spec>@?[^\s"'`,;)]+)"#)
            .expect("valid bare peer pattern")
    });
    bare.captures(text)
        .and_then(|captures| captures.name("spec"))
        .map(|spec| clean_spec(spec.as_str()))
        .filter(|spec| spec != "dependency")
}

fn version_spec(text: &str) -> Option<String> {
    if let Some(spec) = peer_spec(text) {
        return Some(spec);
    }
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        Regex::new(
            r#"(?i)(?:could not resolve dependency|requires|expected)\s*[:\s]+(?:peer\s+)?['"`]?(?P<spec>@?[^\s"'`,;)]+)"#,
        )
        .expect("valid version conflict pattern")
    });
    pattern
        .captures(text)
        .and_then(|captures| captures.name("spec"))
        .map(|spec| clean_spec(spec.as_str()))
}

fn unknown_package_spec(text: &str) -> Option<String> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        Regex::new(r#"(?i)(?:package|module|dependency)\s+['"`](?P<spec>[^'"`]+)['"`]"#)
            .expect("valid unknown package pattern")
    });
    pattern
        .captures(text)
        .and_then(|captures| captures.name("spec"))
        .map(|spec| clean_spec(spec.as_str()))
}

fn clean_spec(spec: &str) -> String {
    spec.trim()
        .trim_matches(|character: char| matches!(character, ',' | ';' | ')' | ']' | '.' | ':'))
        .to_string()
}

fn split_package_spec(spec: &str) -> (String, Option<String>) {
    let spec = spec.trim();
    if let Some(rest) = spec.strip_prefix('@') {
        if let Some(index) = rest.find('@') {
            let index = index + 1;
            return (
                spec[..index].to_string(),
                Some(spec[index + 1..].to_string()),
            );
        }
        (spec.to_string(), None)
    } else if let Some(index) = spec.find('@') {
        (
            spec[..index].to_string(),
            Some(spec[index + 1..].to_string()),
        )
    } else {
        (spec.to_string(), None)
    }
}

fn package_base(spec: &str) -> String {
    let spec = spec.trim();
    if let Some(rest) = spec.strip_prefix('@') {
        let mut parts = rest.split('/');
        let scope = parts.next().unwrap_or("");
        match parts.next() {
            Some(name) if !name.is_empty() => format!("@{scope}/{name}"),
            _ => format!("@{scope}"),
        }
    } else {
        spec.split('/').next().unwrap_or(spec).to_string()
    }
}

fn types_package(package: &str) -> String {
    if let Some(rest) = package.strip_prefix('@') {
        let mut parts = rest.split('/');
        let scope = parts.next().unwrap_or("");
        match parts.next() {
            Some(name) if !name.is_empty() => format!("@types/{scope}__{name}"),
            _ => format!("@types/{scope}"),
        }
    } else {
        format!("@types/{package}")
    }
}

fn is_non_install_spec(spec: &str) -> bool {
    spec.is_empty()
        || spec == "."
        || spec == ".."
        || spec.starts_with("./")
        || spec.starts_with("../")
        || spec.starts_with('/')
        || spec.starts_with("node:")
        || spec.starts_with("bun:")
        || spec.starts_with("deno:")
        || spec.starts_with("file:")
        || spec.starts_with("http:")
        || spec.starts_with("https:")
        || spec.starts_with("data:")
        || spec.starts_with('#')
        || is_node_builtin(spec)
}

fn is_node_builtin(spec: &str) -> bool {
    let base = package_base(spec);
    matches!(
        base.as_str(),
        "assert"
            | "async_hooks"
            | "buffer"
            | "child_process"
            | "cluster"
            | "console"
            | "constants"
            | "crypto"
            | "dgram"
            | "diagnostics_channel"
            | "dns"
            | "domain"
            | "events"
            | "fs"
            | "http"
            | "http2"
            | "https"
            | "inspector"
            | "module"
            | "net"
            | "os"
            | "path"
            | "perf_hooks"
            | "process"
            | "punycode"
            | "querystring"
            | "readline"
            | "repl"
            | "stream"
            | "string_decoder"
            | "sys"
            | "timers"
            | "tls"
            | "trace_events"
            | "tty"
            | "url"
            | "util"
            | "v8"
            | "vm"
            | "wasi"
            | "worker_threads"
            | "zlib"
    )
}
