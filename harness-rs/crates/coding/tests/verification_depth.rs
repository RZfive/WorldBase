use std::{fs, path::Path};
use worldbase_coding::{
    verification::detect_profile, ProjectKind, VerificationCheckKind, VerificationProfile,
};

fn write(root: &Path, name: &str, contents: &str) {
    fs::write(root.join(name), contents).unwrap();
}

fn kinds(profile: &VerificationProfile) -> Vec<VerificationCheckKind> {
    profile
        .commands
        .iter()
        .map(|command| command.kind)
        .collect()
}

fn command(
    profile: &VerificationProfile,
    kind: VerificationCheckKind,
) -> &worldbase_coding::VerificationCommand {
    profile
        .commands
        .iter()
        .find(|command| command.kind == kind)
        .unwrap_or_else(|| panic!("missing {kind:?} command"))
}

#[test]
fn node_scripts_are_detected_with_the_selected_package_manager() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "package.json",
        r#"{"name":"fixture","scripts":{"typecheck":"tsc --noEmit","lint":"eslint .","test":"vitest run","build":"vite build"}}"#,
    );
    write(root.path(), "pnpm-lock.yaml", "lockfileVersion: 9\n");

    let profile = detect_profile(root.path()).unwrap();
    assert_eq!(profile.project_kind, ProjectKind::FrontendNode);
    assert_eq!(
        kinds(&profile),
        vec![
            VerificationCheckKind::Typecheck,
            VerificationCheckKind::Lint,
            VerificationCheckKind::Test,
            VerificationCheckKind::Build,
        ]
    );
    assert!(profile
        .commands
        .iter()
        .all(|command| command.program == "pnpm"));
    assert!(profile.source.contains("pnpm-lock.yaml"));
}

#[test]
fn rust_distinguishes_workspace_package_and_hybrid_manifests() {
    let workspace = tempfile::tempdir().unwrap();
    write(
        workspace.path(),
        "Cargo.toml",
        "[workspace]\nmembers = [\"crates/core\"]\n",
    );
    let profile = detect_profile(workspace.path()).unwrap();
    assert_eq!(profile.project_kind, ProjectKind::Rust);
    assert!(profile.source.contains("workspace"));
    assert!(!profile.source.contains("root package"));
    assert_eq!(profile.commands.len(), 4);

    let package = tempfile::tempdir().unwrap();
    write(
        package.path(),
        "Cargo.toml",
        "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\n",
    );
    let profile = detect_profile(package.path()).unwrap();
    assert!(profile.source.contains("package project"));
    assert!(!profile.source.contains("workspace"));

    let hybrid = tempfile::tempdir().unwrap();
    write(
        hybrid.path(),
        "Cargo.toml",
        "[workspace]\nmembers = [\".\"]\n\n[package]\nname = \"fixture\"\n",
    );
    let profile = detect_profile(hybrid.path()).unwrap();
    assert!(profile.source.contains("workspace"));
    assert!(profile.source.contains("root package"));
}

#[test]
fn rustfmt_is_optional_and_workspace_independent() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "Cargo.toml",
        "[workspace]\nmembers = [\"crates/core\"]\n",
    );
    write(root.path(), ".rustfmt.toml", "edition = \"2021\"\n");

    let profile = detect_profile(root.path()).unwrap();
    assert_eq!(
        kinds(&profile),
        vec![
            VerificationCheckKind::Typecheck,
            VerificationCheckKind::Lint,
            VerificationCheckKind::Test,
            VerificationCheckKind::Build,
            VerificationCheckKind::Format,
        ]
    );
    let format = command(&profile, VerificationCheckKind::Format);
    assert_eq!(format.program, "cargo");
    assert_eq!(format.args, ["fmt", "--check"]);
    assert!(!format.required);
    assert!(profile.source.contains(".rustfmt.toml"));
}

#[test]
fn go_workspace_and_module_markers_are_reported_together() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "go.mod", "module example.com/demo\n");
    write(root.path(), "go.work", "go 1.23\n\nuse ./demo\n");

    let profile = detect_profile(root.path()).unwrap();
    assert_eq!(profile.project_kind, ProjectKind::Go);
    assert!(profile.source.contains("go.mod"));
    assert!(profile.source.contains("go.work"));
    assert_eq!(
        kinds(&profile),
        vec![
            VerificationCheckKind::Typecheck,
            VerificationCheckKind::Test,
            VerificationCheckKind::Build,
        ]
    );
}

#[test]
fn python_uv_wins_over_poetry_and_pytest_config_is_reported() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "pyproject.toml",
        "[tool.mypy]\nstrict = true\n\n[tool.ruff]\nline-length = 100\n\n[tool.pytest.ini_options]\naddopts = \"-q\"\n",
    );
    write(root.path(), "uv.lock", "version = 1\n");
    write(root.path(), "poetry.lock", "package = []\n");

    let profile = detect_profile(root.path()).unwrap();
    assert_eq!(profile.project_kind, ProjectKind::Python);
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
    assert!(profile.source.contains("uv.lock"));
    assert!(!profile.source.contains("poetry wrapper"));
    assert!(profile
        .source
        .contains("[tool.mypy] configured in pyproject.toml"));
    assert!(profile
        .source
        .contains("[tool.ruff] configured in pyproject.toml"));
    assert!(profile
        .source
        .contains("[tool.pytest] configured in pyproject.toml"));
}

#[test]
fn python_tool_config_prefers_pyproject_then_config_files() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "pyproject.toml",
        "[tool.mypy]\nstrict = true\n",
    );
    write(
        root.path(),
        "mypy.ini",
        "[mypy]\nignore_missing_imports = true\n",
    );
    write(root.path(), "ruff.toml", "line-length = 100\n");

    let profile = detect_profile(root.path()).unwrap();
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
        .source
        .contains("[tool.mypy] configured in pyproject.toml"));
    assert!(!profile.source.contains("mypy.ini"));
    assert!(profile.source.contains("ruff.toml"));
    assert_eq!(
        command(&profile, VerificationCheckKind::Lint).program,
        "ruff"
    );
}

#[test]
fn python_pytest_marker_alone_still_detects_a_project() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "pytest.ini", "[pytest]\naddopts = -q\n");

    let profile = detect_profile(root.path()).unwrap();
    assert_eq!(profile.project_kind, ProjectKind::Python);
    assert_eq!(
        kinds(&profile),
        vec![VerificationCheckKind::Test, VerificationCheckKind::Build,]
    );
    assert!(profile.source.contains("pytest.ini"));
    assert!(profile.source.contains("pytest: pytest.ini"));
}

#[test]
fn java_wrapper_must_be_executable_not_merely_present() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "build.gradle", "plugins { id 'java' }\n");
    write(root.path(), "gradlew", "plain text without a shebang\n");

    let profile = detect_profile(root.path()).unwrap();
    assert_eq!(profile.project_kind, ProjectKind::Java);
    assert!(profile
        .commands
        .iter()
        .all(|command| command.program == "gradle"));
    assert!(profile.source.contains("not executable"));
    assert!(!profile.source.contains("using wrapper"));
}

#[test]
fn java_shebang_wrapper_is_used_without_an_execute_bit() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "pom.xml", "<project/>\n");
    write(root.path(), "mvnw", "#!/bin/sh\n");

    let profile = detect_profile(root.path()).unwrap();
    assert!(profile
        .commands
        .iter()
        .all(|command| command.program == "./mvnw"));
    assert!(profile.source.contains("using wrapper ./mvnw"));
}

#[cfg(unix)]
#[test]
fn java_executable_bit_is_enough_for_a_wrapper() {
    use std::os::unix::fs::PermissionsExt;

    let root = tempfile::tempdir().unwrap();
    write(root.path(), "pom.xml", "<project/>\n");
    let wrapper = root.path().join("mvnw");
    write(root.path(), "mvnw", "binary wrapper\n");
    let mut permissions = fs::metadata(&wrapper).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&wrapper, permissions).unwrap();

    let profile = detect_profile(root.path()).unwrap();
    assert!(profile
        .commands
        .iter()
        .all(|command| command.program == "./mvnw"));
    assert!(profile.source.contains("using wrapper ./mvnw"));
}
