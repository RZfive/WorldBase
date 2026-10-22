use std::fs;
use worldbase_coding::{detect_profile, ProjectKind, VerificationCheckKind};

#[test]
fn detects_go_module_and_plans_commands_in_order() {
    let root = tempfile::tempdir().unwrap();
    fs::write(
        root.path().join("go.mod"),
        "module example.com/demo\n\ngo 1.22\n",
    )
    .unwrap();

    let profile = detect_profile(root.path()).unwrap();
    assert_eq!(profile.project_kind, ProjectKind::Go);
    assert_eq!(profile.package_manager, None);
    assert!(profile.source.contains("go.mod"));
    assert_eq!(profile.root, root.path());
    assert_eq!(profile.commands.len(), 3);
    assert_eq!(
        profile
            .commands
            .iter()
            .map(|command| command.kind)
            .collect::<Vec<_>>(),
        vec![
            VerificationCheckKind::Typecheck,
            VerificationCheckKind::Test,
            VerificationCheckKind::Build,
        ]
    );
    assert_eq!(
        profile
            .commands
            .iter()
            .map(|command| command.args.clone())
            .collect::<Vec<_>>(),
        vec![
            vec!["vet".to_string(), "./...".to_string()],
            vec!["test".to_string(), "./...".to_string()],
            vec!["build".to_string(), "./...".to_string()],
        ]
    );
    assert!(profile.commands.iter().all(|command| command.required));
    assert!(profile
        .commands
        .iter()
        .all(|command| command.program == "go"));
    assert!(profile
        .commands
        .iter()
        .all(|command| !command.args.iter().any(|arg| arg == "-race")));
}

#[test]
fn go_work_is_a_secondary_marker() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("go.work"), "go 1.22\n\nuse ./app\n").unwrap();

    let profile = detect_profile(root.path()).unwrap();
    assert_eq!(profile.project_kind, ProjectKind::Go);
    assert_eq!(profile.package_manager, None);
    assert!(profile.source.contains("go.work"));
    assert_eq!(profile.commands.len(), 3);
    assert_eq!(profile.commands[0].args, vec!["vet", "./..."]);
}

#[test]
fn go_mod_and_go_work_are_both_reported() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("go.mod"), "module example.com/demo\n").unwrap();
    fs::write(root.path().join("go.work"), "go 1.22\n\nuse ./demo\n").unwrap();

    let profile = detect_profile(root.path()).unwrap();
    assert_eq!(profile.project_kind, ProjectKind::Go);
    assert!(profile.source.contains("go.mod"));
    assert!(profile.source.contains("go.work"));
    assert_eq!(profile.commands.len(), 3);
}

#[test]
fn missing_go_markers_do_not_plan_go_commands() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("README.md"), "# not a Go project\n").unwrap();

    let profile = detect_profile(root.path()).unwrap();
    assert_eq!(profile.project_kind, ProjectKind::Unknown);
    assert_eq!(profile.package_manager, None);
    assert!(profile.commands.is_empty());
    assert!(!profile.source.contains("go.mod"));
}

#[test]
fn go_profile_commands_preserve_order_and_required_flags() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("go.mod"), "module example.com/demo\n").unwrap();

    let profile = detect_profile(root.path()).unwrap();
    for (index, (kind, program, args)) in [
        (VerificationCheckKind::Typecheck, "go", vec!["vet", "./..."]),
        (VerificationCheckKind::Test, "go", vec!["test", "./..."]),
        (VerificationCheckKind::Build, "go", vec!["build", "./..."]),
    ]
    .into_iter()
    .enumerate()
    {
        let command = &profile.commands[index];
        assert_eq!(command.kind, kind);
        assert_eq!(command.program, program);
        assert_eq!(command.args, args);
        assert!(command.required);
    }
}
