//! Deterministic, offline frontend coding benchmark.
//!
//! Every case uses static fixtures under `tests/fixtures`. No package manager,
//! build script, subprocess, or network access is involved.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use worldbase_coding::{
    analyze_diagnostics, analyze_outcomes, detect_profile,
    error_analyzer::normalize_outcome,
    plan_repair,
    smart_editor::{parse_file, NodeSelector, ParsedFile, SymbolEntry, SymbolKind, SymbolQuery},
    CodingPolicy, CommandOutcome, DiagnosisReport, Diagnostic, DiagnosticSeverity, ErrorCategory,
    PackageManager, ProjectKind, RepairStopReason, VerificationCheckKind, VerificationCommand,
};

const LARGE_FILES: &[&str] = &[
    "frontend-app-large/src/app/App.tsx",
    "frontend-app-large/src/app/routes.tsx",
    "frontend-app-large/src/app/main.tsx",
    "frontend-app-large/src/components/Button.tsx",
    "frontend-app-large/src/components/Modal.tsx",
    "frontend-app-large/src/components/List.tsx",
    "frontend-app-large/src/components/Form.tsx",
    "frontend-app-large/src/components/Toast.tsx",
    "frontend-app-large/src/hooks/useDebounce.ts",
    "frontend-app-large/src/hooks/useFetch.ts",
    "frontend-app-large/src/hooks/useToggle.ts",
    "frontend-app-large/src/lib/api.ts",
    "frontend-app-large/src/lib/math.ts",
    "frontend-app-large/src/lib/format.ts",
    "frontend-app-large/src/lib/storage.ts",
    "frontend-app-large/src/lib/validation.ts",
    "frontend-app-large/src/types/api.ts",
    "frontend-app-large/src/types/models.ts",
    "frontend-app-large/src/types/ui.ts",
    "frontend-app-large/src/features/auth/AuthProvider.tsx",
    "frontend-app-large/src/features/auth/LoginForm.tsx",
    "frontend-app-large/src/features/session/SessionList.tsx",
    "frontend-app-large/src/features/session/sessionStore.ts",
    "frontend-app-large/tests/format.test.ts",
    "frontend-app-large/tests/validation.test.ts",
    "frontend-app-large/error-cases/type-errors.ts",
    "frontend-app-large/error-cases/lint-errors.tsx",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Category {
    Profile,
    Symbols,
    Edits,
    Diagnostics,
    Repair,
    Formatting,
}

impl Category {
    const ALL: [Category; 6] = [
        Category::Profile,
        Category::Symbols,
        Category::Edits,
        Category::Diagnostics,
        Category::Repair,
        Category::Formatting,
    ];

    fn name(self) -> &'static str {
        match self {
            Category::Profile => "profile",
            Category::Symbols => "symbols",
            Category::Edits => "edits",
            Category::Diagnostics => "diagnostics",
            Category::Repair => "repair",
            Category::Formatting => "formatting",
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
    passed: usize,
    failed: usize,
}

impl Benchmark {
    fn run(&mut self, case: &Case) {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(case.run));
        let passed = result.is_ok();
        if passed {
            self.passed += 1;
            println!("[PASS] {}", case.name);
        } else {
            self.failed += 1;
            let payload = result.expect_err("failed case");
            println!("[FAIL] {}: {}", case.name, panic_message(payload.as_ref()));
        }

        let stats = self.stats.entry(case.category).or_default();
        if passed {
            stats.passed += 1;
        } else {
            stats.failed += 1;
        }
    }

    fn finish(&self) {
        for category in Category::ALL {
            if let Some(stats) = self.stats.get(&category) {
                let total = stats.passed + stats.failed;
                println!("category {}: {}/{}", category.name(), stats.passed, total);
            }
        }
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

fn read_fixture(relative: &str) -> String {
    let path = fixture_path(relative);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

fn parse_fixture(relative: &str) -> ParsedFile {
    let source = read_fixture(relative);
    parse_file(Path::new(relative), &source)
        .unwrap_or_else(|error| panic!("parse fixture {relative}: {error}"))
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

fn diagnostic_codes(diagnostics: &[Diagnostic]) -> Vec<&str> {
    diagnostics.iter().map(code_of).collect()
}

fn match_ids(report: &DiagnosisReport) -> Vec<&str> {
    report
        .matches
        .iter()
        .map(|pattern_match| pattern_match.pattern_id.as_str())
        .collect()
}

fn report_for(kind: VerificationCheckKind, log: &str) -> DiagnosisReport {
    analyze_outcomes(&[failed_outcome(kind, log)])
}

fn benchmark_cases() -> Vec<Case> {
    vec![
        Case {
            name: "profile-detection",
            category: Category::Profile,
            run: profile_detection,
        },
        Case {
            name: "profile-detection-large",
            category: Category::Profile,
            run: profile_detection_large,
        },
        Case {
            name: "symbol-index",
            category: Category::Symbols,
            run: symbol_index,
        },
        Case {
            name: "symbol-index-large-app",
            category: Category::Symbols,
            run: symbol_index_large_app,
        },
        Case {
            name: "symbol-index-large-components",
            category: Category::Symbols,
            run: symbol_index_large_components,
        },
        Case {
            name: "symbol-index-large-hooks",
            category: Category::Symbols,
            run: symbol_index_large_hooks,
        },
        Case {
            name: "symbol-index-large-classes",
            category: Category::Symbols,
            run: symbol_index_large_classes,
        },
        Case {
            name: "symbol-index-large-types",
            category: Category::Symbols,
            run: symbol_index_large_types,
        },
        Case {
            name: "symbol-search-consistency",
            category: Category::Symbols,
            run: symbol_search_consistency,
        },
        Case {
            name: "ambiguous-candidate-listing",
            category: Category::Symbols,
            run: ambiguous_candidate_listing,
        },
        Case {
            name: "semantic-replace",
            category: Category::Edits,
            run: semantic_replace,
        },
        Case {
            name: "semantic-replace-large-component",
            category: Category::Edits,
            run: semantic_replace_large_component,
        },
        Case {
            name: "insert-after",
            category: Category::Edits,
            run: insert_after,
        },
        Case {
            name: "insert-after-large-class",
            category: Category::Edits,
            run: insert_after_large_class,
        },
        Case {
            name: "delete-symbol",
            category: Category::Edits,
            run: delete_symbol,
        },
        Case {
            name: "delete-symbol-large",
            category: Category::Edits,
            run: delete_symbol_large,
        },
        Case {
            name: "rename-symbol",
            category: Category::Edits,
            run: rename_symbol,
        },
        Case {
            name: "rename-symbol-large",
            category: Category::Edits,
            run: rename_symbol_large,
        },
        Case {
            name: "ambiguous-selector-rejection",
            category: Category::Edits,
            run: ambiguous_selector_rejection,
        },
        Case {
            name: "invalid-replacement-rejection",
            category: Category::Edits,
            run: invalid_replacement_rejection,
        },
        Case {
            name: "stale-proposal-offsets",
            category: Category::Edits,
            run: stale_proposal_offsets,
        },
        Case {
            name: "typescript-diagnosis",
            category: Category::Diagnostics,
            run: typescript_diagnosis,
        },
        Case {
            name: "typescript-extended-diagnosis",
            category: Category::Diagnostics,
            run: typescript_extended_diagnosis,
        },
        Case {
            name: "eslint-diagnosis",
            category: Category::Diagnostics,
            run: eslint_diagnosis,
        },
        Case {
            name: "eslint-extended-diagnosis",
            category: Category::Diagnostics,
            run: eslint_extended_diagnosis,
        },
        Case {
            name: "vitest-diagnosis",
            category: Category::Diagnostics,
            run: vitest_diagnosis,
        },
        Case {
            name: "vitest-module-not-found-diagnosis",
            category: Category::Diagnostics,
            run: vitest_module_not_found_diagnosis,
        },
        Case {
            name: "bundler-diagnosis",
            category: Category::Diagnostics,
            run: bundler_diagnosis,
        },
        Case {
            name: "rollup-resolve-failure",
            category: Category::Diagnostics,
            run: rollup_resolve_failure,
        },
        Case {
            name: "diagnosis-dedup-ordering",
            category: Category::Diagnostics,
            run: diagnosis_dedup_ordering,
        },
        Case {
            name: "multi-error-aggregation-signature",
            category: Category::Diagnostics,
            run: multi_error_aggregation_signature,
        },
        Case {
            name: "repair-planning",
            category: Category::Repair,
            run: repair_planning,
        },
        Case {
            name: "repair-no-repairable-issue",
            category: Category::Repair,
            run: repair_no_repairable_issue,
        },
        Case {
            name: "repair-repeated-history",
            category: Category::Repair,
            run: repair_repeated_history,
        },
        Case {
            name: "repair-targeted-files-priority",
            category: Category::Repair,
            run: repair_targeted_files_priority,
        },
        Case {
            name: "repair-round-progression",
            category: Category::Repair,
            run: repair_round_progression,
        },
        Case {
            name: "formatting-preservation",
            category: Category::Formatting,
            run: formatting_preservation,
        },
        Case {
            name: "formatting-indentation-spaces",
            category: Category::Formatting,
            run: formatting_indentation_spaces,
        },
        Case {
            name: "formatting-crlf-tabs-insert",
            category: Category::Formatting,
            run: formatting_crlf_tabs_insert,
        },
    ]
}

#[test]
fn frontend_coding_benchmark() {
    let mut suite = Benchmark::default();
    for case in benchmark_cases() {
        suite.run(&case);
    }
    suite.finish();
}

fn profile_detection() {
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
}

fn profile_detection_large() {
    let profile = detect_profile(&fixture_path("frontend-app-large"))
        .unwrap_or_else(|error| panic!("detect large profile: {error}"));

    assert_eq!(profile.project_kind, ProjectKind::FrontendNode);
    assert_eq!(profile.package_manager, Some(PackageManager::Yarn));
    assert_eq!(profile.commands.len(), 4);
    assert!(profile
        .commands
        .iter()
        .all(|command| command.program == "yarn"));
    assert!(profile.commands.iter().all(|command| command.required));
    assert!(profile.source.contains("yarn.lock"));
}

fn symbol_index() {
    let app = parse_fixture("frontend-app/src/App.tsx");
    assert!(!app.has_syntax_errors());
    let app_symbols = app.symbols();

    let app_component = symbol(&app_symbols, "App", SymbolKind::Function);
    assert!(app_component.exported);
    assert!(app_component.parent_path.is_empty());
    assert_eq!(app_component.start_row, 6);
    assert_range(&app.source, app_component);
    assert!(app.source[app_component.byte_range()].starts_with("function App() {"));

    let counter_import = symbol(&app_symbols, "Counter", SymbolKind::Import);
    assert_eq!(counter_import.start_row, 0);
    assert_range(&app.source, counter_import);
    assert_eq!(
        &app.source[counter_import.byte_range()],
        "import { Counter } from \"./components/Counter\";"
    );

    let theme_import = symbol(&app_symbols, "Theme", SymbolKind::Import);
    assert_eq!(theme_import.start_row, 2);
    assert_range(&app.source, theme_import);

    let default_theme = symbol(&app_symbols, "DEFAULT_THEME", SymbolKind::Variable);
    assert!(!default_theme.exported);
    assert_eq!(default_theme.start_row, 4);
    assert_range(&app.source, default_theme);
    assert_eq!(
        &app.source[default_theme.byte_range()],
        "const DEFAULT_THEME: Theme = \"light\";"
    );

    let counter = parse_fixture("frontend-app/src/components/Counter.tsx");
    assert!(!counter.has_syntax_errors());
    let counter_symbols = counter.symbols();

    let props = symbol(&counter_symbols, "CounterProps", SymbolKind::Interface);
    assert!(!props.exported);
    assert_eq!(props.start_row, 3);
    assert_range(&counter.source, props);
    assert!(counter.source[props.byte_range()].starts_with("interface CounterProps {"));

    let counter_component = symbol(&counter_symbols, "Counter", SymbolKind::Function);
    assert!(counter_component.exported);
    assert_eq!(counter_component.start_row, 8);
    assert_range(&counter.source, counter_component);
    assert!(counter.source[counter_component.byte_range()].starts_with("function Counter("));

    let increment = symbol(&counter_symbols, "increment", SymbolKind::Function);
    assert_eq!(increment.parent_path, vec!["Counter"]);
    assert_eq!(increment.start_row, 11);
    assert_range(&counter.source, increment);

    let decrement = symbol(&counter_symbols, "decrement", SymbolKind::Function);
    assert_eq!(decrement.parent_path, vec!["Counter"]);
    assert_eq!(decrement.start_row, 15);
    assert_range(&counter.source, decrement);

    let button = parse_fixture("frontend-app/src/components/Button.tsx");
    let button_symbols = button.symbols();
    let button_props = symbol(&button_symbols, "ButtonProps", SymbolKind::Interface);
    assert!(!button_props.exported);
    assert_eq!(button_props.start_row, 2);
    assert_range(&button.source, button_props);
    let button_component = symbol(&button_symbols, "Button", SymbolKind::Function);
    assert!(button_component.exported);
    assert_eq!(button_component.start_row, 7);
    assert_range(&button.source, button_component);

    let api = parse_fixture("frontend-app/src/lib/api.ts");
    assert!(!api.has_syntax_errors());
    let api_symbols = api.symbols();

    let user_import = symbol(&api_symbols, "User", SymbolKind::Import);
    assert_eq!(user_import.start_row, 0);
    assert_range(&api.source, user_import);

    let client = symbol(&api_symbols, "ApiClient", SymbolKind::Type);
    assert!(client.exported);
    assert_eq!(client.start_row, 4);
    assert_range(&api.source, client);
    assert!(api.source[client.byte_range()].starts_with("class ApiClient {"));

    let get_json = symbol(&api_symbols, "getJson", SymbolKind::Method);
    assert_eq!(get_json.parent_path, vec!["ApiClient"]);
    assert_eq!(get_json.start_row, 7);
    assert_eq!(get_json.start_column, 2);
    assert_range(&api.source, get_json);

    let fetch_user = symbol(&api_symbols, "fetchUser", SymbolKind::Function);
    assert!(fetch_user.exported);
    assert_eq!(fetch_user.start_row, 16);
    assert_range(&api.source, fetch_user);

    let types = parse_fixture("frontend-app/src/lib/types.ts");
    assert!(!types.has_syntax_errors());
    let type_symbols = types.symbols();
    let user = symbol(&type_symbols, "User", SymbolKind::Interface);
    assert!(user.exported);
    assert_eq!(user.start_row, 0);
    assert_range(&types.source, user);
    let result = symbol(&type_symbols, "ApiResult", SymbolKind::Interface);
    assert!(result.exported);
    assert_eq!(result.start_row, 6);
    assert_range(&types.source, result);
    let theme = symbol(&type_symbols, "Theme", SymbolKind::Type);
    assert!(theme.exported);
    assert_eq!(theme.start_row, 11);
    assert_range(&types.source, theme);
}

fn symbol_index_large_app() {
    let app = parse_fixture("frontend-app-large/src/app/App.tsx");
    assert!(!app.has_syntax_errors());
    let symbols = app.symbols();

    let component = symbol(&symbols, "App", SymbolKind::Function);
    assert!(component.exported);
    assert_eq!(component.start_row, 15);
    assert_range(&app.source, component);
    assert!(app.source[component.byte_range()].starts_with("function App() {"));

    let auth_import = symbol(&symbols, "AuthProvider", SymbolKind::Import);
    assert_eq!(auth_import.start_row, 1);
    assert_range(&app.source, auth_import);

    let session_import = symbol(&symbols, "Session", SymbolKind::Import);
    assert_eq!(session_import.start_row, 6);
    assert_range(&app.source, session_import);

    let demo = symbol(&symbols, "demoSession", SymbolKind::Variable);
    assert!(!demo.exported);
    assert_eq!(demo.start_row, 8);
    assert_range(&app.source, demo);
    assert!(app.source[demo.byte_range()].starts_with("const demoSession: Session = {"));

    let routes = parse_fixture("frontend-app-large/src/app/routes.tsx");
    let symbols = routes.symbols();
    let route_table = symbol(&symbols, "routes", SymbolKind::Variable);
    assert!(route_table.exported);
    assert_eq!(route_table.start_row, 4);
    assert_range(&routes.source, route_table);
    let describe = symbol(&symbols, "describeRoute", SymbolKind::Function);
    assert!(describe.exported);
    assert_eq!(describe.start_row, 9);
    assert_range(&routes.source, describe);
    let labels = symbol(&symbols, "routeLabels", SymbolKind::Variable);
    assert!(labels.exported);
    assert_eq!(labels.start_row, 13);
    assert_range(&routes.source, labels);
}

fn symbol_index_large_components() {
    let button = parse_fixture("frontend-app-large/src/components/Button.tsx");
    let symbols = button.symbols();
    let props = symbol(&symbols, "ButtonProps", SymbolKind::Interface);
    assert!(props.exported);
    assert_eq!(props.start_row, 3);
    assert_range(&button.source, props);
    let component = symbol(&symbols, "Button", SymbolKind::Function);
    assert!(component.exported);
    assert_eq!(component.start_row, 8);
    assert_range(&button.source, component);
    let default_export = symbol(&symbols, "default", SymbolKind::Export);
    assert_eq!(default_export.start_row, 17);
    assert_range(&button.source, default_export);

    let modal = parse_fixture("frontend-app-large/src/components/Modal.tsx");
    let symbols = modal.symbols();
    let props = symbol(&symbols, "ModalProps", SymbolKind::Interface);
    assert!(props.exported);
    assert_eq!(props.start_row, 4);
    assert_range(&modal.source, props);
    let component = symbol(&symbols, "Modal", SymbolKind::Function);
    assert_eq!(component.start_row, 11);
    assert_range(&modal.source, component);
    let key_handler = symbol(&symbols, "onKeyDown", SymbolKind::Function);
    assert_eq!(key_handler.parent_path, vec!["Modal"]);
    assert_eq!(key_handler.start_row, 16);
    assert_range(&modal.source, key_handler);

    let list = parse_fixture("frontend-app-large/src/components/List.tsx");
    let symbols = list.symbols();
    let item = symbol(&symbols, "ListItem", SymbolKind::Interface);
    assert!(item.exported);
    assert_range(&list.source, item);
    let list_props = symbol(&symbols, "ListProps", SymbolKind::Interface);
    assert!(list_props.exported);
    assert_range(&list.source, list_props);
    let component = symbol(&symbols, "List", SymbolKind::Function);
    assert!(component.exported);
    assert_range(&list.source, component);
    let empty = symbol(&symbols, "EmptyList", SymbolKind::Function);
    assert!(empty.exported);
    assert_range(&list.source, empty);

    let form = parse_fixture("frontend-app-large/src/components/Form.tsx");
    let symbols = form.symbols();
    let field = symbol(&symbols, "FormField", SymbolKind::Interface);
    assert!(field.exported);
    assert_range(&form.source, field);
    let form_props = symbol(&symbols, "FormProps", SymbolKind::Interface);
    assert!(form_props.exported);
    assert_range(&form.source, form_props);
    let component = symbol(&symbols, "Form", SymbolKind::Function);
    assert!(component.exported);
    assert_range(&form.source, component);
    let update = symbol(&symbols, "update", SymbolKind::Function);
    assert_eq!(update.parent_path, vec!["Form"]);
    assert_range(&form.source, update);

    let toast = parse_fixture("frontend-app-large/src/components/Toast.tsx");
    let symbols = toast.symbols();
    let props = symbol(&symbols, "ToastProps", SymbolKind::Interface);
    assert!(props.exported);
    assert_range(&toast.source, props);
    let component = symbol(&symbols, "Toast", SymbolKind::Function);
    assert!(component.exported);
    assert_range(&toast.source, component);
    let stack = symbol(&symbols, "ToastStack", SymbolKind::Function);
    assert!(stack.exported);
    assert_range(&toast.source, stack);
}

fn symbol_index_large_hooks() {
    let debounce = parse_fixture("frontend-app-large/src/hooks/useDebounce.ts");
    let symbols = debounce.symbols();
    let hook = symbol(&symbols, "useDebounce", SymbolKind::Function);
    assert!(hook.exported);
    assert_eq!(hook.start_row, 2);
    assert_range(&debounce.source, hook);

    let fetch = parse_fixture("frontend-app-large/src/hooks/useFetch.ts");
    let symbols = fetch.symbols();
    let state = symbol(&symbols, "FetchState", SymbolKind::Interface);
    assert!(!state.exported);
    assert_eq!(state.start_row, 2);
    assert_range(&fetch.source, state);
    let hook = symbol(&symbols, "useFetch", SymbolKind::Function);
    assert!(hook.exported);
    assert_eq!(hook.start_row, 8);
    assert_range(&fetch.source, hook);

    let toggle = parse_fixture("frontend-app-large/src/hooks/useToggle.ts");
    let symbols = toggle.symbols();
    let hook = symbol(&symbols, "useToggle", SymbolKind::Function);
    assert!(hook.exported);
    assert_eq!(hook.start_row, 2);
    assert_range(&toggle.source, hook);

    let toggle_fn = symbol(&symbols, "toggle", SymbolKind::Variable);
    assert_eq!(toggle_fn.parent_path, vec!["useToggle"]);
    assert_eq!(toggle_fn.start_row, 5);
    assert_range(&toggle.source, toggle_fn);

    let set_fn = symbol(&symbols, "set", SymbolKind::Variable);
    assert_eq!(set_fn.parent_path, vec!["useToggle"]);
    assert_eq!(set_fn.start_row, 9);
    assert_range(&toggle.source, set_fn);
}

fn symbol_index_large_classes() {
    let api = parse_fixture("frontend-app-large/src/lib/api.ts");
    let symbols = api.symbols();
    let client = symbol(&symbols, "FetchApiClient", SymbolKind::Type);
    assert!(client.exported);
    assert_eq!(client.start_row, 5);
    assert_range(&api.source, client);
    let get = symbol(&symbols, "get", SymbolKind::Method);
    assert_eq!(get.parent_path, vec!["FetchApiClient"]);
    assert_eq!(get.start_row, 8);
    assert_range(&api.source, get);
    let post = symbol(&symbols, "post", SymbolKind::Method);
    assert_eq!(post.parent_path, vec!["FetchApiClient"]);
    assert_eq!(post.start_row, 16);
    assert_range(&api.source, post);

    let storage = parse_fixture("frontend-app-large/src/lib/storage.ts");
    let symbols = storage.symbols();
    let memory = symbol(&symbols, "MemoryStorage", SymbolKind::Type);
    assert!(memory.exported);
    assert_eq!(memory.start_row, 6);
    assert_range(&storage.source, memory);
    let session = symbol(&symbols, "SessionStorage", SymbolKind::Type);
    assert!(session.exported);
    assert_eq!(session.start_row, 22);
    assert_range(&storage.source, session);
    let get_item = symbol(&symbols, "getItem", SymbolKind::Method);
    assert_eq!(get_item.parent_path, vec!["MemoryStorage"]);
    assert_eq!(get_item.start_row, 9);
    assert_range(&storage.source, get_item);

    let store = parse_fixture("frontend-app-large/src/features/session/sessionStore.ts");
    let symbols = store.symbols();
    let memory_store = symbol(&symbols, "MemorySessionStore", SymbolKind::Type);
    assert!(memory_store.exported);
    assert_eq!(memory_store.start_row, 8);
    assert_range(&store.source, memory_store);
    let save = symbol(&symbols, "save", SymbolKind::Method);
    assert_eq!(save.parent_path, vec!["MemorySessionStore"]);
    assert_eq!(save.start_row, 11);
    assert_range(&store.source, save);
    let list = symbol(&symbols, "list", SymbolKind::Method);
    assert_eq!(list.parent_path, vec!["MemorySessionStore"]);
    assert_range(&store.source, list);
    let remove = symbol(&symbols, "remove", SymbolKind::Method);
    assert_eq!(remove.parent_path, vec!["MemorySessionStore"]);
    assert_range(&store.source, remove);
    let singleton = symbol(&symbols, "sessionStore", SymbolKind::Variable);
    assert!(singleton.exported);
    assert_eq!(singleton.start_row, 24);
    assert_range(&store.source, singleton);
}

fn symbol_index_large_types() {
    let models = parse_fixture("frontend-app-large/src/types/models.ts");
    let symbols = models.symbols();
    let user = symbol(&symbols, "User", SymbolKind::Interface);
    assert!(user.exported);
    assert_eq!(user.start_row, 0);
    assert_range(&models.source, user);
    let session = symbol(&symbols, "Session", SymbolKind::Interface);
    assert_eq!(session.start_row, 6);
    assert_range(&models.source, session);
    let role = symbol(&symbols, "Role", SymbolKind::Type);
    assert_eq!(role.start_row, 13);
    assert_range(&models.source, role);
    let paginated = symbol(&symbols, "Paginated", SymbolKind::Interface);
    assert_eq!(paginated.start_row, 15);
    assert_range(&models.source, paginated);

    let api = parse_fixture("frontend-app-large/src/types/api.ts");
    let symbols = api.symbols();
    let error = symbol(&symbols, "ApiError", SymbolKind::Interface);
    assert_eq!(error.start_row, 2);
    assert_range(&api.source, error);
    let auth = symbol(&symbols, "AuthResponse", SymbolKind::Interface);
    assert_eq!(auth.start_row, 7);
    assert_range(&api.source, auth);
    let users = symbol(&symbols, "UserListResponse", SymbolKind::Type);
    assert_eq!(users.start_row, 12);
    assert_range(&api.source, users);
    let sessions = symbol(&symbols, "SessionListResponse", SymbolKind::Type);
    assert_eq!(sessions.start_row, 13);
    assert_range(&api.source, sessions);
    let client = symbol(&symbols, "ApiClient", SymbolKind::Interface);
    assert_eq!(client.start_row, 15);
    assert_range(&api.source, client);

    let ui = parse_fixture("frontend-app-large/src/types/ui.ts");
    let symbols = ui.symbols();
    let size = symbol(&symbols, "Size", SymbolKind::Type);
    assert_eq!(size.start_row, 2);
    assert_range(&ui.source, size);
    let option = symbol(&symbols, "SelectOption", SymbolKind::Interface);
    assert_eq!(option.start_row, 4);
    assert_range(&ui.source, option);
    let nav = symbol(&symbols, "NavItem", SymbolKind::Interface);
    assert_eq!(nav.start_row, 9);
    assert_range(&ui.source, nav);
    let toast = symbol(&symbols, "ToastKind", SymbolKind::Type);
    assert_eq!(toast.start_row, 15);
    assert_range(&ui.source, toast);
}

fn symbol_search_consistency() {
    assert!(LARGE_FILES.len() >= 20);
    let mut total_symbols = 0;

    for relative in LARGE_FILES {
        let parsed = parse_fixture(relative);
        assert!(!parsed.has_syntax_errors(), "{relative} has syntax errors");
        let symbols = parsed.symbols();
        total_symbols += symbols.len();
        assert!(
            symbols
                .windows(2)
                .all(|window| window[0].start_byte <= window[1].start_byte),
            "{relative} symbols are not in source order"
        );

        for entry in &symbols {
            assert_range(&parsed.source, entry);
            let query = SymbolQuery::new(&entry.name)
                .with_kind(entry.kind)
                .with_parent_path(entry.parent_path.clone());
            let found = parsed.find_symbol(&query).unwrap_or_else(|error| {
                panic!("{relative}: query {query} failed for indexed symbol: {error}")
            });
            assert_eq!(found.start_byte, entry.start_byte, "{relative}");
            assert_eq!(found.end_byte, entry.end_byte, "{relative}");
        }
    }

    assert!(
        total_symbols >= 100,
        "expected a large symbol corpus, found {total_symbols}"
    );
}

fn ambiguous_candidate_listing() {
    let storage = parse_fixture("frontend-app-large/src/lib/storage.ts");
    let error = storage
        .find_symbol(&SymbolQuery::new("getItem"))
        .expect_err("two classes define getItem")
        .to_string();

    assert!(
        error.contains("ambiguous symbol"),
        "unexpected error: {error}"
    );
    assert!(error.contains("2 matches"), "unexpected error: {error}");
    assert!(
        error.contains("method `getItem`"),
        "unexpected error: {error}"
    );
    assert!(
        error.matches("at bytes").count() >= 2,
        "missing candidates: {error}"
    );

    let memory = storage
        .find_symbol(
            &SymbolQuery::new("getItem")
                .with_kind(SymbolKind::Method)
                .with_parent("MemoryStorage"),
        )
        .expect("parent disambiguates MemoryStorage");
    assert_eq!(memory.start_row, 9);
    let session = storage
        .find_symbol(
            &SymbolQuery::new("getItem")
                .with_kind(SymbolKind::Method)
                .with_parent("SessionStorage"),
        )
        .expect("parent disambiguates SessionStorage");
    assert_eq!(session.start_row, 25);
}

fn semantic_replace() {
    let math = parse_fixture("frontend-app/src/lib/math.ts");
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

    let edited = parse_file(Path::new("src/lib/math.ts"), &edit.edited_source)
        .unwrap_or_else(|error| panic!("re-parse edited math: {error}"));
    assert!(!edited.has_syntax_errors());
    let symbols = edited.symbols();
    let add = symbol(&symbols, "add", SymbolKind::Function);
    assert!(edited.source[add.byte_range()].contains("+ 1"));
}

fn semantic_replace_large_component() {
    let modal = parse_fixture("frontend-app-large/src/components/Modal.tsx");
    let replacement = "function Modal({ open, title, onClose, children }: ModalProps) {\n  if (!open) {\n    return null;\n  }\n\n  return (\n    <div className=\"modal\" role=\"dialog\" aria-label={title}>\n      <header>\n        <h2>{title}</h2>\n        <Button label=\"Dismiss\" onClick={onClose} />\n      </header>\n      <section>{children}</section>\n    </div>\n  );\n}";
    let edit = modal
        .replace_symbol(
            &SymbolQuery::new("Modal").with_kind(SymbolKind::Function),
            replacement,
        )
        .unwrap_or_else(|error| panic!("replace Modal: {error}"));

    assert!(edit.edited_source.contains("label=\"Dismiss\""));
    assert!(!edit.edited_source.contains("label=\"Close\""));
    let edited = parse_file(Path::new("src/components/Modal.tsx"), &edit.edited_source)
        .unwrap_or_else(|error| panic!("re-parse edited Modal: {error}"));
    assert!(!edited.has_syntax_errors());
    let symbols = edited.symbols();
    let component = symbol(&symbols, "Modal", SymbolKind::Function);
    assert_range(&edited.source, component);
    assert!(edited.source[component.byte_range()].contains("Dismiss"));
}

fn insert_after() {
    let math = parse_fixture("frontend-app/src/lib/math.ts");
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

    let edited = parse_file(Path::new("src/lib/math.ts"), &edit.edited_source)
        .unwrap_or_else(|error| panic!("re-parse inserted math: {error}"));
    assert!(!edited.has_syntax_errors());
    let subtract = edited
        .find_symbol(&SymbolQuery::new("subtract").with_kind(SymbolKind::Function))
        .expect("inserted subtract symbol");
    assert!(subtract.parent_path.is_empty());
}

fn insert_after_large_class() {
    let store = parse_fixture("frontend-app-large/src/features/session/sessionStore.ts");
    let edit = store
        .insert_after(
            &SymbolQuery::new("remove")
                .with_kind(SymbolKind::Method)
                .with_parent("MemorySessionStore"),
            "clear(): void {\n  this.sessions.clear();\n}",
        )
        .unwrap_or_else(|error| panic!("insert clear method: {error}"));

    assert!(edit.edited_source.contains(
        "  remove(id: string): void {\n    this.sessions.delete(id);\n  }\n  clear(): void {\n    this.sessions.clear();\n  }\n}"
    ));
    let edited = parse_file(
        Path::new("src/features/session/sessionStore.ts"),
        &edit.edited_source,
    )
    .unwrap_or_else(|error| panic!("re-parse session store: {error}"));
    assert!(!edited.has_syntax_errors());
    let clear = edited
        .find_symbol(
            &SymbolQuery::new("clear")
                .with_kind(SymbolKind::Method)
                .with_parent("MemorySessionStore"),
        )
        .expect("inserted clear method");
    assert_eq!(clear.parent_path, vec!["MemorySessionStore"]);
}

fn delete_symbol() {
    let math = parse_fixture("frontend-app/src/lib/math.ts");
    let edit = math
        .delete_symbol(&SymbolQuery::new("legacyTotal").with_kind(SymbolKind::Function))
        .unwrap_or_else(|error| panic!("delete legacyTotal: {error}"));

    assert!(edit
        .original_snippet
        .starts_with("export function legacyTotal("));
    assert!(!edit.edited_source.contains("legacyTotal"));
    assert!(edit.edited_source.contains("export const clamp"));

    let edited = parse_file(Path::new("src/lib/math.ts"), &edit.edited_source)
        .unwrap_or_else(|error| panic!("re-parse deleted math: {error}"));
    assert!(!edited.has_syntax_errors());
    let missing = edited
        .find_symbol(&SymbolQuery::new("legacyTotal").with_kind(SymbolKind::Function))
        .expect_err("deleted symbol must not be indexed");
    assert!(missing.to_string().contains("no symbol matched"));
}

fn delete_symbol_large() {
    let math = parse_fixture("frontend-app-large/src/lib/math.ts");
    let edit = math
        .delete_symbol(&SymbolQuery::new("deprecatedScore").with_kind(SymbolKind::Function))
        .unwrap_or_else(|error| panic!("delete deprecatedScore: {error}"));

    assert!(edit
        .original_snippet
        .starts_with("export function deprecatedScore("));
    assert!(!edit.edited_source.contains("deprecatedScore"));
    assert!(edit.edited_source.contains("export function percentage"));

    let edited = parse_file(Path::new("src/lib/math.ts"), &edit.edited_source)
        .unwrap_or_else(|error| panic!("re-parse large math: {error}"));
    assert!(!edited.has_syntax_errors());
    assert!(edited
        .find_symbol(&SymbolQuery::new("deprecatedScore").with_kind(SymbolKind::Function))
        .is_err());
}

fn rename_symbol() {
    let math = parse_fixture("frontend-app/src/lib/math.ts");
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

    let edited = parse_file(Path::new("src/lib/math.ts"), &edit.edited_source)
        .unwrap_or_else(|error| panic!("re-parse renamed math: {error}"));
    assert!(!edited.has_syntax_errors());
    edited
        .find_symbol(&SymbolQuery::new("formatItemCount").with_kind(SymbolKind::Function))
        .expect("renamed symbol");
    assert!(edited
        .find_symbol(&SymbolQuery::new("formatCount").with_kind(SymbolKind::Function))
        .is_err());
}

fn rename_symbol_large() {
    let format = parse_fixture("frontend-app-large/src/lib/format.ts");
    let edit = format
        .rename_symbol(
            &SymbolQuery::new("formatSessionCount").with_kind(SymbolKind::Function),
            "formatActiveSessionCount",
        )
        .unwrap_or_else(|error| panic!("rename formatSessionCount: {error}"));

    assert!(edit
        .edited_source
        .contains("function formatActiveSessionCount(count: number): string"));
    assert!(edit
        .edited_source
        .contains("Active: ${formatActiveSessionCount(count)}"));
    assert!(!edit.edited_source.contains("formatSessionCount"));

    let edited = parse_file(Path::new("src/lib/format.ts"), &edit.edited_source)
        .unwrap_or_else(|error| panic!("re-parse renamed format: {error}"));
    assert!(!edited.has_syntax_errors());
    edited
        .find_symbol(&SymbolQuery::new("formatActiveSessionCount").with_kind(SymbolKind::Function))
        .expect("renamed format symbol");
    assert!(edited
        .find_symbol(&SymbolQuery::new("formatSessionCount").with_kind(SymbolKind::Function))
        .is_err());
}

fn ambiguous_selector_rejection() {
    let counter = parse_fixture("frontend-app/src/components/Counter.tsx");
    let error = counter
        .find_node(&NodeSelector::new("function_declaration"))
        .expect_err("three function declarations must be ambiguous")
        .to_string();
    assert!(error.contains("3 matched"), "unexpected error: {error}");
}

fn invalid_replacement_rejection() {
    let math = parse_fixture("frontend-app/src/lib/math.ts");
    let error = math
        .propose_semantic_edit(
            &NodeSelector::new("function_declaration").with_name("add"),
            "function add(left: number, right: number): number {\n  return left +;",
        )
        .expect_err("unbalanced expression must be rejected")
        .to_string();
    assert!(error.contains("syntax errors"), "unexpected error: {error}");
    assert_eq!(math.source, read_fixture("frontend-app/src/lib/math.ts"));

    let broken = parse_fixture("frontend-app-large/error-cases/syntax-error.tsx");
    assert!(broken.has_syntax_errors());
}

fn stale_proposal_offsets() {
    let format = parse_fixture("frontend-app-large/src/lib/format.ts");
    let edit = format
        .replace_symbol(
            &SymbolQuery::new("truncate").with_kind(SymbolKind::Function),
            "function truncate(value: string, length = 40): string {\n  return value.slice(0, length);\n}",
        )
        .unwrap_or_else(|error| panic!("propose truncate edit: {error}"));

    let mut updated = format.source.clone();
    updated.insert_str(0, "// generated from a newer revision\n");
    let stale_slice = updated
        .get(edit.byte_range.clone())
        .expect("old byte range remains in bounds");
    assert_ne!(stale_slice, edit.original_snippet);

    let reparsed = parse_file(Path::new("src/lib/format.ts"), &updated)
        .unwrap_or_else(|error| panic!("re-parse updated format: {error}"));
    let fresh = reparsed
        .find_symbol(&SymbolQuery::new("truncate").with_kind(SymbolKind::Function))
        .expect("re-query after content shift");
    assert!(fresh.start_byte > edit.byte_range.start);
    assert_eq!(&updated[fresh.byte_range()], edit.original_snippet);
}

fn typescript_diagnosis() {
    let log = read_fixture("error-logs/typescript-typecheck.txt");
    let outcome = failed_outcome(VerificationCheckKind::Typecheck, &log);
    let diagnostics = normalize_outcome(&outcome);
    assert_eq!(diagnostics.len(), 3);
    assert_eq!(
        diagnostic_codes(&diagnostics),
        vec!["TS2304", "TS2339", "TS2345"]
    );

    let report = analyze_outcomes(std::slice::from_ref(&outcome));
    assert_eq!(report.error_count, 3);
    assert_eq!(report.warning_count, 0);
    assert_eq!(report.primary_category, ErrorCategory::Type);
    assert_eq!(match_ids(&report), vec!["ts-2304", "ts-2339", "ts-2345"]);
    assert!(report.has_repairable_issues);
    assert!(report.failure_signature.starts_with("fnv1a64:"));
}

fn typescript_extended_diagnosis() {
    let log = read_fixture("error-logs/typescript-extended.txt");
    let outcome = failed_outcome(VerificationCheckKind::Typecheck, &log);
    let diagnostics = normalize_outcome(&outcome);
    assert_eq!(diagnostics.len(), 4);
    assert_eq!(
        diagnostic_codes(&diagnostics),
        vec!["TS2322", "TS2307", "TS2554", "TS7006"]
    );

    let report = analyze_outcomes(std::slice::from_ref(&outcome));
    assert_eq!(report.error_count, 4);
    assert_eq!(report.primary_category, ErrorCategory::Type);
    assert_eq!(
        match_ids(&report),
        vec!["ts-2322", "ts-2307", "ts-7006", "ts-2554"]
    );
    assert_eq!(
        report.affected_files,
        vec![
            PathBuf::from("src/app/App.tsx"),
            PathBuf::from("src/app/routes.tsx"),
            PathBuf::from("src/hooks/useFetch.ts"),
            PathBuf::from("src/lib/api.ts"),
        ]
    );
    assert!(report
        .repair_instructions
        .iter()
        .any(|line| line.starts_with("import: src/app/routes.tsx:")));
}

fn eslint_diagnosis() {
    let log = read_fixture("error-logs/eslint.txt");
    let outcome = failed_outcome(VerificationCheckKind::Lint, &log);
    let diagnostics = normalize_outcome(&outcome);
    assert_eq!(diagnostics.len(), 2);
    assert_eq!(
        diagnostic_codes(&diagnostics),
        vec!["no-unused-vars", "import/no-unresolved"]
    );

    let report = analyze_outcomes(std::slice::from_ref(&outcome));
    assert_eq!(report.error_count, 2);
    assert_eq!(report.primary_category, ErrorCategory::Lint);
    assert_eq!(
        match_ids(&report),
        vec!["eslint-no-unused-vars", "eslint-import-no-unresolved"]
    );
    assert_eq!(report.matches[1].category, ErrorCategory::Import);
}

fn eslint_extended_diagnosis() {
    let log = read_fixture("error-logs/eslint-extended.txt");
    let outcome = failed_outcome(VerificationCheckKind::Lint, &log);
    let diagnostics = normalize_outcome(&outcome);
    assert_eq!(diagnostics.len(), 2);
    assert_eq!(
        diagnostic_codes(&diagnostics),
        vec!["no-undef", "react-hooks/exhaustive-deps"]
    );

    let report = analyze_outcomes(std::slice::from_ref(&outcome));
    assert_eq!(report.error_count, 1);
    assert_eq!(report.warning_count, 1);
    assert_eq!(report.primary_category, ErrorCategory::Lint);
    assert_eq!(
        match_ids(&report),
        vec!["eslint-no-undef", "eslint-react-hooks-exhaustive-deps"]
    );
}

fn vitest_diagnosis() {
    let assertion_log = read_fixture("error-logs/vitest-assertion.txt");
    let assertion_outcome = failed_outcome(VerificationCheckKind::Test, &assertion_log);
    let assertion_diagnostics = normalize_outcome(&assertion_outcome);
    assert_eq!(assertion_diagnostics.len(), 1);
    assert_eq!(code_of(&assertion_diagnostics[0]), "TEST_FAILURE");
    assert_eq!(
        assertion_diagnostics[0].file.as_deref(),
        Some(Path::new("src/lib/math.test.ts"))
    );

    let assertion_report =
        analyze_diagnostics(&[log_diagnostic(&assertion_diagnostics[0], &assertion_log)]);
    assert_eq!(match_ids(&assertion_report), vec!["test-assertion-failure"]);
    assert_eq!(assertion_report.primary_category, ErrorCategory::Test);

    let timeout_log = read_fixture("error-logs/vitest-timeout.txt");
    let timeout_outcome = failed_outcome(VerificationCheckKind::Test, &timeout_log);
    let timeout_diagnostics = normalize_outcome(&timeout_outcome);
    assert_eq!(timeout_diagnostics.len(), 1);
    assert_eq!(code_of(&timeout_diagnostics[0]), "TEST_FAILURE");

    let timeout_report =
        analyze_diagnostics(&[log_diagnostic(&timeout_diagnostics[0], &timeout_log)]);
    assert_eq!(match_ids(&timeout_report), vec!["test-timeout"]);
    assert_eq!(timeout_report.primary_category, ErrorCategory::Test);
}

fn vitest_module_not_found_diagnosis() {
    let log = read_fixture("error-logs/vitest-module-not-found.txt");
    let outcome = failed_outcome(VerificationCheckKind::Test, &log);
    let diagnostics = normalize_outcome(&outcome);
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(code_of(&diagnostics[0]), "TEST_FAILURE");
    assert_eq!(
        diagnostics[0].file.as_deref(),
        Some(Path::new("tests/format.test.ts"))
    );

    let report = analyze_diagnostics(&[log_diagnostic(&diagnostics[0], &log)]);
    assert_eq!(match_ids(&report), vec!["test-module-not-found"]);
    assert_eq!(report.primary_category, ErrorCategory::Import);
}

fn bundler_diagnosis() {
    let log = read_fixture("error-logs/bundler-module-not-found.txt");
    let outcome = failed_outcome(VerificationCheckKind::Build, &log);
    let diagnostics = normalize_outcome(&outcome);
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].code, None);
    assert_eq!(diagnostics[0].file, None);
    assert_eq!(diagnostics[0].severity, DiagnosticSeverity::Error);

    let report = analyze_diagnostics(&diagnostics);
    assert_eq!(report.error_count, 1);
    assert_eq!(match_ids(&report), vec!["build-failed-to-resolve-import"]);
    assert_eq!(report.primary_category, ErrorCategory::Build);
}

fn rollup_resolve_failure() {
    let log = read_fixture("error-logs/rollup-resolve-failure.txt");
    let outcome = failed_outcome(VerificationCheckKind::Build, &log);
    let diagnostics = normalize_outcome(&outcome);
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].code, None);
    let raw = diagnostics[0].raw.as_deref().expect("raw build output");
    assert!(raw.contains("Could not resolve"));

    let report = analyze_diagnostics(&diagnostics);
    assert_eq!(match_ids(&report), vec!["generic-non-zero-exit"]);
    assert_eq!(report.primary_category, ErrorCategory::Unknown);
    assert!(report.has_repairable_issues);
}

fn diagnosis_dedup_ordering() {
    let log = read_fixture("error-logs/mixed-diagnostics.txt");
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
    let ts2304 = &report.matches[0];
    assert_eq!(ts2304.count, 1);
    assert_eq!(ts2304.files, vec![PathBuf::from("src/app/App.tsx")]);
}

fn multi_error_aggregation_signature() {
    let log = read_fixture("error-logs/mixed-diagnostics.txt");
    let diagnostics = normalize_outcome(&failed_outcome(VerificationCheckKind::Lint, &log));
    let forward = analyze_diagnostics(&diagnostics);
    let mut reversed_diagnostics = diagnostics;
    reversed_diagnostics.reverse();
    let reversed = analyze_diagnostics(&reversed_diagnostics);

    assert_eq!(forward, reversed);
    assert_eq!(forward.error_count, 3);
    assert_eq!(forward.warning_count, 1);
    assert_eq!(forward.primary_category, ErrorCategory::Type);
    assert_eq!(
        forward.affected_files,
        vec![
            PathBuf::from("src/app/App.tsx"),
            PathBuf::from("src/lib/format.ts"),
        ]
    );
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

fn repair_planning() {
    let log = read_fixture("error-logs/typescript-typecheck.txt");
    let report = report_for(VerificationCheckKind::Typecheck, &log);
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
}

fn repair_no_repairable_issue() {
    let report = analyze_diagnostics(&[]);
    let plan = plan_repair(
        &report,
        &[],
        99,
        &CodingPolicy {
            max_repair_rounds: 0,
            ..CodingPolicy::default()
        },
    );
    assert!(!plan.should_retry);
    assert_eq!(plan.stop_reason, Some(RepairStopReason::NoRepairableIssue));
    assert_eq!(plan.round, 100);
    assert!(plan.targeted_files.is_empty());
    assert!(plan.instructions.is_empty());
}

fn repair_repeated_history() {
    let log = read_fixture("error-logs/mixed-diagnostics.txt");
    let report = report_for(VerificationCheckKind::Lint, &log);
    let signature = report.failure_signature.clone();
    let policy = CodingPolicy {
        max_repair_rounds: 4,
        ..CodingPolicy::default()
    };

    let seen_twice = vec![
        signature.clone(),
        "other-signature".to_string(),
        signature.clone(),
    ];
    let plan = plan_repair(&report, &seen_twice, 2, &policy);
    assert_eq!(plan.stop_reason, Some(RepairStopReason::RepeatedFailure));

    let trailing_duplicate = vec![
        "other-signature".to_string(),
        "same-signature".to_string(),
        "same-signature".to_string(),
    ];
    let plan = plan_repair(&report, &trailing_duplicate, 2, &policy);
    assert_eq!(plan.stop_reason, Some(RepairStopReason::RepeatedFailure));
}

fn repair_targeted_files_priority() {
    let log = read_fixture("error-logs/repair-priority.txt");
    let report = report_for(VerificationCheckKind::Typecheck, &log);
    assert_eq!(match_ids(&report), vec!["ts-2304", "ts-2339"]);
    assert_eq!(
        report.affected_files,
        vec![PathBuf::from("src/a/app.ts"), PathBuf::from("src/z/app.ts"),]
    );

    let plan = plan_repair(
        &report,
        &[],
        0,
        &CodingPolicy {
            max_repair_rounds: 3,
            ..CodingPolicy::default()
        },
    );
    assert!(plan.should_retry);
    assert_eq!(
        plan.targeted_files,
        vec![PathBuf::from("src/z/app.ts"), PathBuf::from("src/a/app.ts"),]
    );
}

fn repair_round_progression() {
    let log = read_fixture("error-logs/typescript-typecheck.txt");
    let report = report_for(VerificationCheckKind::Typecheck, &log);
    let policy = CodingPolicy {
        max_repair_rounds: 2,
        ..CodingPolicy::default()
    };

    let first = plan_repair(&report, &[], 0, &policy);
    assert!(first.should_retry);
    assert_eq!(first.round, 1);
    let second = plan_repair(&report, &[], 1, &policy);
    assert!(second.should_retry);
    assert_eq!(second.round, 2);
    let third = plan_repair(&report, &[], 2, &policy);
    assert!(!third.should_retry);
    assert_eq!(third.round, 3);
    assert_eq!(third.stop_reason, Some(RepairStopReason::MaxRepairRounds));
    assert_eq!(first.signature, second.signature);
}

fn formatting_preservation() {
    let source = "export function outer() {\r\n\tconst value = 1;\r\n\r\n\tfunction inner() {\r\n\t\treturn value;\r\n\t}\r\n\r\n\treturn inner();\r\n}\r\n";
    let parsed = parse_file(Path::new("src/formatting.ts"), source)
        .unwrap_or_else(|error| panic!("parse formatting fixture: {error}"));
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
}

fn formatting_indentation_spaces() {
    let store = parse_fixture("frontend-app-large/src/features/session/sessionStore.ts");
    let replacement = "save(session: Session): void {\n  if (!session.id) {\n    throw new Error(\"missing id\");\n  }\n  this.sessions.set(session.id, session);\n}";
    let edit = store
        .replace_symbol(
            &SymbolQuery::new("save")
                .with_kind(SymbolKind::Method)
                .with_parent("MemorySessionStore"),
            replacement,
        )
        .unwrap_or_else(|error| panic!("replace save method: {error}"));

    assert!(edit.edited_source.contains(
        "  save(session: Session): void {\n    if (!session.id) {\n      throw new Error(\"missing id\");\n    }\n    this.sessions.set(session.id, session);\n  }"
    ));
    let edited = parse_file(
        Path::new("src/features/session/sessionStore.ts"),
        &edit.edited_source,
    )
    .unwrap_or_else(|error| panic!("re-parse indented store: {error}"));
    assert!(!edited.has_syntax_errors());
    assert!(!edited.source.contains("\r\n"));
}

fn formatting_crlf_tabs_insert() {
    let source = "export function first() {\r\n\treturn 1;\r\n}\r\n\r\nexport function last() {\r\n\treturn 2;\r\n}\r\n";
    let parsed = parse_file(Path::new("src/crlf-insert.ts"), source)
        .unwrap_or_else(|error| panic!("parse CRLF insert fixture: {error}"));
    assert!(!parsed.has_syntax_errors());

    let edit = parsed
        .insert_after(
            &SymbolQuery::new("first").with_kind(SymbolKind::Function),
            "function middle() {\n\treturn 1.5;\n}",
        )
        .unwrap_or_else(|error| panic!("insert CRLF middle: {error}"));

    assert!(edit.edited_source.contains(
        "}\r\nfunction middle() {\r\n\treturn 1.5;\r\n}\r\n\r\nexport function last() {"
    ));
    let without_crlf = edit.edited_source.replace("\r\n", "");
    assert!(!without_crlf.contains('\n'));
    assert!(!without_crlf.contains('\r'));
}
