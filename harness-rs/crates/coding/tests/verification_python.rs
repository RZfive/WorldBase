use std::path::Path;
use worldbase_coding::{detect_profile, ProjectKind, VerificationCheckKind};

fn write(root: &Path, name: &str, content: &str) {
    std::fs::write(root.join(name), content).unwrap();
}

fn kinds(profile: &worldbase_coding::VerificationProfile) -> Vec<VerificationCheckKind> {
    profile
        .commands
        .iter()
        .map(|command| command.kind)
        .collect()
}

fn assert_python_profile(profile: &worldbase_coding::VerificationProfile) {
    assert_eq!(profile.project_kind, ProjectKind::Python);
    assert!(profile.package_manager.is_none());
    assert!(profile.commands.iter().all(|command| command.required));
}

#[test]
fn pyproject_configures_pytest_mypy_ruff_and_build_in_order() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "pyproject.toml",
        r#"
[tool.pytest.ini_options]
addopts = "-q"

[tool.mypy]
strict = true

[tool.ruff]
line-length = 100
"#,
    );

    let profile = detect_profile(root.path()).unwrap();
    assert_python_profile(&profile);
    assert_eq!(
        kinds(&profile),
        vec![
            VerificationCheckKind::Test,
            VerificationCheckKind::Typecheck,
            VerificationCheckKind::Lint,
            VerificationCheckKind::Build,
        ]
    );
    assert_eq!(profile.commands[0].program, "pytest");
    assert!(profile.commands[0].args.is_empty());
    assert_eq!(profile.commands[1].program, "mypy");
    assert_eq!(profile.commands[1].args, vec!["."]);
    assert_eq!(profile.commands[2].program, "ruff");
    assert_eq!(profile.commands[2].args, vec!["check", "."]);
    assert_eq!(profile.commands[3].program, "python");
    assert_eq!(
        profile.commands[3].args,
        vec!["-m", "compileall", "-q", "."]
    );
    assert!(profile.source.contains("pyproject.toml"));
    assert!(profile.source.contains("[tool.mypy]"));
    assert!(profile.source.contains("[tool.ruff]"));
    assert!(profile.source.contains("no uv/poetry lockfile wrapper"));
}

#[test]
fn requirements_only_runs_pytest_and_build() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "requirements.txt", "pytest==8.0.0\n");

    let profile = detect_profile(root.path()).unwrap();
    assert_python_profile(&profile);
    assert_eq!(
        kinds(&profile),
        vec![VerificationCheckKind::Test, VerificationCheckKind::Build]
    );
    assert_eq!(profile.commands[0].program, "pytest");
    assert_eq!(profile.commands[1].program, "python");
    assert!(profile.source.contains("requirements.txt"));
}

#[test]
fn uv_lock_prefers_uv_run_wrappers() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "pyproject.toml", "[tool.mypy]\n[tool.ruff]\n");
    write(root.path(), "uv.lock", "version = 1\n");

    let profile = detect_profile(root.path()).unwrap();
    assert_python_profile(&profile);
    assert_eq!(
        kinds(&profile),
        vec![
            VerificationCheckKind::Test,
            VerificationCheckKind::Typecheck,
            VerificationCheckKind::Lint,
            VerificationCheckKind::Build,
        ]
    );
    assert!(profile
        .commands
        .iter()
        .all(|command| command.program == "uv"));
    assert_eq!(
        profile.commands[0].args,
        vec!["run".to_string(), "pytest".to_string()]
    );
    assert_eq!(
        profile.commands[1].args,
        vec!["run".to_string(), "mypy".to_string(), ".".to_string()]
    );
    assert_eq!(
        profile.commands[2].args,
        vec![
            "run".to_string(),
            "ruff".to_string(),
            "check".to_string(),
            ".".to_string()
        ]
    );
    assert_eq!(
        profile.commands[3].args,
        vec![
            "run".to_string(),
            "python".to_string(),
            "-m".to_string(),
            "compileall".to_string(),
            "-q".to_string(),
            ".".to_string()
        ]
    );
    assert!(profile.source.contains("uv.lock"));
}

#[test]
fn poetry_lock_prefers_poetry_run_wrappers() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "pyproject.toml", "[tool.ruff]\n");
    write(root.path(), "poetry.lock", "package = []\n");

    let profile = detect_profile(root.path()).unwrap();
    assert_python_profile(&profile);
    assert_eq!(
        kinds(&profile),
        vec![
            VerificationCheckKind::Test,
            VerificationCheckKind::Lint,
            VerificationCheckKind::Build,
        ]
    );
    assert!(profile
        .commands
        .iter()
        .all(|command| command.program == "poetry"));
    assert_eq!(
        profile.commands[0].args,
        vec!["run".to_string(), "pytest".to_string()]
    );
    assert_eq!(
        profile.commands[1].args,
        vec![
            "run".to_string(),
            "ruff".to_string(),
            "check".to_string(),
            ".".to_string()
        ]
    );
    assert!(profile.source.contains("poetry.lock"));
}

#[test]
fn setup_py_is_a_python_project_marker() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "setup.py",
        "from setuptools import setup\nsetup()\n",
    );

    let profile = detect_profile(root.path()).unwrap();
    assert_python_profile(&profile);
    assert_eq!(
        kinds(&profile),
        vec![VerificationCheckKind::Test, VerificationCheckKind::Build]
    );
    assert!(profile.source.contains("setup.py"));
}

#[test]
fn setup_cfg_is_a_python_project_marker() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "setup.cfg", "[metadata]\nname = sample\n");

    let profile = detect_profile(root.path()).unwrap();
    assert_python_profile(&profile);
    assert_eq!(
        kinds(&profile),
        vec![VerificationCheckKind::Test, VerificationCheckKind::Build]
    );
    assert!(profile.source.contains("setup.cfg"));
}

#[test]
fn missing_python_marker_reports_unknown_at_the_caller() {
    let root = tempfile::tempdir().unwrap();
    let profile = detect_profile(root.path()).unwrap();
    assert_eq!(profile.project_kind, ProjectKind::Unknown);
    assert!(profile.package_manager.is_none());
    assert!(profile.commands.is_empty());
    assert!(profile.source.contains("No supported project manifest"));
}
