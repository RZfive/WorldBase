use std::{fs, path::Path};
use worldbase_coding::{
    verification::detect_profile, PackageManager, ProjectKind, VerificationCheckKind,
    VerificationProfile,
};

fn write_package_with_scripts(root: &Path, scripts: &str) {
    fs::write(
        root.join("package.json"),
        format!(r#"{{"name":"fixture","scripts":{scripts}}}"#),
    )
    .unwrap();
}

fn assert_script_command(
    profile: &VerificationProfile,
    kind: VerificationCheckKind,
    program: &str,
    script: &str,
) {
    let command = profile
        .commands
        .iter()
        .find(|command| command.kind == kind)
        .unwrap_or_else(|| panic!("missing {kind:?} command"));
    assert_eq!(command.program, program);
    assert_eq!(command.args, ["run", script]);
    assert!(command.required);
    assert!(command.description.contains(script));
}

#[test]
fn detects_pnpm_yarn_npm_bun_and_default_npm_from_lockfiles() {
    let fixtures = [
        ("pnpm-lock.yaml", PackageManager::Pnpm, "pnpm"),
        ("yarn.lock", PackageManager::Yarn, "yarn"),
        ("package-lock.json", PackageManager::Npm, "npm"),
        ("bun.lock", PackageManager::Bun, "bun"),
        ("bun.lockb", PackageManager::Bun, "bun"),
    ];

    for (lockfile, expected_manager, expected_program) in fixtures {
        let root = tempfile::tempdir().unwrap();
        write_package_with_scripts(
            root.path(),
            r#"{"typecheck":"tsc --noEmit","lint":"eslint .","test":"vitest run","build":"vite build"}"#,
        );
        fs::write(root.path().join(lockfile), b"fixture lockfile").unwrap();

        let profile = detect_profile(root.path()).unwrap();
        assert_eq!(profile.project_kind, ProjectKind::FrontendNode);
        assert_eq!(profile.package_manager, Some(expected_manager));
        assert!(profile.source.contains(lockfile));
        assert_eq!(profile.commands.len(), 4);
        for command in &profile.commands {
            assert_eq!(command.program, expected_program);
        }
    }

    let root = tempfile::tempdir().unwrap();
    write_package_with_scripts(root.path(), r#"{"test":"vitest run"}"#);
    let profile = detect_profile(root.path()).unwrap();
    assert_eq!(profile.package_manager, Some(PackageManager::Npm));
    assert!(profile.source.contains("defaulted"));
    assert_script_command(&profile, VerificationCheckKind::Test, "npm", "test");
}

#[test]
fn discovers_all_supported_scripts_and_uses_their_declared_names() {
    let root = tempfile::tempdir().unwrap();
    write_package_with_scripts(
        root.path(),
        r#"{"type-check":"tsc --noEmit","lint":"eslint .","test":"jest","build":"vite build","dev":"vite"}"#,
    );
    fs::write(
        root.path().join("pnpm-lock.yaml"),
        b"lockfileVersion: '9.0'",
    )
    .unwrap();

    let profile = detect_profile(root.path()).unwrap();
    assert_eq!(profile.project_kind, ProjectKind::FrontendNode);
    assert_eq!(profile.commands.len(), 4);
    assert_eq!(
        profile
            .commands
            .iter()
            .map(|command| command.kind)
            .collect::<Vec<_>>(),
        [
            VerificationCheckKind::Typecheck,
            VerificationCheckKind::Lint,
            VerificationCheckKind::Test,
            VerificationCheckKind::Build,
        ]
    );
    assert_script_command(
        &profile,
        VerificationCheckKind::Typecheck,
        "pnpm",
        "type-check",
    );
    assert_script_command(&profile, VerificationCheckKind::Lint, "pnpm", "lint");
    assert_script_command(&profile, VerificationCheckKind::Test, "pnpm", "test");
    assert_script_command(&profile, VerificationCheckKind::Build, "pnpm", "build");
    assert!(profile.source.contains("type-check, lint, test, build"));
}

#[test]
fn missing_package_json_is_an_unknown_profile_not_an_error() {
    let root = tempfile::tempdir().unwrap();
    let profile = detect_profile(root.path()).unwrap();

    assert_eq!(profile.project_kind, ProjectKind::Unknown);
    assert_eq!(profile.package_manager, None);
    assert!(profile.commands.is_empty());
    assert_eq!(profile.root, root.path());
    assert!(profile.source.contains("package.json"));
}

#[test]
fn ignores_non_string_scripts_and_reports_malformed_package_json() {
    let root = tempfile::tempdir().unwrap();
    write_package_with_scripts(root.path(), r#"{"lint":42,"test":"vitest run"}"#);
    let profile = detect_profile(root.path()).unwrap();
    assert_eq!(profile.commands.len(), 1);
    assert_eq!(profile.commands[0].kind, VerificationCheckKind::Test);

    fs::write(root.path().join("package.json"), b"{not json").unwrap();
    assert!(detect_profile(root.path()).is_err());
}
