use crate::model::{ProjectKind, VerificationCheckKind, VerificationCommand, VerificationProfile};
use anyhow::Result;
use std::path::Path;

pub(crate) fn detect(root: &Path) -> Result<Option<VerificationProfile>> {
    let has_module = root.join("go.mod").is_file();
    let has_workspace = root.join("go.work").is_file();
    if !has_module && !has_workspace {
        return Ok(None);
    }

    let source = match (has_module, has_workspace) {
        (true, true) => "Go project detected from go.mod and go.work.".to_string(),
        (true, false) => "Go project detected from go.mod.".to_string(),
        (false, true) => "Go workspace detected from go.work.".to_string(),
        (false, false) => unreachable!("marker check guarantees one source"),
    };

    Ok(Some(VerificationProfile {
        project_kind: ProjectKind::Go,
        package_manager: None,
        root: root.to_path_buf(),
        commands: vec![
            command(
                VerificationCheckKind::Typecheck,
                "go",
                &["vet", "./..."],
                "Run go vet across all packages.",
            ),
            command(
                VerificationCheckKind::Test,
                "go",
                &["test", "./..."],
                "Run all Go tests.",
            ),
            command(
                VerificationCheckKind::Build,
                "go",
                &["build", "./..."],
                "Build all packages.",
            ),
        ],
        source,
    }))
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
