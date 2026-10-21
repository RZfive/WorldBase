//! Project verification profile detection and command execution planning.
//! Frontend/Node profiles are the first implementation target.

use crate::model::{
    PackageManager, ProjectKind, VerificationCheckKind, VerificationCommand, VerificationProfile,
};
use anyhow::{Context, Result};
use serde_json::Value;
use std::{fs, path::Path};

/// Plan verification commands for a project without executing anything.
///
/// Frontend/Node is currently the only implemented profile. A missing
/// `package.json` is a normal result, not a detection failure.
pub fn detect_profile(root: &Path) -> Result<VerificationProfile> {
    let package_json_path = root.join("package.json");
    if !package_json_path.is_file() {
        return Ok(VerificationProfile {
            project_kind: ProjectKind::Unknown,
            package_manager: None,
            root: root.to_path_buf(),
            commands: Vec::new(),
            source: "No package.json found at package.json; no verification commands were planned."
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
