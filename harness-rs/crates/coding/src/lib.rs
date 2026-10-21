//! Coding-specific policy and analysis for the Rust harness.
//!
//! This crate intentionally does not depend on `worldbase-core`. The core owns
//! provider calls, tool execution, permissions, cancellation, and stream
//! events. This crate owns deterministic coding policy, project verification
//! profiles, diagnostics, and state transitions so those rules can be tested
//! without starting an Agent run.

pub mod budget;
pub mod error_analyzer;
pub mod evidence;
pub mod model;
pub mod repair;
pub mod smart_editor;
pub mod state;
pub mod verification;
pub mod verification_runner;

pub use budget::CodingBudget;
pub use error_analyzer::{
    analyze_diagnostics, analyze_outcomes, normalize_outcome, DiagnosisReport, ErrorCategory,
    ErrorPattern, PatternMatch,
};
pub use evidence::verification_evidence_from_value;
pub use model::{
    CodingPhase, CodingPolicy, CodingStopReason, CommandOutcome, Diagnostic, DiagnosticSeverity,
    PackageManager, ProjectKind, VerificationCheckKind, VerificationCommand, VerificationEvidence,
    VerificationProfile,
};
pub use repair::{plan_repair, RepairPlan, RepairStopReason};
pub use state::CodingState;
pub use verification::detect_profile;
