use std::path::Path;
use worldbase_coding::{
    error_analyzer::normalize_outcome, CommandOutcome, Diagnostic, DiagnosticSeverity,
    VerificationCheckKind, VerificationCommand,
};

fn outcome(stdout: &str, stderr: &str, exit_code: i32) -> CommandOutcome {
    CommandOutcome {
        command: VerificationCommand {
            kind: VerificationCheckKind::Test,
            program: "fixture".into(),
            args: Vec::new(),
            required: true,
            description: "semantic depth fixture".into(),
        },
        exit_code: Some(exit_code),
        stdout: stdout.into(),
        stderr: stderr.into(),
        timed_out: false,
        cancelled: false,
        duration_ms: 10,
    }
}

fn diagnostics(stdout: &str, stderr: &str) -> Vec<Diagnostic> {
    normalize_outcome(&outcome(stdout, stderr, 1))
}

fn codes(diagnostics: &[Diagnostic]) -> Vec<&str> {
    diagnostics
        .iter()
        .map(|diagnostic| diagnostic.code.as_deref().unwrap_or(""))
        .collect()
}

#[test]
fn rust_headers_wait_through_context_and_flush_when_unpaired() {
    let stderr = "\
error[E0308]: mismatched types
note: expected `u32`, found `&str`

  --> src/main.rs:10:5
   |
10 |     let value: u32 = \"text\";
   |                      ^^^^^^";
    let parsed = diagnostics("", stderr);
    assert_eq!(parsed.len(), 1, "{parsed:#?}");
    assert_eq!(parsed[0].code.as_deref(), Some("E0308"));
    assert_eq!(parsed[0].message, "mismatched types");
    assert_eq!(parsed[0].file.as_deref(), Some(Path::new("src/main.rs")));
    assert_eq!(parsed[0].line, Some(10));
    assert_eq!(parsed[0].column, Some(5));

    let unpaired = diagnostics("", "error[E0425]: cannot find value `missing`\n");
    assert_eq!(unpaired.len(), 1, "{unpaired:#?}");
    assert_eq!(unpaired[0].code.as_deref(), Some("E0425"));
    assert_eq!(unpaired[0].message, "cannot find value `missing`");
    assert_eq!(unpaired[0].file, None);
    assert_eq!(unpaired[0].line, None);
}

#[test]
fn mypy_and_javac_with_columns_are_not_misclassified_as_rust_short_form() {
    let python = diagnostics(
        "src/app.py:12:5: error: Incompatible types in assignment  [assignment]\n",
        "",
    );
    assert_eq!(python.len(), 1, "{python:#?}");
    assert_eq!(python[0].code.as_deref(), Some("assignment"));
    assert_eq!(python[0].message, "Incompatible types in assignment");
    assert_eq!(python[0].file.as_deref(), Some(Path::new("src/app.py")));

    let java = diagnostics("src/App.java:10:5: error: cannot find symbol\n", "");
    assert_eq!(java.len(), 1, "{java:#?}");
    assert_eq!(java[0].code.as_deref(), Some("JAVAC"));
    assert_eq!(java[0].message, "cannot find symbol");
    assert_eq!(java[0].line, Some(10));
    assert_eq!(java[0].column, Some(5));
}

#[test]
fn python_traceback_uses_the_last_frame_and_following_exception() {
    let traceback = "\
Traceback (most recent call last):
  File \"src/app.py\", line 10, in run
    run()
During handling of the above exception, another exception occurred:
Traceback (most recent call last):
  File \"src/app.py\", line 12, in run
    raise ValueError(\"bad\")
ValueError: bad
";
    let parsed = diagnostics(traceback, "");
    assert_eq!(parsed.len(), 1, "{parsed:#?}");
    assert_eq!(parsed[0].severity, DiagnosticSeverity::Error);
    assert_eq!(parsed[0].code.as_deref(), Some("PYTHON"));
    assert_eq!(parsed[0].message, "ValueError: bad");
    assert_eq!(parsed[0].file.as_deref(), Some(Path::new("src/app.py")));
    assert_eq!(parsed[0].line, Some(12));
    assert_eq!(parsed[0].confidence, 0.6);

    let frame_only = diagnostics("  File \"src/app.py\", line 42, in run\n", "");
    assert_eq!(frame_only.len(), 1, "{frame_only:#?}");
    assert_eq!(frame_only[0].file.as_deref(), Some(Path::new("src/app.py")));
    assert_eq!(frame_only[0].line, Some(42));
    assert!(frame_only[0].message.contains("run"));
}

#[test]
fn go_test_details_replace_the_header_and_package_summary_stays_separate() {
    let stdout = "\
--- FAIL: TestAdd (0.00s)
    add_test.go:12: expected 3, got 4
    add_test.go:13: second detail
FAIL\texample.com/pkg\t0.01s
";
    let parsed = diagnostics(stdout, "");
    assert_eq!(parsed.len(), 3, "{parsed:#?}");
    assert_eq!(codes(&parsed), ["GOTEST", "GOTEST", "GOTEST"]);
    assert_eq!(parsed[0].message, "Test failed: TestAdd: expected 3, got 4");
    assert_eq!(parsed[0].file.as_deref(), Some(Path::new("add_test.go")));
    assert_eq!(parsed[0].line, Some(12));
    assert_eq!(parsed[1].message, "Test failed: TestAdd: second detail");
    assert_eq!(parsed[1].line, Some(13));
    assert_eq!(parsed[2].message, "Test failed: example.com/pkg");
    assert_eq!(parsed[2].file, None);
    assert!(!parsed
        .iter()
        .any(|diagnostic| diagnostic.message == "Test failed: TestAdd"));

    let header_only = diagnostics("--- FAIL: TestSolo (0.00s)\n", "");
    assert_eq!(header_only.len(), 1);
    assert_eq!(header_only[0].message, "Test failed: TestSolo");
    assert_eq!(
        header_only[0].raw.as_deref(),
        Some("--- FAIL: TestSolo (0.00s)")
    );
}

#[test]
fn go_vet_multiline_entries_are_distinct_and_not_duplicated() {
    let stdout = "\
vet: ./main.go:10:2: unreachable code
vet: ./main.go:11:2: printf: non-constant format string
";
    let parsed = diagnostics(stdout, "");
    assert_eq!(parsed.len(), 2, "{parsed:#?}");
    assert_eq!(codes(&parsed), ["GOVET", "GOVET"]);
    assert_eq!(parsed[0].file.as_deref(), Some(Path::new("./main.go")));
    assert_eq!(parsed[0].message, "unreachable code");
    assert_eq!(parsed[1].line, Some(11));
    assert_eq!(parsed[1].message, "printf: non-constant format string");
}

#[test]
fn maven_coordinates_absorb_symbol_and_location_continuations() {
    let stdout = "\
[ERROR] /project/src/App.java:[12,5] cannot find symbol
[ERROR]   symbol:   variable foo
[ERROR]   location: class App
> Task :compileJava FAILED
";
    let parsed = diagnostics(stdout, "");
    assert_eq!(parsed.len(), 2, "{parsed:#?}");
    assert_eq!(codes(&parsed), ["MAVEN", "GRADLE"]);
    assert_eq!(
        parsed[0].file.as_deref(),
        Some(Path::new("/project/src/App.java"))
    );
    assert_eq!(parsed[0].line, Some(12));
    assert_eq!(parsed[0].column, Some(5));
    assert!(parsed[0].message.contains("cannot find symbol"));
    assert!(parsed[0].message.contains("symbol:   variable foo"));
    assert!(parsed[0].message.contains("location: class App"));
    assert_eq!(parsed[1].message, "Gradle task :compileJava failed");
}

#[test]
fn javac_continuations_are_merged_and_build_headers_stay_distinct() {
    let stdout = "\
src/App.java:10: error: cannot find symbol
  symbol: variable bar
  location: class App
BUILD FAILURE
";
    let parsed = diagnostics(stdout, "");
    assert_eq!(parsed.len(), 2, "{parsed:#?}");
    assert_eq!(codes(&parsed), ["JAVAC", "MAVEN"]);
    assert_eq!(parsed[0].file.as_deref(), Some(Path::new("src/App.java")));
    assert_eq!(parsed[0].line, Some(10));
    assert!(parsed[0].message.contains("cannot find symbol"));
    assert!(parsed[0].message.contains("symbol: variable bar"));
    assert!(parsed[0].message.contains("location: class App"));
    assert_eq!(parsed[1].message, "BUILD FAILURE");
}

#[test]
fn kotlin_gradle_errors_coexist_with_maven_headers_in_order() {
    let stdout = "\
e: file:///project/src/Main.kt:7:3 Unresolved reference: missing
[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.13.0:compile on project demo: Compilation failure
BUILD FAILURE
";
    let parsed = diagnostics(stdout, "");
    assert_eq!(parsed.len(), 3, "{parsed:#?}");
    assert_eq!(codes(&parsed), ["GRADLE", "MAVEN", "MAVEN"]);
    assert_eq!(
        parsed[0].file.as_deref(),
        Some(Path::new("/project/src/Main.kt"))
    );
    assert_eq!(parsed[0].line, Some(7));
    assert_eq!(parsed[0].column, Some(3));
    assert_eq!(parsed[0].message, "Unresolved reference: missing");
    assert!(parsed[1].message.starts_with("Failed to execute goal"));
    assert_eq!(parsed[2].message, "BUILD FAILURE");
}
