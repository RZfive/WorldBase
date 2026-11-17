//! Context budgeting, provenance, run-state ledger, checkpoints, and compaction lifecycle.

pub mod budget;
pub mod candidate;
pub mod capabilities;
pub mod checkpoint;
pub mod compaction_note;
pub mod engine;
pub mod ledger;
pub mod microcompact;
pub mod provenance;
pub mod track_b;

pub use budget::{select_recent_window, RecentWindow, TokenBudget, TokenEstimator};
pub use candidate::{
    history_version_from_messages, prompt_hash, CompactionCandidate, CompactionVersion,
    OverflowCompactionGuard, OverflowDecision,
};
pub use capabilities::{
    apply_tool_result_capability_snapshot, capability_snapshot_from_tool_result, CapabilitySnapshot,
};
pub use checkpoint::{CompactionCheckpoint, KnowledgeGap};
pub use compaction_note::{CompactionNoteState, COMPACTION_NOTE_EVIDENCE_OPEN};
pub use engine::{
    assemble_request, generate_checkpoint, load_checkpoint, persist_compaction,
    CheckpointGeneration,
};
pub use ledger::{AttemptOutcome, RunStateLedger, TrackBUpdate};
pub use microcompact::{microcompact, MicrocompactOptions, MicrocompactReport};
pub use provenance::{MessageProvenance, UserAnchor, UserAnchors};
pub use track_b::{
    TrackBExtractionInput, TrackBExtractionOutcome, TrackBExtractionSource, TrackBExtractor,
};
