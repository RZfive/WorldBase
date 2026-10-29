use crate::model::{ProjectKind, VerificationCheckKind, VerificationCommand, VerificationProfile};
use anyhow::Result;
use std::{fs, path::Path};

pub(crate) fn detect(root: &Path) -> Result<Option<VerificationProfile>> {
    let Some(marker) = ["pom.xml", "build.gradle", "build.gradle.kts"]
        .into_iter()
        .find(|marker| root.join(marker).is_file())
    else {
        return Ok(None);
    };

    if marker == "pom.xml" {
        let (program, wrapper_source) = maven_program(root);
        return Ok(Some(profile(
            root,
            marker,
            &program,
            wrapper_source,
            &["-q", "-DskipTests", "compile"],
            &["-q", "test"],
            &["-q", "-DskipTests", "package"],
        )));
    }

    let (program, wrapper_source) = gradle_program(root);
    Ok(Some(profile(
        root,
        marker,
        &program,
        wrapper_source,
        &["compileJava"],
        &["test"],
        &["build", "-x", "test"],
    )))
}

fn maven_program(root: &Path) -> (String, String) {
    wrapper_program(root, "mvnw", "mvn")
}

fn gradle_program(root: &Path) -> (String, String) {
    wrapper_program(root, "gradlew", "gradle")
}

/// A wrapper is only used when it is an actual executable script. Executable
/// permission bits are authoritative on Unix; a shebang also counts because
/// archives and test fixtures commonly lose the mode bit while preserving the
/// script header. A plain non-executable file falls back to the system tool.
fn wrapper_program(root: &Path, wrapper: &str, system: &str) -> (String, String) {
    let path = root.join(wrapper);
    if wrapper_is_executable(&path) {
        (format!("./{wrapper}"), format!("using wrapper ./{wrapper}"))
    } else if path.is_file() {
        (
            system.to_string(),
            format!("using system {system} (wrapper {wrapper} is not executable)"),
        )
    } else {
        (
            system.to_string(),
            format!("using system {system} (wrapper not found)"),
        )
    }
}

fn wrapper_is_executable(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 != 0 {
            return true;
        }
    }
    fs::read(path).is_ok_and(|contents| contents.starts_with(b"#!"))
}

fn profile(
    root: &Path,
    marker: &str,
    program: &str,
    wrapper_source: String,
    compile_args: &[&str],
    test_args: &[&str],
    build_args: &[&str],
) -> VerificationProfile {
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
