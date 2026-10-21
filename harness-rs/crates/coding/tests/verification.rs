use std::{
    fs,
    path::{Path, PathBuf},
};
use worldbase_coding::{
    select_minimal_profile, verification::detect_profile, PackageManager, ProjectKind,
    VerificationCheckKind, VerificationCommand, VerificationProfile,
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

fn command(kind: VerificationCheckKind, required: bool) -> VerificationCommand {
    VerificationCommand {
        kind,
        program: "pnpm".into(),
        args: vec!["run".into(), kind.label().into()],
        required,
        description: format!("run the {} gate", kind.label()),
    }
}

fn profile_with_commands(commands: Vec<VerificationCommand>) -> VerificationProfile {
    VerificationProfile {
        project_kind: ProjectKind::FrontendNode,
        package_manager: Some(PackageManager::Pnpm),
        root: PathBuf::from("/repo"),
        commands,
        source: "frontend profile".into(),
    }
}

fn full_profile() -> VerificationProfile {
    profile_with_commands(vec![
        command(VerificationCheckKind::Typecheck, true),
        command(VerificationCheckKind::Lint, true),
        command(VerificationCheckKind::Test, true),
        command(VerificationCheckKind::Build, true),
    ])
}

fn kinds(profile: &VerificationProfile) -> Vec<VerificationCheckKind> {
    profile
        .commands
        .iter()
        .map(|command| command.kind)
        .collect()
}

fn paths(values: &[&str]) -> Vec<PathBuf> {
    values.iter().map(PathBuf::from).collect()
}

#[test]
fn empty_change_set_returns_the_full_profile_unchanged() {
    let profile = full_profile();
    let selected = select_minimal_profile(&profile, &[]);
    assert_eq!(selected, profile);
}

#[test]
fn docs_only_changes_remove_all_commands() {
    let profile = full_profile();
    let changed = paths(&[
        "README.md",
        "docs/guide.mdx",
        "assets/logo.png",
        "notes.txt",
    ]);

    let selected = select_minimal_profile(&profile, &changed);
    assert!(selected.commands.is_empty());
    assert_eq!(selected.project_kind, profile.project_kind);
    assert_eq!(selected.package_manager, profile.package_manager);
    assert_eq!(selected.root, profile.root);
    assert!(selected.source.ends_with(" (minimal: 4 file(s))"));
    assert_eq!(profile.commands.len(), 4);
}

#[test]
fn non_entry_code_changes_keep_typecheck_lint_and_test_but_drop_build() {
    let profile = full_profile();
    let selected = select_minimal_profile(&profile, &paths(&["src/lib/math.ts"]));

    assert_eq!(
        kinds(&selected),
        vec![
            VerificationCheckKind::Typecheck,
            VerificationCheckKind::Lint,
            VerificationCheckKind::Test,
        ]
    );
    assert_eq!(selected.commands[0], profile.commands[0]);
    assert!(selected.source.ends_with(" (minimal: 1 file(s))"));
}

#[test]
fn entry_point_code_changes_keep_build() {
    let profile = full_profile();
    for entry in ["src/main.tsx", "src/app/App.tsx", "src/lib/index.ts"] {
        let selected = select_minimal_profile(&profile, &paths(&[entry]));
        assert_eq!(
            kinds(&selected),
            vec![
                VerificationCheckKind::Typecheck,
                VerificationCheckKind::Lint,
                VerificationCheckKind::Test,
                VerificationCheckKind::Build,
            ],
            "{entry}"
        );
    }
}

#[test]
fn test_only_changes_keep_typecheck_lint_and_test_without_build() {
    let profile = full_profile();
    let selected = select_minimal_profile(
        &profile,
        &paths(&[
            "src/lib/math.test.ts",
            "src/components/Button.spec.tsx",
            "src/__tests__/api.ts",
        ]),
    );

    assert_eq!(
        kinds(&selected),
        vec![
            VerificationCheckKind::Typecheck,
            VerificationCheckKind::Lint,
            VerificationCheckKind::Test,
        ]
    );
    assert!(selected.source.ends_with(" (minimal: 3 file(s))"));
}

#[test]
fn manifest_and_lockfile_changes_return_the_full_profile() {
    let profile = full_profile();
    for manifest in [
        "package.json",
        "pnpm-lock.yaml",
        "package-lock.json",
        "yarn.lock",
        "bun.lockb",
    ] {
        let selected = select_minimal_profile(&profile, &paths(&["src/lib/math.ts", manifest]));
        assert_eq!(
            kinds(&selected),
            vec![
                VerificationCheckKind::Typecheck,
                VerificationCheckKind::Lint,
                VerificationCheckKind::Test,
                VerificationCheckKind::Build,
            ],
            "{manifest}"
        );
        assert_eq!(selected.commands, profile.commands);
        assert!(selected.source.ends_with(" (minimal: 2 file(s))"));
    }
}

#[test]
fn style_and_config_changes_select_appropriate_commands() {
    let profile = full_profile();

    let style = select_minimal_profile(&profile, &paths(&["src/styles/app.css"]));
    assert_eq!(
        kinds(&style),
        vec![VerificationCheckKind::Lint, VerificationCheckKind::Build]
    );

    let style_with_test = select_minimal_profile(
        &profile,
        &paths(&["src/styles/app.scss", "src/lib/math.test.ts"]),
    );
    assert_eq!(
        kinds(&style_with_test),
        vec![
            VerificationCheckKind::Typecheck,
            VerificationCheckKind::Lint,
            VerificationCheckKind::Test,
            VerificationCheckKind::Build,
        ]
    );

    let tsconfig = select_minimal_profile(&profile, &paths(&["tsconfig.build.json"]));
    assert_eq!(
        kinds(&tsconfig),
        vec![
            VerificationCheckKind::Typecheck,
            VerificationCheckKind::Lint,
            VerificationCheckKind::Build,
        ]
    );

    let vite = select_minimal_profile(&profile, &paths(&["vite.config.ts"]));
    assert_eq!(kinds(&vite), kinds(&tsconfig));

    let eslint = select_minimal_profile(&profile, &paths(&[".eslintrc.json"]));
    assert_eq!(kinds(&eslint), kinds(&tsconfig));

    let vitest = select_minimal_profile(&profile, &paths(&["vitest.config.ts"]));
    assert_eq!(
        kinds(&vitest),
        vec![
            VerificationCheckKind::Typecheck,
            VerificationCheckKind::Lint,
            VerificationCheckKind::Test,
            VerificationCheckKind::Build,
        ]
    );
}

#[test]
fn unrecognized_non_doc_files_keep_conservative_verification() {
    let profile = full_profile();
    let selected = select_minimal_profile(&profile, &paths(&["public/data.json"]));
    assert_eq!(
        kinds(&selected),
        vec![
            VerificationCheckKind::Typecheck,
            VerificationCheckKind::Lint,
            VerificationCheckKind::Build,
        ]
    );
}

#[test]
fn fallback_restores_required_commands_when_filtering_would_be_empty() {
    let profile = profile_with_commands(vec![command(VerificationCheckKind::Build, true)]);
    let selected = select_minimal_profile(&profile, &paths(&["src/lib/math.test.ts"]));

    assert_eq!(kinds(&selected), vec![VerificationCheckKind::Build]);
    assert!(selected.commands[0].required);
    assert!(selected.source.ends_with(" (minimal: 1 file(s))"));
}

#[test]
fn path_normalization_deduplicates_and_ignores_outside_absolute_paths() {
    let profile = full_profile();
    let selected = select_minimal_profile(
        &profile,
        &[
            PathBuf::from("./src/lib/math.ts"),
            PathBuf::from("src/lib/math.ts"),
            PathBuf::from("/repo/src/lib/math.ts"),
            PathBuf::from("src/lib/MATH.TS"),
        ],
    );

    assert_eq!(kinds(&selected), kinds(&profile)[..3].to_vec());
    assert!(selected.source.ends_with(" (minimal: 2 file(s))"));

    let outside_only = select_minimal_profile(&profile, &paths(&["/elsewhere/src/main.tsx"]));
    assert_eq!(outside_only, profile);

    let mixed = select_minimal_profile(
        &profile,
        &paths(&["/repo/src/lib/math.ts", "/elsewhere/src/main.tsx"]),
    );
    assert_eq!(kinds(&mixed), kinds(&profile)[..3].to_vec());
    assert!(mixed.source.ends_with(" (minimal: 1 file(s))"));
}

#[test]
fn repeated_selection_is_deterministic_and_idempotent() {
    let profile = full_profile();
    let changed = paths(&["src/lib/math.ts"]);

    let first = select_minimal_profile(&profile, &changed);
    let second = select_minimal_profile(&profile, &changed);
    assert_eq!(first, second);

    let repeated = select_minimal_profile(&first, &changed);
    assert_eq!(repeated, first);
}

#[test]
fn selected_commands_preserve_order_required_flags_and_metadata() {
    let profile = profile_with_commands(vec![
        command(VerificationCheckKind::Lint, false),
        command(VerificationCheckKind::Typecheck, true),
        command(VerificationCheckKind::Test, true),
        command(VerificationCheckKind::Build, false),
        command(VerificationCheckKind::Custom, true),
    ]);
    let selected = select_minimal_profile(&profile, &paths(&["src/lib/math.ts"]));

    assert_eq!(
        kinds(&selected),
        vec![
            VerificationCheckKind::Lint,
            VerificationCheckKind::Typecheck,
            VerificationCheckKind::Test,
            VerificationCheckKind::Custom,
        ]
    );
    assert_eq!(selected.commands[0], profile.commands[0]);
    assert_eq!(selected.commands[1], profile.commands[1]);
    assert_eq!(selected.commands[2], profile.commands[2]);
    assert_eq!(selected.commands[3], profile.commands[4]);
    assert!(!selected.commands[0].required);
    assert!(selected.commands[3].required);
}
