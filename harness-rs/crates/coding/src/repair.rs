//! Pure repair planning for the coding verification loop.
//!
//! The planner never executes commands or edits files. It turns a
//! [`DiagnosisReport`] plus prior failure signatures into a deterministic
//! decision about whether another repair round is worthwhile.

use crate::error_analyzer::DiagnosisReport;
use crate::model::CodingPolicy;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RepairStopReason {
    VerificationPassed,
    MaxRepairRounds,
    RepeatedFailure,
    NoRepairableIssue,
    BudgetExhausted,
    VerificationUnavailable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairPlan {
    pub should_retry: bool,
    pub stop_reason: Option<RepairStopReason>,
    /// One-based repair round being planned.
    pub round: u32,
    pub signature: String,
    pub targeted_files: Vec<PathBuf>,
    pub instructions: Vec<String>,
}

/// Decide whether to attempt another repair round.
///
/// Check order follows the policy contract: no repairable issue, repeated
/// failure, then exhausted rounds. A failure signature seen in the immediate
/// previous round also counts as repeated, which prevents a same-failure loop
/// even when the signature only appears once in history.
pub fn plan_repair(
    report: &DiagnosisReport,
    previous_signatures: &[String],
    attempt: u32,
    policy: &CodingPolicy,
) -> RepairPlan {
    let round = attempt.saturating_add(1);

    if !report.has_repairable_issues {
        return stopped(report, round, RepairStopReason::NoRepairableIssue);
    }
    if is_repeated_failure(&report.failure_signature, previous_signatures) {
        return stopped(report, round, RepairStopReason::RepeatedFailure);
    }
    if attempt >= policy.max_repair_rounds {
        return stopped(report, round, RepairStopReason::MaxRepairRounds);
    }

    RepairPlan {
        should_retry: true,
        stop_reason: None,
        round,
        signature: report.failure_signature.clone(),
        targeted_files: targeted_files(report),
        instructions: report.repair_instructions.clone(),
    }
}

fn stopped(report: &DiagnosisReport, round: u32, reason: RepairStopReason) -> RepairPlan {
    RepairPlan {
        should_retry: false,
        stop_reason: Some(reason),
        round,
        signature: report.failure_signature.clone(),
        targeted_files: Vec::new(),
        instructions: Vec::new(),
    }
}

fn is_repeated_failure(signature: &str, previous_signatures: &[String]) -> bool {
    let immediate_repeat = previous_signatures
        .last()
        .is_some_and(|previous| previous == signature);
    let seen_twice = previous_signatures
        .iter()
        .filter(|previous| previous.as_str() == signature)
        .count()
        >= 2;
    let trailing_duplicate = previous_signatures.len() >= 2
        && previous_signatures[previous_signatures.len() - 1]
            == previous_signatures[previous_signatures.len() - 2];

    immediate_repeat || seen_twice || trailing_duplicate
}

/// Files from the highest-priority matches first, then any remaining files
/// reported by the diagnosis. Duplicates are removed deterministically.
fn targeted_files(report: &DiagnosisReport) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut files = Vec::new();

    for pattern_match in &report.matches {
        for file in &pattern_match.files {
            if seen.insert(file.clone()) {
                files.push(file.clone());
            }
        }
    }
    for file in &report.affected_files {
        if seen.insert(file.clone()) {
            files.push(file.clone());
        }
    }

    files
}
