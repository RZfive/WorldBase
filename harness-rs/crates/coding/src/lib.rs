//! Coding-specific policy and analysis for the Rust harness.
//!
//! This crate intentionally does not depend on `worldbase-core`. The core owns
//! provider calls, tool execution, permissions, cancellation, and stream
//! events. This crate owns deterministic coding policy, project verification
//! profiles, diagnostics, and state transitions so those rules can be tested
//! without starting an Agent run.

pub mod budget;
pub mod dependency;
pub mod error_analyzer;
pub mod evidence;
pub mod lsp;
pub mod lsp_client;
pub mod model;
pub mod planner;
pub mod repair;
pub mod smart_editor;
pub mod state;
pub mod verification;
pub mod verification_runner;

pub use budget::CodingBudget;
pub use dependency::{
    analyze_dependency_diagnostics, analyze_package_manager_output, detect_package_manager,
    parse_package_manifest, DependencyFix, DependencyFixAction, DependencyIssue,
    DependencyIssueKind, DependencyKind, DependencyReport, PackageManifest,
};
pub use error_analyzer::{
    analyze_diagnostics, analyze_outcomes, normalize_outcome, DiagnosisReport, ErrorCategory,
    ErrorPattern, PatternMatch,
};
pub use evidence::verification_evidence_from_value;
pub use lsp::{
    analyze_lsp_diagnostics, diagnostic_from_lsp, file_uri_to_path, merge_lsp_diagnostics,
    parse_definition_response, parse_document_symbols, parse_hover, parse_publish_diagnostics,
    parse_symbol_information, path_to_file_uri, LspDiagnostic, LspDocumentSymbol, LspHover,
    LspLocation, LspPosition, LspRange, LspSymbolInformation, LspSymbolKind,
    PublishDiagnosticsParams,
};
pub use model::{
    CodingPhase, CodingPolicy, CodingStopReason, CommandOutcome, Diagnostic, DiagnosticSeverity,
    PackageManager, ProjectKind, VerificationCheckKind, VerificationCommand, VerificationEvidence,
    VerificationProfile,
};
pub use planner::{plan_write_batches, PlannedWrite, WriteBatch};
pub use repair::{plan_repair, RepairPlan, RepairStopReason};
pub use state::CodingState;
pub use verification::{detect_profile, select_minimal_profile};
