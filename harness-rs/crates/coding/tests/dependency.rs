use serde_json::json;
use worldbase_coding::dependency::{
    analyze_dependency_diagnostics, analyze_package_manager_output, dependency_kind,
    detect_package_manager, has_dependency, parse_package_manifest, DependencyFixAction,
    DependencyIssueKind, DependencyKind, PackageManifest,
};
use worldbase_coding::{Diagnostic, DiagnosticSeverity, PackageManager};

fn diagnostic(code: Option<&str>, message: &str, file: Option<&str>) -> Diagnostic {
    Diagnostic {
        severity: DiagnosticSeverity::Error,
        message: message.into(),
        code: code.map(str::to_string),
        file: file.map(Into::into),
        line: Some(1),
        column: Some(1),
        confidence: 0.95,
        raw: None,
    }
}

fn manifest() -> PackageManifest {
    parse_package_manifest(&json!({
        "name": "fixture",
        "packageManager": "pnpm@9.0.0",
        "dependencies": {
            "react": "^18.3.1",
            "left-pad": "^1.3.0"
        },
        "devDependencies": {
            "typescript": "^5.7.2",
            "@types/node": "^22.0.0"
        },
        "peerDependencies": {
            "react-dom": "^18.3.1"
        },
        "optionalDependencies": {
            "fsevents": "^2.3.3"
        }
    }))
    .unwrap()
}

fn first_report(
    message: &str,
    manifest: Option<&PackageManifest>,
    pm: Option<PackageManager>,
) -> worldbase_coding::dependency::DependencyReport {
    analyze_dependency_diagnostics(
        &[diagnostic(None, message, Some("src/App.tsx"))],
        manifest,
        pm,
    )
}

#[test]
fn parses_all_manifest_sections_and_package_manager() {
    let manifest = manifest();
    assert_eq!(manifest.name.as_deref(), Some("fixture"));
    assert_eq!(manifest.package_manager, Some(PackageManager::Pnpm));
    assert_eq!(manifest.dependencies.len(), 2);
    assert_eq!(manifest.dependencies["react"], "^18.3.1");
    assert_eq!(manifest.dev_dependencies["@types/node"], "^22.0.0");
    assert_eq!(manifest.peer_dependencies["react-dom"], "^18.3.1");
    assert_eq!(manifest.optional_dependencies["fsevents"], "^2.3.3");

    assert_eq!(
        dependency_kind(&manifest, "react"),
        Some(DependencyKind::Runtime)
    );
    assert_eq!(
        dependency_kind(&manifest, "typescript"),
        Some(DependencyKind::Dev)
    );
    assert_eq!(
        dependency_kind(&manifest, "react-dom"),
        Some(DependencyKind::Peer)
    );
    assert_eq!(
        dependency_kind(&manifest, "fsevents"),
        Some(DependencyKind::Optional)
    );
    assert_eq!(dependency_kind(&manifest, "missing"), None);
    assert!(has_dependency(&manifest, "react"));
    assert!(!has_dependency(&manifest, "zod"));
}

#[test]
fn manifest_tolerates_missing_sections_and_non_string_versions() {
    let manifest = parse_package_manifest(&json!({
        "name": "partial",
        "dependencies": { "good": "1.0.0", "bad": 42 },
        "devDependencies": [],
        "peerDependencies": null,
        "optionalDependencies": "not-an-object"
    }))
    .unwrap();

    assert_eq!(manifest.name.as_deref(), Some("partial"));
    assert_eq!(manifest.package_manager, None);
    assert_eq!(manifest.dependencies.len(), 1);
    assert_eq!(manifest.dependencies["good"], "1.0.0");
    assert!(manifest.dev_dependencies.is_empty());
    assert!(manifest.peer_dependencies.is_empty());
    assert!(manifest.optional_dependencies.is_empty());

    assert!(parse_package_manifest(&json!(["not", "an", "object"])).is_err());
    assert!(parse_package_manifest(&json!(null)).is_err());
}

#[test]
fn package_manager_precedence_and_lockfile_order() {
    let manifest = manifest();
    assert_eq!(
        detect_package_manager(Some(&manifest), &["package-lock.json"]),
        Some(PackageManager::Pnpm)
    );

    assert_eq!(
        detect_package_manager(None, &["pnpm-lock.yaml", "package-lock.json"]),
        Some(PackageManager::Pnpm)
    );
    assert_eq!(
        detect_package_manager(None, &["package-lock.json", "yarn.lock"]),
        Some(PackageManager::Npm)
    );
    assert_eq!(
        detect_package_manager(None, &["npm-shrinkwrap.json", "yarn.lock"]),
        Some(PackageManager::Npm)
    );
    assert_eq!(
        detect_package_manager(None, &["yarn.lock", "bun.lockb"]),
        Some(PackageManager::Yarn)
    );
    assert_eq!(
        detect_package_manager(None, &["bun.lockb", "bun.lock"]),
        Some(PackageManager::Bun)
    );
    assert_eq!(detect_package_manager(None, &[]), None);
    assert_eq!(
        detect_package_manager(None, &["workspace/project/pnpm-lock.yaml"]),
        Some(PackageManager::Pnpm)
    );
}

#[test]
fn missing_package_generates_the_correct_command_for_each_manager() {
    let cases = [
        (PackageManager::Pnpm, "pnpm add left-pad"),
        (PackageManager::Npm, "npm install left-pad"),
        (PackageManager::Yarn, "yarn add left-pad"),
        (PackageManager::Bun, "bun add left-pad"),
    ];

    for (manager, expected_command) in cases {
        let report = first_report(
            "Cannot find module 'left-pad'",
            Some(&manifest()),
            Some(manager),
        );
        assert_eq!(report.issues.len(), 1);
        let issue = &report.issues[0];
        assert_eq!(issue.kind, DependencyIssueKind::MissingPackage);
        assert_eq!(issue.package.as_deref(), Some("left-pad"));
        assert_eq!(issue.spec.as_deref(), Some("left-pad"));
        assert_eq!(
            issue.file.as_deref(),
            Some(std::path::Path::new("src/App.tsx"))
        );
        assert_eq!(report.commands, vec![expected_command]);
        let fix = issue.suggested_fix.as_ref().expect("install fix");
        assert_eq!(fix.action, DependencyFixAction::Install);
        assert_eq!(fix.command, expected_command);
        assert!(!fix.reason.contains("defaulted"));
    }
}

#[test]
fn no_manifest_still_suggests_a_package_with_pnpm_default() {
    let report = first_report("Cannot find package 'zod'", None, None);
    assert_eq!(report.issues.len(), 1);
    let issue = &report.issues[0];
    assert_eq!(issue.kind, DependencyIssueKind::MissingPackage);
    assert_eq!(issue.package.as_deref(), Some("zod"));
    assert_eq!(report.commands, vec!["pnpm add zod"]);
    let fix = issue.suggested_fix.as_ref().expect("install fix");
    assert!(fix.reason.contains("defaulted to pnpm"));
    assert_eq!(fix.action, DependencyFixAction::Install);
}

#[test]
fn relative_imports_and_node_builtins_have_no_install_command() {
    let cases = [
        "Cannot find module './missing'",
        "Cannot find module '../shared/util'",
        "Cannot find module '/absolute/path'",
        "Cannot find module 'node:fs'",
        "Cannot find module 'fs'",
        "Failed to resolve import \"fs/promises\"",
        "Could not resolve \"../styles.css\"",
    ];

    for message in cases {
        let report = first_report(message, Some(&manifest()), Some(PackageManager::Pnpm));
        assert_eq!(report.issues.len(), 1, "{message}");
        assert_eq!(report.issues[0].kind, DependencyIssueKind::UnresolvedImport);
        assert!(report.issues[0].suggested_fix.is_none(), "{message}");
        assert!(report.commands.is_empty(), "{message}");
    }
}

#[test]
fn package_subpaths_reduce_to_the_package_base() {
    let plain = first_report(
        "Cannot find module 'left-pad/uppercase'",
        Some(&manifest()),
        Some(PackageManager::Pnpm),
    );
    assert_eq!(plain.issues[0].package.as_deref(), Some("left-pad"));
    assert_eq!(plain.commands, vec!["pnpm add left-pad"]);

    let scoped = first_report(
        "Failed to resolve import \"@scope/pkg/sub/path\"",
        None,
        Some(PackageManager::Yarn),
    );
    assert_eq!(scoped.issues[0].package.as_deref(), Some("@scope/pkg"));
    assert_eq!(scoped.commands, vec!["yarn add @scope/pkg"]);
}

#[test]
fn ts2307_for_existing_runtime_dependency_suggests_types_dev_install() {
    let report = analyze_dependency_diagnostics(
        &[diagnostic(
            Some("TS2307"),
            "Cannot find module 'react/jsx-runtime' or its corresponding type declarations.",
            Some("src/App.tsx"),
        )],
        Some(&manifest()),
        None,
    );

    assert_eq!(report.issues.len(), 1);
    let issue = &report.issues[0];
    assert_eq!(issue.kind, DependencyIssueKind::MissingTypeDefinitions);
    assert_eq!(issue.package.as_deref(), Some("react"));
    assert_eq!(issue.spec.as_deref(), Some("react/jsx-runtime"));
    assert!(issue.confidence >= 0.95);
    let fix = issue.suggested_fix.as_ref().expect("types fix");
    assert_eq!(fix.action, DependencyFixAction::InstallDev);
    assert_eq!(fix.package.as_deref(), Some("@types/react"));
    assert_eq!(fix.command, "pnpm add -D @types/react");
    assert_eq!(report.commands, vec!["pnpm add -D @types/react"]);
}

#[test]
fn ts2307_for_scoped_runtime_dependency_uses_scoped_types_name() {
    let manifest = parse_package_manifest(&json!({
        "dependencies": { "@scope/pkg": "1.0.0" }
    }))
    .unwrap();
    let report = analyze_dependency_diagnostics(
        &[diagnostic(
            Some("TS2307"),
            "Cannot find module '@scope/pkg/sub' or its corresponding type declarations.",
            None,
        )],
        Some(&manifest),
        Some(PackageManager::Npm),
    );

    assert_eq!(
        report.issues[0].kind,
        DependencyIssueKind::MissingTypeDefinitions
    );
    assert_eq!(
        report.issues[0]
            .suggested_fix
            .as_ref()
            .unwrap()
            .package
            .as_deref(),
        Some("@types/scope__pkg")
    );
    assert_eq!(report.commands, vec!["npm install -D @types/scope__pkg"]);
}

#[test]
fn ts2307_for_unknown_package_installs_the_package() {
    let report = analyze_dependency_diagnostics(
        &[diagnostic(
            Some("TS2307"),
            "Cannot find module 'zod' or its corresponding type declarations.",
            None,
        )],
        Some(&manifest()),
        Some(PackageManager::Bun),
    );
    assert_eq!(report.issues[0].kind, DependencyIssueKind::MissingPackage);
    assert_eq!(report.issues[0].package.as_deref(), Some("zod"));
    assert_eq!(report.commands, vec!["bun add zod"]);

    let types = analyze_dependency_diagnostics(
        &[diagnostic(
            Some("TS2307"),
            "Cannot find module '@types/lodash' or its corresponding type declarations.",
            None,
        )],
        Some(&manifest()),
        Some(PackageManager::Pnpm),
    );
    assert_eq!(types.issues[0].kind, DependencyIssueKind::MissingPackage);
    assert_eq!(
        types.issues[0].suggested_fix.as_ref().unwrap().action,
        DependencyFixAction::InstallDev
    );
    assert_eq!(types.commands, vec!["pnpm add -D @types/lodash"]);
}

#[test]
fn peer_dependency_and_version_conflict_are_distinguished() {
    let peer = first_report(
        "npm ERR! peer dep missing: react@^18.3.1, required by react-dom@18.3.1",
        Some(&manifest()),
        Some(PackageManager::Npm),
    );
    assert_eq!(peer.issues[0].kind, DependencyIssueKind::PeerDependency);
    assert_eq!(peer.issues[0].package.as_deref(), Some("react"));
    let peer_fix = peer.issues[0].suggested_fix.as_ref().expect("peer fix");
    assert_eq!(peer_fix.action, DependencyFixAction::Update);
    assert_eq!(peer_fix.command, "npm install react@^18.3.1");

    let conflict = first_report(
        "npm ERR! Could not resolve dependency: peer react@^18.3.1 from react-dom@18.3.1",
        Some(&manifest()),
        Some(PackageManager::Npm),
    );
    assert_eq!(
        conflict.issues[0].kind,
        DependencyIssueKind::VersionConflict
    );
    assert_eq!(conflict.issues[0].package.as_deref(), Some("react"));
    let conflict_fix = conflict.issues[0]
        .suggested_fix
        .as_ref()
        .expect("update fix");
    assert_eq!(conflict_fix.action, DependencyFixAction::Update);
    assert_eq!(conflict_fix.command, "npm install react@^18.3.1");
}

#[test]
fn lockfile_mismatch_regenerates_the_lockfile() {
    let report = first_report(
        "ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile because pnpm-lock.yaml is not up to date",
        Some(&manifest()),
        Some(PackageManager::Pnpm),
    );
    assert_eq!(report.issues[0].kind, DependencyIssueKind::LockfileMismatch);
    assert_eq!(report.issues[0].package, None);
    let fix = report.issues[0]
        .suggested_fix
        .as_ref()
        .expect("lockfile fix");
    assert_eq!(fix.action, DependencyFixAction::RegenerateLockfile);
    assert_eq!(fix.command, "pnpm install");
    assert_eq!(report.commands, vec!["pnpm install"]);
}

#[test]
fn duplicate_diagnostics_are_deduped_with_their_commands() {
    let message = "Cannot find module 'zod'";
    let diagnostics = [
        diagnostic(None, message, Some("src/App.tsx")),
        diagnostic(None, message, Some("src/App.tsx")),
    ];
    let report =
        analyze_dependency_diagnostics(&diagnostics, Some(&manifest()), Some(PackageManager::Pnpm));

    assert_eq!(report.issues.len(), 1);
    assert_eq!(report.commands, vec!["pnpm add zod"]);
    assert_eq!(report.affected_packages, vec!["zod".to_string()]);
    assert!(report.summary.contains("1 dependency issue(s)"));
    assert!(report.summary.contains("1 package(s)"));
    assert!(report.has_issues);
}

#[test]
fn unknown_dependency_error_is_low_confidence() {
    let report = analyze_dependency_diagnostics(
        &[diagnostic(
            None,
            "dependency error: package 'left-pad' failed to install",
            None,
        )],
        Some(&manifest()),
        None,
    );
    assert_eq!(report.issues[0].kind, DependencyIssueKind::Unknown);
    assert_eq!(report.issues[0].package.as_deref(), Some("left-pad"));
    assert!(report.issues[0].confidence <= 0.4);
    assert_eq!(report.commands, vec!["pnpm add left-pad"]);
}

#[test]
fn raw_package_manager_output_is_analyzed_line_by_line() {
    let output = "\
npm ERR! Cannot find module 'zod'
ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile
";
    let report = analyze_package_manager_output(output, None, Some(PackageManager::Pnpm));
    assert_eq!(report.issues.len(), 2);
    assert_eq!(report.commands, vec!["pnpm add zod", "pnpm install"]);
    assert!(report
        .issues
        .iter()
        .any(|issue| issue.kind == DependencyIssueKind::MissingPackage));
    assert!(report
        .issues
        .iter()
        .any(|issue| issue.kind == DependencyIssueKind::LockfileMismatch));
}

#[test]
fn report_generation_is_deterministic() {
    let diagnostics = [
        diagnostic(
            None,
            "npm ERR! peer dep missing: react@^18.3.1",
            Some("src/App.tsx"),
        ),
        diagnostic(
            Some("TS2307"),
            "Cannot find module 'react/jsx-runtime' or its corresponding type declarations.",
            Some("src/components/App.tsx"),
        ),
        diagnostic(None, "Cannot find module './local'", None),
    ];

    let first =
        analyze_dependency_diagnostics(&diagnostics, Some(&manifest()), Some(PackageManager::Pnpm));
    let second =
        analyze_dependency_diagnostics(&diagnostics, Some(&manifest()), Some(PackageManager::Pnpm));
    assert_eq!(first, second);
    assert!(first.has_issues);
    assert_eq!(
        first.primary_kind,
        DependencyIssueKind::MissingTypeDefinitions
    );
}
