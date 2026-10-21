//! Deterministic 50-task coding benchmark with per-task latency.
//!
//! Ten tasks read real repository TypeScript files read-only through
//! `../../../apps/electron/...`. Everything else uses the checked-in frontend
//! fixtures or inline sources. No subprocess, network, or filesystem write is
//! performed by this benchmark.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Instant,
};
use worldbase_coding::{
    analyze_diagnostics, analyze_outcomes, detect_profile,
    error_analyzer::normalize_outcome,
    plan_repair,
    smart_editor::{
        delete_symbol, insert_after, parse_file, rename_symbol, replace_symbol, NodeSelector,
        ParsedFile, SymbolEntry, SymbolKind, SymbolQuery,
    },
    CodingPolicy, CommandOutcome, DiagnosisReport, Diagnostic, DiagnosticSeverity, ErrorCategory,
    PackageManager, ProjectKind, RepairStopReason, VerificationCheckKind, VerificationCommand,
};

const FIXTURE_APP: &str = "frontend-app";
const FIXTURE_LARGE: &str = "frontend-app-large";
const REAL_TYPES: &str = "apps/electron/src/main/ai-harness/types.ts";
const REAL_ENGINE: &str = "apps/electron/src/main/ai-harness/rust-harness-engine.ts";
const REAL_CLIENT: &str = "apps/electron/electron/main-process/rust-harness-client.ts";
const REAL_CONTRACTS: &str = "apps/electron/src/main/ai-harness/contracts.ts";
const REAL_AGENT_TYPES: &str = "apps/electron/src/shared/agent-workspace-types.ts";
const REAL_TOOL_SUMMARY: &str = "apps/electron/src/main/ai-harness/tool-run-summary.ts";
const REAL_ABORT_UTILS: &str = "apps/electron/src/main/ai-harness/abort-utils.ts";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Category {
    Profile,
    RealSymbols,
    FixtureSymbols,
    Edits,
    Diagnostics,
    Repair,
    Formatting,
}

impl Category {
    const ALL: [Category; 7] = [
        Category::Profile,
        Category::RealSymbols,
        Category::FixtureSymbols,
        Category::Edits,
        Category::Diagnostics,
        Category::Repair,
        Category::Formatting,
    ];

    fn name(self) -> &'static str {
        match self {
            Self::Profile => "profile",
            Self::RealSymbols => "real-symbols",
            Self::FixtureSymbols => "fixture-symbols",
            Self::Edits => "edits",
            Self::Diagnostics => "diagnostics",
            Self::Repair => "repair",
            Self::Formatting => "formatting",
        }
    }

    fn expected_count(self) -> usize {
        match self {
            Self::Profile => 3,
            Self::RealSymbols => 10,
            Self::FixtureSymbols => 7,
            Self::Edits => 12,
            Self::Diagnostics => 10,
            Self::Repair => 4,
            Self::Formatting => 4,
        }
    }
}

struct Case {
    name: &'static str,
    category: Category,
    run: fn(),
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
        println!("benchmark50: {}/50 passed", self.passed);
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
        assert_eq!(self.passed, 50, "expected 50 passing tasks");
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

fn failed_outcome(kind: VerificationCheckKind, log: &str) -> CommandOutcome {
    CommandOutcome {
        command: VerificationCommand {
            kind,
            program: "pnpm".into(),
            args: vec!["run".into(), kind.label().into()],
            required: true,
            description: "benchmark50 fixture".into(),
        },
        exit_code: Some(1),
        stdout: log.into(),
        stderr: String::new(),
        timed_out: false,
        cancelled: false,
        duration_ms: 10,
    }
}

fn report_for(kind: VerificationCheckKind, log: &str) -> DiagnosisReport {
    analyze_outcomes(&[failed_outcome(kind, log)])
}

fn log_diagnostic(diagnostic: &Diagnostic, log: &str) -> Diagnostic {
    let mut diagnostic = diagnostic.clone();
    diagnostic.raw = Some(log.to_string());
    diagnostic
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

fn benchmark_cases() -> Vec<Case> {
    vec![
        Case {
            name: "profile-frontend-app",
            category: Category::Profile,
            run: profile_frontend_app,
        },
        Case {
            name: "profile-frontend-app-large",
            category: Category::Profile,
            run: profile_frontend_app_large,
        },
        Case {
            name: "profile-missing-manifest",
            category: Category::Profile,
            run: profile_missing_manifest,
        },
        Case {
            name: "real-symbol-types-interfaces",
            category: Category::RealSymbols,
            run: real_symbol_types_interfaces,
        },
        Case {
            name: "real-symbol-types-aliases",
            category: Category::RealSymbols,
            run: real_symbol_types_aliases,
        },
        Case {
            name: "real-symbol-engine-class",
            category: Category::RealSymbols,
            run: real_symbol_engine_class,
        },
        Case {
            name: "real-symbol-engine-functions",
            category: Category::RealSymbols,
            run: real_symbol_engine_functions,
        },
        Case {
            name: "real-symbol-engine-methods",
            category: Category::RealSymbols,
            run: real_symbol_engine_methods,
        },
        Case {
            name: "real-symbol-client-interfaces",
            category: Category::RealSymbols,
            run: real_symbol_client_interfaces,
        },
        Case {
            name: "real-symbol-client-class",
            category: Category::RealSymbols,
            run: real_symbol_client_class,
        },
        Case {
            name: "real-symbol-contracts",
            category: Category::RealSymbols,
            run: real_symbol_contracts,
        },
        Case {
            name: "real-symbol-agent-types",
            category: Category::RealSymbols,
            run: real_symbol_agent_types,
        },
        Case {
            name: "real-symbol-utils",
            category: Category::RealSymbols,
            run: real_symbol_utils,
        },
        Case {
            name: "fixture-symbol-app",
            category: Category::FixtureSymbols,
            run: fixture_symbol_app,
        },
        Case {
            name: "fixture-symbol-counter",
            category: Category::FixtureSymbols,
            run: fixture_symbol_counter,
        },
        Case {
            name: "fixture-symbol-button",
            category: Category::FixtureSymbols,
            run: fixture_symbol_button,
        },
        Case {
            name: "fixture-symbol-api",
            category: Category::FixtureSymbols,
            run: fixture_symbol_api,
        },
        Case {
            name: "fixture-symbol-types",
            category: Category::FixtureSymbols,
            run: fixture_symbol_types,
        },
        Case {
            name: "fixture-symbol-large-routes",
            category: Category::FixtureSymbols,
            run: fixture_symbol_large_routes,
        },
        Case {
            name: "fixture-symbol-large-modal",
            category: Category::FixtureSymbols,
            run: fixture_symbol_large_modal,
        },
        Case {
            name: "edit-replace-app",
            category: Category::Edits,
            run: edit_replace_app,
        },
        Case {
            name: "edit-replace-counter",
            category: Category::Edits,
            run: edit_replace_counter,
        },
        Case {
            name: "edit-insert-after-app",
            category: Category::Edits,
            run: edit_insert_after_app,
        },
        Case {
            name: "edit-insert-after-large-method",
            category: Category::Edits,
            run: edit_insert_after_large_method,
        },
        Case {
            name: "edit-delete-multiply",
            category: Category::Edits,
            run: edit_delete_multiply,
        },
        Case {
            name: "edit-delete-large-function",
            category: Category::Edits,
            run: edit_delete_large_function,
        },
        Case {
            name: "edit-rename-add",
            category: Category::Edits,
            run: edit_rename_add,
        },
        Case {
            name: "edit-rename-large-route-labels",
            category: Category::Edits,
            run: edit_rename_large_route_labels,
        },
        Case {
            name: "edit-replace-real-symbol",
            category: Category::Edits,
            run: edit_replace_real_symbol,
        },
        Case {
            name: "edit-rename-real-symbol",
            category: Category::Edits,
            run: edit_rename_real_symbol,
        },
        Case {
            name: "edit-ambiguous-selector-rejected",
            category: Category::Edits,
            run: edit_ambiguous_selector_rejected,
        },
        Case {
            name: "edit-invalid-replacement-rejected",
            category: Category::Edits,
            run: edit_invalid_replacement_rejected,
        },
        Case {
            name: "diagnostics-typescript-basic",
            category: Category::Diagnostics,
            run: diagnostics_typescript_basic,
        },
        Case {
            name: "diagnostics-typescript-extended",
            category: Category::Diagnostics,
            run: diagnostics_typescript_extended,
        },
        Case {
            name: "diagnostics-eslint-basic",
            category: Category::Diagnostics,
            run: diagnostics_eslint_basic,
        },
        Case {
            name: "diagnostics-eslint-extended",
            category: Category::Diagnostics,
            run: diagnostics_eslint_extended,
        },
        Case {
            name: "diagnostics-vitest-assertion",
            category: Category::Diagnostics,
            run: diagnostics_vitest_assertion,
        },
        Case {
            name: "diagnostics-vitest-module-not-found",
            category: Category::Diagnostics,
            run: diagnostics_vitest_module_not_found,
        },
        Case {
            name: "diagnostics-bundler-fallback",
            category: Category::Diagnostics,
            run: diagnostics_bundler_fallback,
        },
        Case {
            name: "diagnostics-rollup-fallback",
            category: Category::Diagnostics,
            run: diagnostics_rollup_fallback,
        },
        Case {
            name: "diagnostics-dedup-order",
            category: Category::Diagnostics,
            run: diagnostics_dedup_order,
        },
        Case {
            name: "diagnostics-stable-signature",
            category: Category::Diagnostics,
            run: diagnostics_stable_signature,
        },
        Case {
            name: "repair-retry",
            category: Category::Repair,
            run: repair_retry,
        },
        Case {
            name: "repair-repeated-failure",
            category: Category::Repair,
            run: repair_repeated_failure,
        },
        Case {
            name: "repair-max-rounds",
            category: Category::Repair,
            run: repair_max_rounds,
        },
        Case {
            name: "repair-no-repairable-issue",
            category: Category::Repair,
            run: repair_no_repairable_issue,
        },
        Case {
            name: "formatting-spaces-insert",
            category: Category::Formatting,
            run: formatting_spaces_insert,
        },
        Case {
            name: "formatting-crlf-preserve",
            category: Category::Formatting,
            run: formatting_crlf_preserve,
        },
        Case {
            name: "formatting-tabs-insert",
            category: Category::Formatting,
            run: formatting_tabs_insert,
        },
        Case {
            name: "formatting-nested-indent",
            category: Category::Formatting,
            run: formatting_nested_indent,
        },
    ]
}

#[test]
fn benchmark_50_tasks() {
    let cases = benchmark_cases();
    assert_eq!(cases.len(), 50, "benchmark task count");
    let mut counts: BTreeMap<Category, usize> = BTreeMap::new();
    for case in &cases {
        *counts.entry(case.category).or_default() += 1;
    }
    for category in Category::ALL {
        assert_eq!(
            counts.get(&category).copied().unwrap_or(0),
            category.expected_count(),
            "{} task count",
            category.name()
        );
    }

    let mut benchmark = Benchmark::default();
    for case in &cases {
        benchmark.run(case);
    }
    benchmark.finish();
}

fn profile_frontend_app() {
    let profile = detect_profile(&fixture_path(FIXTURE_APP)).expect("detect frontend app");
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
}

fn profile_frontend_app_large() {
    let profile = detect_profile(&fixture_path(FIXTURE_LARGE)).expect("detect large app");
    assert_eq!(profile.project_kind, ProjectKind::FrontendNode);
    assert_eq!(profile.package_manager, Some(PackageManager::Yarn));
    assert_eq!(profile.commands.len(), 4);
    assert!(profile
        .commands
        .iter()
        .all(|command| command.program == "yarn"));
    assert!(profile.source.contains("yarn.lock"));
}

fn profile_missing_manifest() {
    let profile = detect_profile(&fixture_path("benchmark50/no-package-json"))
        .expect("missing manifest is not an error");
    assert_eq!(profile.project_kind, ProjectKind::Unknown);
    assert!(profile.package_manager.is_none());
    assert!(profile.commands.is_empty());
    assert!(profile.source.contains("No package.json"));
}

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
    let imported = required(&parsed, &query("ChatMessage", SymbolKind::Import));
    assert!(!imported.exported);
    assert!(parsed.source[imported.byte_range()].contains("ChatMessage"));
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
        assert!(parsed.source[entry.byte_range()].contains(&format!("{method} (")));
    }
}

fn real_symbol_engine_functions() {
    let parsed = parse_repo(REAL_ENGINE);
    for (name, exported) in [
        ("shouldExecuteInElectronHost", false),
        ("planModeExitedAfterNativeResult", true),
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
    for (name, exported) in [
        ("buildToolRunSummary", true),
        ("filePathForToolRun", true),
        ("MAX_SUMMARY_CHARS", false),
    ] {
        let kind = if name == "MAX_SUMMARY_CHARS" {
            SymbolKind::Variable
        } else {
            SymbolKind::Function
        };
        let entry = required(&summary, &query(name, kind));
        assert_eq!(entry.exported, exported, "{name} export flag");
        assert_range(&summary.source, &entry);
    }

    let abort_utils = parse_repo(REAL_ABORT_UTILS);
    let message = required(
        &abort_utils,
        &query("USER_ABORT_MESSAGE", SymbolKind::Variable),
    );
    assert!(message.exported);
    let normalize = required(
        &abort_utils,
        &query("normalizeAbortReason", SymbolKind::Function),
    );
    assert!(normalize.exported);
    assert_range(&abort_utils.source, &normalize);
}

fn fixture_symbol_app() {
    let parsed = parse_fixture("frontend-app/src/App.tsx");
    let entries = parsed.symbols();

    let app = symbol(&entries, "App", SymbolKind::Function);
    assert!(app.exported);
    assert!(app.parent_path.is_empty());
    assert_eq!(app.start_row, 6);
    assert_range(&parsed.source, app);

    let counter = symbol(&entries, "Counter", SymbolKind::Import);
    assert_eq!(
        &parsed.source[counter.byte_range()],
        "import { Counter } from \"./components/Counter\";"
    );
    let theme = symbol(&entries, "DEFAULT_THEME", SymbolKind::Variable);
    assert!(!theme.exported);
    assert!(parsed.source[theme.byte_range()].starts_with("const DEFAULT_THEME"));

    let jsx = parsed.find_nodes(&NodeSelector::new("jsx_element"));
    assert!(!jsx.is_empty(), "App fixture should contain JSX elements");
}

fn fixture_symbol_counter() {
    let parsed = parse_fixture("frontend-app/src/components/Counter.tsx");
    let entries = parsed.symbols();
    let props = symbol(&entries, "CounterProps", SymbolKind::Interface);
    assert!(!props.exported);
    assert_range(&parsed.source, props);
    let component = symbol(&entries, "Counter", SymbolKind::Function);
    assert!(component.exported);
    assert_range(&parsed.source, component);
    for name in ["increment", "decrement"] {
        let entry = symbol(&entries, name, SymbolKind::Function);
        assert_eq!(entry.parent_path, vec!["Counter"]);
        assert_range(&parsed.source, entry);
    }
}

fn fixture_symbol_button() {
    let parsed = parse_fixture("frontend-app/src/components/Button.tsx");
    let entries = parsed.symbols();
    let props = symbol(&entries, "ButtonProps", SymbolKind::Interface);
    assert!(!props.exported);
    let button = symbol(&entries, "Button", SymbolKind::Function);
    assert!(button.exported);
    assert_range(&parsed.source, props);
    assert_range(&parsed.source, button);
}

fn fixture_symbol_api() {
    let parsed = parse_fixture("frontend-app/src/lib/api.ts");
    let entries = parsed.symbols();
    assert_eq!(symbol(&entries, "User", SymbolKind::Import).start_row, 0);
    let client = symbol(&entries, "ApiClient", SymbolKind::Type);
    assert!(client.exported);
    let method = symbol(&entries, "getJson", SymbolKind::Method);
    assert_eq!(method.parent_path, vec!["ApiClient"]);
    let fetch_user = symbol(&entries, "fetchUser", SymbolKind::Function);
    assert!(fetch_user.exported);
    for entry in [client, method, fetch_user] {
        assert_range(&parsed.source, entry);
    }
}

fn fixture_symbol_types() {
    let parsed = parse_fixture("frontend-app/src/lib/types.ts");
    let entries = parsed.symbols();
    for (name, kind) in [
        ("User", SymbolKind::Interface),
        ("ApiResult", SymbolKind::Interface),
        ("Theme", SymbolKind::Type),
    ] {
        let entry = symbol(&entries, name, kind);
        assert!(entry.exported);
        assert_range(&parsed.source, entry);
    }
}

fn fixture_symbol_large_routes() {
    let parsed = parse_fixture("frontend-app-large/src/app/routes.tsx");
    let entries = parsed.symbols();
    for (name, kind) in [
        ("routes", SymbolKind::Variable),
        ("describeRoute", SymbolKind::Function),
        ("routeLabels", SymbolKind::Variable),
    ] {
        let entry = symbol(&entries, name, kind);
        assert!(entry.exported);
        assert_range(&parsed.source, entry);
    }
}

fn fixture_symbol_large_modal() {
    let parsed = parse_fixture("frontend-app-large/src/components/Modal.tsx");
    let entries = parsed.symbols();
    let props = symbol(&entries, "ModalProps", SymbolKind::Interface);
    assert!(props.exported);
    let modal = symbol(&entries, "Modal", SymbolKind::Function);
    assert_range(&parsed.source, props);
    assert_range(&parsed.source, modal);
    let key_handler = symbol(&entries, "onKeyDown", SymbolKind::Function);
    assert_eq!(key_handler.parent_path, vec!["Modal"]);
    assert_range(&parsed.source, key_handler);
}

fn edit_replace_app() {
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

fn edit_replace_counter() {
    let parsed = parse_fixture("frontend-app/src/components/Counter.tsx");
    let replacement = "function Counter() {\n  return <div>counter</div>;\n}";
    let proposal = replace_symbol(
        &parsed,
        &query("Counter", SymbolKind::Function),
        replacement,
    )
    .expect("replace Counter");
    assert!(proposal
        .edited_source
        .contains("return <div>counter</div>;"));
    assert!(!proposal.edited_source.contains("setCount"));
    assert_edited_parses(&parsed, &proposal.edited_source, "replace Counter");
}

fn edit_insert_after_app() {
    let parsed = parse_fixture("frontend-app/src/App.tsx");
    let proposal = insert_after(
        &parsed,
        &query("App", SymbolKind::Function),
        "function benchmarkProbe() {\n  return 1;\n}",
    )
    .expect("insert after App");
    assert!(proposal
        .edited_source
        .contains("\nfunction benchmarkProbe() {\n  return 1;\n}\n"));
    assert_edited_parses(&parsed, &proposal.edited_source, "insert after App");
}

fn edit_insert_after_large_method() {
    let parsed = parse_fixture("frontend-app-large/src/lib/api.ts");
    let proposal = insert_after(
        &parsed,
        &SymbolQuery::new("get")
            .with_kind(SymbolKind::Method)
            .with_parent("FetchApiClient"),
        "benchmarkProbe(): number {\n  return 1;\n}",
    )
    .expect("insert after FetchApiClient::get");
    assert!(proposal
        .edited_source
        .contains("\n  benchmarkProbe(): number {"));
    assert_edited_parses(
        &parsed,
        &proposal.edited_source,
        "insert after large method",
    );
}

fn edit_delete_multiply() {
    let parsed = parse_fixture("frontend-app/src/lib/math.ts");
    let proposal =
        delete_symbol(&parsed, &query("multiply", SymbolKind::Function)).expect("delete multiply");
    assert!(!proposal.edited_source.contains("function multiply"));
    assert!(proposal.edited_source.contains("function add"));
    assert_edited_parses(&parsed, &proposal.edited_source, "delete multiply");
}

fn edit_delete_large_function() {
    let parsed = parse_fixture("frontend-app-large/src/lib/api.ts");
    let proposal = delete_symbol(&parsed, &query("listSessions", SymbolKind::Function))
        .expect("delete listSessions");
    assert!(!proposal.edited_source.contains("function listSessions"));
    assert!(proposal.edited_source.contains("function listUsers"));
    assert_edited_parses(&parsed, &proposal.edited_source, "delete large function");
}

fn edit_rename_add() {
    let parsed = parse_fixture("frontend-app/src/lib/math.ts");
    let proposal =
        rename_symbol(&parsed, &query("add", SymbolKind::Function), "sum").expect("rename add");
    assert!(proposal.edited_source.contains("function sum("));
    assert!(!proposal.edited_source.contains("function add("));
    assert_edited_parses(&parsed, &proposal.edited_source, "rename add");
}

fn edit_rename_large_route_labels() {
    let parsed = parse_fixture("frontend-app-large/src/app/routes.tsx");
    let proposal = rename_symbol(
        &parsed,
        &query("routeLabels", SymbolKind::Variable),
        "routeLabelList",
    )
    .expect("rename routeLabels");
    assert!(proposal
        .edited_source
        .contains("export const routeLabelList"));
    assert_edited_parses(&parsed, &proposal.edited_source, "rename large routeLabels");
}

fn edit_replace_real_symbol() {
    let parsed = parse_repo(REAL_ABORT_UTILS);
    let proposal = replace_symbol(
        &parsed,
        &query("USER_ABORT_MESSAGE", SymbolKind::Variable),
        "const USER_ABORT_MESSAGE = 'stopped'",
    )
    .expect("replace real abort message");
    assert!(proposal
        .edited_source
        .contains("export const USER_ABORT_MESSAGE = 'stopped'"));
    assert_edited_parses(&parsed, &proposal.edited_source, "replace real symbol");
}

fn edit_rename_real_symbol() {
    let parsed = parse_repo(REAL_ABORT_UTILS);
    let proposal = rename_symbol(
        &parsed,
        &query("normalizeAbortReason", SymbolKind::Function),
        "normalizeAbortReasonBench",
    )
    .expect("rename real function");
    assert!(proposal
        .edited_source
        .contains("function normalizeAbortReasonBench"));
    assert_edited_parses(&parsed, &proposal.edited_source, "rename real symbol");
}

fn edit_ambiguous_selector_rejected() {
    let source = "function duplicate() {}\nfunction duplicate() { return 1; }\n";
    let parsed = parse_source(Path::new("benchmark50/ambiguous.ts"), source);
    let error = delete_symbol(&parsed, &query("duplicate", SymbolKind::Function))
        .expect_err("ambiguous delete must fail");
    assert!(
        error.to_string().contains("ambiguous symbol"),
        "unexpected error: {error}"
    );
    assert_eq!(parsed.source, source);
}

fn edit_invalid_replacement_rejected() {
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

fn diagnostics_typescript_basic() {
    let log = read_text(&fixture_path("error-logs/typescript-typecheck.txt"));
    let outcome = failed_outcome(VerificationCheckKind::Typecheck, &log);
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
    let outcome = failed_outcome(VerificationCheckKind::Typecheck, &log);
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

fn diagnostics_eslint_basic() {
    let log = read_text(&fixture_path("error-logs/eslint.txt"));
    let outcome = failed_outcome(VerificationCheckKind::Lint, &log);
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
    let outcome = failed_outcome(VerificationCheckKind::Lint, &log);
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

fn diagnostics_vitest_assertion() {
    let log = read_text(&fixture_path("error-logs/vitest-assertion.txt"));
    let outcome = failed_outcome(VerificationCheckKind::Test, &log);
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

fn diagnostics_vitest_module_not_found() {
    let log = read_text(&fixture_path("error-logs/vitest-module-not-found.txt"));
    let outcome = failed_outcome(VerificationCheckKind::Test, &log);
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

fn diagnostics_bundler_fallback() {
    let log = read_text(&fixture_path("error-logs/bundler-module-not-found.txt"));
    let outcome = failed_outcome(VerificationCheckKind::Build, &log);
    let diagnostics = normalize_outcome(&outcome);
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].code, None);
    assert_eq!(diagnostics[0].severity, DiagnosticSeverity::Error);
    let report = analyze_diagnostics(&diagnostics);
    assert_eq!(report.error_count, 1);
    assert_eq!(match_ids(&report), vec!["build-failed-to-resolve-import"]);
    assert_eq!(report.primary_category, ErrorCategory::Build);
}

fn diagnostics_rollup_fallback() {
    let log = read_text(&fixture_path("error-logs/rollup-resolve-failure.txt"));
    let outcome = failed_outcome(VerificationCheckKind::Build, &log);
    let diagnostics = normalize_outcome(&outcome);
    assert_eq!(diagnostics.len(), 1);
    assert!(diagnostics[0]
        .raw
        .as_deref()
        .is_some_and(|raw| raw.contains("Could not resolve")));
    let report = analyze_diagnostics(&diagnostics);
    assert_eq!(match_ids(&report), vec!["generic-non-zero-exit"]);
    assert_eq!(report.primary_category, ErrorCategory::Unknown);
}

fn diagnostics_dedup_order() {
    let log = read_text(&fixture_path("error-logs/mixed-diagnostics.txt"));
    let diagnostics = normalize_outcome(&failed_outcome(VerificationCheckKind::Lint, &log));
    assert_eq!(diagnostics.len(), 4);
    let mut duplicated = diagnostics.clone();
    duplicated.insert(0, diagnostics[0].clone());
    let report = analyze_diagnostics(&duplicated);
    assert_eq!(report, analyze_diagnostics(&diagnostics));
    assert_eq!(report.error_count, 3);
    assert_eq!(report.warning_count, 1);
    assert_eq!(
        match_ids(&report),
        vec![
            "ts-2304",
            "ts-2339",
            "eslint-no-unused-vars",
            "eslint-react-hooks-exhaustive-deps",
        ]
    );
}

fn diagnostics_stable_signature() {
    let log = read_text(&fixture_path("error-logs/mixed-diagnostics.txt"));
    let diagnostics = normalize_outcome(&failed_outcome(VerificationCheckKind::Lint, &log));
    let forward = analyze_diagnostics(&diagnostics);
    let mut reversed_diagnostics = diagnostics;
    reversed_diagnostics.reverse();
    let reversed = analyze_diagnostics(&reversed_diagnostics);
    assert_eq!(forward, reversed);
    assert!(forward.failure_signature.starts_with("fnv1a64:"));
    assert!(forward
        .repair_instructions
        .iter()
        .any(|line| line.starts_with("type: src/app/App.tsx:")));
    assert!(forward
        .repair_instructions
        .iter()
        .any(|line| line.starts_with("lint: src/lib/format.ts:")));
}

fn repair_retry() {
    let report = report_for(
        VerificationCheckKind::Typecheck,
        &read_text(&fixture_path("error-logs/typescript-typecheck.txt")),
    );
    let policy = CodingPolicy {
        max_repair_rounds: 2,
        ..CodingPolicy::default()
    };
    let plan = plan_repair(&report, &[], 0, &policy);
    assert!(plan.should_retry);
    assert_eq!(plan.stop_reason, None);
    assert_eq!(plan.round, 1);
    assert_eq!(plan.signature, report.failure_signature);
    assert!(!plan.instructions.is_empty());
    assert!(plan.targeted_files.contains(&PathBuf::from("src/App.tsx")));
}

fn repair_repeated_failure() {
    let report = report_for(
        VerificationCheckKind::Typecheck,
        &read_text(&fixture_path("error-logs/typescript-typecheck.txt")),
    );
    let previous = vec![report.failure_signature.clone()];
    let plan = plan_repair(&report, &previous, 0, &CodingPolicy::default());
    assert!(!plan.should_retry);
    assert_eq!(plan.stop_reason, Some(RepairStopReason::RepeatedFailure));
}

fn repair_max_rounds() {
    let report = report_for(
        VerificationCheckKind::Typecheck,
        &read_text(&fixture_path("error-logs/typescript-typecheck.txt")),
    );
    let policy = CodingPolicy {
        max_repair_rounds: 2,
        ..CodingPolicy::default()
    };
    let plan = plan_repair(&report, &[], 2, &policy);
    assert!(!plan.should_retry);
    assert_eq!(plan.stop_reason, Some(RepairStopReason::MaxRepairRounds));
}

fn repair_no_repairable_issue() {
    let report = analyze_diagnostics(&[]);
    assert!(!report.has_repairable_issues);
    let plan = plan_repair(&report, &[], 0, &CodingPolicy::default());
    assert!(!plan.should_retry);
    assert_eq!(plan.stop_reason, Some(RepairStopReason::NoRepairableIssue));
}

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

fn formatting_crlf_preserve() {
    let source = "export function greet() {\r\n  return \"hi\";\r\n}\r\n";
    let parsed = parse_source(Path::new("benchmark50/crlf.ts"), source);
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

fn formatting_tabs_insert() {
    let source = "class Box {\n\tone() {}\n}\n";
    let parsed = parse_source(Path::new("benchmark50/tabs.ts"), source);
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

fn formatting_nested_indent() {
    let source = "function outer() {\n    function inner() {\n        return 1;\n    }\n}\n";
    let parsed = parse_source(Path::new("benchmark50/nested.ts"), source);
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
