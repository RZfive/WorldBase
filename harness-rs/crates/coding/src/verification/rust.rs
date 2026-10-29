use crate::model::{ProjectKind, VerificationCheckKind, VerificationCommand, VerificationProfile};
use anyhow::Result;
use std::{fs, path::Path};

pub(crate) fn detect(root: &Path) -> Result<Option<VerificationProfile>> {
    let manifest = root.join("Cargo.toml");
    if !manifest.is_file() {
        return Ok(None);
    }

    let manifest_text = fs::read_to_string(&manifest).unwrap_or_default();
    let is_workspace = has_manifest_section(&manifest_text, "workspace");
    let is_package = has_manifest_section(&manifest_text, "package");
    let mut commands = vec![
        command(
            VerificationCheckKind::Typecheck,
            &["check"],
            "Run cargo check.",
        ),
        command(
            VerificationCheckKind::Lint,
            &["clippy", "--", "-D", "warnings"],
            "Run cargo clippy with warnings denied.",
        ),
        command(VerificationCheckKind::Test, &["test"], "Run cargo tests."),
        command(
            VerificationCheckKind::Build,
            &["build"],
            "Build with cargo.",
        ),
    ];

    let rustfmt_marker = ["rustfmt.toml", ".rustfmt.toml"]
        .into_iter()
        .find(|name| root.join(name).is_file());
    let mut source = match (is_workspace, is_package) {
        (true, true) => {
            "Rust workspace project with a root package detected from Cargo.toml.".to_string()
        }
        (true, false) => "Rust workspace project detected from Cargo.toml.".to_string(),
        (false, true) => "Rust package project detected from Cargo.toml.".to_string(),
        (false, false) => "Rust project detected from Cargo.toml.".to_string(),
    };
    if let Some(marker) = rustfmt_marker {
        commands.push(VerificationCommand {
            kind: VerificationCheckKind::Format,
            program: "cargo".into(),
            args: vec!["fmt".into(), "--check".into()],
            required: false,
            description: format!("Check formatting with cargo fmt because {marker} is present."),
        });
        source.push_str(&format!(" Optional formatting check enabled by {marker}."));
    }

    Ok(Some(VerificationProfile {
        project_kind: ProjectKind::Rust,
        package_manager: None,
        root: root.to_path_buf(),
        commands,
        source,
    }))
}

fn has_manifest_section(manifest: &str, section: &str) -> bool {
    let expected = format!("[{section}]");
    manifest
        .lines()
        .map(str::trim)
        .any(|line| line == expected || line.starts_with(&format!("{expected} ")))
}

fn command(kind: VerificationCheckKind, args: &[&str], description: &str) -> VerificationCommand {
    VerificationCommand {
        kind,
        program: "cargo".into(),
        args: args.iter().map(|arg| arg.to_string()).collect(),
        required: true,
        description: description.into(),
    }
}
