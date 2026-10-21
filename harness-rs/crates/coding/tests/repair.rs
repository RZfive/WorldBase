use std::path::PathBuf;
use worldbase_coding::{
    analyze_diagnostics, plan_repair, CodingPolicy, DiagnosisReport, Diagnostic,
    DiagnosticSeverity, RepairStopReason,
};

fn diagnostic(
    message: &str,
    code: &str,
    file: &str,
    line: u32,
    severity: DiagnosticSeverity,
) -> Diagnostic {
    Diagnostic {
        severity,
        message: message.into(),
        code: Some(code.into()),
        file: Some(PathBuf::from(file)),
        line: Some(line),
        column: None,
        confidence: 0.95,
        raw: None,
    }
}

fn report() -> DiagnosisReport {
    analyze_diagnostics(&[
        diagnostic(
            "Type 'string' is not assignable to type 'number'.",
            "TS2322",
            "src/z.ts",
            7,
            DiagnosticSeverity::Error,
        ),
        diagnostic(
            "Cannot find name 'alpha'.",
            "TS2304",
            "src/a.ts",
            3,
            DiagnosticSeverity::Error,
        ),
        diagnostic(
            "Unexpected console statement.",
            "no-console",
            "src/b.ts",
            9,
            DiagnosticSeverity::Warning,
        ),
    ])
}

fn policy(max_repair_rounds: u32) -> CodingPolicy {
    CodingPolicy {
        max_repair_rounds,
        ..CodingPolicy::default()
    }
}

#[test]
fn retry_plan_targets_highest_priority_files_and_instructions() {
    let report = report();
    let plan = plan_repair(&report, &[], 0, &policy(3));

    assert!(plan.should_retry);
    assert_eq!(plan.stop_reason, None);
    assert_eq!(plan.round, 1);
    assert_eq!(plan.signature, report.failure_signature);
    assert_eq!(
        plan.targeted_files,
        vec![
            PathBuf::from("src/a.ts"),
            PathBuf::from("src/z.ts"),
            PathBuf::from("src/b.ts"),
        ]
    );
    assert_eq!(plan.instructions, report.repair_instructions);
    assert!(plan
        .instructions
        .iter()
        .any(|instruction| instruction.starts_with("type: src/a.ts:")));
    assert!(plan
        .instructions
        .iter()
        .any(|instruction| instruction.starts_with("lint: src/b.ts:")));
}

#[test]
fn immediate_repeat_of_the_same_signature_stops_the_loop() {
    let report = report();
    let history = vec![report.failure_signature.clone()];
    let plan = plan_repair(&report, &history, 1, &policy(3));

    assert!(!plan.should_retry);
    assert_eq!(plan.stop_reason, Some(RepairStopReason::RepeatedFailure));
    assert!(plan.targeted_files.is_empty());
    assert!(plan.instructions.is_empty());
    assert_eq!(plan.signature, report.failure_signature);
}

#[test]
fn signature_seen_twice_or_trailing_duplicate_is_a_repeated_failure() {
    let report = report();

    let seen_twice = vec![
        report.failure_signature.clone(),
        "other-signature".to_string(),
        report.failure_signature.clone(),
    ];
    let plan = plan_repair(&report, &seen_twice, 2, &policy(3));
    assert_eq!(plan.stop_reason, Some(RepairStopReason::RepeatedFailure));

    let trailing_duplicate = vec![
        "other-signature".to_string(),
        "same-signature".to_string(),
        "same-signature".to_string(),
    ];
    let plan = plan_repair(&report, &trailing_duplicate, 2, &policy(3));
    assert_eq!(plan.stop_reason, Some(RepairStopReason::RepeatedFailure));
}

#[test]
fn exhausting_max_repair_rounds_stops_the_loop() {
    let report = report();
    let plan = plan_repair(&report, &[], 2, &policy(2));

    assert!(!plan.should_retry);
    assert_eq!(plan.stop_reason, Some(RepairStopReason::MaxRepairRounds));
    assert_eq!(plan.round, 3);
    assert!(plan.targeted_files.is_empty());
    assert!(plan.instructions.is_empty());

    let beyond = plan_repair(&report, &[], 9, &policy(2));
    assert_eq!(beyond.stop_reason, Some(RepairStopReason::MaxRepairRounds));
}

#[test]
fn no_repairable_issue_takes_precedence_over_other_stop_reasons() {
    let empty = analyze_diagnostics(&[]);
    let plan = plan_repair(&empty, &[], 99, &policy(0));

    assert!(!plan.should_retry);
    assert_eq!(plan.stop_reason, Some(RepairStopReason::NoRepairableIssue));
    assert_eq!(plan.round, 100);
    assert!(plan.targeted_files.is_empty());
    assert!(plan.instructions.is_empty());
}

#[test]
fn planning_is_deterministic_for_reordered_equivalent_input() {
    let first = diagnostic(
        "Cannot find name 'alpha'.",
        "TS2304",
        "src/a.ts",
        3,
        DiagnosticSeverity::Error,
    );
    let second = diagnostic(
        "Type 'string' is not assignable to type 'number'.",
        "TS2322",
        "src/z.ts",
        7,
        DiagnosticSeverity::Error,
    );

    let forward = analyze_diagnostics(&[first.clone(), second.clone()]);
    let reverse = analyze_diagnostics(&[second, first]);
    let plan = plan_repair(&forward, &[], 0, &policy(3));

    assert_eq!(
        plan,
        plan_repair(&forward, &[], 0, &policy(3)),
        "same input must produce the same plan"
    );
    assert_eq!(
        plan,
        plan_repair(&reverse, &[], 0, &policy(3)),
        "report ordering must not change the plan"
    );
    assert_eq!(plan.signature, forward.failure_signature);
    assert_eq!(plan.signature, reverse.failure_signature);
}
