//! Deterministic 100-task coding benchmark with per-task latency.
//!
//! The corpus covers profile detection, multi-language symbol indexing,
//! semantic edits, diagnostics, repair planning, formatting, and dependency/LSP
//! data parsing. Twenty-two tasks read real repository files read-only through
//! `CARGO_MANIFEST_DIR/../../..`; everything else uses checked-in fixtures or
//! inline sources. No subprocess, network, or filesystem write is performed.

use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    time::Instant,
};
use worldbase_coding::{
    analyze_diagnostics, analyze_outcomes,
    dependency::{
        analyze_dependency_diagnostics, analyze_package_manager_output, dependency_kind,
        detect_package_manager, parse_package_manifest, DependencyFixAction, DependencyIssueKind,
        DependencyKind, PackageManifest,
    },
    detect_profile,
    error_analyzer::normalize_outcome,
    lsp::{
        analyze_lsp_diagnostics, file_uri_to_path, merge_lsp_diagnostics,
        parse_definition_response, parse_document_symbols, parse_hover, parse_publish_diagnostics,
        parse_symbol_information, path_to_file_uri, LspSymbolKind,
    },
    plan_repair,
    smart_editor::{
        delete_symbol, insert_after, parse_file, rename_symbol, replace_symbol, ParsedFile,
        SymbolEntry, SymbolKind, SymbolQuery,
    },
    CodingPolicy, CommandOutcome, DiagnosisReport, Diagnostic, DiagnosticSeverity, ErrorCategory,
    PackageManager, ProjectKind, RepairStopReason, VerificationCheckKind, VerificationCommand,
};

const REAL_TYPES: &str = "apps/electron/src/main/ai-harness/types.ts";
const REAL_ENGINE: &str = "apps/electron/src/main/ai-harness/rust-harness-engine.ts";
const REAL_CLIENT: &str = "apps/electron/electron/main-process/rust-harness-client.ts";
const REAL_CONTRACTS: &str = "apps/electron/src/main/ai-harness/contracts.ts";
const REAL_AGENT_TYPES: &str = "apps/electron/src/shared/agent-workspace-types.ts";
const REAL_TOOL_SUMMARY: &str = "apps/electron/src/main/ai-harness/tool-run-summary.ts";
const REAL_ABORT_UTILS: &str = "apps/electron/src/main/ai-harness/abort-utils.ts";
const REAL_COST_TRACKER: &str = "apps/electron/src/main/ai-harness/cost-tracker.ts";
const REAL_TOOL_REGISTRY: &str = "apps/electron/src/main/ai-harness/electron-tool-registry.ts";
const REAL_CHAT_UTILS: &str = "apps/electron/electron/main-process/chat-message-utils.ts";
const REAL_DOCUMENT_WATCHER: &str = "apps/electron/electron/main-process/document-file-watcher.ts";
const REAL_LOG_ROUTING: &str = "apps/electron/electron/main-process/project-runtime-log-routing.ts";

const REAL_INDEX_FILES: &[&str] = &[
    REAL_TYPES,
    REAL_ENGINE,
    REAL_CLIENT,
    REAL_CONTRACTS,
    REAL_AGENT_TYPES,
    REAL_COST_TRACKER,
    REAL_TOOL_REGISTRY,
    REAL_DOCUMENT_WATCHER,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Category {
    Profile,
    Symbols,
    Edits,
    Diagnostics,
    Repair,
    Formatting,
    DependencyLsp,
}

impl Category {
    const ALL: [Category; 7] = [
        Category::Profile,
        Category::Symbols,
        Category::Edits,
        Category::Diagnostics,
        Category::Repair,
        Category::Formatting,
        Category::DependencyLsp,
    ];

    fn name(self) -> &'static str {
        match self {
            Self::Profile => "profile",
            Self::Symbols => "symbols",
            Self::Edits => "edits",
            Self::Diagnostics => "diagnostics",
            Self::Repair => "repair",
            Self::Formatting => "formatting",
            Self::DependencyLsp => "dependency-lsp",
        }
    }

    fn expected_count(self) -> usize {
        match self {
            Self::Profile => 8,
            Self::Symbols => 20,
            Self::Edits => 24,
            Self::Diagnostics => 20,
            Self::Repair => 12,
            Self::Formatting => 8,
            Self::DependencyLsp => 8,
        }
    }
}

struct Case {
    name: &'static str,
    category: Category,
    real_files: &'static [&'static str],
    run: fn(),
}

fn case(name: &'static str, category: Category, run: fn()) -> Case {
    Case {
        name,
        category,
        real_files: &[],
        run,
    }
}

fn real_case(
    name: &'static str,
    category: Category,
    real_files: &'static [&'static str],
    run: fn(),
) -> Case {
    Case {
        name,
        category,
        real_files,
        run,
    }
}

#[derive(Default)]
struct CategoryStats {
    passed: usize,
    failed: usize,
}

#[derive(Default)]
struct Benchmark {
    stats: BTreeMap<Category, CategoryStats>,
    latencies_ms: Vec<f64>,
    passed: usize,
    failed: usize,
    real_tasks: usize,
    real_files: BTreeSet<&'static str>,
}

impl Benchmark {
    fn run(&mut self, case: &Case) {
        let started = Instant::now();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(case.run));
        let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
        self.latencies_ms.push(elapsed_ms);

        let stats = self.stats.entry(case.category).or_default();
        match result {
            Ok(()) => {
                self.passed += 1;
                stats.passed += 1;
                println!("[PASS] {} {elapsed_ms:.2}ms", case.name);
            }
            Err(payload) => {
                self.failed += 1;
                stats.failed += 1;
                println!(
                    "[FAIL] {} {elapsed_ms:.2}ms: {}",
                    case.name,
                    panic_message(payload.as_ref())
                );
            }
        }
    }

    fn finish(mut self) {
        for category in Category::ALL {
            let stats = self.stats.get(&category).expect("category statistics");
            println!(
                "category {}: {}/{}",
                category.name(),
                stats.passed,
                stats.passed + stats.failed
            );
        }
        println!(
            "real-files: {} task(s) read {} repository file(s) read-only",
            self.real_tasks,
            self.real_files.len()
        );
        println!("benchmark100: {}/100 passed", self.passed);
        self.latencies_ms
            .sort_by(|left, right| left.total_cmp(right));
        let total = self.latencies_ms.iter().sum::<f64>();
        let count = self.latencies_ms.len() as f64;
        println!(
            "latency: total={total:.2}ms, mean={:.2}ms, p50={:.2}ms, p95={:.2}ms",
            total / count,
            percentile(&self.latencies_ms, 0.50),
            percentile(&self.latencies_ms, 0.95)
        );
        assert_eq!(self.failed, 0, "{} benchmark task(s) failed", self.failed);
        assert_eq!(self.passed, 100, "expected 100 passing tasks");
        assert!(
            self.real_tasks >= 20,
            "expected at least 20 real-repository tasks, found {}",
            self.real_tasks
        );
    }
}

fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    let rank = (fraction * sorted.len() as f64).ceil() as usize;
    sorted[rank.saturating_sub(1).min(sorted.len() - 1)]
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

fn repo_path(relative: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(relative)
}

fn read_text(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

fn parse_fixture(relative: &str) -> ParsedFile {
    parse_source(Path::new(relative), &read_text(&fixture_path(relative)))
}

fn parse_repo(relative: &str) -> ParsedFile {
    parse_source(Path::new(relative), &read_text(&repo_path(relative)))
}

fn parse_source(path: &Path, source: &str) -> ParsedFile {
    let parsed = parse_file(path, source)
        .unwrap_or_else(|error| panic!("parse {}: {error}", path.display()));
    assert!(
        !parsed.has_syntax_errors(),
        "benchmark source {} has syntax errors",
        path.display()
    );
    parsed
}

fn query(name: &str, kind: SymbolKind) -> SymbolQuery {
    SymbolQuery::new(name).with_kind(kind)
}

fn symbol<'a>(entries: &'a [SymbolEntry], name: &str, kind: SymbolKind) -> &'a SymbolEntry {
    entries
        .iter()
        .find(|entry| entry.name == name && entry.kind == kind)
        .unwrap_or_else(|| panic!("missing {kind} symbol `{name}`"))
}

fn symbol_with_prefix<'a>(
    entries: &'a [SymbolEntry],
    source: &str,
    prefix: &str,
) -> &'a SymbolEntry {
    entries
        .iter()
        .find(|entry| source[entry.byte_range()].starts_with(prefix))
        .unwrap_or_else(|| panic!("missing symbol starting with `{prefix}`"))
}

fn required(parsed: &ParsedFile, query: &SymbolQuery) -> SymbolEntry {
    parsed
        .find_symbol(query)
        .unwrap_or_else(|error| panic!("{error}"))
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
        "{} has an empty range",
        entry.name
    );
    assert!(
        entry.end_byte <= source.len(),
        "{} exceeds the source length",
        entry.name
    );
    assert_eq!(entry.start_row, row_at(source, entry.start_byte));
    assert_eq!(entry.end_row, row_at(source, entry.end_byte));
    assert_eq!(entry.start_column, column_at(source, entry.start_byte));
    assert_eq!(entry.end_column, column_at(source, entry.end_byte));
    assert_eq!(entry.line(), entry.start_row + 1);
}

fn assert_edited_parses(parsed: &ParsedFile, edited: &str, task: &str) {
    let reparsed =
        parse_file(&parsed.path, edited).unwrap_or_else(|error| panic!("{task} re-parse: {error}"));
    assert!(
        !reparsed.has_syntax_errors(),
        "{task} introduced syntax errors"
    );
}

fn command_outcome(
    kind: VerificationCheckKind,
    program: &str,
    stdout: &str,
    stderr: &str,
    exit_code: Option<i32>,
) -> CommandOutcome {
    CommandOutcome {
        command: VerificationCommand {
            kind,
            program: program.into(),
            args: vec!["run".into(), kind.label().into()],
            required: true,
            description: "benchmark100 fixture".into(),
        },
        exit_code,
        stdout: stdout.into(),
        stderr: stderr.into(),
        timed_out: false,
        cancelled: false,
        duration_ms: 10,
    }
}

fn failed(kind: VerificationCheckKind, log: &str) -> CommandOutcome {
    command_outcome(kind, "pnpm", log, "", Some(1))
}

fn rust_failed(log: &str) -> CommandOutcome {
    command_outcome(VerificationCheckKind::Test, "cargo", "", log, Some(1))
}

fn diagnostic_codes(diagnostics: &[Diagnostic]) -> Vec<&str> {
    diagnostics
        .iter()
        .map(|diagnostic| diagnostic.code.as_deref().unwrap_or(""))
        .collect()
}

fn match_ids(report: &DiagnosisReport) -> Vec<&str> {
    report
        .matches
        .iter()
        .map(|pattern_match| pattern_match.pattern_id.as_str())
        .collect()
}

fn log_diagnostic(diagnostic: &Diagnostic, log: &str) -> Diagnostic {
    let mut diagnostic = diagnostic.clone();
    diagnostic.raw = Some(log.to_string());
    diagnostic
}

fn dependency_diagnostic(code: Option<&str>, message: &str, file: Option<&str>) -> Diagnostic {
    Diagnostic {
        severity: DiagnosticSeverity::Error,
        message: message.into(),
        code: code.map(str::to_string),
        file: file.map(Into::into),
        line: Some(1),
        column: Some(1),
        confidence: 0.95,
        raw: None,
    }
}

fn make_diagnostic(
    code: &str,
    message: &str,
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

fn fixture_manifest(relative: &str) -> PackageManifest {
    let text = read_text(&fixture_path(relative));
    let value: Value = serde_json::from_str(&text).expect("parse package.json fixture");
    parse_package_manifest(&value).expect("parse package manifest")
}

fn lsp_range(start_line: u32, start_character: u32, end_line: u32, end_character: u32) -> Value {
    json!({
        "start": { "line": start_line, "character": start_character },
        "end": { "line": end_line, "character": end_character }
    })
}

fn lsp_diagnostic(
    severity: Option<u8>,
    code: Option<Value>,
    message: &str,
    line: u32,
    character: u32,
) -> Value {
    let mut value = json!({
        "range": lsp_range(line, character, line, character + 1),
        "message": message
    });
    if let Some(severity) = severity {
        value["severity"] = json!(severity);
    }
    if let Some(code) = code {
        value["code"] = code;
    }
    value
}

fn publish_payload(uri: &str, diagnostics: Vec<Value>) -> Value {
    json!({ "uri": uri, "diagnostics": diagnostics })
}

fn benchmark_cases() -> Vec<Case> {
    vec![
        // Profile detection (8).
        real_case(
            "profile-real-electron-node",
            Category::Profile,
            &["apps/electron/package.json", "apps/electron/pnpm-lock.yaml"],
            profile_real_electron_node,
        ),
        case("profile-python-app", Category::Profile, profile_python_app),
        case("profile-go-app", Category::Profile, profile_go_app),
        real_case(
            "profile-real-rust-workspace",
            Category::Profile,
            &["harness-rs/Cargo.toml"],
            profile_real_rust_workspace,
        ),
        case("profile-java-app", Category::Profile, profile_java_app),
        case(
            "profile-missing-manifest",
            Category::Profile,
            profile_missing_manifest,
        ),
        case(
            "profile-python-uv-wrapper",
            Category::Profile,
            profile_python_uv_wrapper,
        ),
        case(
            "profile-mixed-manifest-precedence",
            Category::Profile,
            profile_mixed_manifest,
        ),
        // Symbol indexing (20): 16 real TypeScript files, 4 language fixtures.
        real_case(
            "real-symbol-types-interfaces",
            Category::Symbols,
            &[REAL_TYPES],
            real_symbol_types_interfaces,
        ),
        real_case(
            "real-symbol-types-aliases",
            Category::Symbols,
            &[REAL_TYPES],
            real_symbol_types_aliases,
        ),
        real_case(
            "real-symbol-engine-class",
            Category::Symbols,
            &[REAL_ENGINE],
            real_symbol_engine_class,
        ),
        real_case(
            "real-symbol-engine-functions",
            Category::Symbols,
            &[REAL_ENGINE],
            real_symbol_engine_functions,
        ),
        real_case(
            "real-symbol-engine-methods",
            Category::Symbols,
            &[REAL_ENGINE],
            real_symbol_engine_methods,
        ),
        real_case(
            "real-symbol-client-interfaces",
            Category::Symbols,
            &[REAL_CLIENT],
            real_symbol_client_interfaces,
        ),
        real_case(
            "real-symbol-client-class",
            Category::Symbols,
            &[REAL_CLIENT],
            real_symbol_client_class,
        ),
        real_case(
            "real-symbol-contracts",
            Category::Symbols,
            &[REAL_CONTRACTS],
            real_symbol_contracts,
        ),
        real_case(
            "real-symbol-agent-types",
            Category::Symbols,
            &[REAL_AGENT_TYPES],
            real_symbol_agent_types,
        ),
        real_case(
            "real-symbol-utils",
            Category::Symbols,
            &[REAL_TOOL_SUMMARY, REAL_ABORT_UTILS],
            real_symbol_utils,
        ),
        real_case(
            "real-symbol-cost-tracker",
            Category::Symbols,
            &[REAL_COST_TRACKER],
            real_symbol_cost_tracker,
        ),
        real_case(
            "real-symbol-tool-registry",
            Category::Symbols,
            &[REAL_TOOL_REGISTRY],
            real_symbol_tool_registry,
        ),
        real_case(
            "real-symbol-chat-utils",
            Category::Symbols,
            &[REAL_CHAT_UTILS],
            real_symbol_chat_utils,
        ),
        real_case(
            "real-symbol-document-watcher",
            Category::Symbols,
            &[REAL_DOCUMENT_WATCHER],
            real_symbol_document_watcher,
        ),
        real_case(
            "real-symbol-log-routing",
            Category::Symbols,
            &[REAL_LOG_ROUTING],
            real_symbol_log_routing,
        ),
        real_case(
            "real-symbol-cross-file-index",
            Category::Symbols,
            REAL_INDEX_FILES,
            real_symbol_cross_file_index,
        ),
        case(
            "fixture-symbol-python-service",
            Category::Symbols,
            fixture_symbol_python_service,
        ),
        case(
            "fixture-symbol-go-service",
            Category::Symbols,
            fixture_symbol_go_service,
        ),
        case(
            "fixture-symbol-rust-service",
            Category::Symbols,
            fixture_symbol_rust_service,
        ),
        case(
            "fixture-symbol-java-service",
            Category::Symbols,
            fixture_symbol_java_service,
        ),
        // Semantic edits (24): TypeScript, Python, Go, Rust, Java.
        case("ts-replace-app", Category::Edits, ts_replace_app),
        case(
            "ts-insert-after-counter-method",
            Category::Edits,
            ts_insert_after_counter_method,
        ),
        case("ts-delete-multiply", Category::Edits, ts_delete_multiply),
        case("ts-rename-add", Category::Edits, ts_rename_add),
        case(
            "ts-ambiguous-selector-rejected",
            Category::Edits,
            ts_ambiguous_selector_rejected,
        ),
        case("ts-noop-rejected", Category::Edits, ts_noop_rejected),
        case(
            "ts-syntax-replacement-rejected",
            Category::Edits,
            ts_syntax_replacement_rejected,
        ),
        real_case(
            "ts-replace-real-abort-constant",
            Category::Edits,
            &[REAL_ABORT_UTILS],
            ts_replace_real_abort_constant,
        ),
        case(
            "py-replace-health-check",
            Category::Edits,
            py_replace_health_check,
        ),
        case(
            "py-insert-after-health-check",
            Category::Edits,
            py_insert_after_health_check,
        ),
        case(
            "py-delete-health-check",
            Category::Edits,
            py_delete_health_check,
        ),
        case(
            "py-rename-load-value",
            Category::Edits,
            py_rename_load_value,
        ),
        case("go-replace-new-user", Category::Edits, go_replace_new_user),
        case(
            "go-insert-after-new-user",
            Category::Edits,
            go_insert_after_new_user,
        ),
        case("go-delete-helper", Category::Edits, go_delete_helper),
        case("go-rename-greet", Category::Edits, go_rename_greet),
        case(
            "rust-replace-new-user",
            Category::Edits,
            rust_replace_new_user,
        ),
        case(
            "rust-insert-after-health-check",
            Category::Edits,
            rust_insert_after_health_check,
        ),
        case("rust-delete-helper", Category::Edits, rust_delete_helper),
        case(
            "rust-rename-health-check",
            Category::Edits,
            rust_rename_health_check,
        ),
        case("java-replace-greet", Category::Edits, java_replace_greet),
        case(
            "java-insert-after-greet",
            Category::Edits,
            java_insert_after_greet,
        ),
        case("java-delete-retries", Category::Edits, java_delete_retries),
        case("java-rename-ping", Category::Edits, java_rename_ping),
        // Diagnostics (20): TypeScript/ESLint/Vitest, Python, Go, Rust, Java.
        case(
            "diagnostics-typescript-basic",
            Category::Diagnostics,
            diagnostics_typescript_basic,
        ),
        case(
            "diagnostics-typescript-extended",
            Category::Diagnostics,
            diagnostics_typescript_extended,
        ),
        case(
            "diagnostics-typescript-syntax-codes",
            Category::Diagnostics,
            diagnostics_typescript_syntax_codes,
        ),
        case(
            "diagnostics-typescript-multi-outcome",
            Category::Diagnostics,
            diagnostics_typescript_multi_outcome,
        ),
        case(
            "diagnostics-eslint-basic",
            Category::Diagnostics,
            diagnostics_eslint_basic,
        ),
        case(
            "diagnostics-eslint-extended",
            Category::Diagnostics,
            diagnostics_eslint_extended,
        ),
        case(
            "diagnostics-eslint-no-explicit-any",
            Category::Diagnostics,
            diagnostics_eslint_no_explicit_any,
        ),
        case(
            "diagnostics-eslint-no-console-empty",
            Category::Diagnostics,
            diagnostics_eslint_no_console_empty,
        ),
        case(
            "diagnostics-vitest-assertion",
            Category::Diagnostics,
            diagnostics_vitest_assertion,
        ),
        case(
            "diagnostics-vitest-timeout",
            Category::Diagnostics,
            diagnostics_vitest_timeout,
        ),
        case(
            "diagnostics-vitest-module-not-found",
            Category::Diagnostics,
            diagnostics_vitest_module_not_found,
        ),
        case(
            "diagnostics-vitest-suite-failure",
            Category::Diagnostics,
            diagnostics_vitest_suite_failure,
        ),
        case(
            "diagnostics-python-lint-lines",
            Category::Diagnostics,
            diagnostics_python_lint_lines,
        ),
        case(
            "diagnostics-python-mypy-and-traceback",
            Category::Diagnostics,
            diagnostics_python_mypy_and_traceback,
        ),
        case(
            "diagnostics-python-pytest-and-module",
            Category::Diagnostics,
            diagnostics_python_pytest_and_module,
        ),
        case(
            "diagnostics-go-compiler-and-vet",
            Category::Diagnostics,
            diagnostics_go_compiler_and_vet,
        ),
        case(
            "diagnostics-go-test-failures",
            Category::Diagnostics,
            diagnostics_go_test_failures,
        ),
        case(
            "diagnostics-rust-compiler",
            Category::Diagnostics,
            diagnostics_rust_compiler,
        ),
        case(
            "diagnostics-rust-test-panic",
            Category::Diagnostics,
            diagnostics_rust_test_panic,
        ),
        case(
            "diagnostics-java-javac-maven-junit",
            Category::Diagnostics,
            diagnostics_java_javac_maven_junit,
        ),
        // Repair planning (12).
        case(
            "repair-retry-priority",
            Category::Repair,
            repair_retry_priority,
        ),
        case(
            "repair-immediate-repeat",
            Category::Repair,
            repair_immediate_repeat,
        ),
        case("repair-seen-twice", Category::Repair, repair_seen_twice),
        case(
            "repair-trailing-duplicate",
            Category::Repair,
            repair_trailing_duplicate,
        ),
        case("repair-max-rounds", Category::Repair, repair_max_rounds),
        case(
            "repair-beyond-max-rounds",
            Category::Repair,
            repair_beyond_max_rounds,
        ),
        case(
            "repair-no-repairable-issue",
            Category::Repair,
            repair_no_repairable_issue,
        ),
        case(
            "repair-warning-only-no-pattern",
            Category::Repair,
            repair_warning_only_no_pattern,
        ),
        case(
            "repair-python-go-diagnostics",
            Category::Repair,
            repair_python_go_diagnostics,
        ),
        case(
            "repair-rust-java-diagnostics",
            Category::Repair,
            repair_rust_java_diagnostics,
        ),
        case(
            "repair-deterministic-order",
            Category::Repair,
            repair_deterministic_order,
        ),
        case(
            "repair-targeted-file-dedupe",
            Category::Repair,
            repair_targeted_file_dedupe,
        ),
        // Formatting (8).
        case(
            "formatting-spaces-insert",
            Category::Formatting,
            formatting_spaces_insert,
        ),
        case(
            "formatting-tabs-insert",
            Category::Formatting,
            formatting_tabs_insert,
        ),
        case(
            "formatting-crlf-preserve",
            Category::Formatting,
            formatting_crlf_preserve,
        ),
        case(
            "formatting-nested-indent",
            Category::Formatting,
            formatting_nested_indent,
        ),
        case(
            "formatting-python-indent",
            Category::Formatting,
            formatting_python_indent,
        ),
        case(
            "formatting-go-tabs",
            Category::Formatting,
            formatting_go_tabs,
        ),
        case(
            "formatting-rust-indent",
            Category::Formatting,
            formatting_rust_indent,
        ),
        case(
            "formatting-java-indent",
            Category::Formatting,
            formatting_java_indent,
        ),
        // Dependency and LSP data parsing (8).
        real_case(
            "dep-real-root-manifest",
            Category::DependencyLsp,
            &["package.json"],
            dep_real_root_manifest,
        ),
        real_case(
            "dep-real-electron-manifest",
            Category::DependencyLsp,
            &["apps/electron/package.json"],
            dep_real_electron_manifest,
        ),
        real_case(
            "dep-real-tsconfig",
            Category::DependencyLsp,
            &["apps/electron/tsconfig.json"],
            dep_real_tsconfig,
        ),
        case(
            "dep-fixture-manifest-sections",
            Category::DependencyLsp,
            dep_fixture_manifest_sections,
        ),
        case(
            "dep-missing-package-and-types",
            Category::DependencyLsp,
            dep_missing_package_and_types,
        ),
        case(
            "dep-peer-version-lockfile",
            Category::DependencyLsp,
            dep_peer_version_lockfile,
        ),
        case(
            "lsp-publish-diagnostics",
            Category::DependencyLsp,
            lsp_publish_diagnostics,
        ),
        case(
            "lsp-symbols-definition-hover-uri",
            Category::DependencyLsp,
            lsp_symbols_definition_hover_uri,
        ),
    ]
}

#[test]
fn benchmark_100_tasks() {
    let cases = benchmark_cases();
    assert_eq!(cases.len(), 100, "benchmark task count");

    let mut counts: BTreeMap<Category, usize> = BTreeMap::new();
    let mut real_files = BTreeSet::new();
    let mut real_tasks = 0;
    for case in &cases {
        *counts.entry(case.category).or_default() += 1;
        if !case.real_files.is_empty() {
            real_tasks += 1;
            real_files.extend(case.real_files.iter().copied());
        }
    }
    for category in Category::ALL {
        assert_eq!(
            counts.get(&category).copied().unwrap_or(0),
            category.expected_count(),
            "{} task count",
            category.name()
        );
    }
    assert!(
        real_tasks >= 20,
        "expected at least 20 real-repository tasks, found {real_tasks}"
    );

    let mut benchmark = Benchmark {
        real_tasks,
        real_files,
        ..Benchmark::default()
    };
    for case in &cases {
        benchmark.run(case);
    }
    benchmark.finish();
}

// ---------------------------------------------------------------------------
// Profile detection.
// ---------------------------------------------------------------------------

fn profile_real_electron_node() {
    let profile = detect_profile(&repo_path("apps/electron")).expect("detect Electron profile");
    assert_eq!(profile.project_kind, ProjectKind::FrontendNode);
    assert_eq!(profile.package_manager, Some(PackageManager::Pnpm));
    assert!(profile.source.contains("pnpm-lock.yaml"));
    assert_eq!(profile.commands.len(), 2);
    assert_eq!(
        profile
            .commands
            .iter()
            .map(|command| command.kind)
            .collect::<Vec<_>>(),
        vec![
            VerificationCheckKind::Typecheck,
            VerificationCheckKind::Build,
        ]
    );
    assert_eq!(profile.commands[0].args, vec!["run", "typecheck"]);
    assert_eq!(profile.commands[1].args, vec!["run", "build"]);
    assert!(profile
        .commands
        .iter()
        .all(|command| command.program == "pnpm" && command.required));
}

fn profile_python_app() {
    let profile =
        detect_profile(&fixture_path("benchmark100/python-app")).expect("detect Python profile");
    assert_eq!(profile.project_kind, ProjectKind::Python);
    assert!(profile.package_manager.is_none());
    assert_eq!(profile.commands.len(), 4);
    assert_eq!(
        profile
            .commands
            .iter()
            .map(|command| (command.kind, command.program.as_str()))
            .collect::<Vec<_>>(),
        vec![
            (VerificationCheckKind::Test, "pytest"),
            (VerificationCheckKind::Typecheck, "mypy"),
            (VerificationCheckKind::Lint, "ruff"),
            (VerificationCheckKind::Build, "python"),
        ]
    );
    assert_eq!(profile.commands[1].args, vec!["."]);
    assert_eq!(profile.commands[2].args, vec!["check", "."]);
    assert!(profile.source.contains("pyproject.toml"));
    assert!(profile.source.contains("[tool.mypy]"));
    assert!(profile.source.contains("[tool.ruff]"));
    assert!(profile.commands.iter().all(|command| command.required));
}

fn profile_go_app() {
    let profile = detect_profile(&fixture_path("benchmark100/go-app")).expect("detect Go profile");
    assert_eq!(profile.project_kind, ProjectKind::Go);
    assert!(profile.package_manager.is_none());
    assert_eq!(profile.commands.len(), 3);
    assert_eq!(
        profile
            .commands
            .iter()
            .map(|command| command.args.clone())
            .collect::<Vec<_>>(),
        vec![
            vec!["vet".to_string(), "./...".to_string()],
            vec!["test".to_string(), "./...".to_string()],
            vec!["build".to_string(), "./...".to_string()],
        ]
    );
    assert!(profile
        .commands
        .iter()
        .all(|command| command.program == "go"));
    assert!(profile.source.contains("go.mod"));
}

fn profile_real_rust_workspace() {
    let profile = detect_profile(&repo_path("harness-rs")).expect("detect Rust workspace");
    assert_eq!(profile.project_kind, ProjectKind::Rust);
    assert!(profile.package_manager.is_none());
    assert!(profile.source.contains("Cargo.toml"));
    assert!(profile.source.contains("workspace"));
    assert_eq!(profile.commands.len(), 4);
    assert_eq!(
        profile
            .commands
            .iter()
            .map(|command| command.args.clone())
            .collect::<Vec<_>>(),
        vec![
            vec!["check".to_string()],
            vec![
                "clippy".to_string(),
                "--".to_string(),
                "-D".to_string(),
                "warnings".to_string()
            ],
            vec!["test".to_string()],
            vec!["build".to_string()],
        ]
    );
    assert!(profile
        .commands
        .iter()
        .all(|command| command.program == "cargo" && command.required));
}

fn profile_java_app() {
    let profile =
        detect_profile(&fixture_path("benchmark100/java-app")).expect("detect Java profile");
    assert_eq!(profile.project_kind, ProjectKind::Java);
    assert!(profile.package_manager.is_none());
    assert_eq!(profile.commands.len(), 3);
    assert_eq!(
        profile
            .commands
            .iter()
            .map(|command| command.kind)
            .collect::<Vec<_>>(),
        vec![
            VerificationCheckKind::Typecheck,
            VerificationCheckKind::Test,
            VerificationCheckKind::Build,
        ]
    );
    assert!(profile
        .commands
        .iter()
        .all(|command| command.program == "mvn"));
    assert_eq!(
        profile.commands[0].args,
        vec!["-q", "-DskipTests", "compile"]
    );
    assert_eq!(profile.commands[1].args, vec!["-q", "test"]);
    assert_eq!(
        profile.commands[2].args,
        vec!["-q", "-DskipTests", "package"]
    );
    assert!(profile.source.contains("pom.xml"));
    assert!(profile.source.contains("wrapper not found"));
}

fn profile_missing_manifest() {
    let profile = detect_profile(&fixture_path("benchmark100/no-project"))
        .expect("missing manifest is not an error");
    assert_eq!(profile.project_kind, ProjectKind::Unknown);
    assert!(profile.package_manager.is_none());
    assert!(profile.commands.is_empty());
    assert!(profile.source.contains("No supported project manifest"));
}

fn profile_python_uv_wrapper() {
    let profile = detect_profile(&fixture_path("benchmark100/python-wrapper"))
        .expect("detect uv-wrapped Python profile");
    assert_eq!(profile.project_kind, ProjectKind::Python);
    assert_eq!(profile.commands.len(), 3);
    assert!(profile
        .commands
        .iter()
        .all(|command| command.program == "uv"));
    assert_eq!(
        profile.commands[0].args,
        vec!["run".to_string(), "pytest".to_string()]
    );
    assert_eq!(
        profile.commands[1].args,
        vec!["run".to_string(), "mypy".to_string(), ".".to_string()]
    );
    assert_eq!(
        profile.commands[2].args,
        vec![
            "run".to_string(),
            "python".to_string(),
            "-m".to_string(),
            "compileall".to_string(),
            "-q".to_string(),
            ".".to_string()
        ]
    );
    assert!(profile.source.contains("uv.lock"));
}

fn profile_mixed_manifest() {
    let profile = detect_profile(&fixture_path("benchmark100/mixed-app"))
        .expect("detect mixed project profile");
    assert_eq!(profile.project_kind, ProjectKind::FrontendNode);
    assert_eq!(profile.package_manager, Some(PackageManager::Npm));
    assert_eq!(profile.commands.len(), 2);
    assert_eq!(
        profile
            .commands
            .iter()
            .map(|command| command.kind)
            .collect::<Vec<_>>(),
        vec![VerificationCheckKind::Test, VerificationCheckKind::Build]
    );
    assert!(profile.source.contains("package.json"));
    assert!(profile.source.contains("npm"));
}

// ---------------------------------------------------------------------------
// Symbol indexing.
// ---------------------------------------------------------------------------

fn real_symbol_types_interfaces() {
    let parsed = parse_repo(REAL_TYPES);
    for (name, kind) in [
        ("AIConfigInput", SymbolKind::Interface),
        ("AIRequestOptions", SymbolKind::Interface),
        ("ProgressCallback", SymbolKind::Interface),
        ("AIHarness", SymbolKind::Interface),
    ] {
        let entry = required(&parsed, &query(name, kind));
        assert!(entry.exported, "{name} should be exported");
        assert!(entry.parent_path.is_empty());
        assert_range(&parsed.source, &entry);
        assert!(parsed.source[entry.byte_range()].contains(name));
    }
}

fn real_symbol_types_aliases() {
    let parsed = parse_repo(REAL_TYPES);
    for (name, kind) in [
        ("ProgressEvent", SymbolKind::Type),
        ("StreamEvent", SymbolKind::Type),
        ("CustomToolRegistration", SymbolKind::Interface),
        ("AIExecutionEngine", SymbolKind::Interface),
    ] {
        let entry = required(&parsed, &query(name, kind));
        assert!(entry.exported);
        assert_range(&parsed.source, &entry);
    }
    let imported = required(&parsed, &query("AILogSessionLogger", SymbolKind::Import));
    assert!(!imported.exported);
    assert!(parsed.source[imported.byte_range()].contains("AILogSessionLogger"));
}

fn real_symbol_engine_class() {
    let parsed = parse_repo(REAL_ENGINE);
    let engine = required(&parsed, &query("RustHarnessEngine", SymbolKind::Type));
    assert!(engine.exported);
    assert_range(&parsed.source, &engine);
    for method in ["start", "chat"] {
        let entry = required(
            &parsed,
            &SymbolQuery::new(method)
                .with_kind(SymbolKind::Method)
                .with_parent("RustHarnessEngine"),
        );
        assert_range(&parsed.source, &entry);
        assert!(parsed.source[entry.byte_range()].contains(method));
    }
}

fn real_symbol_engine_functions() {
    let parsed = parse_repo(REAL_ENGINE);
    for (name, exported) in [
        ("shouldExecuteInElectronHost", false),
        ("planModeExitedAfterNativeResult", true),
        ("codingEventsForToolResult", true),
        ("webToolResultEvents", true),
        ("fileWritePreviewEvents", true),
    ] {
        let entry = required(&parsed, &query(name, SymbolKind::Function));
        assert_eq!(entry.exported, exported, "{name} export flag");
        assert_range(&parsed.source, &entry);
    }
}

fn real_symbol_engine_methods() {
    let parsed = parse_repo(REAL_ENGINE);
    for method in [
        "collectCustomTools",
        "handleNativeToolResult",
        "recordUsage",
        "nativeToolNames",
    ] {
        let entry = required(
            &parsed,
            &SymbolQuery::new(method)
                .with_kind(SymbolKind::Method)
                .with_parent("RustHarnessEngine"),
        );
        assert_range(&parsed.source, &entry);
        assert_eq!(entry.parent_path, vec!["RustHarnessEngine"]);
    }
}

fn real_symbol_client_interfaces() {
    let parsed = parse_repo(REAL_CLIENT);
    for (name, kind) in [
        ("RustEventFrame", SymbolKind::Interface),
        ("RustHostRequest", SymbolKind::Interface),
        ("RustChatOptions", SymbolKind::Interface),
        ("RustToolDescriptor", SymbolKind::Interface),
        ("JsonRpcResult", SymbolKind::Type),
    ] {
        let entry = required(&parsed, &query(name, kind));
        assert!(entry.exported);
        assert_range(&parsed.source, &entry);
    }
}

fn real_symbol_client_class() {
    let parsed = parse_repo(REAL_CLIENT);
    let client = required(&parsed, &query("RustHarnessClient", SymbolKind::Type));
    assert!(client.exported);
    assert_range(&parsed.source, &client);
    for method in ["start", "call", "chatStream"] {
        let entry = required(
            &parsed,
            &SymbolQuery::new(method)
                .with_kind(SymbolKind::Method)
                .with_parent("RustHarnessClient"),
        );
        assert_range(&parsed.source, &entry);
        assert_eq!(entry.parent_path, vec!["RustHarnessClient"]);
    }
}

fn real_symbol_contracts() {
    let parsed = parse_repo(REAL_CONTRACTS);
    for (name, kind) in [
        ("ChatContentTextPart", SymbolKind::Interface),
        ("ChatMessage", SymbolKind::Interface),
        ("ToolDefinition", SymbolKind::Interface),
        ("ChatContentPart", SymbolKind::Type),
        ("MessageContent", SymbolKind::Type),
    ] {
        let entry = required(&parsed, &query(name, kind));
        assert!(entry.exported, "{name} should be exported");
        assert_range(&parsed.source, &entry);
    }
}

fn real_symbol_agent_types() {
    let parsed = parse_repo(REAL_AGENT_TYPES);
    for (name, kind) in [
        ("AgentDefinition", SymbolKind::Interface),
        ("AgentGroupDefinition", SymbolKind::Interface),
        ("MemoryEntry", SymbolKind::Interface),
        ("MemoryType", SymbolKind::Type),
        ("MemoryEntryStatus", SymbolKind::Type),
    ] {
        let entry = required(&parsed, &query(name, kind));
        assert!(entry.exported);
        assert_range(&parsed.source, &entry);
    }
}

fn real_symbol_utils() {
    let summary = parse_repo(REAL_TOOL_SUMMARY);
    for (name, kind, exported) in [
        ("buildToolRunSummary", SymbolKind::Function, true),
        ("filePathForToolRun", SymbolKind::Function, true),
        ("MAX_SUMMARY_CHARS", SymbolKind::Variable, false),
    ] {
        let entry = required(&summary, &query(name, kind));
        assert_eq!(entry.exported, exported, "{name} export flag");
        assert_range(&summary.source, &entry);
    }

    let abort_utils = parse_repo(REAL_ABORT_UTILS);
    for (name, kind) in [
        ("USER_ABORT_MESSAGE", SymbolKind::Variable),
        ("normalizeAbortReason", SymbolKind::Function),
    ] {
        let entry = required(&abort_utils, &query(name, kind));
        assert!(entry.exported);
        assert_range(&abort_utils.source, &entry);
    }
}

fn real_symbol_cost_tracker() {
    let parsed = parse_repo(REAL_COST_TRACKER);
    let pricing = required(&parsed, &query("ModelPricing", SymbolKind::Interface));
    assert!(pricing.exported);
    let table = required(
        &parsed,
        &query("DEFAULT_MODEL_PRICING", SymbolKind::Variable),
    );
    assert!(table.exported);
    for name in ["resolveDefaultModelPricing", "resolveModelPricing"] {
        let entry = required(&parsed, &query(name, SymbolKind::Function));
        assert!(entry.exported, "{name} should be exported");
        assert_range(&parsed.source, &entry);
    }
}

fn real_symbol_tool_registry() {
    let parsed = parse_repo(REAL_TOOL_REGISTRY);
    for (name, kind) in [
        ("ElectronToolRegistryServices", SymbolKind::Interface),
        ("ElectronToolRunContext", SymbolKind::Interface),
        ("ElectronToolRegistryOptions", SymbolKind::Interface),
        ("ElectronToolRegistry", SymbolKind::Type),
    ] {
        let entry = required(&parsed, &query(name, kind));
        assert!(entry.exported);
        assert_range(&parsed.source, &entry);
    }
    for method in ["getToolDefinitions", "createRegistrations"] {
        let entry = required(
            &parsed,
            &SymbolQuery::new(method)
                .with_kind(SymbolKind::Method)
                .with_parent("ElectronToolRegistry"),
        );
        assert_range(&parsed.source, &entry);
    }
    let private_method = required(
        &parsed,
        &SymbolQuery::new("collect")
            .with_kind(SymbolKind::Method)
            .with_parent("ElectronToolRegistry"),
    );
    assert!(!private_method.exported);
}

fn real_symbol_chat_utils() {
    let parsed = parse_repo(REAL_CHAT_UTILS);
    for name in [
        "getMessageText",
        "serializeMessageContentForDisplay",
        "getTaskLabelFromMessages",
        "truncateSectionText",
    ] {
        let entry = required(&parsed, &query(name, SymbolKind::Function));
        assert!(entry.exported);
        assert_range(&parsed.source, &entry);
    }
    let imported = required(&parsed, &query("MessageContent", SymbolKind::Import));
    assert!(!imported.exported);
}

fn real_symbol_document_watcher() {
    let parsed = parse_repo(REAL_DOCUMENT_WATCHER);
    let change = required(&parsed, &query("DocumentFileChange", SymbolKind::Interface));
    assert!(change.exported);
    let watcher = required(&parsed, &query("DocumentFileWatcher", SymbolKind::Type));
    assert!(watcher.exported);
    for method in ["watch", "unwatch", "dispose", "onChange", "watchedPaths"] {
        let entry = required(
            &parsed,
            &SymbolQuery::new(method)
                .with_kind(SymbolKind::Method)
                .with_parent("DocumentFileWatcher"),
        );
        assert_range(&parsed.source, &entry);
    }
    let private_method = required(
        &parsed,
        &SymbolQuery::new("disposeEntry")
            .with_kind(SymbolKind::Method)
            .with_parent("DocumentFileWatcher"),
    );
    assert!(!private_method.exported);
}

fn real_symbol_log_routing() {
    let parsed = parse_repo(REAL_LOG_ROUTING);
    for (name, kind) in [
        ("ProjectRuntimeLogType", SymbolKind::Type),
        ("RustProjectLogSink", SymbolKind::Interface),
        ("TypeScriptProjectLogSink", SymbolKind::Interface),
        ("ProjectRuntimeLogRoute", SymbolKind::Interface),
        ("forwardProjectRuntimeLog", SymbolKind::Function),
    ] {
        let entry = required(&parsed, &query(name, kind));
        assert!(entry.exported);
        assert!(entry.parent_path.is_empty());
        assert_range(&parsed.source, &entry);
    }
}

fn real_symbol_cross_file_index() {
    let mut total_symbols = 0;
    for relative in REAL_INDEX_FILES {
        let parsed = parse_repo(relative);
        let entries = parsed.symbols();
        total_symbols += entries.len();
        assert!(
            entries
                .windows(2)
                .all(|window| window[0].start_byte <= window[1].start_byte),
            "{relative} symbols are not in source order"
        );
        for entry in &entries {
            assert_range(&parsed.source, entry);
        }
        let stride = entries.len().div_ceil(48).max(1);
        for entry in entries.iter().step_by(stride) {
            let query = SymbolQuery::new(&entry.name)
                .with_kind(entry.kind)
                .with_parent_path(entry.parent_path.clone());
            let matches = parsed.find_symbols(&query);
            assert!(
                matches.iter().any(|found| {
                    found.start_byte == entry.start_byte && found.end_byte == entry.end_byte
                }),
                "{relative}: query {query} did not find indexed symbol"
            );
        }
    }
    assert!(
        total_symbols >= 100,
        "expected a large real symbol corpus, found {total_symbols}"
    );
}

fn fixture_symbol_python_service() {
    let parsed = parse_fixture("benchmark100/python-app/src/service.py");
    let entries = parsed.symbols();

    let os_import = symbol(&entries, "os", SymbolKind::Import);
    assert!(os_import.exported);
    assert_range(&parsed.source, os_import);

    let max_retries = symbol(&entries, "MAX_RETRIES", SymbolKind::Variable);
    assert!(max_retries.exported);
    assert!(max_retries.parent_path.is_empty());
    let private_cache = symbol(&entries, "_private_cache", SymbolKind::Variable);
    assert!(!private_cache.exported);

    let config = symbol(&entries, "ServiceConfig", SymbolKind::Type);
    assert!(config.exported);
    let field = symbol(&entries, "name", SymbolKind::Variable);
    assert_eq!(field.parent_path, vec!["ServiceConfig"]);
    assert!(!field.exported);

    let service = symbol(&entries, "Service", SymbolKind::Type);
    assert!(service.exported);
    for method in ["__init__", "fetch", "reset"] {
        let entry = symbol(&entries, method, SymbolKind::Function);
        assert_eq!(entry.parent_path, vec!["Service"]);
        assert!(!entry.exported);
        assert_range(&parsed.source, entry);
    }
    let load = symbol(&entries, "load_value", SymbolKind::Function);
    assert!(load.exported);
    let health = symbol(&entries, "health_check", SymbolKind::Function);
    assert!(health.exported);
}

fn fixture_symbol_go_service() {
    let parsed = parse_fixture("benchmark100/go-app/service.go");
    let entries = parsed.symbols();

    let fmt_import = symbol(&entries, "fmt", SymbolKind::Import);
    assert!(!fmt_import.exported);
    let alias_import = symbol(&entries, "alias", SymbolKind::Import);
    assert!(!alias_import.exported);
    assert!(parsed.source[alias_import.byte_range()].contains("example.com/support"));

    for name in ["User", "Greeter", "ID"] {
        let entry = symbol(&entries, name, SymbolKind::Type);
        assert!(entry.exported, "{name} should be exported");
        assert!(entry.parent_path.is_empty());
        assert_range(&parsed.source, entry);
    }
    assert!(symbol(&entries, "MaxRetries", SymbolKind::Variable).exported);
    assert!(!symbol(&entries, "defaultTimeout", SymbolKind::Variable).exported);
    assert!(symbol(&entries, "NewUser", SymbolKind::Function).exported);
    assert!(!symbol(&entries, "describe", SymbolKind::Function).exported);
    assert!(!symbol(&entries, "helper", SymbolKind::Function).exported);
    assert!(symbol(&entries, "Greet", SymbolKind::Method).exported);
    assert!(!symbol(&entries, "rename", SymbolKind::Method).exported);
}

fn fixture_symbol_rust_service() {
    let parsed = parse_fixture("benchmark100/rust-app/src/lib.rs");
    let entries = parsed.symbols();

    let imported = symbol(&entries, "std::collections::HashMap", SymbolKind::Import);
    assert!(!imported.exported);

    let user_struct = symbol_with_prefix(&entries, &parsed.source, "pub struct User");
    assert_eq!(user_struct.kind, SymbolKind::Type);
    assert!(user_struct.exported);
    assert_eq!(
        parsed
            .find_symbols(&SymbolQuery::new("User").with_kind(SymbolKind::Type))
            .len(),
        2,
        "the struct and impl share the type name"
    );

    for name in ["Greeter", "Mode", "UserId"] {
        let entry = symbol(&entries, name, SymbolKind::Type);
        assert!(entry.exported, "{name} should be exported");
    }
    assert!(symbol(&entries, "MAX_RETRIES", SymbolKind::Variable).exported);
    assert!(!symbol(&entries, "DEFAULT_TIMEOUT", SymbolKind::Variable).exported);

    let new = required(
        &parsed,
        &SymbolQuery::new("new")
            .with_kind(SymbolKind::Function)
            .with_parent("User"),
    );
    assert!(new.exported);
    let rename = required(
        &parsed,
        &SymbolQuery::new("rename")
            .with_kind(SymbolKind::Function)
            .with_parent("User"),
    );
    assert!(!rename.exported);
    let greet = required(
        &parsed,
        &SymbolQuery::new("greet")
            .with_kind(SymbolKind::Function)
            .with_parent("User"),
    );
    assert!(greet.exported);
    let trait_greet = required(
        &parsed,
        &SymbolQuery::new("greet")
            .with_kind(SymbolKind::Function)
            .with_parent("Greeter"),
    );
    assert!(trait_greet.exported);
    assert!(symbol(&entries, "health_check", SymbolKind::Function).exported);
    assert!(!symbol(&entries, "helper", SymbolKind::Function).exported);
}

fn fixture_symbol_java_service() {
    let parsed =
        parse_fixture("benchmark100/java-app/src/main/java/com/example/bench/Service.java");
    let entries = parsed.symbols();

    let module = symbol(&entries, "com.example.bench", SymbolKind::Module);
    assert_eq!(module.parent_path, Vec::<String>::new());
    let imported = symbol(&entries, "java.util.List", SymbolKind::Import);
    assert!(!imported.exported);

    let service = symbol(&entries, "Service", SymbolKind::Type);
    assert!(service.exported);
    let helper = symbol(&entries, "Helper", SymbolKind::Type);
    assert_eq!(helper.parent_path, vec!["Service"]);
    assert!(helper.exported);
    let contract = symbol(&entries, "Contract", SymbolKind::Interface);
    assert!(!contract.exported);

    let max_retries = required(
        &parsed,
        &SymbolQuery::new("MAX_RETRIES")
            .with_kind(SymbolKind::Variable)
            .with_parent("Service"),
    );
    assert!(max_retries.exported);
    let name = required(
        &parsed,
        &SymbolQuery::new("name")
            .with_kind(SymbolKind::Variable)
            .with_parent("Service"),
    );
    assert!(!name.exported);

    let greet = required(
        &parsed,
        &SymbolQuery::new("greet")
            .with_kind(SymbolKind::Method)
            .with_parent("Service"),
    );
    assert!(greet.exported);
    let retries = required(
        &parsed,
        &SymbolQuery::new("retries")
            .with_kind(SymbolKind::Method)
            .with_parent("Service"),
    );
    assert!(!retries.exported);
    let ping = required(
        &parsed,
        &SymbolQuery::new("ping")
            .with_kind(SymbolKind::Method)
            .with_parent("Service.Helper"),
    );
    assert!(ping.exported);
    let run = required(
        &parsed,
        &SymbolQuery::new("run")
            .with_kind(SymbolKind::Method)
            .with_parent("Contract"),
    );
    assert!(run.exported);
}

// ---------------------------------------------------------------------------
// Semantic edits.
// ---------------------------------------------------------------------------

fn ts_replace_app() {
    let parsed = parse_fixture("frontend-app/src/App.tsx");
    let replacement = "function App() {\n  return <main>benchmark</main>;\n}";
    let proposal = replace_symbol(&parsed, &query("App", SymbolKind::Function), replacement)
        .expect("replace App");
    assert!(proposal
        .edited_source
        .contains("return <main>benchmark</main>;"));
    assert!(!proposal.edited_source.contains("Frontend Benchmark"));
    assert_edited_parses(&parsed, &proposal.edited_source, "replace App");
}

fn ts_insert_after_counter_method() {
    let parsed = parse_fixture("frontend-app/src/components/Counter.tsx");
    let proposal = insert_after(
        &parsed,
        &SymbolQuery::new("increment")
            .with_kind(SymbolKind::Function)
            .with_parent("Counter"),
        "function extra() {\n  return 1;\n}",
    )
    .expect("insert after Counter::increment");
    assert!(proposal
        .edited_source
        .contains("\n  function extra() {\n    return 1;\n  }\n"));
    assert_edited_parses(&parsed, &proposal.edited_source, "insert Counter method");
}

fn ts_delete_multiply() {
    let parsed = parse_fixture("frontend-app/src/lib/math.ts");
    let proposal =
        delete_symbol(&parsed, &query("multiply", SymbolKind::Function)).expect("delete multiply");
    assert!(!proposal.edited_source.contains("function multiply"));
    assert!(proposal.edited_source.contains("function add"));
    assert_edited_parses(&parsed, &proposal.edited_source, "delete multiply");
}

fn ts_rename_add() {
    let parsed = parse_fixture("frontend-app/src/lib/math.ts");
    let proposal =
        rename_symbol(&parsed, &query("add", SymbolKind::Function), "sum").expect("rename add");
    assert!(proposal.edited_source.contains("function sum("));
    assert!(!proposal.edited_source.contains("function add("));
    assert_edited_parses(&parsed, &proposal.edited_source, "rename add");
}

fn ts_ambiguous_selector_rejected() {
    let source = "function duplicate() {}\nfunction duplicate() { return 1; }\n";
    let parsed = parse_source(Path::new("benchmark100/ambiguous.ts"), source);
    let error = delete_symbol(&parsed, &query("duplicate", SymbolKind::Function))
        .expect_err("ambiguous delete must fail");
    assert!(
        error.to_string().contains("ambiguous symbol"),
        "unexpected error: {error}"
    );
    assert_eq!(parsed.source, source);
}

fn ts_noop_rejected() {
    let parsed = parse_fixture("frontend-app/src/App.tsx");
    let entry = required(&parsed, &query("App", SymbolKind::Function));
    let original = parsed.source[entry.byte_range()].to_string();
    let error = replace_symbol(&parsed, &query("App", SymbolKind::Function), original)
        .expect_err("identical replacement must fail");
    assert!(
        error.to_string().contains("no-op"),
        "unexpected error: {error}"
    );
}

fn ts_syntax_replacement_rejected() {
    let parsed = parse_fixture("frontend-app/src/App.tsx");
    let error = replace_symbol(
        &parsed,
        &query("App", SymbolKind::Function),
        "function App() {",
    )
    .expect_err("invalid replacement must fail");
    assert!(
        error.to_string().contains("syntax errors"),
        "unexpected error: {error}"
    );
}

fn ts_replace_real_abort_constant() {
    let parsed = parse_repo(REAL_ABORT_UTILS);
    let proposal = replace_symbol(
        &parsed,
        &query("USER_ABORT_MESSAGE", SymbolKind::Variable),
        "const USER_ABORT_MESSAGE = 'stopped'",
    )
    .expect("replace real abort message");
    assert!(proposal
        .edited_source
        .contains("USER_ABORT_MESSAGE = 'stopped'"));
    assert!(!proposal
        .edited_source
        .contains("AI generation stopped by user"));
    assert_edited_parses(&parsed, &proposal.edited_source, "replace real constant");
}

fn py_replace_health_check() {
    let parsed = parse_fixture("benchmark100/python-app/src/service.py");
    let proposal = replace_symbol(
        &parsed,
        &query("health_check", SymbolKind::Function),
        "def health_check():\n    return False",
    )
    .expect("replace Python function");
    assert!(proposal.edited_source.contains("return False"));
    assert_edited_parses(&parsed, &proposal.edited_source, "replace Python function");
}

fn py_insert_after_health_check() {
    let parsed = parse_fixture("benchmark100/python-app/src/service.py");
    let proposal = insert_after(
        &parsed,
        &query("health_check", SymbolKind::Function),
        "def ready():\n    return health_check()",
    )
    .expect("insert Python function");
    assert!(proposal
        .edited_source
        .contains("\ndef ready():\n    return health_check()\n"));
    assert_edited_parses(&parsed, &proposal.edited_source, "insert Python function");
}

fn py_delete_health_check() {
    let parsed = parse_fixture("benchmark100/python-app/src/service.py");
    let proposal = delete_symbol(&parsed, &query("health_check", SymbolKind::Function))
        .expect("delete Python function");
    assert!(!proposal.edited_source.contains("def health_check"));
    assert!(proposal.edited_source.contains("def load_value"));
    assert_edited_parses(&parsed, &proposal.edited_source, "delete Python function");
}

fn py_rename_load_value() {
    let parsed = parse_fixture("benchmark100/python-app/src/service.py");
    let proposal = rename_symbol(
        &parsed,
        &query("load_value", SymbolKind::Function),
        "load_cached_value",
    )
    .expect("rename Python function");
    assert!(proposal
        .edited_source
        .contains("def load_cached_value(key):"));
    assert!(proposal
        .edited_source
        .contains("return load_cached_value(key)"));
    assert!(!proposal.edited_source.contains("load_value"));
    assert_edited_parses(&parsed, &proposal.edited_source, "rename Python function");
}

fn go_replace_new_user() {
    let parsed = parse_fixture("benchmark100/go-app/service.go");
    let proposal = replace_symbol(
        &parsed,
        &query("NewUser", SymbolKind::Function),
        "func NewUser(name string) User {\n\treturn User{Name: name + \"!\"}\n}",
    )
    .expect("replace Go function");
    assert!(proposal.edited_source.contains("name + \"!\""));
    assert_edited_parses(&parsed, &proposal.edited_source, "replace Go function");
}

fn go_insert_after_new_user() {
    let parsed = parse_fixture("benchmark100/go-app/service.go");
    let proposal = insert_after(
        &parsed,
        &query("NewUser", SymbolKind::Function),
        "func NewGuest() User {\n\treturn User{}\n}",
    )
    .expect("insert Go function");
    assert!(proposal
        .edited_source
        .contains("\nfunc NewGuest() User {\n\treturn User{}\n}\n"));
    assert_edited_parses(&parsed, &proposal.edited_source, "insert Go function");
}

fn go_delete_helper() {
    let parsed = parse_fixture("benchmark100/go-app/service.go");
    let proposal =
        delete_symbol(&parsed, &query("helper", SymbolKind::Function)).expect("delete Go helper");
    assert!(!proposal.edited_source.contains("func helper"));
    assert!(proposal.edited_source.contains("func describe"));
    assert_edited_parses(&parsed, &proposal.edited_source, "delete Go helper");
}

fn go_rename_greet() {
    let parsed = parse_fixture("benchmark100/go-app/service.go");
    let proposal = rename_symbol(&parsed, &query("Greet", SymbolKind::Method), "Welcome")
        .expect("rename Go method");
    assert!(proposal.edited_source.contains("func (u User) Welcome()"));
    assert!(proposal.edited_source.contains("user.Welcome()"));
    assert!(!proposal.edited_source.contains("user.Greet()"));
    assert_edited_parses(&parsed, &proposal.edited_source, "rename Go method");
}

fn rust_replace_new_user() {
    let parsed = parse_fixture("benchmark100/rust-app/src/lib.rs");
    let proposal = replace_symbol(
        &parsed,
        &SymbolQuery::new("new")
            .with_kind(SymbolKind::Function)
            .with_parent("User"),
        "pub fn new(name: &str) -> Self {\n    Self { name: format!(\"{name}!\") }\n}",
    )
    .expect("replace Rust method");
    assert!(proposal.edited_source.contains("format!(\"{name}!\")"));
    assert_edited_parses(&parsed, &proposal.edited_source, "replace Rust method");
}

fn rust_insert_after_health_check() {
    let parsed = parse_fixture("benchmark100/rust-app/src/lib.rs");
    let proposal = insert_after(
        &parsed,
        &query("health_check", SymbolKind::Function),
        "pub fn ready() -> bool {\n    health_check()\n}",
    )
    .expect("insert Rust function");
    assert!(proposal
        .edited_source
        .contains("\npub fn ready() -> bool {\n    health_check()\n}\n"));
    assert_edited_parses(&parsed, &proposal.edited_source, "insert Rust function");
}

fn rust_delete_helper() {
    let parsed = parse_fixture("benchmark100/rust-app/src/lib.rs");
    let proposal =
        delete_symbol(&parsed, &query("helper", SymbolKind::Function)).expect("delete Rust helper");
    assert!(!proposal.edited_source.contains("fn helper"));
    assert!(proposal.edited_source.contains("fn status"));
    assert_edited_parses(&parsed, &proposal.edited_source, "delete Rust helper");
}

fn rust_rename_health_check() {
    let parsed = parse_fixture("benchmark100/rust-app/src/lib.rs");
    let proposal = rename_symbol(
        &parsed,
        &query("health_check", SymbolKind::Function),
        "is_healthy",
    )
    .expect("rename Rust function");
    assert!(proposal.edited_source.contains("pub fn is_healthy()"));
    assert!(proposal.edited_source.contains("    is_healthy()"));
    assert!(!proposal.edited_source.contains("health_check()"));
    assert_edited_parses(&parsed, &proposal.edited_source, "rename Rust function");
}

fn java_replace_greet() {
    let parsed =
        parse_fixture("benchmark100/java-app/src/main/java/com/example/bench/Service.java");
    let proposal = replace_symbol(
        &parsed,
        &SymbolQuery::new("greet")
            .with_kind(SymbolKind::Method)
            .with_parent("Service"),
        "public String greet() {\n    return \"hi \" + name;\n}",
    )
    .expect("replace Java method");
    assert!(proposal.edited_source.contains("return \"hi \" + name;"));
    assert_edited_parses(&parsed, &proposal.edited_source, "replace Java method");
}

fn java_insert_after_greet() {
    let parsed =
        parse_fixture("benchmark100/java-app/src/main/java/com/example/bench/Service.java");
    let proposal = insert_after(
        &parsed,
        &SymbolQuery::new("greet")
            .with_kind(SymbolKind::Method)
            .with_parent("Service"),
        "public String farewell() {\n    return \"bye\";\n}",
    )
    .expect("insert Java method");
    assert!(proposal
        .edited_source
        .contains("\n    public String farewell() {\n        return \"bye\";\n    }\n"));
    assert_edited_parses(&parsed, &proposal.edited_source, "insert Java method");
}

fn java_delete_retries() {
    let parsed =
        parse_fixture("benchmark100/java-app/src/main/java/com/example/bench/Service.java");
    let proposal = delete_symbol(
        &parsed,
        &SymbolQuery::new("retries")
            .with_kind(SymbolKind::Method)
            .with_parent("Service"),
    )
    .expect("delete Java method");
    assert!(!proposal.edited_source.contains("private int retries"));
    assert!(proposal.edited_source.contains("public String greet"));
    assert_edited_parses(&parsed, &proposal.edited_source, "delete Java method");
}

fn java_rename_ping() {
    let parsed =
        parse_fixture("benchmark100/java-app/src/main/java/com/example/bench/Service.java");
    let proposal = rename_symbol(
        &parsed,
        &SymbolQuery::new("ping")
            .with_kind(SymbolKind::Method)
            .with_parent("Service.Helper"),
        "pong",
    )
    .expect("rename Java method");
    assert!(proposal.edited_source.contains("public void pong()"));
    assert!(proposal.edited_source.contains("new Helper().pong()"));
    assert!(!proposal.edited_source.contains("ping()"));
    assert_edited_parses(&parsed, &proposal.edited_source, "rename Java method");
}

// ---------------------------------------------------------------------------
// Diagnostics.
// ---------------------------------------------------------------------------

fn diagnostics_typescript_basic() {
    let log = read_text(&fixture_path("error-logs/typescript-typecheck.txt"));
    let outcome = failed(VerificationCheckKind::Typecheck, &log);
    let diagnostics = normalize_outcome(&outcome);
    assert_eq!(diagnostics.len(), 3);
    assert_eq!(
        diagnostic_codes(&diagnostics),
        vec!["TS2304", "TS2339", "TS2345"]
    );
    let report = analyze_outcomes(&[outcome]);
    assert_eq!(report.error_count, 3);
    assert_eq!(report.primary_category, ErrorCategory::Type);
    assert_eq!(match_ids(&report), vec!["ts-2304", "ts-2339", "ts-2345"]);
}

fn diagnostics_typescript_extended() {
    let log = read_text(&fixture_path("error-logs/typescript-extended.txt"));
    let outcome = failed(VerificationCheckKind::Typecheck, &log);
    let diagnostics = normalize_outcome(&outcome);
    assert_eq!(diagnostics.len(), 4);
    assert_eq!(
        diagnostic_codes(&diagnostics),
        vec!["TS2322", "TS2307", "TS2554", "TS7006"]
    );
    let report = analyze_outcomes(&[outcome]);
    assert_eq!(report.error_count, 4);
    assert_eq!(report.primary_category, ErrorCategory::Type);
    assert_eq!(
        match_ids(&report),
        vec!["ts-2322", "ts-2307", "ts-7006", "ts-2554"]
    );
}

fn diagnostics_typescript_syntax_codes() {
    let log = "src/parse.ts(4,12): error TS1005: ';' expected.\n\
               src/parse.ts(5,1): error TS1109: Expression expected.\n";
    let outcome = failed(VerificationCheckKind::Typecheck, log);
    let diagnostics = normalize_outcome(&outcome);
    assert_eq!(diagnostic_codes(&diagnostics), vec!["TS1005", "TS1109"]);
    let report = analyze_outcomes(&[outcome]);
    assert_eq!(report.error_count, 2);
    assert_eq!(report.primary_category, ErrorCategory::Syntax);
    assert_eq!(match_ids(&report), vec!["ts-1005", "ts-1109"]);
}

fn diagnostics_typescript_multi_outcome() {
    let typecheck = failed(
        VerificationCheckKind::Typecheck,
        &read_text(&fixture_path("error-logs/typescript-typecheck.txt")),
    );
    let lint = failed(
        VerificationCheckKind::Lint,
        &read_text(&fixture_path("error-logs/eslint.txt")),
    );
    let test = failed(
        VerificationCheckKind::Test,
        &read_text(&fixture_path("error-logs/vitest-assertion.txt")),
    );
    let outcomes = vec![typecheck, lint, test];
    let diagnostics = outcomes
        .iter()
        .flat_map(normalize_outcome)
        .collect::<Vec<_>>();
    assert_eq!(diagnostics.len(), 6);
    let report = analyze_outcomes(&outcomes);
    assert_eq!(report.error_count, 6);
    assert_eq!(report.warning_count, 0);
    assert_eq!(report.primary_category, ErrorCategory::Type);
    let ids = match_ids(&report);
    assert!(ids.contains(&"ts-2304"));
    assert!(ids.contains(&"eslint-no-unused-vars"));
    assert!(ids.contains(&"test-suite-failed"));
}

fn diagnostics_eslint_basic() {
    let log = read_text(&fixture_path("error-logs/eslint.txt"));
    let outcome = failed(VerificationCheckKind::Lint, &log);
    let diagnostics = normalize_outcome(&outcome);
    assert_eq!(diagnostics.len(), 2);
    assert_eq!(
        diagnostic_codes(&diagnostics),
        vec!["no-unused-vars", "import/no-unresolved"]
    );
    let report = analyze_outcomes(&[outcome]);
    assert_eq!(report.error_count, 2);
    assert_eq!(report.primary_category, ErrorCategory::Lint);
    assert_eq!(report.matches[1].category, ErrorCategory::Import);
}

fn diagnostics_eslint_extended() {
    let log = read_text(&fixture_path("error-logs/eslint-extended.txt"));
    let outcome = failed(VerificationCheckKind::Lint, &log);
    let diagnostics = normalize_outcome(&outcome);
    assert_eq!(diagnostics.len(), 2);
    assert_eq!(
        diagnostic_codes(&diagnostics),
        vec!["no-undef", "react-hooks/exhaustive-deps"]
    );
    let report = analyze_outcomes(&[outcome]);
    assert_eq!(report.error_count, 1);
    assert_eq!(report.warning_count, 1);
    assert_eq!(
        match_ids(&report),
        vec!["eslint-no-undef", "eslint-react-hooks-exhaustive-deps"]
    );
}

fn diagnostics_eslint_no_explicit_any() {
    let log = "src/lib/api.ts:9:12  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any\n";
    let outcome = failed(VerificationCheckKind::Lint, log);
    let diagnostics = normalize_outcome(&outcome);
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(
        diagnostics[0].code.as_deref(),
        Some("@typescript-eslint/no-explicit-any")
    );
    assert_eq!(diagnostics[0].severity, DiagnosticSeverity::Warning);
    let report = analyze_outcomes(&[outcome]);
    assert_eq!(report.error_count, 0);
    assert_eq!(report.warning_count, 1);
    assert_eq!(
        match_ids(&report),
        vec!["eslint-typescript-no-explicit-any"]
    );
}

fn diagnostics_eslint_no_console_empty() {
    let log = "src/App.tsx:7:3  warning  Unexpected console statement  no-console\n\
               src/App.tsx:9:1  error  Empty block statement  no-empty\n";
    let outcome = failed(VerificationCheckKind::Lint, log);
    let diagnostics = normalize_outcome(&outcome);
    assert_eq!(
        diagnostic_codes(&diagnostics),
        vec!["no-console", "no-empty"]
    );
    let report = analyze_outcomes(&[outcome]);
    assert_eq!(report.error_count, 1);
    assert_eq!(report.warning_count, 1);
    assert_eq!(
        match_ids(&report),
        vec!["eslint-no-empty", "eslint-no-console"]
    );
}

fn diagnostics_vitest_assertion() {
    let log = read_text(&fixture_path("error-logs/vitest-assertion.txt"));
    let outcome = failed(VerificationCheckKind::Test, &log);
    let diagnostics = normalize_outcome(&outcome);
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].code.as_deref(), Some("TEST_FAILURE"));
    assert_eq!(
        diagnostics[0].file.as_deref(),
        Some(Path::new("src/lib/math.test.ts"))
    );
    let report = analyze_diagnostics(&[log_diagnostic(&diagnostics[0], &log)]);
    assert_eq!(match_ids(&report), vec!["test-assertion-failure"]);
    assert_eq!(report.primary_category, ErrorCategory::Test);
}

fn diagnostics_vitest_timeout() {
    let log = read_text(&fixture_path("error-logs/vitest-timeout.txt"));
    let outcome = failed(VerificationCheckKind::Test, &log);
    let diagnostics = normalize_outcome(&outcome);
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].code.as_deref(), Some("TEST_FAILURE"));
    let report = analyze_diagnostics(&[log_diagnostic(&diagnostics[0], &log)]);
    assert_eq!(match_ids(&report), vec!["test-timeout"]);
    assert_eq!(report.primary_category, ErrorCategory::Test);
}

fn diagnostics_vitest_module_not_found() {
    let log = read_text(&fixture_path("error-logs/vitest-module-not-found.txt"));
    let outcome = failed(VerificationCheckKind::Test, &log);
    let diagnostics = normalize_outcome(&outcome);
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(
        diagnostics[0].file.as_deref(),
        Some(Path::new("tests/format.test.ts"))
    );
    let report = analyze_diagnostics(&[log_diagnostic(&diagnostics[0], &log)]);
    assert_eq!(match_ids(&report), vec!["test-module-not-found"]);
    assert_eq!(report.primary_category, ErrorCategory::Import);
}

fn diagnostics_vitest_suite_failure() {
    let log = "FAIL  src/lib/broken.test.ts > broken > loads\n";
    let outcome = failed(VerificationCheckKind::Test, log);
    let diagnostics = normalize_outcome(&outcome);
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].message, "Test failed: broken > loads");
    let report = analyze_diagnostics(&[log_diagnostic(&diagnostics[0], log)]);
    assert_eq!(match_ids(&report), vec!["test-suite-failed"]);
    assert_eq!(report.primary_category, ErrorCategory::Test);
}

fn diagnostics_python_lint_lines() {
    let log = "src/app.py:12:5: E501 line too long (100 > 88)\n\
               src/app.py:3:1: F401 'os' imported but unused\n\
               src/app.py:1:1: W291 trailing whitespace\n";
    let diagnostics = normalize_outcome(&failed(VerificationCheckKind::Lint, log));
    assert_eq!(diagnostic_codes(&diagnostics), vec!["E501", "F401", "W291"]);
    assert_eq!(diagnostics[0].severity, DiagnosticSeverity::Error);
    assert_eq!(diagnostics[2].severity, DiagnosticSeverity::Warning);
    let report = analyze_outcomes(&[failed(VerificationCheckKind::Lint, log)]);
    assert_eq!(report.error_count, 2);
    assert_eq!(report.warning_count, 1);
    assert!(report.matches.is_empty());
}

fn diagnostics_python_mypy_and_traceback() {
    let log = "src/app.py:10: error: Incompatible types in assignment  [assignment]\n\
               src/app.py:11: warning: Unused ignore  [unused-ignore]\n\
                 File \"src/app.py\", line 42, in run\n\
               SyntaxError: invalid syntax\n";
    let diagnostics = normalize_outcome(&failed(VerificationCheckKind::Typecheck, log));
    assert!(diagnostics.len() >= 3);
    let codes = diagnostic_codes(&diagnostics);
    assert_eq!(&codes[..2], &["assignment", "unused-ignore"]);
    assert!(diagnostics[2..]
        .iter()
        .all(|diagnostic| diagnostic.code.as_deref() == Some("PYTHON")));
    assert_eq!(diagnostics[0].severity, DiagnosticSeverity::Error);
    assert_eq!(diagnostics[1].severity, DiagnosticSeverity::Warning);
    assert_eq!(diagnostics[2].line, Some(42));
    assert!(diagnostics
        .iter()
        .any(|diagnostic| diagnostic.message.contains("invalid syntax")));
}

fn diagnostics_python_pytest_and_module() {
    let log = "FAILED tests/test_app.py::test_add - AssertionError: assert 1 == 2\n\
               ModuleNotFoundError: No module named 'requests'\n";
    let diagnostics = normalize_outcome(&failed(VerificationCheckKind::Test, log));
    assert_eq!(diagnostic_codes(&diagnostics), vec!["PYTEST", "PYTHON"]);
    let report = analyze_diagnostics(&[
        log_diagnostic(&diagnostics[0], log),
        log_diagnostic(&diagnostics[1], log),
    ]);
    assert_eq!(report.primary_category, ErrorCategory::Test);
    assert_eq!(match_ids(&report), vec!["test-assertion-failure"]);
}

fn diagnostics_go_compiler_and_vet() {
    let log = "main.go:12:4: undefined: missing\n\
               vet: pkg/file.go:3:1: unreachable code\n";
    let diagnostics = normalize_outcome(&failed(VerificationCheckKind::Typecheck, log));
    assert_eq!(diagnostic_codes(&diagnostics), vec!["GO", "GOVET"]);
    assert_eq!(diagnostics[0].file.as_deref(), Some(Path::new("main.go")));
    assert_eq!(
        diagnostics[1].file.as_deref(),
        Some(Path::new("pkg/file.go"))
    );
    let report = analyze_outcomes(&[failed(VerificationCheckKind::Typecheck, log)]);
    assert_eq!(report.error_count, 2);
}

fn diagnostics_go_test_failures() {
    let log = "--- FAIL: TestAdd (0.00s)\n\
               --- FAIL: TestDiv/subcase (0.12s)\n\
               FAIL\texample.com/pkg\t0.123s\n";
    let diagnostics = normalize_outcome(&failed(VerificationCheckKind::Test, log));
    let codes = diagnostic_codes(&diagnostics);
    assert_eq!(codes.len(), 3);
    assert_eq!(&codes[..2], &["GOTEST", "GOTEST"]);
    assert!(matches!(codes[2], "GO" | "GOTEST"));
    let report = analyze_outcomes(&[failed(VerificationCheckKind::Test, log)]);
    assert_eq!(report.error_count, 3);
    assert_eq!(report.primary_category, ErrorCategory::Unknown);
    assert!(report.matches.is_empty());
}

fn diagnostics_rust_compiler() {
    let stderr = "error[E0308]: mismatched types\n  \
                  --> src/main.rs:10:5\n   |\n \
                  10 |     let x: u32 = \"text\";\n   \
                  |                  ^^^^^^ expected `u32`, found `&str`\n";
    let outcome = rust_failed(stderr);
    let diagnostics = normalize_outcome(&outcome);
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].code.as_deref(), Some("E0308"));
    assert_eq!(
        diagnostics[0].file.as_deref(),
        Some(Path::new("src/main.rs"))
    );
    assert_eq!(diagnostics[0].line, Some(10));
    assert_eq!(diagnostics[0].column, Some(5));
    let report = analyze_outcomes(&[outcome]);
    assert_eq!(report.error_count, 1);
}

fn diagnostics_rust_test_panic() {
    let stdout = "running 2 tests\ntest tests::foo ... FAILED\n";
    let stderr = "thread 'tests::foo' panicked at src/lib.rs:10:5:\n\
                  assertion `left == right` failed\n";
    let outcome = command_outcome(
        VerificationCheckKind::Test,
        "cargo",
        stdout,
        stderr,
        Some(1),
    );
    let diagnostics = normalize_outcome(&outcome);
    assert_eq!(diagnostics.len(), 2);
    assert_eq!(diagnostics[0].code.as_deref(), Some("TEST"));
    assert_eq!(
        diagnostics[1].file.as_deref(),
        Some(Path::new("src/lib.rs"))
    );
    let report = analyze_outcomes(&[outcome]);
    assert_eq!(report.error_count, 2);
    assert!(
        report.matches.is_empty() || match_ids(&report) == vec!["test-suite-failed"],
        "unexpected matches: {:?}",
        match_ids(&report)
    );
}

fn diagnostics_java_javac_maven_junit() {
    let log = "src/main/java/App.java:10: error: cannot find symbol\n\
               [ERROR] /project/src/App.java:[12,5] cannot find symbol\n\
               Tests run: 5, Failures: 1, Errors: 0\n\
               BUILD FAILURE\n";
    let diagnostics = normalize_outcome(&failed(VerificationCheckKind::Build, log));
    assert_eq!(
        diagnostic_codes(&diagnostics),
        vec!["JAVAC", "MAVEN", "JUNIT", "MAVEN"]
    );
    assert_eq!(diagnostics[0].line, Some(10));
    assert_eq!(diagnostics[1].line, Some(12));
    assert_eq!(diagnostics[1].column, Some(5));
    let report = analyze_outcomes(&[failed(VerificationCheckKind::Build, log)]);
    assert_eq!(report.error_count, 4);
}

// ---------------------------------------------------------------------------
// Repair planning.
// ---------------------------------------------------------------------------

fn repair_report() -> DiagnosisReport {
    analyze_diagnostics(&[
        make_diagnostic(
            "TS2322",
            "Type 'string' is not assignable to type 'number'.",
            "src/z.ts",
            7,
            DiagnosticSeverity::Error,
        ),
        make_diagnostic(
            "TS2304",
            "Cannot find name 'alpha'.",
            "src/a.ts",
            3,
            DiagnosticSeverity::Error,
        ),
        make_diagnostic(
            "no-console",
            "Unexpected console statement.",
            "src/b.ts",
            9,
            DiagnosticSeverity::Warning,
        ),
    ])
}

fn repair_policy(max_repair_rounds: u32) -> CodingPolicy {
    CodingPolicy {
        max_repair_rounds,
        ..CodingPolicy::default()
    }
}

fn repair_retry_priority() {
    let report = repair_report();
    let plan = plan_repair(&report, &[], 0, &repair_policy(3));
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
    assert!(!plan.instructions.is_empty());
    assert!(plan
        .instructions
        .iter()
        .any(|line| line.starts_with("type: src/a.ts:")));
    assert!(plan
        .instructions
        .iter()
        .any(|line| line.starts_with("lint: src/b.ts:")));
}

fn repair_immediate_repeat() {
    let report = repair_report();
    let previous = vec![report.failure_signature.clone()];
    let plan = plan_repair(&report, &previous, 1, &repair_policy(3));
    assert!(!plan.should_retry);
    assert_eq!(plan.stop_reason, Some(RepairStopReason::RepeatedFailure));
    assert!(plan.targeted_files.is_empty());
    assert!(plan.instructions.is_empty());
}

fn repair_seen_twice() {
    let report = repair_report();
    let previous = vec![
        report.failure_signature.clone(),
        "other-signature".to_string(),
        report.failure_signature.clone(),
    ];
    let plan = plan_repair(&report, &previous, 2, &repair_policy(3));
    assert!(!plan.should_retry);
    assert_eq!(plan.stop_reason, Some(RepairStopReason::RepeatedFailure));
}

fn repair_trailing_duplicate() {
    let report = repair_report();
    let previous = vec![
        "other-signature".to_string(),
        "same-signature".to_string(),
        "same-signature".to_string(),
    ];
    let plan = plan_repair(&report, &previous, 2, &repair_policy(3));
    assert!(!plan.should_retry);
    assert_eq!(plan.stop_reason, Some(RepairStopReason::RepeatedFailure));
}

fn repair_max_rounds() {
    let report = repair_report();
    let plan = plan_repair(&report, &[], 2, &repair_policy(2));
    assert!(!plan.should_retry);
    assert_eq!(plan.stop_reason, Some(RepairStopReason::MaxRepairRounds));
    assert_eq!(plan.round, 3);
    assert!(plan.targeted_files.is_empty());
}

fn repair_beyond_max_rounds() {
    let report = repair_report();
    let plan = plan_repair(&report, &[], 9, &repair_policy(2));
    assert!(!plan.should_retry);
    assert_eq!(plan.stop_reason, Some(RepairStopReason::MaxRepairRounds));
    assert_eq!(plan.round, 10);
}

fn repair_no_repairable_issue() {
    let report = analyze_diagnostics(&[]);
    let plan = plan_repair(&report, &[], 99, &repair_policy(0));
    assert!(!plan.should_retry);
    assert_eq!(plan.stop_reason, Some(RepairStopReason::NoRepairableIssue));
    assert_eq!(plan.round, 100);
    assert!(plan.targeted_files.is_empty());
    assert!(plan.instructions.is_empty());
}

fn repair_warning_only_no_pattern() {
    let report = analyze_diagnostics(&[make_diagnostic(
        "W123",
        "style nit",
        "src/style.ts",
        4,
        DiagnosticSeverity::Warning,
    )]);
    assert_eq!(report.error_count, 0);
    assert_eq!(report.warning_count, 1);
    assert!(report.matches.is_empty());
    let plan = plan_repair(&report, &[], 0, &repair_policy(3));
    assert!(!plan.should_retry);
    assert_eq!(plan.stop_reason, Some(RepairStopReason::NoRepairableIssue));
}

fn repair_python_go_diagnostics() {
    let report = analyze_outcomes(&[
        failed(
            VerificationCheckKind::Typecheck,
            "src/app.py:10: error: Incompatible types in assignment  [assignment]\n",
        ),
        failed(
            VerificationCheckKind::Typecheck,
            "main.go:12:4: undefined: missing\n",
        ),
    ]);
    assert_eq!(report.error_count, 2);
    let plan = plan_repair(&report, &[], 0, &repair_policy(3));
    assert!(plan.should_retry);
    assert_eq!(
        plan.targeted_files,
        vec![PathBuf::from("main.go"), PathBuf::from("src/app.py")]
    );
}

fn repair_rust_java_diagnostics() {
    let report = analyze_outcomes(&[
        rust_failed("src/lib.rs:10:5: error[E0308]: mismatched types\n"),
        failed(
            VerificationCheckKind::Typecheck,
            "src/App.java:3: error: ';' expected\n",
        ),
    ]);
    assert_eq!(report.error_count, 2);
    let plan = plan_repair(&report, &[], 0, &repair_policy(3));
    assert!(plan.should_retry);
    assert_eq!(
        plan.targeted_files,
        vec![PathBuf::from("src/App.java"), PathBuf::from("src/lib.rs"),]
    );
}

fn repair_deterministic_order() {
    let first = make_diagnostic(
        "TS2304",
        "Cannot find name 'alpha'.",
        "src/a.ts",
        3,
        DiagnosticSeverity::Error,
    );
    let second = make_diagnostic(
        "TS2322",
        "Type 'string' is not assignable to type 'number'.",
        "src/z.ts",
        7,
        DiagnosticSeverity::Error,
    );
    let forward = analyze_diagnostics(&[first.clone(), second.clone()]);
    let reverse = analyze_diagnostics(&[second, first]);
    let plan = plan_repair(&forward, &[], 0, &repair_policy(3));
    assert_eq!(plan, plan_repair(&forward, &[], 0, &repair_policy(3)));
    assert_eq!(plan, plan_repair(&reverse, &[], 0, &repair_policy(3)));
    assert_eq!(plan.signature, forward.failure_signature);
}

fn repair_targeted_file_dedupe() {
    let report = analyze_diagnostics(&[
        make_diagnostic(
            "TS2304",
            "Cannot find name 'alpha'.",
            "src/a.ts",
            3,
            DiagnosticSeverity::Error,
        ),
        make_diagnostic(
            "TS2339",
            "Property 'beta' does not exist on type 'Gamma'.",
            "src/a.ts",
            5,
            DiagnosticSeverity::Error,
        ),
        make_diagnostic(
            "TS2322",
            "Type 'string' is not assignable to type 'number'.",
            "src/z.ts",
            7,
            DiagnosticSeverity::Error,
        ),
    ]);
    let plan = plan_repair(&report, &[], 0, &repair_policy(3));
    assert!(plan.should_retry);
    assert_eq!(
        plan.targeted_files,
        vec![PathBuf::from("src/a.ts"), PathBuf::from("src/z.ts")]
    );
    let unique = plan.targeted_files.iter().collect::<BTreeSet<_>>();
    assert_eq!(unique.len(), plan.targeted_files.len());
}

// ---------------------------------------------------------------------------
// Formatting.
// ---------------------------------------------------------------------------

fn formatting_spaces_insert() {
    let parsed = parse_fixture("frontend-app/src/components/Counter.tsx");
    let proposal = insert_after(
        &parsed,
        &SymbolQuery::new("increment")
            .with_kind(SymbolKind::Function)
            .with_parent("Counter"),
        "function extra() {\n  return 1;\n}",
    )
    .expect("insert after increment");
    assert!(proposal
        .edited_source
        .contains("\n  function extra() {\n    return 1;\n  }\n"));
    assert_edited_parses(
        &parsed,
        &proposal.edited_source,
        "spaces indentation insert",
    );
}

fn formatting_tabs_insert() {
    let source = "class Box {\n\tone() {}\n}\n";
    let parsed = parse_source(Path::new("benchmark100/tabs.ts"), source);
    let proposal = insert_after(
        &parsed,
        &SymbolQuery::new("one")
            .with_kind(SymbolKind::Method)
            .with_parent("Box"),
        "two() {\n  return 2;\n}",
    )
    .expect("insert tab-indented method");
    assert_eq!(
        proposal.edited_source,
        "class Box {\n\tone() {}\n\ttwo() {\n\t  return 2;\n\t}\n}\n"
    );
}

fn formatting_crlf_preserve() {
    let source = "export function greet() {\r\n  return \"hi\";\r\n}\r\n";
    let parsed = parse_source(Path::new("benchmark100/crlf.ts"), source);
    let proposal = replace_symbol(
        &parsed,
        &query("greet", SymbolKind::Function),
        "function greet() {\n  return \"bye\";\n}",
    )
    .expect("replace CRLF function");
    assert_eq!(
        proposal.edited_source,
        "export function greet() {\r\n  return \"bye\";\r\n}\r\n"
    );
    assert!(!proposal.edited_source.replace("\r\n", "").contains('\n'));
}

fn formatting_nested_indent() {
    let source = "function outer() {\n    function inner() {\n        return 1;\n    }\n}\n";
    let parsed = parse_source(Path::new("benchmark100/nested.ts"), source);
    let proposal = replace_symbol(
        &parsed,
        &query("inner", SymbolKind::Function),
        "function inner() {\n    return 2;\n}",
    )
    .expect("replace nested function");
    assert_eq!(
        proposal.edited_source,
        "function outer() {\n    function inner() {\n        return 2;\n    }\n}\n"
    );
}

fn formatting_python_indent() {
    let parsed = parse_fixture("benchmark100/python-app/src/service.py");
    let proposal = insert_after(
        &parsed,
        &SymbolQuery::new("reset")
            .with_kind(SymbolKind::Function)
            .with_parent("Service"),
        "def clear_cache(self):\n    _private_cache.clear()",
    )
    .expect("insert Python indented method");
    assert!(proposal
        .edited_source
        .contains("\n    def clear_cache(self):\n        _private_cache.clear()\n"));
    assert_edited_parses(
        &parsed,
        &proposal.edited_source,
        "Python indentation insert",
    );
}

fn formatting_go_tabs() {
    let parsed = parse_fixture("benchmark100/go-app/service.go");
    let proposal = insert_after(
        &parsed,
        &query("NewUser", SymbolKind::Function),
        "func NewGuest() User {\n\treturn User{}\n}",
    )
    .expect("insert Go function");
    assert!(proposal
        .edited_source
        .contains("\nfunc NewGuest() User {\n\treturn User{}\n}\n"));
    assert_edited_parses(&parsed, &proposal.edited_source, "Go tab insert");
}

fn formatting_rust_indent() {
    let parsed = parse_fixture("benchmark100/rust-app/src/lib.rs");
    let proposal = insert_after(
        &parsed,
        &SymbolQuery::new("new")
            .with_kind(SymbolKind::Function)
            .with_parent("User"),
        "pub fn ready() -> bool {\n    true\n}",
    )
    .expect("insert Rust method");
    assert!(proposal
        .edited_source
        .contains("\n    pub fn ready() -> bool {\n        true\n    }\n"));
    assert_edited_parses(&parsed, &proposal.edited_source, "Rust indent insert");
}

fn formatting_java_indent() {
    let parsed =
        parse_fixture("benchmark100/java-app/src/main/java/com/example/bench/Service.java");
    let proposal = insert_after(
        &parsed,
        &SymbolQuery::new("greet")
            .with_kind(SymbolKind::Method)
            .with_parent("Service"),
        "public String farewell() {\n    return \"bye\";\n}",
    )
    .expect("insert Java method");
    assert!(proposal
        .edited_source
        .contains("\n    public String farewell() {\n        return \"bye\";\n    }\n"));
    assert_edited_parses(&parsed, &proposal.edited_source, "Java indent insert");
}

// ---------------------------------------------------------------------------
// Dependency and LSP data parsing.
// ---------------------------------------------------------------------------

fn dep_real_root_manifest() {
    let text = read_text(&repo_path("package.json"));
    let value: Value = serde_json::from_str(&text).expect("parse root package.json");
    let manifest = parse_package_manifest(&value).expect("parse root manifest");
    assert_eq!(manifest.name.as_deref(), Some("the-world-monorepo"));
    assert_eq!(manifest.package_manager, Some(PackageManager::Pnpm));
    assert!(manifest.dependencies.is_empty());
    assert!(manifest.dev_dependencies.is_empty());
    assert!(manifest.peer_dependencies.is_empty());
    assert!(manifest.optional_dependencies.is_empty());
}

fn dep_real_electron_manifest() {
    let text = read_text(&repo_path("apps/electron/package.json"));
    let value: Value = serde_json::from_str(&text).expect("parse Electron package.json");
    let manifest = parse_package_manifest(&value).expect("parse Electron manifest");
    assert_eq!(manifest.name.as_deref(), Some("the-world"));
    assert_eq!(manifest.package_manager, Some(PackageManager::Pnpm));
    assert_eq!(
        dependency_kind(&manifest, "electron"),
        Some(DependencyKind::Dev)
    );
    assert_eq!(
        dependency_kind(&manifest, "typescript"),
        Some(DependencyKind::Dev)
    );
    assert_eq!(
        dependency_kind(&manifest, "vue-i18n"),
        Some(DependencyKind::Runtime)
    );
    assert_eq!(dependency_kind(&manifest, "missing-package"), None);
}

fn dep_real_tsconfig() {
    let text = read_text(&repo_path("apps/electron/tsconfig.json"));
    let value: Value = serde_json::from_str(&text).expect("parse tsconfig.json");
    let options = value
        .get("compilerOptions")
        .and_then(Value::as_object)
        .expect("compilerOptions");
    assert_eq!(options.get("strict").and_then(Value::as_bool), Some(true));
    assert_eq!(
        options.get("target").and_then(Value::as_str),
        Some("ES2022")
    );
    assert_eq!(options.get("noEmit").and_then(Value::as_bool), Some(true));
    let include = value
        .get("include")
        .and_then(Value::as_array)
        .expect("include array");
    assert!(include
        .iter()
        .any(|entry| entry.as_str() == Some("src/**/*.ts")));
}

fn dep_fixture_manifest_sections() {
    let manifest = fixture_manifest("benchmark100/dependency-app/package.json");
    assert_eq!(manifest.name.as_deref(), Some("benchmark100-deps"));
    assert_eq!(manifest.package_manager, Some(PackageManager::Yarn));
    assert_eq!(manifest.dependencies.len(), 2);
    assert_eq!(manifest.dev_dependencies.len(), 2);
    assert_eq!(
        dependency_kind(&manifest, "react"),
        Some(DependencyKind::Runtime)
    );
    assert_eq!(
        dependency_kind(&manifest, "typescript"),
        Some(DependencyKind::Dev)
    );
    assert_eq!(
        dependency_kind(&manifest, "react-dom"),
        Some(DependencyKind::Peer)
    );
    assert_eq!(
        dependency_kind(&manifest, "fsevents"),
        Some(DependencyKind::Optional)
    );
    assert_eq!(
        detect_package_manager(Some(&manifest), &["package-lock.json"]),
        Some(PackageManager::Yarn)
    );
    assert_eq!(
        detect_package_manager(None, &["package-lock.json", "yarn.lock"]),
        Some(PackageManager::Npm)
    );
    assert_eq!(
        detect_package_manager(None, &["pnpm-lock.yaml", "yarn.lock"]),
        Some(PackageManager::Pnpm)
    );
    assert_eq!(
        detect_package_manager(None, &["workspace/project/pnpm-lock.yaml"]),
        Some(PackageManager::Pnpm)
    );
}

fn dep_missing_package_and_types() {
    let manifest = fixture_manifest("benchmark100/dependency-app/package.json");
    let missing = analyze_dependency_diagnostics(
        &[dependency_diagnostic(
            None,
            "Cannot find module 'zod/sub'",
            Some("src/App.tsx"),
        )],
        Some(&manifest),
        None,
    );
    assert_eq!(missing.issues[0].kind, DependencyIssueKind::MissingPackage);
    assert_eq!(missing.issues[0].package.as_deref(), Some("zod"));
    assert_eq!(missing.commands, vec!["yarn add zod"]);

    let types = analyze_dependency_diagnostics(
        &[dependency_diagnostic(
            Some("TS2307"),
            "Cannot find module 'react/jsx-runtime' or its corresponding type declarations.",
            Some("src/App.tsx"),
        )],
        Some(&manifest),
        None,
    );
    assert_eq!(
        types.issues[0].kind,
        DependencyIssueKind::MissingTypeDefinitions
    );
    assert_eq!(
        types.issues[0]
            .suggested_fix
            .as_ref()
            .expect("types fix")
            .command,
        "yarn add -D @types/react"
    );
    assert_eq!(
        types.issues[0]
            .suggested_fix
            .as_ref()
            .expect("types fix")
            .action,
        DependencyFixAction::InstallDev
    );

    let relative = analyze_dependency_diagnostics(
        &[dependency_diagnostic(
            None,
            "Cannot find module './missing'",
            None,
        )],
        Some(&manifest),
        Some(PackageManager::Pnpm),
    );
    assert_eq!(
        relative.issues[0].kind,
        DependencyIssueKind::UnresolvedImport
    );
    assert!(relative.issues[0].suggested_fix.is_none());
    assert!(relative.commands.is_empty());

    let defaulted = analyze_dependency_diagnostics(
        &[dependency_diagnostic(
            None,
            "Cannot find package 'zod'",
            None,
        )],
        None,
        None,
    );
    assert_eq!(defaulted.commands, vec!["pnpm add zod"]);
    assert!(defaulted.issues[0]
        .suggested_fix
        .as_ref()
        .expect("default fix")
        .reason
        .contains("defaulted to pnpm"));
}

fn dep_peer_version_lockfile() {
    let manifest = fixture_manifest("benchmark100/dependency-app/package.json");

    let peer = analyze_dependency_diagnostics(
        &[dependency_diagnostic(
            None,
            "npm ERR! peer dep missing: react@^18.3.1, required by react-dom@18.3.1",
            Some("src/App.tsx"),
        )],
        Some(&manifest),
        Some(PackageManager::Npm),
    );
    assert_eq!(peer.issues[0].kind, DependencyIssueKind::PeerDependency);
    assert_eq!(peer.issues[0].package.as_deref(), Some("react"));
    assert_eq!(
        peer.issues[0]
            .suggested_fix
            .as_ref()
            .expect("peer fix")
            .command,
        "npm install react@^18.3.1"
    );

    let conflict = analyze_dependency_diagnostics(
        &[dependency_diagnostic(
            None,
            "npm ERR! Could not resolve dependency: peer react@^18.3.1 from react-dom@18.3.1",
            None,
        )],
        Some(&manifest),
        Some(PackageManager::Npm),
    );
    assert_eq!(
        conflict.issues[0].kind,
        DependencyIssueKind::VersionConflict
    );
    assert_eq!(conflict.commands, vec!["npm install react@^18.3.1"]);

    let lockfile = analyze_dependency_diagnostics(
        &[dependency_diagnostic(
            None,
            "ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile because pnpm-lock.yaml is not up to date",
            None,
        )],
        Some(&manifest),
        Some(PackageManager::Pnpm),
    );
    assert_eq!(
        lockfile.issues[0].kind,
        DependencyIssueKind::LockfileMismatch
    );
    assert_eq!(
        lockfile.issues[0]
            .suggested_fix
            .as_ref()
            .expect("lockfile fix")
            .action,
        DependencyFixAction::RegenerateLockfile
    );
    assert_eq!(lockfile.commands, vec!["pnpm install"]);

    let output = analyze_package_manager_output(
        "npm ERR! Cannot find module 'zod'\nERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile\n",
        None,
        Some(PackageManager::Pnpm),
    );
    assert_eq!(output.issues.len(), 2);
    assert_eq!(output.commands, vec!["pnpm add zod", "pnpm install"]);
}

fn lsp_publish_diagnostics() {
    let payload = publish_payload(
        "file:///workspace/src/App.ts",
        vec![lsp_diagnostic(
            Some(1),
            Some(json!("TS2304")),
            "Cannot find name 'missingValue'.",
            11,
            6,
        )],
    );
    let diagnostics = parse_publish_diagnostics(&payload).expect("parse publish diagnostics");
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].severity, DiagnosticSeverity::Error);
    assert_eq!(diagnostics[0].code.as_deref(), Some("TS2304"));
    assert_eq!(
        diagnostics[0].file.as_deref(),
        Some(Path::new("/workspace/src/App.ts"))
    );
    assert_eq!(diagnostics[0].line, Some(12));
    assert_eq!(diagnostics[0].column, Some(7));
    assert_eq!(diagnostics[0].confidence, 1.0);

    let report = analyze_lsp_diagnostics(&payload).expect("analyze LSP diagnostics");
    assert_eq!(report.error_count, 1);
    assert_eq!(report.primary_category, ErrorCategory::Type);
    assert_eq!(match_ids(&report), vec!["ts-2304"]);

    let incoming = publish_payload(
        "file:///workspace/src/App.ts",
        vec![
            lsp_diagnostic(
                Some(1),
                Some(json!("TS2304")),
                "Cannot find name 'missingValue'.",
                11,
                6,
            ),
            lsp_diagnostic(
                Some(1),
                Some(json!("TS2339")),
                "Property 'user' does not exist on type 'AppState'.",
                13,
                1,
            ),
        ],
    );
    let merged = merge_lsp_diagnostics(
        &diagnostics,
        &parse_publish_diagnostics(&incoming).expect("parse incoming diagnostics"),
    );
    assert_eq!(merged.len(), 2);
    assert_eq!(merged[0], diagnostics[0]);
    assert_eq!(merged[1].code.as_deref(), Some("TS2339"));
}

fn lsp_symbols_definition_hover_uri() {
    let symbols = json!([{
        "name": "App",
        "detail": "component",
        "kind": 12,
        "range": lsp_range(0, 0, 9, 0),
        "selectionRange": lsp_range(0, 9, 0, 12),
        "children": [{
            "name": "render",
            "kind": 6,
            "range": lsp_range(2, 2, 6, 3),
            "selectionRange": lsp_range(2, 11, 2, 17)
        }]
    }]);
    let documents = parse_document_symbols(&symbols);
    assert_eq!(documents.len(), 1);
    assert_eq!(documents[0].name, "App");
    assert_eq!(documents[0].kind, LspSymbolKind::Function);
    assert_eq!(documents[0].children.len(), 1);
    assert_eq!(documents[0].children[0].name, "render");
    assert_eq!(documents[0].children[0].kind, LspSymbolKind::Method);

    let information = json!([{
        "name": "loadConfig",
        "kind": 12,
        "location": {
            "uri": "file:///workspace/src/config.ts",
            "range": lsp_range(4, 0, 8, 1)
        },
        "containerName": "config"
    }]);
    let flat = parse_symbol_information(&information);
    assert_eq!(flat.len(), 1);
    assert_eq!(flat[0].name, "loadConfig");
    assert_eq!(flat[0].container_name.as_deref(), Some("config"));

    let definition = parse_definition_response(&json!({
        "targetUri": "file:///workspace/src/Linked.ts",
        "targetRange": lsp_range(5, 2, 8, 1),
        "targetSelectionRange": lsp_range(5, 2, 5, 9),
        "originSelectionRange": lsp_range(0, 0, 0, 3)
    }));
    assert_eq!(definition.len(), 1);
    assert_eq!(definition[0].uri, "file:///workspace/src/Linked.ts");
    assert_eq!(definition[0].range.start.line, 5);
    assert_eq!(definition[0].range.start.character, 2);
    assert_eq!(definition[0].range.end.line, 8);

    assert_eq!(
        parse_hover(&json!({ "contents": { "kind": "markdown", "value": "**App**" } })),
        Some("**App**".to_string())
    );
    assert_eq!(
        parse_hover(&json!({
            "contents": [
                "first",
                { "language": "ts", "value": "second" },
                { "kind": "plaintext", "value": "third" }
            ]
        })),
        Some("first\nsecond\nthird".to_string())
    );

    let original = PathBuf::from("/tmp/hello world/你.ts");
    let uri = path_to_file_uri(&original);
    assert!(uri.contains("%20"));
    assert!(uri.contains("%E4%BD%A0"));
    assert_eq!(file_uri_to_path(&uri).expect("decode URI"), original);
    assert_eq!(
        file_uri_to_path("file:///C:/Users/Test/App.ts").expect("Windows URI"),
        PathBuf::from("C:/Users/Test/App.ts")
    );
    assert!(file_uri_to_path("https://example.com/App.ts").is_err());
}
