//! Execute a verification profile through a core-provided command executor.
//!
//! This module only sequences already-planned commands. Process creation,
//! permissions, cancellation, and provider calls remain owned by core.

use crate::error_analyzer;
use crate::model::{
    CommandOutcome, Diagnostic, VerificationCommand, VerificationEvidence, VerificationProfile,
};
use anyhow::Result;
use async_trait::async_trait;

/// Timeout used by [`run_profile`] when core does not provide a policy-specific
/// value. Prefer [`run_profile_with_timeout`] for policy-driven execution.
pub const DEFAULT_COMMAND_TIMEOUT_MS: u64 = 120_000;

#[async_trait]
pub trait VerificationExecutor: Send + Sync {
    async fn execute(
        &self,
        command: &VerificationCommand,
        timeout_ms: u64,
    ) -> Result<CommandOutcome>;
}

/// Run a verification profile using the default command timeout.
pub async fn run_profile(
    profile: &VerificationProfile,
    executor: &dyn VerificationExecutor,
    max_commands: u32,
) -> VerificationEvidence {
    run_profile_with_timeout(profile, executor, max_commands, DEFAULT_COMMAND_TIMEOUT_MS).await
}

/// Run profile commands sequentially and return normalized verification
/// evidence.
///
/// `max_commands` is a hard cap on executor calls. Required failures,
/// cancellation, and timeout stop further execution. Optional non-zero exits
/// are recorded and normalized but do not prevent later required commands from
/// running.
pub async fn run_profile_with_timeout(
    profile: &VerificationProfile,
    executor: &dyn VerificationExecutor,
    max_commands: u32,
    timeout_ms: u64,
) -> VerificationEvidence {
    let command_limit = (max_commands as usize).min(profile.commands.len());
    let mut outcomes = Vec::with_capacity(command_limit);
    let mut diagnostics = Vec::new();
    let mut cancelled = false;
    let mut timed_out = false;

    for command in profile.commands.iter().take(command_limit) {
        let outcome = match executor.execute(command, timeout_ms).await {
            Ok(outcome) => outcome,
            Err(error) => executor_error_outcome(command, error),
        };

        cancelled |= outcome.cancelled;
        timed_out |= outcome.timed_out;

        let failed = !outcome.succeeded();
        if failed {
            push_unique_diagnostics(
                &mut diagnostics,
                error_analyzer::normalize_outcome(&outcome),
            );
        }

        let stop_after_failure = failed && command.required;
        outcomes.push(outcome);

        if stop_after_failure || cancelled || timed_out {
            break;
        }
    }

    let all_required_succeeded = profile.commands.iter().enumerate().all(|(index, command)| {
        !command.required || outcomes.get(index).is_some_and(CommandOutcome::succeeded)
    });
    let passed = !outcomes.is_empty() && !cancelled && !timed_out && all_required_succeeded;

    VerificationEvidence {
        profile: profile.clone(),
        outcomes,
        diagnostics,
        passed,
        cancelled,
        timed_out,
    }
}

fn executor_error_outcome(command: &VerificationCommand, error: anyhow::Error) -> CommandOutcome {
    CommandOutcome {
        command: command.clone(),
        exit_code: None,
        stdout: String::new(),
        stderr: format!("verification executor error: {error:#}"),
        timed_out: false,
        cancelled: false,
        duration_ms: 0,
    }
}

fn push_unique_diagnostics(target: &mut Vec<Diagnostic>, incoming: Vec<Diagnostic>) {
    for diagnostic in incoming {
        if !target.contains(&diagnostic) {
            target.push(diagnostic);
        }
    }
}
