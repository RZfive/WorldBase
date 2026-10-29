use crate::model::{ProjectKind, VerificationCheckKind, VerificationCommand, VerificationProfile};
use anyhow::{Context, Result};
use std::fs;
use std::path::Path;

const MARKERS: [&str; 13] = [
    "pyproject.toml",
    "uv.lock",
    "poetry.lock",
    "setup.py",
    "setup.cfg",
    "requirements.txt",
    "mypy.ini",
    ".mypy.ini",
    "ruff.toml",
    ".ruff.toml",
    "pytest.ini",
    "tox.ini",
    "conftest.py",
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
    let setup_cfg = readable(root.join("setup.cfg"))?;
    let mypy_ini = first_file(root, &["mypy.ini", ".mypy.ini"])?;
    let ruff_toml = first_file(root, &["ruff.toml", ".ruff.toml"])?;

    let mypy_source = if pyproject_text
        .as_deref()
        .is_some_and(|text| text.contains("[tool.mypy"))
    {
        Some("[tool.mypy] configured in pyproject.toml")
    } else if let Some((name, _)) = &mypy_ini {
        Some(*name)
    } else if setup_cfg
        .as_deref()
        .is_some_and(|text| text.contains("[mypy]"))
    {
        Some("[mypy] configured in setup.cfg")
    } else {
        None
    };
    let ruff_source = if pyproject_text
        .as_deref()
        .is_some_and(|text| text.contains("[tool.ruff"))
    {
        Some("[tool.ruff] configured in pyproject.toml")
    } else if let Some((name, _)) = &ruff_toml {
        Some(*name)
    } else if setup_cfg
        .as_deref()
        .is_some_and(|text| text.contains("[ruff]"))
    {
        Some("[ruff] configured in setup.cfg")
    } else {
        None
    };
    let configured_mypy = mypy_source.is_some();
    let configured_ruff = ruff_source.is_some();

    let pytest_source = if pyproject_text
        .as_deref()
        .is_some_and(|text| text.contains("[tool.pytest"))
    {
        Some("[tool.pytest] configured in pyproject.toml")
    } else {
        first_file(root, &["pytest.ini", "tox.ini", "conftest.py"])?.map(|(name, _)| name)
    };

    // uv has precedence over poetry when both lockfiles are present.
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
    let configured = match (mypy_source, ruff_source) {
        (Some(mypy), Some(ruff)) => format!("{mypy}; {ruff}"),
        (Some(mypy), None) => mypy.to_string(),
        (None, Some(ruff)) => ruff.to_string(),
        (None, None) => "no optional mypy/ruff configuration".to_string(),
    };
    let pytest = pytest_source.unwrap_or("no pytest-specific configuration");
    Ok(Some(VerificationProfile {
        project_kind: ProjectKind::Python,
        package_manager: None,
        root: root.to_path_buf(),
        commands,
        source: format!(
            "Python project detected from {marker}; {wrapper_source}; {configured}; pytest: {pytest}."
        ),
    }))
}

fn readable(path: std::path::PathBuf) -> Result<Option<String>> {
    if !path.is_file() {
        return Ok(None);
    }
    fs::read_to_string(&path)
        .map(Some)
        .with_context(|| format!("read {}", path.display()))
}

fn first_file(root: &Path, candidates: &[&'static str]) -> Result<Option<(&'static str, String)>> {
    for candidate in candidates {
        let text = readable(root.join(candidate))?;
        if let Some(text) = text {
            return Ok(Some((candidate, text)));
        }
    }
    Ok(None)
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
