use std::fs;
use std::path::Path;
use worldbase_coding::{
    verification::detect_profile, ProjectKind, VerificationCheckKind, VerificationProfile,
};

fn fixture(marker: &str) -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join(marker), b"fixture").unwrap();
    root
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
fn detects_maven_pom_and_plans_compile_test_package() {
    let root = fixture("pom.xml");
    let profile = detect_profile(root.path()).unwrap();

    assert_eq!(profile.project_kind, ProjectKind::Java);
    assert_eq!(profile.package_manager, None);
    assert_eq!(profile.commands.len(), 3);
    assert_eq!(
        profile
            .commands
            .iter()
            .map(|command| command.kind)
            .collect::<Vec<_>>(),
        [
            VerificationCheckKind::Typecheck,
            VerificationCheckKind::Test,
            VerificationCheckKind::Build,
        ]
    );

    let compile = command(&profile, VerificationCheckKind::Typecheck);
    assert_eq!(compile.program, "mvn");
    assert_eq!(compile.args, ["-q", "-DskipTests", "compile"]);
    let test = command(&profile, VerificationCheckKind::Test);
    assert_eq!(test.program, "mvn");
    assert_eq!(test.args, ["-q", "test"]);
    let build = command(&profile, VerificationCheckKind::Build);
    assert_eq!(build.program, "mvn");
    assert_eq!(build.args, ["-q", "-DskipTests", "package"]);
    assert!(profile.commands.iter().all(|command| command.required));

    assert!(profile.source.contains("pom.xml"));
    assert!(profile.source.contains("mvn"));
    assert!(profile.source.contains("wrapper not found"));
}

#[test]
fn detects_gradle_build_file_and_plans_gradle_tasks() {
    let root = fixture("build.gradle");
    let profile = detect_profile(root.path()).unwrap();

    assert_eq!(profile.project_kind, ProjectKind::Java);
    assert_eq!(profile.package_manager, None);
    assert_eq!(
        profile
            .commands
            .iter()
            .map(|command| command.kind)
            .collect::<Vec<_>>(),
        [
            VerificationCheckKind::Typecheck,
            VerificationCheckKind::Test,
            VerificationCheckKind::Build,
        ]
    );
    assert!(profile.commands.iter().all(|command| command.required));

    assert_eq!(
        command(&profile, VerificationCheckKind::Typecheck).args,
        ["compileJava"]
    );
    assert_eq!(
        command(&profile, VerificationCheckKind::Test).args,
        ["test"]
    );
    assert_eq!(
        command(&profile, VerificationCheckKind::Build).args,
        ["build", "-x", "test"]
    );
    assert_eq!(
        command(&profile, VerificationCheckKind::Build).program,
        "gradle"
    );
    assert!(profile.source.contains("build.gradle"));
    assert!(profile.source.contains("gradle"));
}

#[test]
fn detects_gradle_kotlin_dsl_marker() {
    let root = fixture("build.gradle.kts");
    let profile = detect_profile(root.path()).unwrap();

    assert_eq!(profile.project_kind, ProjectKind::Java);
    assert!(profile.source.contains("build.gradle.kts"));
    assert_eq!(
        command(&profile, VerificationCheckKind::Typecheck).args,
        ["compileJava"]
    );
}

#[test]
fn prefers_maven_and_gradle_wrappers_when_present() {
    let maven_root = fixture("pom.xml");
    fs::write(maven_root.path().join("mvnw"), b"#!/bin/sh\n").unwrap();
    let maven = detect_profile(maven_root.path()).unwrap();
    assert!(maven
        .commands
        .iter()
        .all(|command| command.program == "./mvnw"));
    assert!(maven.source.contains("./mvnw"));
    assert!(maven.source.contains("wrapper"));

    let gradle_root = fixture("build.gradle");
    fs::write(gradle_root.path().join("gradlew"), b"#!/bin/sh\n").unwrap();
    let gradle = detect_profile(gradle_root.path()).unwrap();
    assert!(gradle
        .commands
        .iter()
        .all(|command| command.program == "./gradlew"));
    assert!(gradle.source.contains("./gradlew"));
    assert!(gradle.source.contains("wrapper"));
}

#[test]
fn wrapper_preference_is_independent_per_build_tool() {
    let maven_root = fixture("pom.xml");
    fs::write(maven_root.path().join("gradlew"), b"#!/bin/sh\n").unwrap();
    let maven = detect_profile(maven_root.path()).unwrap();
    assert_eq!(maven.commands[0].program, "mvn");

    let gradle_root = fixture("build.gradle.kts");
    fs::write(gradle_root.path().join("mvnw"), b"#!/bin/sh\n").unwrap();
    let gradle = detect_profile(gradle_root.path()).unwrap();
    assert_eq!(gradle.commands[0].program, "gradle");
}

#[test]
fn no_java_marker_returns_unknown_profile() {
    let root = tempfile::tempdir().unwrap();
    let profile = detect_profile(root.path()).unwrap();

    assert_eq!(profile.project_kind, ProjectKind::Unknown);
    assert_eq!(profile.package_manager, None);
    assert!(profile.commands.is_empty());
    assert_eq!(profile.root, Path::new(root.path()));
}
