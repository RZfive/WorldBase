use serde_json::json;
use worldbase_coding::evidence::verification_evidence_from_value;
use worldbase_coding::{DiagnosticSeverity, PackageManager, ProjectKind, VerificationCheckKind};

#[test]
fn parses_successful_frontend_profile_evidence() {
    let value = json!({
        "passed": true,
        "projectId": "project-1",
        "profile": {
            "projectKind": "frontendNode",
            "packageManager": "pnpm",
            "source": "Frontend Node project detected from package.json",
            "root": "/private/project",
            "commands": [
                {
                    "kind": "typecheck",
                    "program": "pnpm",
                    "args": ["run", "typecheck"],
                    "required": true,
                    "description": "Run typecheck"
                },
                {
                    "kind": "test",
                    "program": "pnpm",
                    "args": ["run", "test"],
                    "required": true,
                    "description": "Run tests"
                }
            ],
            "futureProfileField": true
        },
        "outcomes": [
            {
                "kind": "typecheck",
                "program": "pnpm",
                "args": ["run", "typecheck"],
                "exitCode": 0,
                "timedOut": false,
                "cancelled": false,
                "durationMs": 42,
                "stdout": "typecheck ok",
                "stderr": ""
            },
            {
                "kind": "test",
                "program": "pnpm",
                "args": ["run", "test"],
                "exitCode": 0,
                "timedOut": false,
                "cancelled": false,
                "durationMs": 87,
                "stdout": "tests passed",
                "stderr": ""
            }
        ],
        "diagnostics": [],
        "cancelled": false,
        "timedOut": false,
        "futureTopLevelField": {"ignored": true}
    });

    let evidence = verification_evidence_from_value(&value).expect("parse successful evidence");

    assert!(evidence.passed);
    assert!(!evidence.cancelled);
    assert!(!evidence.timed_out);
    assert_eq!(evidence.profile.project_kind, ProjectKind::FrontendNode);
    assert_eq!(evidence.profile.package_manager, Some(PackageManager::Pnpm));
    assert_eq!(
        evidence.profile.source,
        "Frontend Node project detected from package.json"
    );
    assert!(evidence.profile.root.as_os_str().is_empty());
    assert_eq!(evidence.profile.commands.len(), 2);
    assert_eq!(
        evidence.profile.commands[0].kind,
        VerificationCheckKind::Typecheck
    );
    assert!(evidence.profile.commands[0].required);
    assert_eq!(evidence.outcomes.len(), 2);
    assert_eq!(evidence.outcomes[0].exit_code, Some(0));
    assert_eq!(evidence.outcomes[0].duration_ms, 42);
    assert_eq!(evidence.outcomes[0].stdout, "typecheck ok");
    assert!(evidence.outcomes[0].command.required);
    assert_eq!(evidence.outcomes[0].command.description, "Run typecheck");
    assert!(evidence.diagnostics.is_empty());
}

#[test]
fn parses_failed_typescript_and_eslint_diagnostics() {
    let value = json!({
        "passed": false,
        "profile": {
            "projectKind": "frontendNode",
            "packageManager": "npm",
            "source": "package.json",
            "commands": [
                {
                    "kind": "typecheck",
                    "program": "npm",
                    "args": ["run", "typecheck"],
                    "required": true,
                    "description": "Run typecheck"
                },
                {
                    "kind": "lint",
                    "program": "npm",
                    "args": ["run", "lint"],
                    "required": true,
                    "description": "Run lint"
                }
            ]
        },
        "outcomes": [
            {
                "kind": "typecheck",
                "program": "npm",
                "args": ["run", "typecheck"],
                "exitCode": 2,
                "timedOut": false,
                "cancelled": false,
                "durationMs": 100,
                "stdout": "",
                "stderr": "src/app.ts(3,4): error TS2322: Type mismatch"
            },
            {
                "kind": "lint",
                "program": "npm",
                "args": ["run", "lint"],
                "exitCode": 1,
                "timedOut": false,
                "cancelled": false,
                "durationMs": 20,
                "stdout": "src/app.ts:8:1 error Unused variable  no-unused-vars",
                "stderr": ""
            }
        ],
        "diagnostics": [
            {
                "severity": "error",
                "message": "Type mismatch",
                "code": "TS2322",
                "file": "src/app.ts",
                "line": 3,
                "column": 4,
                "byteStart": 12,
                "byteEnd": 20,
                "confidence": 0.95,
                "raw": "src/app.ts(3,4): error TS2322: Type mismatch"
            },
            {
                "severity": "warning",
                "message": "Unused variable",
                "code": "no-unused-vars",
                "file": "src/app.ts",
                "line": 8,
                "column": 1,
                "confidence": 1.7,
                "raw": "src/app.ts:8:1 error Unused variable  no-unused-vars"
            },
            {
                "severity": "info",
                "message": "Additional context",
                "confidence": -0.2
            }
        ]
    });

    let evidence = verification_evidence_from_value(&value).expect("parse failed evidence");

    assert!(!evidence.passed);
    assert_eq!(evidence.outcomes.len(), 2);
    assert_eq!(evidence.outcomes[0].exit_code, Some(2));
    assert_eq!(evidence.outcomes[1].exit_code, Some(1));
    assert_eq!(evidence.diagnostics.len(), 3);

    let typescript = &evidence.diagnostics[0];
    assert_eq!(typescript.severity, DiagnosticSeverity::Error);
    assert_eq!(typescript.code.as_deref(), Some("TS2322"));
    assert_eq!(
        typescript.file.as_deref().and_then(|path| path.to_str()),
        Some("src/app.ts")
    );
    assert_eq!(typescript.line, Some(3));
    assert_eq!(typescript.column, Some(4));
    assert_eq!(typescript.confidence, 0.95);

    let eslint = &evidence.diagnostics[1];
    assert_eq!(eslint.severity, DiagnosticSeverity::Warning);
    assert_eq!(eslint.code.as_deref(), Some("no-unused-vars"));
    assert_eq!(eslint.line, Some(8));
    assert_eq!(eslint.column, Some(1));
    assert_eq!(eslint.confidence, 1.0);

    let informational = &evidence.diagnostics[2];
    assert_eq!(informational.severity, DiagnosticSeverity::Info);
    assert_eq!(informational.confidence, 0.0);
}

#[test]
fn parses_unknown_and_missing_profiles_with_defaults() {
    let unknown = json!({
        "passed": false,
        "reason": "no_supported_verification_profile",
        "profile": {
            "projectKind": "unknown",
            "packageManager": null,
            "source": "No package.json found",
            "commands": []
        },
        "outcomes": [],
        "diagnostics": []
    });
    let unknown =
        verification_evidence_from_value(&unknown).expect("parse unknown profile evidence");
    assert_eq!(unknown.profile.project_kind, ProjectKind::Unknown);
    assert_eq!(unknown.profile.package_manager, None);
    assert_eq!(unknown.profile.source, "No package.json found");
    assert!(unknown.profile.commands.is_empty());
    assert!(unknown.outcomes.is_empty());
    assert!(unknown.diagnostics.is_empty());

    let missing = json!({
        "passed": false,
        "cancelled": true,
        "timedOut": true
    });
    let missing =
        verification_evidence_from_value(&missing).expect("parse missing profile evidence");
    assert_eq!(missing.profile.project_kind, ProjectKind::Unknown);
    assert_eq!(missing.profile.package_manager, None);
    assert!(missing.profile.root.as_os_str().is_empty());
    assert!(missing.profile.commands.is_empty());
    assert!(missing.profile.source.is_empty());
    assert!(missing.cancelled);
    assert!(missing.timed_out);
}

#[test]
fn aggregates_cancellation_and_timeout_from_outcomes() {
    let value = json!({
        "passed": false,
        "profile": {
            "projectKind": "frontendNode",
            "packageManager": "npm",
            "source": "package.json",
            "commands": [
                {
                    "kind": "test",
                    "program": "npm",
                    "args": ["run", "test"],
                    "required": true,
                    "description": "Run tests"
                }
            ]
        },
        "outcomes": [
            {
                "kind": "test",
                "program": "npm",
                "args": ["run", "test"],
                "exitCode": null,
                "timedOut": true,
                "cancelled": true,
                "durationMs": 120000,
                "stdout": "",
                "stderr": "cancelled after timeout"
            }
        ],
        "diagnostics": []
    });

    let evidence = verification_evidence_from_value(&value).expect("parse terminal evidence");

    assert!(!evidence.passed);
    assert!(evidence.cancelled);
    assert!(evidence.timed_out);
    assert_eq!(evidence.outcomes.len(), 1);
    assert_eq!(evidence.outcomes[0].exit_code, None);
    assert!(evidence.outcomes[0].cancelled);
    assert!(evidence.outcomes[0].timed_out);
}

#[test]
fn rejects_malformed_required_fields_with_clear_errors() {
    let not_an_object = json!([]);
    let error = verification_evidence_from_value(&not_an_object).expect_err("array must fail");
    assert!(error.to_string().contains("coding_verify evidence"));

    let missing_passed = json!({
        "profile": {
            "projectKind": "unknown",
            "source": "none",
            "commands": []
        }
    });
    let error = verification_evidence_from_value(&missing_passed).expect_err("passed is required");
    assert!(error.to_string().contains("passed"));

    let missing_command_required = json!({
        "passed": false,
        "profile": {
            "projectKind": "frontendNode",
            "source": "package.json",
            "commands": [
                {
                    "kind": "test",
                    "program": "npm",
                    "description": "Run tests"
                }
            ]
        }
    });
    let error = verification_evidence_from_value(&missing_command_required)
        .expect_err("profile command required flag is required");
    assert!(error.to_string().contains("required"));

    let invalid_outcome_type = json!({
        "passed": false,
        "outcomes": [
            {
                "kind": "test",
                "program": "npm",
                "exitCode": "zero"
            }
        ]
    });
    let error = verification_evidence_from_value(&invalid_outcome_type)
        .expect_err("invalid outcome type must fail");
    assert!(error
        .to_string()
        .contains("invalid coding_verify evidence JSON"));

    let invalid_severity = json!({
        "passed": false,
        "diagnostics": [
            {
                "severity": "critical",
                "message": "Unknown severity"
            }
        ]
    });
    let error =
        verification_evidence_from_value(&invalid_severity).expect_err("severity must be known");
    assert!(error.to_string().contains("severity"));
}
