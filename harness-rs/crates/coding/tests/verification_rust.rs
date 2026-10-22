use std::{fs, path::Path};
use worldbase_coding::{
    verification::detect_profile, ProjectKind, VerificationCheckKind, VerificationProfile,
};

fn kinds(profile: &VerificationProfile) -> Vec<VerificationCheckKind> {
    profile
        .commands
        .iter()
        .map(|command| command.kind)
        .collect()
}

fn assert_required_cargo_command(
    profile: &VerificationProfile,
    kind: VerificationCheckKind,
    args: &[&str],
) {
    let command = profile
        .commands
        .iter()
        .find(|command| command.kind == kind)
        .unwrap_or_else(|| panic!("missing {kind:?} command"));
    assert_eq!(command.program, "cargo");
    assert_eq!(command.args, args);
    assert!(command.required, "{kind:?} must be required");
    assert!(!command.description.is_empty());
}

#[test]
fn detects_package_manifest_and_orders_required_cargo_commands() {
    let root = tempfile::tempdir().unwrap();
    fs::write(
        root.path().join("Cargo.toml"),
        "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\n",
    )
    .unwrap();

    let profile = detect_profile(root.path()).unwrap();
    assert_eq!(profile.project_kind, ProjectKind::Rust);
    assert_eq!(profile.package_manager, None);
    assert!(profile.source.contains("Cargo.toml"));
    assert_eq!(
        kinds(&profile),
        vec![
            VerificationCheckKind::Typecheck,
            VerificationCheckKind::Lint,
            VerificationCheckKind::Test,
            VerificationCheckKind::Build,
        ]
    );

    assert_required_cargo_command(&profile, VerificationCheckKind::Typecheck, &["check"]);
    assert_required_cargo_command(
        &profile,
        VerificationCheckKind::Lint,
        &["clippy", "--", "-D", "warnings"],
    );
    assert_required_cargo_command(&profile, VerificationCheckKind::Test, &["test"]);
    assert_required_cargo_command(&profile, VerificationCheckKind::Build, &["build"]);
}

#[test]
fn detects_workspace_manifest() {
    let root = tempfile::tempdir().unwrap();
    fs::write(
        root.path().join("Cargo.toml"),
        "[workspace]\nmembers = [\"crates/core\"]\nresolver = \"2\"\n",
    )
    .unwrap();

    let profile = detect_profile(root.path()).unwrap();
    assert_eq!(profile.project_kind, ProjectKind::Rust);
    assert!(profile.source.contains("workspace"));
    assert!(profile.source.contains("Cargo.toml"));
    assert_eq!(profile.commands.len(), 4);
    assert!(profile.commands.iter().all(|command| command.required));
}

#[test]
fn adds_optional_format_check_for_rustfmt_markers() {
    for marker in ["rustfmt.toml", ".rustfmt.toml"] {
        let root = tempfile::tempdir().unwrap();
        fs::write(
            root.path().join("Cargo.toml"),
            "[package]\nname = \"fixture\"\n",
        )
        .unwrap();
        fs::write(root.path().join(marker), "edition = \"2021\"\n").unwrap();

        let profile = detect_profile(root.path()).unwrap();
        assert_eq!(
            kinds(&profile),
            vec![
                VerificationCheckKind::Typecheck,
                VerificationCheckKind::Lint,
                VerificationCheckKind::Test,
                VerificationCheckKind::Build,
                VerificationCheckKind::Format,
            ],
            "{marker}"
        );
        let format = profile.commands.last().unwrap();
        assert_eq!(format.program, "cargo");
        assert_eq!(format.args, ["fmt", "--check"]);
        assert!(!format.required, "format check should be optional");
        assert!(profile.source.contains(marker));
    }
}

#[test]
fn missing_cargo_manifest_is_unknown_without_commands() {
    let root = tempfile::tempdir().unwrap();
    let profile = detect_profile(root.path()).unwrap();

    assert_eq!(profile.project_kind, ProjectKind::Unknown);
    assert_eq!(profile.package_manager, None);
    assert!(profile.commands.is_empty());
    assert_eq!(profile.root, Path::new(root.path()));
    assert!(profile.source.contains("No supported project manifest"));
}
