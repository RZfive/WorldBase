//! Deterministic coding state machine. Implemented separately from the model
//! types so core integration can test phase transitions without model calls.
//!
//! This module intentionally performs no provider, tool, or filesystem calls.
//! Core passes mutation and verification events into [`CodingState`] and uses
//! the resulting phase and stop reason to decide what to do next.

use crate::model::{CodingPhase, CodingPolicy, CodingStopReason, VerificationEvidence};
use std::collections::BTreeSet;
use std::path::PathBuf;

/// Mutable state for one coding run.
///
/// A completed run must either have no unverified mutations or have received
/// successful verification evidence. `Blocked` is the common terminal phase for
/// cancellation, unavailable verification, exhausted budgets, and repair
/// exhaustion; `stop_reason` distinguishes those outcomes.
#[derive(Debug, Clone)]
pub struct CodingState {
    pub phase: CodingPhase,
    pub repair_round: u32,
    pub mutations_since_verification: u32,
    pub verification_attempts: u32,
    pub dirty_files: BTreeSet<PathBuf>,
    pub stop_reason: Option<CodingStopReason>,
    policy: CodingPolicy,
}

impl CodingState {
    pub fn new(policy: CodingPolicy) -> Self {
        Self {
            phase: CodingPhase::Idle,
            repair_round: 0,
            mutations_since_verification: 0,
            verification_attempts: 0,
            dirty_files: BTreeSet::new(),
            stop_reason: None,
            policy,
        }
    }

    /// Start a fresh run, resetting all per-run counters and evidence.
    pub fn begin(&mut self) {
        self.phase = CodingPhase::Plan;
        self.repair_round = 0;
        self.mutations_since_verification = 0;
        self.verification_attempts = 0;
        self.dirty_files.clear();
        self.stop_reason = None;
    }

    pub fn policy(&self) -> &CodingPolicy {
        &self.policy
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self.phase, CodingPhase::Complete | CodingPhase::Blocked)
    }

    pub fn has_unverified_mutations(&self) -> bool {
        self.mutations_since_verification > 0
    }

    pub fn remaining_repair_rounds(&self) -> u32 {
        self.policy
            .max_repair_rounds
            .saturating_sub(self.repair_round)
    }

    /// Record one mutation operation. Files remain in `dirty_files` for run
    /// reporting, while repeated edits still increase the pending-mutation
    /// counter so they cannot hide behind an earlier dirty-file entry.
    pub fn record_mutation(&mut self, files: impl IntoIterator<Item = PathBuf>) {
        if self.is_terminal() {
            return;
        }

        let mut has_mutation = false;
        for file in files {
            has_mutation = true;
            self.dirty_files.insert(file);
        }

        if has_mutation {
            self.mutations_since_verification = self.mutations_since_verification.saturating_add(1);
            self.phase = CodingPhase::Edit;
        }
    }

    /// Enter the verification phase for pending mutations.
    ///
    /// Returns `false` when the run is terminal or there are no unverified
    /// mutations to verify.
    pub fn begin_verification(&mut self) -> bool {
        if self.is_terminal() || !self.has_unverified_mutations() {
            return false;
        }

        self.phase = CodingPhase::Verify;
        true
    }

    /// Record verification evidence.
    ///
    /// Cancellation and timeout take precedence over the evidence's `passed`
    /// flag. A failed verification starts a repair round while budget remains;
    /// otherwise the run is blocked with `MaxRepairRounds`.
    pub fn record_verification(&mut self, evidence: &VerificationEvidence) -> bool {
        if self.is_terminal() {
            return false;
        }

        self.verification_attempts = self.verification_attempts.saturating_add(1);
        self.phase = CodingPhase::Verify;

        if evidence.cancelled || evidence.timed_out {
            self.block(CodingStopReason::Cancelled);
            return false;
        }

        if evidence.passed {
            self.mutations_since_verification = 0;
            self.phase = CodingPhase::Complete;
            self.stop_reason = Some(CodingStopReason::VerificationPassed);
            return true;
        }

        if self.repair_round < self.policy.max_repair_rounds {
            self.repair_round += 1;
            self.phase = CodingPhase::Repair;
            self.stop_reason = None;
        } else {
            self.block(CodingStopReason::MaxRepairRounds);
        }
        false
    }

    /// Mark the run as terminal because verification could not be performed.
    pub fn mark_verification_unavailable(&mut self) {
        self.block_if_active(CodingStopReason::VerificationUnavailable);
    }

    /// Mark the run as terminally cancelled.
    pub fn cancel(&mut self) {
        self.block_if_active(CodingStopReason::Cancelled);
    }

    /// Record a timeout. The model currently has one stop reason for
    /// cancellation and timeout, so both use `Cancelled`.
    pub fn timeout(&mut self) {
        self.block_if_active(CodingStopReason::Cancelled);
    }

    /// Mark the run as terminal because a core-owned budget was exhausted.
    pub fn mark_budget_exhausted(&mut self) {
        self.block_if_active(CodingStopReason::BudgetExhausted);
    }

    /// Mark the run as terminal when the repair planner detects a repeated
    /// failure signature that another round cannot resolve.
    pub fn mark_non_recoverable(&mut self) {
        self.block_if_active(CodingStopReason::NonRecoverable);
    }

    /// Mark the run as terminal when the repair planner confirms that no
    /// further repair round is available.
    pub fn mark_repair_exhausted(&mut self) {
        self.block_if_active(CodingStopReason::MaxRepairRounds);
    }

    /// Whether this run may finish successfully.
    ///
    /// The verification gate is absolute: pending mutations can never be
    /// completed merely by disabling `CodingPolicy::require_verification`.
    /// A run with no mutations may finish without a verification attempt.
    pub fn can_finish(&self) -> bool {
        if self.phase == CodingPhase::Blocked || self.has_unverified_mutations() {
            return false;
        }

        matches!(
            self.stop_reason,
            None | Some(CodingStopReason::VerificationPassed)
        )
    }

    /// Complete a run that has no unverified mutations.
    ///
    /// Returns `false` without changing the phase when the verification gate
    /// has not been satisfied.
    pub fn finish_successfully(&mut self) -> bool {
        if !self.can_finish() {
            return false;
        }

        self.phase = CodingPhase::Complete;
        true
    }

    fn block_if_active(&mut self, reason: CodingStopReason) {
        if !self.is_terminal() {
            self.block(reason);
        }
    }

    fn block(&mut self, reason: CodingStopReason) {
        self.phase = CodingPhase::Blocked;
        self.stop_reason = Some(reason);
    }
}
