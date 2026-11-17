//! Versioned background compaction candidates and overflow latch state.
//!
//! This module is deliberately pure: it does not spawn tasks or perform I/O. The
//! agent loop owns the single background task represented by
//! [`CandidateManager::begin_background`]. Keeping the lifecycle here makes the
//! "at most one candidate/task" invariant testable without a provider or runtime.

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use worldbase_protocol::types::ChatMessage;

/// Background precomputation starts once usage reaches this percentage.
pub const BACKGROUND_COMPACTION_MIN_PERCENT: usize = 60;
/// Background precomputation is only considered while usage is in this band.
pub const BACKGROUND_COMPACTION_MAX_PERCENT: usize = 65;
/// A ready candidate may only replace the live context at or above this usage.
pub const FORMAL_COMPACTION_MIN_PERCENT: usize = 80;

/// Identity of every input that a compaction candidate was derived from.
///
/// Any field changing invalidates a previously computed candidate. Provider
/// identity and auth owner are strings so callers can use stable provider entry
/// IDs/account identifiers. Do not put raw API keys or other credentials here;
/// use a stable owner identifier or credential fingerprint instead.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompactionVersion {
    pub history_version: u64,
    pub model_slug: String,
    pub prompt_hash: String,
    pub tool_catalog_version: u64,
    pub provider_identity: String,
    pub auth_owner: String,
}

impl CompactionVersion {
    pub fn new(
        history_version: u64,
        model_slug: impl Into<String>,
        prompt_hash: impl Into<String>,
        tool_catalog_version: u64,
        provider_identity: impl Into<String>,
        auth_owner: impl Into<String>,
    ) -> Self {
        Self {
            history_version,
            model_slug: model_slug.into(),
            prompt_hash: prompt_hash.into(),
            tool_catalog_version,
            provider_identity: provider_identity.into(),
            auth_owner: auth_owner.into(),
        }
    }

    /// Return the first component that differs from `current`.
    ///
    /// The ordering is stable so callers and tests can surface a deterministic
    /// invalidation reason.
    pub fn first_mismatch(&self, current: &Self) -> Option<VersionMismatch> {
        if self.history_version != current.history_version {
            return Some(VersionMismatch::HistoryVersion {
                candidate: self.history_version,
                current: current.history_version,
            });
        }
        if self.model_slug != current.model_slug {
            return Some(VersionMismatch::ModelSlug {
                candidate: self.model_slug.clone(),
                current: current.model_slug.clone(),
            });
        }
        if self.prompt_hash != current.prompt_hash {
            return Some(VersionMismatch::PromptHash {
                candidate: self.prompt_hash.clone(),
                current: current.prompt_hash.clone(),
            });
        }
        if self.tool_catalog_version != current.tool_catalog_version {
            return Some(VersionMismatch::ToolCatalogVersion {
                candidate: self.tool_catalog_version,
                current: current.tool_catalog_version,
            });
        }
        if self.provider_identity != current.provider_identity {
            return Some(VersionMismatch::ProviderIdentity {
                candidate: self.provider_identity.clone(),
                current: current.provider_identity.clone(),
            });
        }
        if self.auth_owner != current.auth_owner {
            return Some(VersionMismatch::AuthOwner {
                candidate: self.auth_owner.clone(),
                current: current.auth_owner.clone(),
            });
        }
        None
    }

    pub fn matches(&self, current: &Self) -> bool {
        self.first_mismatch(current).is_none()
    }
}

/// The exact version input that invalidated a candidate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VersionMismatch {
    HistoryVersion { candidate: u64, current: u64 },
    ModelSlug { candidate: String, current: String },
    PromptHash { candidate: String, current: String },
    ToolCatalogVersion { candidate: u64, current: u64 },
    ProviderIdentity { candidate: String, current: String },
    AuthOwner { candidate: String, current: String },
}

impl fmt::Display for VersionMismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::HistoryVersion { candidate, current } => {
                write!(f, "history version changed ({candidate} -> {current})")
            }
            Self::ModelSlug { candidate, current } => {
                write!(f, "model changed ({candidate} -> {current})")
            }
            Self::PromptHash { candidate, current } => {
                write!(
                    f,
                    "prompt/compaction hash changed ({candidate} -> {current})"
                )
            }
            Self::ToolCatalogVersion { candidate, current } => {
                write!(f, "tool catalog version changed ({candidate} -> {current})")
            }
            Self::ProviderIdentity { candidate, current } => {
                write!(f, "provider identity changed ({candidate} -> {current})")
            }
            Self::AuthOwner { candidate, current } => {
                write!(f, "auth owner changed ({candidate} -> {current})")
            }
        }
    }
}

impl std::error::Error for VersionMismatch {}

/// A completed background compaction result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompactionCandidate {
    /// Monotonic creation order assigned before the background work starts.
    pub creation_sequence: u64,
    pub version: CompactionVersion,
    /// Human/model-readable summary payload.
    pub summary: String,
    /// Optional structured checkpoint payload. It is kept opaque here so this
    /// helper can integrate before/after the checkpoint schema module lands.
    pub checkpoint: Option<Value>,
    pub before_tokens: usize,
    pub after_tokens: usize,
}

impl CompactionCandidate {
    pub fn new(
        creation_sequence: u64,
        version: CompactionVersion,
        summary: impl Into<String>,
        checkpoint: Option<Value>,
        before_tokens: usize,
        after_tokens: usize,
    ) -> Self {
        Self {
            creation_sequence,
            version,
            summary: summary.into(),
            checkpoint,
            before_tokens,
            after_tokens,
        }
    }
}

/// A reservation returned when background work may start.
///
/// The caller must finish it with [`CandidateManager::complete_background`] or
/// release it with [`CandidateManager::abandon_background`]. While reserved, no
/// second background task can be started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackgroundCandidateTicket {
    pub sequence: u64,
    pub version: CompactionVersion,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct InFlightCandidate {
    sequence: u64,
    version: CompactionVersion,
}

/// Errors from storing/adopting a candidate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CandidateError {
    VersionMismatch(VersionMismatch),
    OutOfOrder {
        candidate_sequence: u64,
        latest_sequence: u64,
    },
    CandidateAlreadyPresent {
        sequence: u64,
    },
    NoCandidate,
    NoBackgroundCandidateInFlight,
    InvalidSequence,
}

impl CandidateError {
    pub fn version_mismatch(&self) -> Option<&VersionMismatch> {
        match self {
            Self::VersionMismatch(reason) => Some(reason),
            _ => None,
        }
    }
}

impl fmt::Display for CandidateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::VersionMismatch(reason) => write!(f, "candidate is stale: {reason}"),
            Self::OutOfOrder {
                candidate_sequence,
                latest_sequence,
            } => write!(
                f,
                "candidate sequence {candidate_sequence} is not newer than {latest_sequence}"
            ),
            Self::CandidateAlreadyPresent { sequence } => {
                write!(f, "candidate sequence {sequence} is already ready")
            }
            Self::NoCandidate => f.write_str("no compaction candidate is ready"),
            Self::NoBackgroundCandidateInFlight => {
                f.write_str("no background compaction candidate is in flight")
            }
            Self::InvalidSequence => f.write_str("candidate creation sequence must be non-zero"),
        }
    }
}

impl std::error::Error for CandidateError {}

/// Owns the single background candidate slot and its version checks.
#[derive(Debug, Clone)]
pub struct CandidateManager {
    current_version: CompactionVersion,
    candidate: Option<CompactionCandidate>,
    in_flight: Option<InFlightCandidate>,
    last_allocated_sequence: u64,
    last_adopted_sequence: u64,
}

impl CandidateManager {
    pub fn new(current_version: CompactionVersion) -> Self {
        Self {
            current_version,
            candidate: None,
            in_flight: None,
            last_allocated_sequence: 0,
            last_adopted_sequence: 0,
        }
    }

    pub fn current_version(&self) -> &CompactionVersion {
        &self.current_version
    }

    /// Update the live version and discard a ready candidate that no longer
    /// matches. An already-running task is not cancelled; its result will be
    /// rejected on completion because it still occupies the single slot.
    pub fn set_current_version(
        &mut self,
        current_version: CompactionVersion,
    ) -> Option<VersionMismatch> {
        self.current_version = current_version;
        self.discard_stale()
    }

    /// Background work is eligible only in the 60–65% band and when there is no
    /// valid ready candidate or in-flight task. Stale ready candidates do not
    /// block a replacement, but their old task slot is never duplicated.
    pub fn should_start_background(&self, estimated_input_tokens: usize, budget: usize) -> bool {
        if self.in_flight.is_some() {
            return false;
        }
        if self.candidate.as_ref().is_some_and(|candidate| {
            candidate.creation_sequence > self.last_adopted_sequence
                && candidate.version.matches(&self.current_version)
        }) {
            return false;
        }
        at_least_percent(
            estimated_input_tokens,
            budget,
            BACKGROUND_COMPACTION_MIN_PERCENT,
        ) && at_most_percent(
            estimated_input_tokens,
            budget,
            BACKGROUND_COMPACTION_MAX_PERCENT,
        )
    }

    /// Formal swap is allowed from 80% upward. Candidate availability and
    /// version matching are checked separately by [`Self::adopt_candidate`].
    pub fn should_formal_swap(&self, estimated_input_tokens: usize, budget: usize) -> bool {
        at_least_percent(
            estimated_input_tokens,
            budget,
            FORMAL_COMPACTION_MIN_PERCENT,
        )
    }

    /// Reserve the only background task slot and allocate its creation
    /// sequence. Returns `None` outside the background band or when a valid
    /// candidate/task already occupies the slot.
    pub fn begin_background(
        &mut self,
        estimated_input_tokens: usize,
        budget: usize,
    ) -> Option<BackgroundCandidateTicket> {
        if !self.should_start_background(estimated_input_tokens, budget) {
            return None;
        }
        self.last_allocated_sequence = self.last_allocated_sequence.saturating_add(1).max(1);
        let ticket = BackgroundCandidateTicket {
            sequence: self.last_allocated_sequence,
            version: self.current_version.clone(),
        };
        self.in_flight = Some(InFlightCandidate {
            sequence: ticket.sequence,
            version: ticket.version.clone(),
        });
        Some(ticket)
    }

    /// Release a reservation after a failed/cancelled background task.
    pub fn abandon_background(&mut self, sequence: u64) -> bool {
        if self
            .in_flight
            .as_ref()
            .is_some_and(|candidate| candidate.sequence == sequence)
        {
            self.in_flight = None;
            true
        } else {
            false
        }
    }

    /// Store a candidate produced for an existing reservation.
    pub fn complete_background(
        &mut self,
        candidate: CompactionCandidate,
    ) -> Result<(), CandidateError> {
        let reservation = self
            .in_flight
            .take()
            .ok_or(CandidateError::NoBackgroundCandidateInFlight)?;

        if candidate.creation_sequence != reservation.sequence {
            return Err(CandidateError::OutOfOrder {
                candidate_sequence: candidate.creation_sequence,
                latest_sequence: reservation.sequence,
            });
        }
        if let Some(reason) = candidate.version.first_mismatch(&reservation.version) {
            return Err(CandidateError::VersionMismatch(reason));
        }
        self.install_ready(candidate)
    }

    /// Store a candidate directly. Primarily useful for harness/integration code
    /// that already serializes background work. A reserved task must be
    /// completed or abandoned before direct installation.
    pub fn install_candidate(
        &mut self,
        candidate: CompactionCandidate,
    ) -> Result<(), CandidateError> {
        if let Some(in_flight) = &self.in_flight {
            return Err(CandidateError::OutOfOrder {
                candidate_sequence: candidate.creation_sequence,
                latest_sequence: in_flight.sequence,
            });
        }
        self.install_ready(candidate)
    }

    fn install_ready(&mut self, candidate: CompactionCandidate) -> Result<(), CandidateError> {
        if candidate.creation_sequence == 0 {
            return Err(CandidateError::InvalidSequence);
        }
        if let Some(reason) = candidate.version.first_mismatch(&self.current_version) {
            return Err(CandidateError::VersionMismatch(reason));
        }

        if let Some(existing) = &self.candidate {
            if candidate.creation_sequence <= existing.creation_sequence {
                return Err(CandidateError::OutOfOrder {
                    candidate_sequence: candidate.creation_sequence,
                    latest_sequence: existing.creation_sequence,
                });
            }
            if existing.version.matches(&self.current_version) {
                return Err(CandidateError::CandidateAlreadyPresent {
                    sequence: existing.creation_sequence,
                });
            }
        }

        let latest_sequence = self
            .last_adopted_sequence
            .max(candidate.creation_sequence.saturating_sub(1));
        if candidate.creation_sequence <= self.last_adopted_sequence {
            return Err(CandidateError::OutOfOrder {
                candidate_sequence: candidate.creation_sequence,
                latest_sequence,
            });
        }

        self.last_allocated_sequence = self
            .last_allocated_sequence
            .max(candidate.creation_sequence);
        self.candidate = Some(candidate);
        Ok(())
    }

    /// Adopt the ready candidate only after every version component still
    /// matches. A stale candidate is removed before the mismatch is returned.
    pub fn adopt_candidate(&mut self) -> Result<CompactionCandidate, CandidateError> {
        let candidate = self.candidate.take().ok_or(CandidateError::NoCandidate)?;

        if candidate.creation_sequence <= self.last_adopted_sequence {
            return Err(CandidateError::OutOfOrder {
                candidate_sequence: candidate.creation_sequence,
                latest_sequence: self.last_adopted_sequence,
            });
        }
        if let Some(reason) = candidate.version.first_mismatch(&self.current_version) {
            return Err(CandidateError::VersionMismatch(reason));
        }

        self.last_adopted_sequence = candidate.creation_sequence;
        Ok(candidate)
    }

    /// Drop a ready candidate whose stored version differs from the live one.
    pub fn discard_stale(&mut self) -> Option<VersionMismatch> {
        let reason = self
            .candidate
            .as_ref()
            .and_then(|candidate| candidate.version.first_mismatch(&self.current_version))?;
        self.candidate = None;
        Some(reason)
    }

    pub fn candidate(&self) -> Option<&CompactionCandidate> {
        self.candidate.as_ref()
    }

    pub fn in_flight_sequence(&self) -> Option<u64> {
        self.in_flight.as_ref().map(|candidate| candidate.sequence)
    }

    pub fn last_adopted_sequence(&self) -> u64 {
        self.last_adopted_sequence
    }
}

/// Per-logical-step emergency compaction decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverflowCompactionDecision {
    /// Perform exactly one emergency compaction and retry the same request.
    EmergencyCompaction,
    /// The same logical step overflowed again after the one allowed retry.
    Terminate,
}

/// Backwards-compatible short name for [`OverflowCompactionDecision`].
pub type OverflowDecision = OverflowCompactionDecision;

/// Allows at most one emergency compaction per logical step/turn.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OverflowCompactionGuard {
    logical_step: Option<u64>,
    emergency_used: bool,
}

impl OverflowCompactionGuard {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record an overflow and return the action for the current logical step.
    /// A different step resets the allowance.
    pub fn on_overflow(&mut self, logical_step: u64) -> OverflowDecision {
        if self.logical_step != Some(logical_step) {
            self.logical_step = Some(logical_step);
            self.emergency_used = false;
        }

        if self.emergency_used {
            OverflowDecision::Terminate
        } else {
            self.emergency_used = true;
            OverflowDecision::EmergencyCompaction
        }
    }

    /// Alias used by call sites that describe this as recording an overflow.
    pub fn record_overflow(&mut self, logical_step: u64) -> OverflowCompactionDecision {
        self.on_overflow(logical_step)
    }

    pub fn current_step(&self) -> Option<u64> {
        self.logical_step
    }

    pub fn reset(&mut self) {
        self.logical_step = None;
        self.emergency_used = false;
    }
}

/// Stable SHA-256 hex digest for arbitrary identity bytes.
pub fn stable_sha256(input: impl AsRef<[u8]>) -> String {
    hex_digest(&Sha256::digest(input.as_ref()))
}

/// Stable SHA-256 over a serialized value.
///
/// `serde_json` without `preserve_order` uses ordered maps, so equivalent JSON
/// object values serialize deterministically regardless of insertion order.
pub fn stable_json_sha256<T: Serialize + ?Sized>(value: &T) -> Result<String, serde_json::Error> {
    let bytes = serde_json::to_vec(value)?;
    Ok(domain_sha256(b"worldbase-json-v1\0", &[&bytes]))
}

/// Hash used for prompt/compaction-template identity.
pub fn prompt_hash(prompt: &str) -> String {
    domain_sha256(b"worldbase-prompt-v1\0", &[prompt.as_bytes()])
}

/// Hash used for tool-catalog identity. Generic so both protocol and test
/// catalog representations can be hashed.
pub fn tool_catalog_hash<T: Serialize + ?Sized>(catalog: &T) -> Result<String, serde_json::Error> {
    let bytes = serde_json::to_vec(catalog)?;
    Ok(domain_sha256(b"worldbase-tool-catalog-v1\0", &[&bytes]))
}

/// Hash used for stable normalized tool-argument identity.
pub fn args_hash(args: &Value) -> Result<String, serde_json::Error> {
    let bytes = serde_json::to_vec(args)?;
    Ok(domain_sha256(b"worldbase-tool-args-v1\0", &[&bytes]))
}

/// Derive the u64 `history_version` field from persisted `ChatMessage` values.
///
/// Every message is hashed by its full serialized identity: database ID, role,
/// text, multimodal parts, tool calls/results and timestamp. Message count and
/// byte lengths are included as boundaries. IDs are not interpreted as
/// contiguous, so a legitimate ID gap does not alter the version, while adding
/// or editing any persisted message does.
pub fn history_version_from_messages(messages: &[ChatMessage]) -> u64 {
    let mut hasher = Sha256::new();
    hasher.update(b"worldbase-chat-history-v1\0");
    hasher.update((messages.len() as u64).to_be_bytes());
    for message in messages {
        // ChatMessage is a plain protocol DTO and serialization cannot fail for
        // its string/integer/JSON fields. Keep an explicit expectation so a
        // future non-serializable field cannot silently produce collisions.
        let bytes = serde_json::to_vec(message)
            .expect("ChatMessage must remain JSON-serializable for history hashing");
        hasher.update((bytes.len() as u64).to_be_bytes());
        hasher.update(bytes);
    }
    digest_u64(&hasher.finalize())
}

/// Derive a stable u64 version from any serializable catalog/configuration.
pub fn stable_json_version<T: Serialize + ?Sized>(value: &T) -> Result<u64, serde_json::Error> {
    let bytes = serde_json::to_vec(value)?;
    let digest = Sha256::digest(&bytes);
    Ok(digest_u64(&digest))
}

fn at_least_percent(value: usize, budget: usize, percent: usize) -> bool {
    budget > 0 && (value as u128) * 100 >= (budget as u128) * (percent as u128)
}

fn at_most_percent(value: usize, budget: usize, percent: usize) -> bool {
    budget > 0 && (value as u128) * 100 <= (budget as u128) * (percent as u128)
}

fn domain_sha256(domain: &[u8], parts: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    for part in parts {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part);
    }
    hex_digest(&hasher.finalize())
}

fn digest_u64(digest: &[u8]) -> u64 {
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&digest[..8]);
    u64::from_be_bytes(bytes)
}

fn hex_digest(digest: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut out, "{byte:02x}").expect("writing to String cannot fail");
    }
    out
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;
    use worldbase_protocol::types::Role;

    use super::*;

    fn version() -> CompactionVersion {
        CompactionVersion::new(
            41,
            "model-a",
            prompt_hash("compaction prompt"),
            7,
            "provider-entry-a",
            "account-a",
        )
    }

    fn candidate(sequence: u64, version: CompactionVersion) -> CompactionCandidate {
        CompactionCandidate::new(
            sequence,
            version,
            "summary",
            Some(json!({"objective": "ship"})),
            600,
            120,
        )
    }

    fn message(id: i64, content: &str) -> ChatMessage {
        ChatMessage {
            id,
            role: Role::User,
            content: content.into(),
            parts: Vec::new(),
            tool_calls: Vec::new(),
            tool_results: Vec::new(),
            created_at: None,
        }
    }

    #[test]
    fn history_version_tracks_content_and_ids_without_assuming_contiguous_ids() {
        let mut messages = vec![message(1, "first"), message(10, "second")];
        let initial = history_version_from_messages(&messages);
        assert_eq!(initial, history_version_from_messages(&messages));

        messages.push(message(42, "third"));
        let with_new_message = history_version_from_messages(&messages);
        assert_ne!(initial, with_new_message);

        messages[1].content = "second edited".into();
        assert_ne!(
            with_new_message,
            history_version_from_messages(&messages),
            "content edits must invalidate a candidate"
        );
        assert_eq!(
            history_version_from_messages(&[message(1, "a"), message(10, "b")]),
            history_version_from_messages(&[message(1, "a"), message(10, "b")])
        );
    }

    #[test]
    fn stable_hashes_are_deterministic_and_domain_separated() {
        let args_a = json!({"path": "a", "options": {"z": 2, "a": 1}});
        let args_b = json!({"options": {"a": 1, "z": 2}, "path": "a"});
        assert_eq!(args_hash(&args_a).unwrap(), args_hash(&args_b).unwrap());
        assert_eq!(prompt_hash("same"), prompt_hash("same"));
        assert_ne!(prompt_hash("same"), stable_sha256("same"));

        let catalog_a = vec!["read", "write"];
        let catalog_b = vec!["write", "read"];
        assert_ne!(
            tool_catalog_hash(&catalog_a).unwrap(),
            tool_catalog_hash(&catalog_b).unwrap()
        );
        assert_eq!(
            stable_json_version(&catalog_a).unwrap(),
            stable_json_version(&catalog_a).unwrap()
        );
    }

    #[test]
    fn thresholds_cover_background_band_and_formal_swap_floor() {
        let manager = CandidateManager::new(version());
        assert!(!manager.should_start_background(599, 1_000));
        assert!(manager.should_start_background(600, 1_000));
        assert!(manager.should_start_background(650, 1_000));
        assert!(!manager.should_start_background(651, 1_000));
        assert!(!manager.should_formal_swap(799, 1_000));
        assert!(manager.should_formal_swap(800, 1_000));
        assert!(manager.should_formal_swap(850, 1_000));
        assert!(!manager.should_start_background(600, 0));
        assert!(!manager.should_formal_swap(800, 0));
    }

    #[test]
    fn stale_candidate_is_discarded_for_every_version_component() {
        let mutations: Vec<(CompactionVersion, fn(&VersionMismatch) -> bool)> = vec![
            (
                {
                    let mut changed = version();
                    changed.history_version += 1;
                    changed
                },
                |reason| matches!(reason, VersionMismatch::HistoryVersion { .. }),
            ),
            (
                {
                    let mut changed = version();
                    changed.model_slug = "model-b".into();
                    changed
                },
                |reason| matches!(reason, VersionMismatch::ModelSlug { .. }),
            ),
            (
                {
                    let mut changed = version();
                    changed.prompt_hash = prompt_hash("new prompt");
                    changed
                },
                |reason| matches!(reason, VersionMismatch::PromptHash { .. }),
            ),
            (
                {
                    let mut changed = version();
                    changed.tool_catalog_version += 1;
                    changed
                },
                |reason| matches!(reason, VersionMismatch::ToolCatalogVersion { .. }),
            ),
            (
                {
                    let mut changed = version();
                    changed.provider_identity = "provider-entry-b".into();
                    changed
                },
                |reason| matches!(reason, VersionMismatch::ProviderIdentity { .. }),
            ),
            (
                {
                    let mut changed = version();
                    changed.auth_owner = "account-b".into();
                    changed
                },
                |reason| matches!(reason, VersionMismatch::AuthOwner { .. }),
            ),
        ];

        for (changed, is_expected) in mutations {
            let mut manager = CandidateManager::new(version());
            manager
                .install_candidate(candidate(1, version()))
                .expect("fresh candidate should be accepted");
            let mismatch = manager
                .set_current_version(changed)
                .expect("version change should invalidate candidate");
            assert!(is_expected(&mismatch));
            assert!(manager.candidate().is_none());
        }
    }

    #[test]
    fn ready_candidate_blocks_background_start_and_slot_holds_one_candidate() {
        let mut manager = CandidateManager::new(version());
        manager
            .install_candidate(candidate(1, version()))
            .expect("first candidate");

        assert!(!manager.should_start_background(600, 1_000));
        let error = manager
            .install_candidate(candidate(2, version()))
            .expect_err("a second ready candidate must not be queued");
        assert_eq!(
            error,
            CandidateError::CandidateAlreadyPresent { sequence: 1 }
        );
        assert_eq!(manager.candidate().unwrap().creation_sequence, 1);
    }

    #[test]
    fn background_reservation_is_single_flight_and_releasable() {
        let mut manager = CandidateManager::new(version());
        let ticket = manager
            .begin_background(620, 1_000)
            .expect("in-band background work should reserve the slot");
        assert_eq!(ticket.sequence, 1);
        assert_eq!(manager.in_flight_sequence(), Some(1));
        assert!(manager.begin_background(620, 1_000).is_none());
        assert!(manager.should_start_background(620, 1_000) == false);

        assert!(manager.abandon_background(ticket.sequence));
        assert!(manager.begin_background(620, 1_000).is_some());
    }

    #[test]
    fn completing_reserved_candidate_checks_ticket_order_and_version() {
        let mut manager = CandidateManager::new(version());
        let ticket = manager.begin_background(620, 1_000).unwrap();
        manager
            .complete_background(candidate(ticket.sequence, ticket.version.clone()))
            .expect("matching reservation should complete");
        assert_eq!(manager.candidate().unwrap().creation_sequence, 1);

        let mut manager = CandidateManager::new(version());
        let _ticket = manager.begin_background(620, 1_000).unwrap();
        let error = manager
            .complete_background(candidate(99, version()))
            .expect_err("out-of-order background result must fail");
        assert!(matches!(error, CandidateError::OutOfOrder { .. }));
        assert!(manager.in_flight_sequence().is_none());
    }

    #[test]
    fn adoption_rejects_older_sequence_after_newer_candidate() {
        let mut manager = CandidateManager::new(version());
        manager.install_candidate(candidate(2, version())).unwrap();
        let adopted = manager.adopt_candidate().unwrap();
        assert_eq!(adopted.creation_sequence, 2);

        let error = manager
            .install_candidate(candidate(1, version()))
            .expect_err("older candidate must be rejected");
        assert_eq!(
            error,
            CandidateError::OutOfOrder {
                candidate_sequence: 1,
                latest_sequence: 2,
            }
        );
    }

    #[test]
    fn stale_candidate_is_rejected_on_adoption() {
        let mut manager = CandidateManager::new(version());
        manager.install_candidate(candidate(1, version())).unwrap();
        manager.current_version.model_slug = "model-b".into();

        let error = manager
            .adopt_candidate()
            .expect_err("stale candidate must not be adopted");
        assert!(matches!(
            error,
            CandidateError::VersionMismatch(VersionMismatch::ModelSlug { .. })
        ));
        assert!(manager.candidate().is_none());
    }

    #[test]
    fn overflow_allows_one_compaction_per_logical_step() {
        let mut guard = OverflowCompactionGuard::new();
        assert_eq!(guard.on_overflow(7), OverflowDecision::EmergencyCompaction);
        assert_eq!(guard.on_overflow(7), OverflowDecision::Terminate);
        assert_eq!(
            guard.record_overflow(7),
            OverflowDecision::Terminate,
            "the guard must never grant a third attempt"
        );

        assert_eq!(
            guard.on_overflow(8),
            OverflowDecision::EmergencyCompaction,
            "a new logical step resets the allowance"
        );
        assert_eq!(guard.on_overflow(8), OverflowDecision::Terminate);
    }

    #[test]
    fn empty_catalog_version_is_stable() {
        let empty: BTreeMap<String, String> = BTreeMap::new();
        assert_eq!(
            stable_json_version(&empty).unwrap(),
            stable_json_version(&empty).unwrap()
        );
    }
}
