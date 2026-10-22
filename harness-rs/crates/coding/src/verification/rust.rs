use crate::model::{ProjectKind, VerificationCheckKind, VerificationCommand, VerificationProfile};
use anyhow::Result;
use std::{fs, path::Path};

pub(crate) fn detect(root: &Path) -> Result<Option<VerificationProfile>> {
    let manifest = root.join("Cargo.toml");
    if !manifest.is_file() {
        return Ok(None);
    }

    let manifest_text = fs::read_to_string(&manifest).unwrap_or_default();
    let is_workspace = manifest_text.contains("[workspace]");
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
    let mut source = if is_workspace {
        "Rust workspace project detected from Cargo.toml.".to_string()
    } else {
        "Rust project detected from Cargo.toml.".to_string()
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

fn command(kind: VerificationCheckKind, args: &[&str], description: &str) -> VerificationCommand {
    VerificationCommand {
        kind,
        program: "cargo".into(),
        args: args.iter().map(|arg| arg.to_string()).collect(),
        required: true,
        description: description.into(),
    }
}
