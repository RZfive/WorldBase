//! Parse native verification tool output into typed evidence.
//!
//! The native `coding_verify` tool returns a public JSON shape that deliberately
//! omits the project root. This parser reconstructs the shared model without
//! executing commands or reading project files.

use crate::model::{
    CommandOutcome, Diagnostic, DiagnosticSeverity, PackageManager, ProjectKind,
    VerificationCheckKind, VerificationCommand, VerificationEvidence, VerificationProfile,
};
use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;

/// Parse the JSON result returned by the native `coding_verify` tool.
///
/// Unknown fields are ignored for forward compatibility. Required identity and
/// status fields are validated so malformed evidence cannot silently become a
/// successful verification.
pub fn verification_evidence_from_value(value: &Value) -> Result<VerificationEvidence> {
    let payload: EvidencePayload =
        serde_json::from_value(value.clone()).context("invalid coding_verify evidence JSON")?;

    let passed = payload
        .passed
        .ok_or_else(|| anyhow!("coding_verify evidence is missing required boolean `passed`"))?;
    let profile = match payload.profile {
        Some(profile) => parse_profile(profile)?,
        None => unknown_profile(String::new()),
    };

    let outcomes = payload
        .outcomes
        .into_iter()
        .enumerate()
        .map(|(index, outcome)| {
            parse_outcome(outcome, profile.commands.get(index)).map_err(|error| {
                anyhow!("invalid coding_verify outcome at index {index}: {error:#}")
            })
        })
        .collect::<Result<Vec<_>>>()?;

    let diagnostics = payload
        .diagnostics
        .into_iter()
        .enumerate()
        .map(|(index, diagnostic)| {
            parse_diagnostic(diagnostic, index).map_err(|error| {
                anyhow!("invalid coding_verify diagnostic at index {index}: {error:#}")
            })
        })
        .collect::<Result<Vec<_>>>()?;

    let cancelled =
        payload.cancelled.unwrap_or(false) || outcomes.iter().any(|outcome| outcome.cancelled);
    let timed_out =
        payload.timed_out.unwrap_or(false) || outcomes.iter().any(|outcome| outcome.timed_out);

    Ok(VerificationEvidence {
        profile,
        outcomes,
        diagnostics,
        passed,
        cancelled,
        timed_out,
    })
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct EvidencePayload {
    passed: Option<bool>,
    profile: Option<ProfilePayload>,
    outcomes: Vec<OutcomePayload>,
    diagnostics: Vec<DiagnosticPayload>,
    cancelled: Option<bool>,
    timed_out: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ProfilePayload {
    project_kind: Option<String>,
    package_manager: Option<String>,
    source: Option<String>,
    commands: Vec<CommandPayload>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct CommandPayload {
    kind: Option<String>,
    program: Option<String>,
    args: Vec<String>,
    required: Option<bool>,
    description: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct OutcomePayload {
    kind: Option<String>,
    program: Option<String>,
    args: Option<Vec<String>>,
    required: Option<bool>,
    description: Option<String>,
    exit_code: Option<i32>,
    stdout: Option<String>,
    stderr: Option<String>,
    timed_out: Option<bool>,
    cancelled: Option<bool>,
    duration_ms: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct DiagnosticPayload {
    severity: Option<String>,
    message: Option<String>,
    code: Option<String>,
    file: Option<PathBuf>,
    line: Option<u32>,
    column: Option<u32>,
    confidence: Option<f32>,
    raw: Option<String>,
}

fn parse_profile(payload: ProfilePayload) -> Result<VerificationProfile> {
    let project_kind = match payload.project_kind.as_deref() {
        Some(value) => parse_project_kind(value)?,
        None => ProjectKind::Unknown,
    };
    let package_manager = payload
        .package_manager
        .as_deref()
        .map(parse_package_manager)
        .transpose()?;
    let commands = payload
        .commands
        .into_iter()
        .enumerate()
        .map(|(index, command)| {
            parse_profile_command(command, index).map_err(|error| {
                anyhow!("invalid verification profile command at index {index}: {error:#}")
            })
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(VerificationProfile {
        project_kind,
        package_manager,
        root: PathBuf::new(),
        commands,
        source: payload.source.unwrap_or_default(),
    })
}

fn parse_profile_command(payload: CommandPayload, index: usize) -> Result<VerificationCommand> {
    let kind = parse_command_kind(&required_string(
        payload.kind,
        "kind",
        "verification profile command",
    )?)?;
    let program = required_string(payload.program, "program", "verification profile command")?;
    let required = payload.required.ok_or_else(|| {
        anyhow!("verification profile command at index {index} is missing boolean `required`")
    })?;

    Ok(VerificationCommand {
        kind,
        program,
        args: payload.args,
        required,
        description: payload.description.unwrap_or_default(),
    })
}

fn parse_outcome(
    payload: OutcomePayload,
    profile_command: Option<&VerificationCommand>,
) -> Result<CommandOutcome> {
    let kind = parse_command_kind(&required_string(
        payload.kind,
        "kind",
        "verification outcome",
    )?)?;
    let program = required_string(payload.program, "program", "verification outcome")?;
    let args = payload
        .args
        .or_else(|| profile_command.map(|command| command.args.clone()))
        .unwrap_or_default();
    let required = payload
        .required
        .or_else(|| profile_command.map(|command| command.required))
        .unwrap_or(false);
    let description = payload
        .description
        .or_else(|| profile_command.map(|command| command.description.clone()))
        .unwrap_or_default();
    Ok(CommandOutcome {
        command: VerificationCommand {
            kind,
            program,
            args,
            required,
            description,
        },
        exit_code: payload.exit_code,
        stdout: payload.stdout.unwrap_or_default(),
        stderr: payload.stderr.unwrap_or_default(),
        timed_out: payload.timed_out.unwrap_or(false),
        cancelled: payload.cancelled.unwrap_or(false),
        duration_ms: payload.duration_ms.unwrap_or(0),
    })
}

fn parse_diagnostic(payload: DiagnosticPayload, index: usize) -> Result<Diagnostic> {
    let severity = parse_severity(&required_string(
        payload.severity,
        "severity",
        "verification diagnostic",
    )?)?;
    let message = required_string(payload.message, "message", "verification diagnostic")?;
    let confidence = payload.confidence.unwrap_or(0.0);
    if !confidence.is_finite() {
        return Err(anyhow!(
            "verification diagnostic at index {index} has non-finite confidence"
        ));
    }

    Ok(Diagnostic {
        severity,
        message,
        code: payload.code,
        file: payload.file,
        line: payload.line,
        column: payload.column,
        confidence: confidence.clamp(0.0, 1.0),
        raw: payload.raw,
    })
}

fn unknown_profile(source: String) -> VerificationProfile {
    VerificationProfile {
        project_kind: ProjectKind::Unknown,
        package_manager: None,
        root: PathBuf::new(),
        commands: Vec::new(),
        source,
    }
}

fn required_string(value: Option<String>, field: &str, owner: &str) -> Result<String> {
    match value {
        Some(value) if !value.trim().is_empty() => Ok(value),
        Some(_) => Err(anyhow!("{owner} has an empty required string `{field}`")),
        None => Err(anyhow!("{owner} is missing required string `{field}`")),
    }
}

fn parse_project_kind(value: &str) -> Result<ProjectKind> {
    match value {
        "frontendNode" => Ok(ProjectKind::FrontendNode),
        "rust" => Ok(ProjectKind::Rust),
        "python" => Ok(ProjectKind::Python),
        "go" => Ok(ProjectKind::Go),
        "unknown" => Ok(ProjectKind::Unknown),
        _ => Err(anyhow!("unsupported projectKind `{value}`")),
    }
}

fn parse_package_manager(value: &str) -> Result<PackageManager> {
    match value {
        "pnpm" => Ok(PackageManager::Pnpm),
        "npm" => Ok(PackageManager::Npm),
        "yarn" => Ok(PackageManager::Yarn),
        "bun" => Ok(PackageManager::Bun),
        _ => Err(anyhow!("unsupported packageManager `{value}`")),
    }
}

fn parse_command_kind(value: &str) -> Result<VerificationCheckKind> {
    match value {
        "typecheck" => Ok(VerificationCheckKind::Typecheck),
        "lint" => Ok(VerificationCheckKind::Lint),
        "test" => Ok(VerificationCheckKind::Test),
        "build" => Ok(VerificationCheckKind::Build),
        "format" => Ok(VerificationCheckKind::Format),
        "custom" => Ok(VerificationCheckKind::Custom),
        _ => Err(anyhow!("unsupported verification command kind `{value}`")),
    }
}

fn parse_severity(value: &str) -> Result<DiagnosticSeverity> {
    match value {
        "error" | "fatal" => Ok(DiagnosticSeverity::Error),
        "warning" | "warn" => Ok(DiagnosticSeverity::Warning),
        "info" | "information" => Ok(DiagnosticSeverity::Info),
        _ => Err(anyhow!("unsupported diagnostic severity `{value}`")),
    }
}
