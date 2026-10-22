use std::path::PathBuf;
use worldbase_coding::{
    error_analyzer::normalize_outcome, CommandOutcome, DiagnosticSeverity, VerificationCheckKind,
    VerificationCommand,
};

fn outcome(stdout: &str, exit_code: i32) -> CommandOutcome {
    CommandOutcome {
        command: VerificationCommand {
            kind: VerificationCheckKind::Test,
            program: "mvn".into(),
            args: vec!["-q".into(), "test".into()],
            required: true,
            description: "fixture".into(),
        },
        exit_code: Some(exit_code),
        stdout: stdout.into(),
        stderr: String::new(),
        timed_out: false,
        cancelled: false,
        duration_ms: 10,
    }
}

#[test]
fn parses_javac_and_maven_coordinate_diagnostics() {
    let stdout = "\
src/main/java/App.java:10: error: cannot find symbol
[ERROR] /project/src/App.java:[12,5] cannot find symbol
";
    let diagnostics = normalize_outcome(&outcome(stdout, 1));
    assert_eq!(diagnostics.len(), 2);

    let javac = &diagnostics[0];
    assert_eq!(javac.severity, DiagnosticSeverity::Error);
    assert_eq!(javac.code.as_deref(), Some("JAVAC"));
    assert_eq!(javac.file, Some(PathBuf::from("src/main/java/App.java")));
    assert_eq!(javac.line, Some(10));
    assert_eq!(javac.column, None);
    assert_eq!(javac.message, "cannot find symbol");
    assert_eq!(javac.confidence, 0.9);
    assert_eq!(
        javac.raw.as_deref(),
        Some("src/main/java/App.java:10: error: cannot find symbol")
    );

    let maven = &diagnostics[1];
    assert_eq!(maven.severity, DiagnosticSeverity::Error);
    assert_eq!(maven.code.as_deref(), Some("MAVEN"));
    assert_eq!(maven.file, Some(PathBuf::from("/project/src/App.java")));
    assert_eq!(maven.line, Some(12));
    assert_eq!(maven.column, Some(5));
    assert_eq!(maven.message, "cannot find symbol");
    assert_eq!(maven.confidence, 0.9);
}

#[test]
fn parses_maven_build_failure_and_goal_headers() {
    let stdout = "\
[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.13.0:compile (default-compile) on project demo: Compilation failure
BUILD FAILURE
";
    let diagnostics = normalize_outcome(&outcome(stdout, 1));
    assert_eq!(diagnostics.len(), 2);

    let goal = &diagnostics[0];
    assert_eq!(goal.severity, DiagnosticSeverity::Error);
    assert_eq!(goal.code.as_deref(), Some("MAVEN"));
    assert_eq!(goal.file, None);
    assert_eq!(goal.line, None);
    assert_eq!(goal.column, None);
    assert!(goal.message.starts_with("Failed to execute goal"));
    assert_eq!(goal.confidence, 0.6);
    assert_eq!(goal.raw.as_deref(), stdout.lines().next());

    let failure = &diagnostics[1];
    assert_eq!(failure.code.as_deref(), Some("MAVEN"));
    assert_eq!(failure.message, "BUILD FAILURE");
    assert_eq!(failure.confidence, 0.6);
    assert_eq!(failure.raw.as_deref(), Some("BUILD FAILURE"));
}

#[test]
fn parses_gradle_task_kotlin_and_build_failures() {
    let stdout = "\
> Task :compileJava FAILED
BUILD FAILED
e: file:///project/src/main/kotlin/Main.kt:7:3 Unresolved reference: missing
";
    let diagnostics = normalize_outcome(&outcome(stdout, 1));
    assert_eq!(diagnostics.len(), 3);

    let task = &diagnostics[0];
    assert_eq!(task.code.as_deref(), Some("GRADLE"));
    assert_eq!(task.message, "Gradle task :compileJava failed");
    assert_eq!(task.confidence, 0.6);

    let build = &diagnostics[1];
    assert_eq!(build.code.as_deref(), Some("GRADLE"));
    assert_eq!(build.message, "BUILD FAILED");
    assert_eq!(build.confidence, 0.6);

    let kotlin = &diagnostics[2];
    assert_eq!(kotlin.severity, DiagnosticSeverity::Error);
    assert_eq!(kotlin.code.as_deref(), Some("GRADLE"));
    assert_eq!(
        kotlin.file,
        Some(PathBuf::from("/project/src/main/kotlin/Main.kt"))
    );
    assert_eq!(kotlin.line, Some(7));
    assert_eq!(kotlin.column, Some(3));
    assert_eq!(kotlin.message, "Unresolved reference: missing");
    assert_eq!(kotlin.confidence, 0.9);
}

#[test]
fn parses_junit_test_failures_and_ignores_successful_summaries() {
    let stdout = "\
Tests run: 5, Failures: 1, Errors: 0
Tests run: 8, Failures: 0, Errors: 0
[ERROR] Tests run: 2, Failures: 0, Errors: 1, Skipped: 0
";
    let diagnostics = normalize_outcome(&outcome(stdout, 1));
    assert_eq!(diagnostics.len(), 2);

    let failure = &diagnostics[0];
    assert_eq!(failure.severity, DiagnosticSeverity::Error);
    assert_eq!(failure.code.as_deref(), Some("JUNIT"));
    assert_eq!(failure.file, None);
    assert!(failure
        .message
        .starts_with("Tests run: 5, Failures: 1, Errors: 0"));
    assert_eq!(failure.confidence, 0.6);
    assert_eq!(
        failure.raw.as_deref(),
        Some("Tests run: 5, Failures: 1, Errors: 0")
    );

    let errors = &diagnostics[1];
    assert_eq!(errors.code.as_deref(), Some("JUNIT"));
    assert!(errors
        .message
        .starts_with("Tests run: 2, Failures: 0, Errors: 1"));
    assert_eq!(errors.confidence, 0.6);
}

#[test]
fn parses_java_exception_headers_and_stack_frames() {
    let stdout = "\
java.lang.NullPointerException: Cannot invoke \"String.length()\" because \"value\" is null
\tat com.example.App.main(App.java:8)
\tat java.base/java.lang.Thread.run(Thread.java:833)
";
    let diagnostics = normalize_outcome(&outcome(stdout, 1));
    assert_eq!(diagnostics.len(), 3);

    let exception = &diagnostics[0];
    assert_eq!(exception.severity, DiagnosticSeverity::Error);
    assert_eq!(exception.code.as_deref(), Some("JAVA"));
    assert_eq!(exception.file, None);
    assert_eq!(exception.line, None);
    assert_eq!(
        exception.message,
        "java.lang.NullPointerException: Cannot invoke \"String.length()\" because \"value\" is null"
    );
    assert_eq!(exception.confidence, 0.9);

    let app_frame = &diagnostics[1];
    assert_eq!(app_frame.code.as_deref(), Some("JAVA"));
    assert_eq!(app_frame.file, Some(PathBuf::from("App.java")));
    assert_eq!(app_frame.line, Some(8));
    assert_eq!(app_frame.column, None);
    assert_eq!(app_frame.confidence, 0.9);
    assert!(app_frame.message.starts_with("at com.example.App.main"));

    let thread_frame = &diagnostics[2];
    assert_eq!(thread_frame.code.as_deref(), Some("JAVA"));
    assert_eq!(thread_frame.file, Some(PathBuf::from("Thread.java")));
    assert_eq!(thread_frame.line, Some(833));
    assert_eq!(thread_frame.confidence, 0.9);
}

#[test]
fn preserves_order_across_java_diagnostic_formats() {
    let stdout = "\
src/App.java:3: error: ';' expected
Tests run: 2, Failures: 1, Errors: 0
BUILD FAILURE
";
    let diagnostics = normalize_outcome(&outcome(stdout, 1));
    assert_eq!(
        diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code.as_deref())
            .collect::<Vec<_>>(),
        [Some("JAVAC"), Some("JUNIT"), Some("MAVEN")]
    );
    assert_eq!(
        diagnostics
            .iter()
            .map(|diagnostic| diagnostic.raw.as_deref())
            .collect::<Vec<_>>(),
        [
            Some("src/App.java:3: error: ';' expected"),
            Some("Tests run: 2, Failures: 1, Errors: 0"),
            Some("BUILD FAILURE"),
        ]
    );
}

#[test]
fn malformed_input_does_not_create_a_structured_diagnostic() {
    let stdout = "\
File.java: not-a-line error:
[ERROR] something unrelated
this is just build chatter
";
    let diagnostics = normalize_outcome(&outcome(stdout, 0));
    assert!(diagnostics.is_empty());
}
