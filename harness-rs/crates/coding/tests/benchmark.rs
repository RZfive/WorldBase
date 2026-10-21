//! Deterministic, offline frontend coding benchmark.
//!
//! Every case uses static fixtures under `tests/fixtures`. No package manager,
//! build script, subprocess, or network access is involved.

use std::path::{Path, PathBuf};
use worldbase_coding::{
    analyze_diagnostics, analyze_outcomes, detect_profile,
    error_analyzer::normalize_outcome,
    plan_repair,
    smart_editor::{parse_file, NodeSelector, ParsedFile, SymbolEntry, SymbolKind, SymbolQuery},
    CodingPolicy, CommandOutcome, Diagnostic, DiagnosticSeverity, ErrorCategory, PackageManager,
    ProjectKind, RepairStopReason, VerificationCheckKind, VerificationCommand,
};

const APP_TSX: &str = include_str!("fixtures/frontend-app/src/App.tsx");
const BUTTON_TSX: &str = include_str!("fixtures/frontend-app/src/components/Button.tsx");
const COUNTER_TSX: &str = include_str!("fixtures/frontend-app/src/components/Counter.tsx");
const MATH_TS: &str = include_str!("fixtures/frontend-app/src/lib/math.ts");
const API_TS: &str = include_str!("fixtures/frontend-app/src/lib/api.ts");
const TYPES_TS: &str = include_str!("fixtures/frontend-app/src/lib/types.ts");
const TYPE_ERRORS_TS: &str = include_str!("fixtures/frontend-app/error-cases/type-errors.ts");
const LINT_ERRORS_TSX: &str = include_str!("fixtures/frontend-app/error-cases/lint-errors.tsx");

const TYPESCRIPT_LOG: &str = include_str!("fixtures/error-logs/typescript-typecheck.txt");
const ESLINT_LOG: &str = include_str!("fixtures/error-logs/eslint.txt");
const VITEST_ASSERTION_LOG: &str = include_str!("fixtures/error-logs/vitest-assertion.txt");
const VITEST_TIMEOUT_LOG: &str = include_str!("fixtures/error-logs/vitest-timeout.txt");
const BUNDLER_LOG: &str = include_str!("fixtures/error-logs/bundler-module-not-found.txt");

#[derive(Default)]
struct Benchmark {
    passed: usize,
    failed: usize,
}

impl Benchmark {
    fn run(&mut self, name: &str, case: impl FnOnce()) {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(case)) {
            Ok(()) => {
                self.passed += 1;
                println!("[PASS] {name}");
            }
            Err(payload) => {
                self.failed += 1;
                println!("[FAIL] {name}: {}", panic_message(payload.as_ref()));
            }
        }
    }

    fn finish(&self) {
        println!("benchmark: {} passed, {} failed", self.passed, self.failed);
        assert_eq!(self.failed, 0, "{} benchmark case(s) failed", self.failed);
    }
}

fn panic_message(payload: &(dyn std::any::Any + Send)) -> &str {
    payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("unknown panic")
}

fn fixture_path(relative: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(relative)
}

fn parse_fixture(path: &str, source: &str) -> ParsedFile {
    parse_file(Path::new(path), source)
        .unwrap_or_else(|error| panic!("parse fixture {path}: {error}"))
}

fn symbol<'a>(entries: &'a [SymbolEntry], name: &str, kind: SymbolKind) -> &'a SymbolEntry {
    entries
        .iter()
        .find(|entry| entry.name == name && entry.kind == kind)
        .unwrap_or_else(|| panic!("missing {kind} symbol `{name}`"))
}

fn row_at(source: &str, byte: usize) -> usize {
    source.as_bytes()[..byte]
        .iter()
        .filter(|byte| **byte == b'\n')
        .count()
}

fn column_at(source: &str, byte: usize) -> usize {
    let line_start = source[..byte]
        .rfind('\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    byte - line_start
}

fn assert_range(source: &str, entry: &SymbolEntry) {
    assert!(
        entry.start_byte < entry.end_byte,
        "{} has empty range",
        entry.name
    );
    assert!(
        entry.end_byte <= source.len(),
        "{} exceeds source",
        entry.name
    );
    assert_eq!(entry.start_row, row_at(source, entry.start_byte));
    assert_eq!(entry.end_row, row_at(source, entry.end_byte));
    assert_eq!(entry.start_column, column_at(source, entry.start_byte));
    assert_eq!(entry.end_column, column_at(source, entry.end_byte));
    assert_eq!(entry.line(), entry.start_row + 1);
    assert_eq!(
        entry.end_byte - entry.start_byte,
        source[entry.byte_range()].len(),
        "{} byte range is not aligned to the fixture",
        entry.name
    );
}

fn failed_outcome(kind: VerificationCheckKind, stdout: &str) -> CommandOutcome {
    CommandOutcome {
        command: VerificationCommand {
            kind,
            program: "pnpm".into(),
            args: vec!["run".into(), kind.label().into()],
            required: true,
            description: "frontend benchmark fixture".into(),
        },
        exit_code: Some(1),
        stdout: stdout.into(),
        stderr: String::new(),
        timed_out: false,
        cancelled: false,
        duration_ms: 25,
    }
}

fn log_diagnostic(diagnostic: &Diagnostic, log: &str) -> Diagnostic {
    let mut diagnostic = diagnostic.clone();
    diagnostic.raw = Some(log.to_string());
    diagnostic
}

fn code_of(diagnostic: &Diagnostic) -> &str {
    diagnostic.code.as_deref().unwrap_or("")
}

#[test]
fn frontend_coding_benchmark() {
    let mut suite = Benchmark::default();

    suite.run("profile-detection", || {
        let profile = detect_profile(&fixture_path("frontend-app"))
            .unwrap_or_else(|error| panic!("detect profile: {error}"));

        assert_eq!(profile.project_kind, ProjectKind::FrontendNode);
        assert_eq!(profile.package_manager, Some(PackageManager::Pnpm));
        assert_eq!(profile.commands.len(), 4);
        assert_eq!(
            profile
                .commands
                .iter()
                .map(|command| command.kind)
                .collect::<Vec<_>>(),
            vec![
                VerificationCheckKind::Typecheck,
                VerificationCheckKind::Lint,
                VerificationCheckKind::Test,
                VerificationCheckKind::Build,
            ]
        );
        assert!(profile.commands.iter().all(|command| command.required));
        assert!(profile
            .commands
            .iter()
            .all(|command| command.program == "pnpm"));
        assert_eq!(profile.commands[0].args, vec!["run", "typecheck"]);
        assert_eq!(profile.commands[1].args, vec!["run", "lint"]);
        assert_eq!(profile.commands[2].args, vec!["run", "test"]);
        assert_eq!(profile.commands[3].args, vec!["run", "build"]);
        assert!(profile.source.contains("pnpm-lock.yaml"));
    });

    suite.run("symbol-index", || {
        let app = parse_fixture("src/App.tsx", APP_TSX);
        assert!(!app.has_syntax_errors());
        let app_symbols = app.symbols();

        let app_component = symbol(&app_symbols, "App", SymbolKind::Function);
        assert!(app_component.exported);
        assert!(app_component.parent_path.is_empty());
        assert_eq!(app_component.start_row, 6);
        assert_range(APP_TSX, app_component);
        assert!(APP_TSX[app_component.byte_range()].starts_with("function App() {"));

        let counter_import = symbol(&app_symbols, "Counter", SymbolKind::Import);
        assert_eq!(counter_import.start_row, 0);
        assert_range(APP_TSX, counter_import);
        assert_eq!(
            &APP_TSX[counter_import.byte_range()],
            "import { Counter } from \"./components/Counter\";"
        );

        let theme_import = symbol(&app_symbols, "Theme", SymbolKind::Import);
        assert_eq!(theme_import.start_row, 2);
        assert_range(APP_TSX, theme_import);

        let default_theme = symbol(&app_symbols, "DEFAULT_THEME", SymbolKind::Variable);
        assert!(!default_theme.exported);
        assert_eq!(default_theme.start_row, 4);
        assert_range(APP_TSX, default_theme);
        assert_eq!(
            &APP_TSX[default_theme.byte_range()],
            "const DEFAULT_THEME: Theme = \"light\";"
        );

        let counter = parse_fixture("src/components/Counter.tsx", COUNTER_TSX);
        assert!(!counter.has_syntax_errors());
        let counter_symbols = counter.symbols();

        let props = symbol(&counter_symbols, "CounterProps", SymbolKind::Interface);
        assert!(!props.exported);
        assert_eq!(props.start_row, 3);
        assert_range(COUNTER_TSX, props);
        assert!(COUNTER_TSX[props.byte_range()].starts_with("interface CounterProps {"));

        let counter_component = symbol(&counter_symbols, "Counter", SymbolKind::Function);
        assert!(counter_component.exported);
        assert_eq!(counter_component.start_row, 8);
        assert_range(COUNTER_TSX, counter_component);
        assert!(COUNTER_TSX[counter_component.byte_range()].starts_with("function Counter("));

        let increment = symbol(&counter_symbols, "increment", SymbolKind::Function);
        assert_eq!(increment.parent_path, vec!["Counter"]);
        assert_eq!(increment.start_row, 11);
        assert_range(COUNTER_TSX, increment);
        assert!(COUNTER_TSX[increment.byte_range()].starts_with("function increment()"));

        let decrement = symbol(&counter_symbols, "decrement", SymbolKind::Function);
        assert_eq!(decrement.parent_path, vec!["Counter"]);
        assert_eq!(decrement.start_row, 15);
        assert_range(COUNTER_TSX, decrement);

        let button = parse_fixture("src/components/Button.tsx", BUTTON_TSX);
        let button_symbols = button.symbols();
        let button_props = symbol(&button_symbols, "ButtonProps", SymbolKind::Interface);
        assert!(!button_props.exported);
        assert_eq!(button_props.start_row, 2);
        assert_range(BUTTON_TSX, button_props);
        let button_component = symbol(&button_symbols, "Button", SymbolKind::Function);
        assert!(button_component.exported);
        assert_eq!(button_component.start_row, 7);
        assert_range(BUTTON_TSX, button_component);

        let api = parse_fixture("src/lib/api.ts", API_TS);
        assert!(!api.has_syntax_errors());
        let api_symbols = api.symbols();

        let user_import = symbol(&api_symbols, "User", SymbolKind::Import);
        assert_eq!(user_import.start_row, 0);
        assert_range(API_TS, user_import);

        let client = symbol(&api_symbols, "ApiClient", SymbolKind::Type);
        assert!(client.exported);
        assert_eq!(client.start_row, 4);
        assert_range(API_TS, client);
        assert!(API_TS[client.byte_range()].starts_with("class ApiClient {"));

        let get_json = symbol(&api_symbols, "getJson", SymbolKind::Method);
        assert_eq!(get_json.parent_path, vec!["ApiClient"]);
        assert_eq!(get_json.start_row, 7);
        assert_eq!(get_json.start_column, 2);
        assert_range(API_TS, get_json);
        assert!(API_TS[get_json.byte_range()].starts_with("async getJson<T>("));

        let fetch_user = symbol(&api_symbols, "fetchUser", SymbolKind::Function);
        assert!(fetch_user.exported);
        assert_eq!(fetch_user.start_row, 16);
        assert_range(API_TS, fetch_user);
        assert!(API_TS[fetch_user.byte_range()].starts_with("async function fetchUser("));

        let types = parse_fixture("src/lib/types.ts", TYPES_TS);
        assert!(!types.has_syntax_errors());
        let type_symbols = types.symbols();
        let user = symbol(&type_symbols, "User", SymbolKind::Interface);
        assert!(user.exported);
        assert_eq!(user.start_row, 0);
        assert_range(TYPES_TS, user);
        let result = symbol(&type_symbols, "ApiResult", SymbolKind::Interface);
        assert!(result.exported);
        assert_eq!(result.start_row, 6);
        assert_range(TYPES_TS, result);
        let theme = symbol(&type_symbols, "Theme", SymbolKind::Type);
        assert!(theme.exported);
        assert_eq!(theme.start_row, 11);
        assert_range(TYPES_TS, theme);
    });

    suite.run("semantic-replace", || {
        let math = parse_fixture("src/lib/math.ts", MATH_TS);
        let replacement =
            "function add(left: number, right: number): number {\n  return left + right + 1;\n}";
        let edit = math
            .replace_symbol(
                &SymbolQuery::new("add").with_kind(SymbolKind::Function),
                replacement,
            )
            .unwrap_or_else(|error| panic!("replace add: {error}"));

        assert_eq!(
            edit.original_snippet,
            "function add(left: number, right: number): number {\n  return left + right;\n}"
        );
        assert!(edit.edited_source.contains("return left + right + 1;"));
        assert!(edit.edited_source.contains("export function multiply"));
        assert!(edit.edited_source.starts_with("export function add"));

        let edited = parse_fixture("src/lib/math.ts", &edit.edited_source);
        assert!(!edited.has_syntax_errors());
        let edited_symbols = edited.symbols();
        let add = symbol(&edited_symbols, "add", SymbolKind::Function);
        assert!(edited.source[add.byte_range()].contains("+ 1"));
    });

    suite.run("insert-after", || {
        let math = parse_fixture("src/lib/math.ts", MATH_TS);
        let edit = math
            .insert_after(
                &SymbolQuery::new("multiply").with_kind(SymbolKind::Function),
                "function subtract(left: number, right: number): number {\n  return left - right;\n}",
            )
            .unwrap_or_else(|error| panic!("insert subtract: {error}"));

        assert_eq!(edit.byte_range.start, edit.byte_range.end);
        assert!(edit.original_snippet.is_empty());
        assert!(edit.edited_source.contains("}\nfunction subtract"));
        let subtract_at = edit
            .edited_source
            .find("function subtract")
            .expect("inserted function");
        let format_at = edit
            .edited_source
            .find("function formatCount")
            .expect("following function");
        assert!(subtract_at < format_at);

        let edited = parse_fixture("src/lib/math.ts", &edit.edited_source);
        assert!(!edited.has_syntax_errors());
        let subtract = edited
            .find_symbol(&SymbolQuery::new("subtract").with_kind(SymbolKind::Function))
            .expect("inserted subtract symbol");
        assert_eq!(subtract.parent_path, Vec::<String>::new());
    });

    suite.run("delete-symbol", || {
        let math = parse_fixture("src/lib/math.ts", MATH_TS);
        let edit = math
            .delete_symbol(&SymbolQuery::new("legacyTotal").with_kind(SymbolKind::Function))
            .unwrap_or_else(|error| panic!("delete legacyTotal: {error}"));

        assert!(edit
            .original_snippet
            .starts_with("export function legacyTotal("));
        assert!(!edit.edited_source.contains("legacyTotal"));
        assert!(edit.edited_source.contains("export const clamp"));

        let edited = parse_fixture("src/lib/math.ts", &edit.edited_source);
        assert!(!edited.has_syntax_errors());
        let missing = edited
            .find_symbol(&SymbolQuery::new("legacyTotal").with_kind(SymbolKind::Function))
            .expect_err("deleted symbol must not be indexed");
        assert!(missing.to_string().contains("no symbol matched"));
    });

    suite.run("rename-symbol", || {
        let math = parse_fixture("src/lib/math.ts", MATH_TS);
        let edit = math
            .rename_symbol(
                &SymbolQuery::new("formatCount").with_kind(SymbolKind::Function),
                "formatItemCount",
            )
            .unwrap_or_else(|error| panic!("rename formatCount: {error}"));

        assert!(edit
            .edited_source
            .contains("function formatItemCount(count: number): string"));
        assert!(edit
            .edited_source
            .contains("Count: ${formatItemCount(count)}"));
        assert!(!edit.edited_source.contains("formatCount"));

        let edited = parse_fixture("src/lib/math.ts", &edit.edited_source);
        assert!(!edited.has_syntax_errors());
        edited
            .find_symbol(&SymbolQuery::new("formatItemCount").with_kind(SymbolKind::Function))
            .expect("renamed symbol");
        assert!(edited
            .find_symbol(&SymbolQuery::new("formatCount").with_kind(SymbolKind::Function))
            .is_err());
    });

    suite.run("ambiguous-selector-rejection", || {
        let counter = parse_fixture("src/components/Counter.tsx", COUNTER_TSX);
        let error = counter
            .find_node(&NodeSelector::new("function_declaration"))
            .expect_err("three function declarations must be ambiguous")
            .to_string();
        assert!(error.contains("3 matched"), "unexpected error: {error}");
    });

    suite.run("invalid-replacement-rejection", || {
        let math = parse_fixture("src/lib/math.ts", MATH_TS);
        let error = math
            .propose_semantic_edit(
                &NodeSelector::new("function_declaration").with_name("add"),
                "function add(left: number, right: number): number {\n  return left +;",
            )
            .expect_err("unbalanced expression must be rejected")
            .to_string();
        assert!(error.contains("syntax errors"), "unexpected error: {error}");
        assert_eq!(math.source, MATH_TS);
    });

    suite.run("typescript-diagnosis", || {
        let error_copy = parse_fixture("error-cases/type-errors.ts", TYPE_ERRORS_TS);
        assert!(!error_copy.has_syntax_errors());

        let outcome = failed_outcome(VerificationCheckKind::Typecheck, TYPESCRIPT_LOG);
        let diagnostics = normalize_outcome(&outcome);
        assert_eq!(diagnostics.len(), 3);
        assert_eq!(
            diagnostics.iter().map(code_of).collect::<Vec<_>>(),
            vec!["TS2304", "TS2339", "TS2345"]
        );

        let report = analyze_outcomes(std::slice::from_ref(&outcome));
        assert_eq!(report.error_count, 3);
        assert_eq!(report.warning_count, 0);
        assert_eq!(report.primary_category, ErrorCategory::Type);
        assert_eq!(
            report
                .matches
                .iter()
                .map(|pattern_match| pattern_match.pattern_id.as_str())
                .collect::<Vec<_>>(),
            vec!["ts-2304", "ts-2339", "ts-2345"]
        );
        assert_eq!(
            report.affected_files,
            vec![
                PathBuf::from("src/App.tsx"),
                PathBuf::from("src/components/Counter.tsx"),
                PathBuf::from("src/lib/math.ts"),
            ]
        );
        assert!(report.has_repairable_issues);
        assert!(report
            .repair_instructions
            .iter()
            .all(|instruction| instruction.starts_with("type: ")));
        assert!(report.failure_signature.starts_with("fnv1a64:"));
    });

    suite.run("eslint-diagnosis", || {
        let error_copy = parse_fixture("error-cases/lint-errors.tsx", LINT_ERRORS_TSX);
        assert!(!error_copy.has_syntax_errors());

        let outcome = failed_outcome(VerificationCheckKind::Lint, ESLINT_LOG);
        let diagnostics = normalize_outcome(&outcome);
        assert_eq!(diagnostics.len(), 2);
        assert_eq!(code_of(&diagnostics[0]), "no-unused-vars");
        assert_eq!(code_of(&diagnostics[1]), "import/no-unresolved");

        let report = analyze_outcomes(std::slice::from_ref(&outcome));
        assert_eq!(report.error_count, 2);
        assert_eq!(report.primary_category, ErrorCategory::Lint);
        assert_eq!(
            report
                .matches
                .iter()
                .map(|pattern_match| pattern_match.pattern_id.as_str())
                .collect::<Vec<_>>(),
            vec!["eslint-no-unused-vars", "eslint-import-no-unresolved"]
        );
        assert_eq!(report.matches[1].category, ErrorCategory::Import);
    });

    suite.run("vitest-diagnosis", || {
        let assertion_outcome = failed_outcome(VerificationCheckKind::Test, VITEST_ASSERTION_LOG);
        let assertion_diagnostics = normalize_outcome(&assertion_outcome);
        assert_eq!(assertion_diagnostics.len(), 1);
        assert_eq!(code_of(&assertion_diagnostics[0]), "TEST_FAILURE");
        assert_eq!(
            assertion_diagnostics[0].file.as_deref(),
            Some(Path::new("src/lib/math.test.ts"))
        );

        let assertion_report = analyze_diagnostics(&[log_diagnostic(
            &assertion_diagnostics[0],
            VITEST_ASSERTION_LOG,
        )]);
        assert_eq!(
            assertion_report.matches[0].pattern_id,
            "test-assertion-failure"
        );
        assert_eq!(assertion_report.primary_category, ErrorCategory::Test);

        let timeout_outcome = failed_outcome(VerificationCheckKind::Test, VITEST_TIMEOUT_LOG);
        let timeout_diagnostics = normalize_outcome(&timeout_outcome);
        assert_eq!(timeout_diagnostics.len(), 1);
        assert_eq!(code_of(&timeout_diagnostics[0]), "TEST_FAILURE");

        let timeout_report =
            analyze_diagnostics(&[log_diagnostic(&timeout_diagnostics[0], VITEST_TIMEOUT_LOG)]);
        assert_eq!(timeout_report.matches[0].pattern_id, "test-timeout");
        assert_eq!(timeout_report.primary_category, ErrorCategory::Test);
    });

    suite.run("bundler-diagnosis", || {
        let outcome = failed_outcome(VerificationCheckKind::Build, BUNDLER_LOG);
        let diagnostics = normalize_outcome(&outcome);
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].code, None);
        assert_eq!(diagnostics[0].file, None);
        assert_eq!(diagnostics[0].severity, DiagnosticSeverity::Error);

        let report = analyze_diagnostics(&diagnostics);
        assert_eq!(report.error_count, 1);
        assert_eq!(
            report.matches[0].pattern_id,
            "build-failed-to-resolve-import"
        );
        assert_eq!(report.primary_category, ErrorCategory::Build);
        assert!(report.summary.contains("1 error"));
    });

    suite.run("repair-planning", || {
        let report = analyze_outcomes(&[failed_outcome(
            VerificationCheckKind::Typecheck,
            TYPESCRIPT_LOG,
        )]);
        let policy = CodingPolicy {
            max_repair_rounds: 2,
            ..CodingPolicy::default()
        };

        let retry = plan_repair(&report, &[], 0, &policy);
        assert!(retry.should_retry);
        assert_eq!(retry.stop_reason, None);
        assert_eq!(retry.round, 1);
        assert_eq!(retry.signature, report.failure_signature);
        assert_eq!(retry.instructions, report.repair_instructions);
        assert_eq!(
            retry.targeted_files,
            vec![
                PathBuf::from("src/App.tsx"),
                PathBuf::from("src/components/Counter.tsx"),
                PathBuf::from("src/lib/math.ts"),
            ]
        );

        let repeated = plan_repair(
            &report,
            std::slice::from_ref(&report.failure_signature),
            1,
            &policy,
        );
        assert!(!repeated.should_retry);
        assert_eq!(
            repeated.stop_reason,
            Some(RepairStopReason::RepeatedFailure)
        );
        assert!(repeated.targeted_files.is_empty());

        let exhausted = plan_repair(&report, &[], 2, &policy);
        assert!(!exhausted.should_retry);
        assert_eq!(
            exhausted.stop_reason,
            Some(RepairStopReason::MaxRepairRounds)
        );
    });

    suite.run("formatting-preservation", || {
        let source = "export function outer() {\r\n\tconst value = 1;\r\n\r\n\tfunction inner() {\r\n\t\treturn value;\r\n\t}\r\n\r\n\treturn inner();\r\n}\r\n";
        let parsed = parse_fixture("src/formatting.ts", source);
        assert!(!parsed.has_syntax_errors());

        let edit = parsed
            .propose_semantic_edit(
                &NodeSelector::new("function_declaration").with_name("inner"),
                "function inner() {\n\treturn value + 1;\n}",
            )
            .unwrap_or_else(|error| panic!("replace inner: {error}"));

        assert!(edit
            .edited_source
            .contains("\tfunction inner() {\r\n\t\treturn value + 1;\r\n\t}"));
        assert!(edit.edited_source.contains("\r\n\tconst value = 1;"));
        let without_crlf = edit.edited_source.replace("\r\n", "");
        assert!(!without_crlf.contains('\n'));
        assert!(!without_crlf.contains('\r'));
        assert_eq!(
            edit.edited_source.matches("\r\n").count(),
            source.matches("\r\n").count()
        );
    });

    suite.finish();
}
