use crate::model::{ProjectKind, VerificationCheckKind, VerificationCommand, VerificationProfile};
use anyhow::Result;
use std::path::Path;

pub(crate) fn detect(root: &Path) -> Result<Option<VerificationProfile>> {
    let Some(marker) = ["pom.xml", "build.gradle", "build.gradle.kts"]
        .into_iter()
        .find(|marker| root.join(marker).is_file())
    else {
        return Ok(None);
    };

    if marker == "pom.xml" {
        let (program, wrapper) = maven_program(root);
        return Ok(Some(profile(
            root,
            marker,
            &program,
            wrapper,
            &["-q", "-DskipTests", "compile"],
            &["-q", "test"],
            &["-q", "-DskipTests", "package"],
        )));
    }

    let (program, wrapper) = gradle_program(root);
    Ok(Some(profile(
        root,
        marker,
        &program,
        wrapper,
        &["compileJava"],
        &["test"],
        &["build", "-x", "test"],
    )))
}

fn maven_program(root: &Path) -> (String, bool) {
    if root.join("mvnw").is_file() {
        ("./mvnw".into(), true)
    } else {
        ("mvn".into(), false)
    }
}

fn gradle_program(root: &Path) -> (String, bool) {
    if root.join("gradlew").is_file() {
        ("./gradlew".into(), true)
    } else {
        ("gradle".into(), false)
    }
}

fn profile(
    root: &Path,
    marker: &str,
    program: &str,
    wrapper: bool,
    compile_args: &[&str],
    test_args: &[&str],
    build_args: &[&str],
) -> VerificationProfile {
    let wrapper_source = if wrapper {
        format!("using wrapper {program}")
    } else {
        format!("using system {program} (wrapper not found)")
    };
    VerificationProfile {
        project_kind: ProjectKind::Java,
        package_manager: None,
        root: root.to_path_buf(),
        commands: vec![
            command(
                VerificationCheckKind::Typecheck,
                program,
                compile_args,
                "Compile Java sources.",
            ),
            command(
                VerificationCheckKind::Test,
                program,
                test_args,
                "Run Java tests.",
            ),
            command(
                VerificationCheckKind::Build,
                program,
                build_args,
                "Build the Java project.",
            ),
        ],
        source: format!("Java project detected from {marker}; {wrapper_source}."),
    }
}

fn command(
    kind: VerificationCheckKind,
    program: &str,
    args: &[&str],
    description: &str,
) -> VerificationCommand {
    VerificationCommand {
        kind,
        program: program.into(),
        args: args.iter().map(|arg| arg.to_string()).collect(),
        required: true,
        description: description.into(),
    }
}
