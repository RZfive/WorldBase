use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// The target project's primary language/tooling family.
///
/// Frontend projects are the first supported profile. Rust, Python, and Go are
/// reserved for later profiles and must not be treated as current defaults.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectKind {
    FrontendNode,
    Rust,
    Python,
    Go,
    Java,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PackageManager {
    Pnpm,
    Npm,
    Yarn,
    Bun,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VerificationCheckKind {
    Typecheck,
    Lint,
    Test,
    Build,
    Format,
    Custom,
}

impl VerificationCheckKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Typecheck => "typecheck",
            Self::Lint => "lint",
            Self::Test => "test",
            Self::Build => "build",
            Self::Format => "format",
            Self::Custom => "custom",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationCommand {
    pub kind: VerificationCheckKind,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Required commands must pass before a coding run may finish successfully.
    pub required: bool,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationProfile {
    pub project_kind: ProjectKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package_manager: Option<PackageManager>,
    /// Absolute project root. Public protocol payloads must not expose this
    /// value directly; use a project id or workspace-relative paths instead.
    pub root: PathBuf,
    pub commands: Vec<VerificationCommand>,
    /// Human-readable explanation of how the profile was selected.
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutcome {
    pub command: VerificationCommand,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub stdout: String,
    #[serde(default)]
    pub stderr: String,
    #[serde(default)]
    pub timed_out: bool,
    #[serde(default)]
    pub cancelled: bool,
    #[serde(default)]
    pub duration_ms: u64,
}

impl CommandOutcome {
    pub fn succeeded(&self) -> bool {
        !self.cancelled && !self.timed_out && self.exit_code == Some(0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticSeverity {
    Error,
    Warning,
    Info,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub severity: DiagnosticSeverity,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
    /// Confidence in the normalized interpretation, from 0.0 to 1.0.
    pub confidence: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationEvidence {
    pub profile: VerificationProfile,
    pub outcomes: Vec<CommandOutcome>,
    pub diagnostics: Vec<Diagnostic>,
    /// A verification is passed only when every required command succeeded and
    /// no command was cancelled or timed out.
    pub passed: bool,
    #[serde(default)]
    pub cancelled: bool,
    #[serde(default)]
    pub timed_out: bool,
}

impl VerificationEvidence {
    /// Build the minimal evidence used by the core command gate when a tool
    /// has already completed synchronously and returned a trustworthy status.
    pub fn command_gate(passed: bool) -> Self {
        Self {
            profile: VerificationProfile {
                project_kind: ProjectKind::Unknown,
                package_manager: None,
                root: PathBuf::new(),
                commands: Vec::new(),
                source: "core-command-gate".into(),
            },
            outcomes: Vec::new(),
            diagnostics: Vec::new(),
            passed,
            cancelled: false,
            timed_out: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodingPhase {
    Idle,
    Plan,
    Inspect,
    Edit,
    Verify,
    Diagnose,
    Repair,
    Complete,
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodingStopReason {
    VerificationPassed,
    MaxRepairRounds,
    VerificationUnavailable,
    VerificationFailed,
    NonRecoverable,
    Cancelled,
    BudgetExhausted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingPolicy {
    pub enabled: bool,
    pub require_verification: bool,
    pub max_repair_rounds: u32,
    /// Hard cap for verification commands in one coding run.
    pub max_verification_commands: u32,
    /// Hard cap for a single verification command.
    pub command_timeout_ms: u64,
    /// Maximum captured stdout/stderr bytes per command.
    pub max_output_bytes: usize,
}

impl Default for CodingPolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            require_verification: true,
            max_repair_rounds: 3,
            max_verification_commands: 8,
            command_timeout_ms: 120_000,
            max_output_bytes: 64 * 1024,
        }
    }
}
