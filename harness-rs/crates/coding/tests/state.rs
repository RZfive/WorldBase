use std::path::PathBuf;

use worldbase_coding::state::CodingState;
use worldbase_coding::{
    CodingPhase, CodingPolicy, CodingStopReason, CommandOutcome, PackageManager, ProjectKind,
    VerificationCheckKind, VerificationCommand, VerificationEvidence, VerificationProfile,
};

fn policy(max_repair_rounds: u32) -> CodingPolicy {
    CodingPolicy {
        enabled: true,
        require_verification: true,
        max_repair_rounds,
        ..CodingPolicy::default()
    }
}

fn evidence(passed: bool, cancelled: bool, timed_out: bool) -> VerificationEvidence {
    let command = VerificationCommand {
        kind: VerificationCheckKind::Test,
        program: "npm".to_string(),
        args: vec!["run".to_string(), "test".to_string()],
        required: true,
        description: "Run tests".to_string(),
    };
    let outcome = CommandOutcome {
        command: command.clone(),
        exit_code: if cancelled || timed_out {
            None
        } else {
            Some(if passed { 0 } else { 1 })
        },
        stdout: String::new(),
        stderr: if passed {
            String::new()
        } else {
            "test failure".to_string()
        },
        timed_out,
        cancelled,
        duration_ms: 10,
    };
    let profile = VerificationProfile {
        project_kind: ProjectKind::FrontendNode,
        package_manager: Some(PackageManager::Npm),
        root: PathBuf::from("/workspace"),
        commands: vec![command],
        source: "test fixture".to_string(),
    };

    VerificationEvidence {
        profile,
        outcomes: vec![outcome],
        diagnostics: Vec::new(),
        passed,
        cancelled,
        timed_out,
    }
}

#[test]
fn successful_verification_completes_the_run() {
    let mut state = CodingState::new(policy(2));
    state.begin();
    state.record_mutation([PathBuf::from("src/lib.rs")]);

    assert_eq!(state.phase, CodingPhase::Edit);
    assert_eq!(state.mutations_since_verification, 1);
    assert!(!state.can_finish());
    assert!(state.begin_verification());
    assert_eq!(state.phase, CodingPhase::Verify);

    assert!(state.record_verification(&evidence(true, false, false)));
    assert_eq!(state.phase, CodingPhase::Complete);
    assert_eq!(
        state.stop_reason,
        Some(CodingStopReason::VerificationPassed)
    );
    assert_eq!(state.verification_attempts, 1);
    assert_eq!(state.mutations_since_verification, 0);
    assert_eq!(state.dirty_files.len(), 1);
    assert!(state.can_finish());
}

#[test]
fn unverified_mutation_cannot_complete_even_if_policy_disables_verification() {
    let mut guarded_policy = policy(2);
    guarded_policy.require_verification = false;
    let mut state = CodingState::new(guarded_policy);

    state.begin();
    state.record_mutation([PathBuf::from("src/main.rs")]);

    assert!(!state.finish_successfully());
    assert_eq!(state.phase, CodingPhase::Edit);
    assert_eq!(state.mutations_since_verification, 1);
    assert_eq!(state.stop_reason, None);
    assert!(!state.can_finish());
}

#[test]
fn failed_verification_starts_a_repair_round_then_success_completes() {
    let mut state = CodingState::new(policy(2));
    state.begin();
    state.record_mutation([PathBuf::from("src/lib.rs")]);

    assert!(!state.record_verification(&evidence(false, false, false)));
    assert_eq!(state.phase, CodingPhase::Repair);
    assert_eq!(state.repair_round, 1);
    assert_eq!(state.verification_attempts, 1);
    assert_eq!(state.mutations_since_verification, 1);
    assert_eq!(state.stop_reason, None);
    assert!(!state.can_finish());

    // A repeated edit to an already-dirty file is still a new pending mutation.
    state.record_mutation([PathBuf::from("src/lib.rs")]);
    assert_eq!(state.mutations_since_verification, 2);
    assert_eq!(state.dirty_files.len(), 1);

    assert!(state.record_verification(&evidence(true, false, false)));
    assert_eq!(state.phase, CodingPhase::Complete);
    assert_eq!(state.repair_round, 1);
    assert_eq!(state.verification_attempts, 2);
    assert_eq!(state.mutations_since_verification, 0);
    assert_eq!(
        state.stop_reason,
        Some(CodingStopReason::VerificationPassed)
    );
}

#[test]
fn exhausting_max_repair_rounds_blocks_the_run() {
    let mut state = CodingState::new(policy(2));
    state.begin();
    state.record_mutation([PathBuf::from("src/lib.rs")]);

    assert!(!state.record_verification(&evidence(false, false, false)));
    assert_eq!(state.phase, CodingPhase::Repair);
    assert_eq!(state.repair_round, 1);

    assert!(!state.record_verification(&evidence(false, false, false)));
    assert_eq!(state.phase, CodingPhase::Repair);
    assert_eq!(state.repair_round, 2);
    assert_eq!(state.remaining_repair_rounds(), 0);

    assert!(!state.record_verification(&evidence(false, false, false)));
    assert_eq!(state.phase, CodingPhase::Blocked);
    assert_eq!(state.stop_reason, Some(CodingStopReason::MaxRepairRounds));
    assert_eq!(state.repair_round, 2);
    assert_eq!(state.verification_attempts, 3);
    assert!(!state.can_finish());
    assert!(!state.finish_successfully());
}

#[test]
fn cancellation_and_timeout_are_explicit_terminal_states() {
    let mut state = CodingState::new(policy(2));
    state.begin();
    state.cancel();
    assert_eq!(state.phase, CodingPhase::Blocked);
    assert_eq!(state.stop_reason, Some(CodingStopReason::Cancelled));
    assert!(!state.can_finish());

    state.begin();
    state.record_mutation([PathBuf::from("src/lib.rs")]);
    assert!(!state.record_verification(&evidence(false, true, false)));
    assert_eq!(state.phase, CodingPhase::Blocked);
    assert_eq!(state.stop_reason, Some(CodingStopReason::Cancelled));
    assert_eq!(state.verification_attempts, 1);

    state.begin();
    state.record_mutation([PathBuf::from("src/lib.rs")]);
    assert!(!state.record_verification(&evidence(false, false, true)));
    assert_eq!(state.phase, CodingPhase::Blocked);
    assert_eq!(state.stop_reason, Some(CodingStopReason::Cancelled));

    state.begin();
    state.timeout();
    assert_eq!(state.phase, CodingPhase::Blocked);
    assert_eq!(state.stop_reason, Some(CodingStopReason::Cancelled));
}

#[test]
fn verification_unavailable_and_budget_exhaustion_are_terminal() {
    let mut unavailable = CodingState::new(policy(2));
    unavailable.begin();
    unavailable.record_mutation([PathBuf::from("src/lib.rs")]);
    unavailable.mark_verification_unavailable();
    assert_eq!(unavailable.phase, CodingPhase::Blocked);
    assert_eq!(
        unavailable.stop_reason,
        Some(CodingStopReason::VerificationUnavailable)
    );
    assert!(!unavailable.can_finish());

    let mut exhausted = CodingState::new(policy(2));
    exhausted.begin();
    exhausted.record_mutation([PathBuf::from("src/lib.rs")]);
    exhausted.mark_budget_exhausted();
    assert_eq!(exhausted.phase, CodingPhase::Blocked);
    assert_eq!(
        exhausted.stop_reason,
        Some(CodingStopReason::BudgetExhausted)
    );
    assert!(!exhausted.can_finish());
}

#[test]
fn no_mutation_run_can_finish_without_verification() {
    let mut state = CodingState::new(policy(2));
    state.begin();

    assert!(state.can_finish());
    assert!(!state.begin_verification());
    assert_eq!(state.verification_attempts, 0);

    assert!(state.finish_successfully());
    assert_eq!(state.phase, CodingPhase::Complete);
    assert_eq!(state.stop_reason, None);
    assert_eq!(state.verification_attempts, 0);
    assert!(state.dirty_files.is_empty());
}

#[test]
fn diagnosis_and_repair_transitions_follow_the_legal_phase_order() {
    let mut state = CodingState::new(policy(2));
    state.begin();

    // Plan/Inspect/Edit cannot jump directly to diagnosis.
    assert!(!state.begin_diagnosis());
    state.record_mutation([PathBuf::from("src/lib.rs")]);
    assert_eq!(state.phase, CodingPhase::Edit);
    assert!(!state.begin_diagnosis());
    assert!(!state.begin_repair(), "repair requires diagnosis first");

    assert!(state.begin_verification());
    assert_eq!(state.phase, CodingPhase::Verify);
    assert!(state.begin_diagnosis());
    assert_eq!(state.phase, CodingPhase::Diagnose);
    assert!(
        !state.begin_diagnosis(),
        "diagnosis advances only from Verify/Repair"
    );

    assert!(state.begin_repair());
    assert_eq!(state.phase, CodingPhase::Repair);
    assert!(state.begin_diagnosis());
    assert_eq!(state.phase, CodingPhase::Diagnose);
}

#[test]
fn diagnosis_and_repair_reject_terminal_and_empty_states() {
    let mut terminal = CodingState::new(policy(2));
    terminal.begin();
    terminal.cancel();
    assert!(!terminal.begin_diagnosis());
    assert!(!terminal.begin_repair());

    let mut complete = CodingState::new(policy(2));
    complete.begin();
    complete.record_mutation([PathBuf::from("src/lib.rs")]);
    assert!(complete.record_verification(&evidence(true, false, false)));
    assert_eq!(complete.phase, CodingPhase::Complete);
    assert!(!complete.begin_diagnosis());
    assert!(!complete.begin_repair());

    let mut empty = CodingState::new(policy(2));
    empty.begin();
    empty.phase = CodingPhase::Verify;
    assert!(!empty.begin_diagnosis(), "no pending mutation or failure");
    empty.phase = CodingPhase::Repair;
    assert!(
        empty.begin_diagnosis(),
        "a repair phase represents a failure"
    );
}

#[test]
fn inspection_is_reachable_only_from_plan_and_repair() {
    let mut state = CodingState::new(policy(2));
    assert!(!state.begin_inspection(), "an idle run cannot inspect");

    state.begin();
    assert_eq!(state.phase, CodingPhase::Plan);
    assert!(state.begin_inspection());
    assert_eq!(state.phase, CodingPhase::Inspect);
    assert!(
        !state.begin_inspection(),
        "repeated read batches stay in Inspect"
    );

    state.record_mutation([PathBuf::from("src/lib.rs")]);
    assert_eq!(state.phase, CodingPhase::Edit);
    assert!(!state.begin_inspection(), "editing is past inspection");

    assert!(state.begin_verification());
    assert_eq!(state.phase, CodingPhase::Verify);
    assert!(!state.begin_inspection());
    assert!(!state.record_verification(&evidence(false, false, false)));
    assert_eq!(state.phase, CodingPhase::Repair);

    assert!(state.begin_inspection());
    assert_eq!(state.phase, CodingPhase::Inspect);
    state.record_mutation([PathBuf::from("src/lib.rs")]);
    assert_eq!(state.phase, CodingPhase::Edit);

    assert!(state.record_verification(&evidence(true, false, false)));
    assert_eq!(state.phase, CodingPhase::Complete);
    assert!(!state.begin_inspection());
}

#[test]
fn inspection_rejects_terminal_and_advanced_phases() {
    for phase in [
        CodingPhase::Verify,
        CodingPhase::Diagnose,
        CodingPhase::Inspect,
    ] {
        let mut state = CodingState::new(policy(2));
        state.begin();
        state.phase = phase;
        assert!(
            !state.begin_inspection(),
            "{phase:?} must not start inspection"
        );
        assert_eq!(state.phase, phase);
    }

    let mut complete = CodingState::new(policy(2));
    complete.begin();
    complete.record_mutation([PathBuf::from("src/lib.rs")]);
    assert!(complete.record_verification(&evidence(true, false, false)));
    assert_eq!(complete.phase, CodingPhase::Complete);
    assert!(!complete.begin_inspection());

    let mut blocked = CodingState::new(policy(2));
    blocked.begin();
    blocked.cancel();
    assert!(blocked.is_terminal());
    assert_eq!(blocked.stop_reason, Some(CodingStopReason::Cancelled));
    assert!(!blocked.begin_inspection());
    assert_eq!(blocked.phase, CodingPhase::Blocked);
}

#[test]
fn repair_budget_exhaustion_prevents_the_repair_transition() {
    let mut state = CodingState::new(policy(1));
    state.begin();
    state.record_mutation([PathBuf::from("src/lib.rs")]);

    assert!(!state.record_verification(&evidence(false, false, false)));
    assert_eq!(state.phase, CodingPhase::Repair);
    assert_eq!(state.repair_round, 1);
    assert_eq!(state.remaining_repair_rounds(), 0);

    assert!(state.begin_diagnosis());
    assert_eq!(state.phase, CodingPhase::Diagnose);
    assert!(!state.begin_repair());
    assert_eq!(state.phase, CodingPhase::Diagnose);
}
