use crate::model::{ProjectKind, VerificationCheckKind, VerificationCommand, VerificationProfile};
use anyhow::{Context, Result};
use std::fs;
use std::path::Path;

const MARKERS: [&str; 6] = [
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "requirements.txt",
    "uv.lock",
    "poetry.lock",
];

pub(crate) fn detect(root: &Path) -> Result<Option<VerificationProfile>> {
    let Some(marker) = MARKERS
        .iter()
        .copied()
        .find(|name| root.join(name).is_file())
    else {
        return Ok(None);
    };

    let pyproject = root.join("pyproject.toml");
    let pyproject_text = if pyproject.is_file() {
        Some(
            fs::read_to_string(&pyproject)
                .with_context(|| format!("read {}", pyproject.display()))?,
        )
    } else {
        None
    };
    let configured_mypy = pyproject_text
        .as_deref()
        .is_some_and(|text| text.contains("[tool.mypy"));
    let configured_ruff = pyproject_text
        .as_deref()
        .is_some_and(|text| text.contains("[tool.ruff"));

    let wrapper = if root.join("uv.lock").is_file() {
        Some(("uv", "uv.lock"))
    } else if root.join("poetry.lock").is_file() {
        Some(("poetry", "poetry.lock"))
    } else {
        None
    };

    let mut commands = Vec::new();
    commands.push(wrapped_command(
        wrapper,
        VerificationCheckKind::Test,
        "pytest",
        &[],
        "Run pytest.",
    ));
    if configured_mypy {
        commands.push(wrapped_command(
            wrapper,
            VerificationCheckKind::Typecheck,
            "mypy",
            &["."],
            "Run mypy using the [tool.mypy] configuration.",
        ));
    }
    if configured_ruff {
        commands.push(wrapped_command(
            wrapper,
            VerificationCheckKind::Lint,
            "ruff",
            &["check", "."],
            "Run Ruff using the [tool.ruff] configuration.",
        ));
    }
    commands.push(wrapped_command(
        wrapper,
        VerificationCheckKind::Build,
        "python",
        &["-m", "compileall", "-q", "."],
        "Byte-compile the project as a syntax check.",
    ));

    let wrapper_source = wrapper
        .map(|(program, lockfile)| format!("{program} wrapper selected from {lockfile}"))
        .unwrap_or_else(|| "no uv/poetry lockfile wrapper".to_string());
    let configured = match (configured_mypy, configured_ruff) {
        (true, true) => "[tool.mypy] and [tool.ruff] configured in pyproject.toml",
        (true, false) => "[tool.mypy] configured in pyproject.toml",
        (false, true) => "[tool.ruff] configured in pyproject.toml",
        (false, false) => "no optional mypy/ruff pyproject configuration",
    };
    Ok(Some(VerificationProfile {
        project_kind: ProjectKind::Python,
        package_manager: None,
        root: root.to_path_buf(),
        commands,
        source: format!("Python project detected from {marker}; {wrapper_source}; {configured}."),
    }))
}

fn wrapped_command(
    wrapper: Option<(&'static str, &'static str)>,
    kind: VerificationCheckKind,
    program: &str,
    args: &[&str],
    description: &str,
) -> VerificationCommand {
    let (program, args) = match wrapper {
        Some((wrapper_program, _)) => {
            let mut wrapped_args = vec!["run".to_string(), program.to_string()];
            wrapped_args.extend(args.iter().map(|arg| (*arg).to_string()));
            (wrapper_program.to_string(), wrapped_args)
        }
        None => (
            program.to_string(),
            args.iter().map(|arg| (*arg).to_string()).collect(),
        ),
    };
    VerificationCommand {
        kind,
        program,
        args,
        required: true,
        description: description.to_string(),
    }
}
