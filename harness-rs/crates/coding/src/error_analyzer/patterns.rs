//! Static library of frontend, test, and build error patterns.
//!
//! Patterns are compiled exactly once and evaluated in ascending `priority`
//! order. The first matching pattern wins, so specific compiler rules precede
//! broader bundler and generic command failures.

use crate::model::{Diagnostic, DiagnosticSeverity};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{fmt, sync::OnceLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCategory {
    Syntax,
    Type,
    Import,
    Lint,
    Test,
    Build,
    Runtime,
    Dependency,
    Unknown,
}

impl ErrorCategory {
    pub fn label(self) -> &'static str {
        match self {
            Self::Syntax => "syntax",
            Self::Type => "type",
            Self::Import => "import",
            Self::Lint => "lint",
            Self::Test => "test",
            Self::Build => "build",
            Self::Runtime => "runtime",
            Self::Dependency => "dependency",
            Self::Unknown => "unknown",
        }
    }
}

impl fmt::Display for ErrorCategory {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.label())
    }
}

#[derive(Debug, Clone)]
pub struct ErrorPattern {
    pub id: &'static str,
    pub category: ErrorCategory,
    /// When present, the diagnostic code must match this value. If the
    /// diagnostic has no structured code, the raw/message text is searched.
    pub code: Option<&'static str>,
    pub regex: Regex,
    /// Overrides the diagnostic severity when the pattern is applied.
    pub severity: Option<DiagnosticSeverity>,
    pub confidence: f32,
    pub fix_hint: &'static str,
    /// Lower values are evaluated first and sort ahead of later patterns.
    pub priority: u16,
}

struct PatternSpec {
    id: &'static str,
    category: ErrorCategory,
    code: Option<&'static str>,
    regex: &'static str,
    severity: Option<DiagnosticSeverity>,
    confidence: f32,
    fix_hint: &'static str,
    priority: u16,
}

const PATTERN_SPECS: &[PatternSpec] = &[
    PatternSpec {
        id: "ts-2304",
        category: ErrorCategory::Type,
        code: Some("TS2304"),
        regex: r"(?i)cannot find name",
        severity: None,
        confidence: 0.95,
        fix_hint: "Verify the identifier exists, is spelled correctly, and is imported or declared in scope.",
        priority: 100,
    },
    PatternSpec {
        id: "ts-2339",
        category: ErrorCategory::Type,
        code: Some("TS2339"),
        regex: r"(?i)property '.+' does not exist on type|does not exist on type",
        severity: None,
        confidence: 0.95,
        fix_hint: "Check the property name and receiver type; add the member to the interface or narrow the value.",
        priority: 101,
    },
    PatternSpec {
        id: "ts-2345",
        category: ErrorCategory::Type,
        code: Some("TS2345"),
        regex: r"(?i)argument of type .+ is not assignable to parameter",
        severity: None,
        confidence: 0.95,
        fix_hint: "Pass a value matching the parameter type or update the function signature.",
        priority: 102,
    },
    PatternSpec {
        id: "ts-2322",
        category: ErrorCategory::Type,
        code: Some("TS2322"),
        regex: r"(?i)type .+ is not assignable to type",
        severity: None,
        confidence: 0.95,
        fix_hint: "Make the assigned value match the declared type, or widen/update the target type.",
        priority: 103,
    },
    PatternSpec {
        id: "ts-2307",
        category: ErrorCategory::Import,
        code: Some("TS2307"),
        regex: r"(?i)cannot find module",
        severity: None,
        confidence: 0.95,
        fix_hint: "Fix the import path or install the missing package and its type declarations.",
        priority: 104,
    },
    PatternSpec {
        id: "ts-7006",
        category: ErrorCategory::Type,
        code: Some("TS7006"),
        regex: r"(?i)parameter '.+' implicitly has an 'any' type",
        severity: None,
        confidence: 0.95,
        fix_hint: "Add an explicit parameter type or update the TypeScript strictness configuration.",
        priority: 105,
    },
    PatternSpec {
        id: "ts-2554",
        category: ErrorCategory::Type,
        code: Some("TS2554"),
        regex: r"(?i)expected \d+ arguments?, but got \d+",
        severity: None,
        confidence: 0.95,
        fix_hint: "Pass the required number of arguments or update the function signature.",
        priority: 106,
    },
    PatternSpec {
        id: "ts-2741",
        category: ErrorCategory::Type,
        code: Some("TS2741"),
        regex: r"(?i)property '.+' is missing in type .+ but required",
        severity: None,
        confidence: 0.95,
        fix_hint: "Add the missing required property to the object literal or make it optional.",
        priority: 107,
    },
    PatternSpec {
        id: "ts-1005",
        category: ErrorCategory::Syntax,
        code: Some("TS1005"),
        regex: r"(?i)\bexpected\b",
        severity: None,
        confidence: 0.95,
        fix_hint: "Fix the surrounding syntax; the parser expected a token near the reported location.",
        priority: 108,
    },
    PatternSpec {
        id: "ts-1109",
        category: ErrorCategory::Syntax,
        code: Some("TS1109"),
        regex: r"(?i)expression expected",
        severity: None,
        confidence: 0.95,
        fix_hint: "Fix the malformed expression or missing operand near the reported location.",
        priority: 109,
    },
    PatternSpec {
        id: "eslint-no-unused-vars",
        category: ErrorCategory::Lint,
        code: None,
        regex: r"(?i)no-unused-vars|is defined but never used|is assigned a value but never used|unused variable",
        severity: None,
        confidence: 0.9,
        fix_hint: "Remove the unused binding or use it; prefix intentionally ignored names with an underscore if configured.",
        priority: 200,
    },
    PatternSpec {
        id: "eslint-no-undef",
        category: ErrorCategory::Lint,
        code: None,
        regex: r"(?i)no-undef|is not defined\b",
        severity: None,
        confidence: 0.9,
        fix_hint: "Import or declare the identifier before use.",
        priority: 201,
    },
    PatternSpec {
        id: "eslint-react-hooks-exhaustive-deps",
        category: ErrorCategory::Lint,
        code: None,
        regex: r"(?i)exhaustive-deps|missing dependenc|has a missing dependency",
        severity: Some(DiagnosticSeverity::Warning),
        confidence: 0.9,
        fix_hint: "Add the missing dependency or restructure the effect so it does not capture stale values.",
        priority: 202,
    },
    PatternSpec {
        id: "eslint-import-no-unresolved",
        category: ErrorCategory::Import,
        code: None,
        regex: r"(?i)import/no-unresolved|unable to resolve path to module|unresolved import",
        severity: None,
        confidence: 0.9,
        fix_hint: "Correct the import path or install the referenced package.",
        priority: 203,
    },
    PatternSpec {
        id: "eslint-typescript-no-explicit-any",
        category: ErrorCategory::Lint,
        code: Some("@typescript-eslint/no-explicit-any"),
        regex: r"(?i)no-explicit-any|unexpected any",
        severity: Some(DiagnosticSeverity::Warning),
        confidence: 0.9,
        fix_hint: "Replace `any` with a concrete type, `unknown`, or a validated generic.",
        priority: 204,
    },
    PatternSpec {
        id: "eslint-no-empty",
        category: ErrorCategory::Lint,
        code: Some("no-empty"),
        regex: r"(?i)no-empty|empty block statement|empty statement",
        severity: None,
        confidence: 0.9,
        fix_hint: "Remove the empty block or add a comment/statement explaining the intentional no-op.",
        priority: 205,
    },
    PatternSpec {
        id: "eslint-no-console",
        category: ErrorCategory::Lint,
        code: Some("no-console"),
        regex: r"(?i)no-console|unexpected console",
        severity: Some(DiagnosticSeverity::Warning),
        confidence: 0.9,
        fix_hint: "Remove the console call or route logging through the project logger.",
        priority: 206,
    },
    PatternSpec {
        id: "test-assertion-failure",
        category: ErrorCategory::Test,
        code: None,
        regex: r"(?i)assertionerror|expected .+ to (?:be|equal|match|contain|have|throw|reject)|tohavebeencalled|toequal\b",
        severity: None,
        confidence: 0.85,
        fix_hint: "Inspect the expected and received values and fix the implementation or the assertion.",
        priority: 300,
    },
    PatternSpec {
        id: "test-timeout",
        category: ErrorCategory::Test,
        code: None,
        regex: r"(?i)exceeded timeout|test timed out|timed out after|timeout of \d+ ?ms exceeded",
        severity: None,
        confidence: 0.85,
        fix_hint: "Check for unresolved promises or timers and increase the timeout only if the work is legitimately slow.",
        priority: 301,
    },
    PatternSpec {
        id: "test-module-not-found",
        category: ErrorCategory::Import,
        code: None,
        regex: r"(?i)cannot find module .+ from .*(?:test|spec)|(?:jest|vitest).*module not found",
        severity: None,
        confidence: 0.8,
        fix_hint: "Fix the test import path or install the missing package used by the test.",
        priority: 302,
    },
    PatternSpec {
        id: "test-suite-failed",
        category: ErrorCategory::Test,
        code: Some("TEST_FAILURE"),
        regex: r"(?i)test (?:suite )?failed|suite failed to run",
        severity: None,
        confidence: 0.8,
        fix_hint: "Open the failing test file first; fix import or setup errors before rerunning the suite.",
        priority: 303,
    },
    PatternSpec {
        id: "dependency-err-module-not-found",
        category: ErrorCategory::Dependency,
        code: None,
        regex: r"(?i)err_module_not_found",
        severity: None,
        confidence: 0.9,
        fix_hint: "Install the missing package or correct the package specifier, then rerun verification.",
        priority: 400,
    },
    PatternSpec {
        id: "build-failed-to-resolve-import",
        category: ErrorCategory::Build,
        code: None,
        regex: r"(?i)failed to resolve import|failed to resolve entry",
        severity: None,
        confidence: 0.85,
        fix_hint: "Fix the import specifier or add the missing file to the project.",
        priority: 401,
    },
    PatternSpec {
        id: "build-cannot-find-module",
        category: ErrorCategory::Build,
        code: None,
        regex: r"(?i)cannot find module|module not found",
        severity: None,
        confidence: 0.85,
        fix_hint: "Fix the module path or install the dependency that provides it.",
        priority: 402,
    },
    PatternSpec {
        id: "build-out-of-memory",
        category: ErrorCategory::Build,
        code: None,
        regex: r"(?i)javascript heap out of memory|out of memory|enomem|allocation failed",
        severity: None,
        confidence: 0.9,
        fix_hint: "Reduce the build scope or raise the Node heap limit, then rerun the build.",
        priority: 403,
    },
    PatternSpec {
        id: "runtime-command-timed-out",
        category: ErrorCategory::Runtime,
        code: None,
        regex: r"(?i)command timed out|verification command timed out|etimedout",
        severity: None,
        confidence: 0.9,
        fix_hint: "Inspect the command for hangs, then rerun with a longer timeout only if the work is legitimately slow.",
        priority: 500,
    },
    PatternSpec {
        id: "runtime-command-cancelled",
        category: ErrorCategory::Runtime,
        code: None,
        regex: r"(?i)command was cancelled|command cancelled|command canceled|cancelled without a recognized diagnostic",
        severity: None,
        confidence: 0.9,
        fix_hint: "Rerun the verification command after the cancellation cause is resolved.",
        priority: 501,
    },
    PatternSpec {
        id: "generic-non-zero-exit",
        category: ErrorCategory::Unknown,
        code: None,
        regex: r"(?i)failed without a recognized diagnostic|non-zero exit|exited with (?:code|status) [1-9]|command failed",
        severity: None,
        confidence: 0.5,
        fix_hint: "Inspect the raw command output, fix the reported failure, and rerun verification.",
        priority: 502,
    },
];

static PATTERNS: OnceLock<Vec<ErrorPattern>> = OnceLock::new();

/// All patterns in evaluation order (ascending priority).
pub fn patterns() -> &'static [ErrorPattern] {
    PATTERNS.get_or_init(|| {
        let mut patterns = PATTERN_SPECS
            .iter()
            .map(|spec| ErrorPattern {
                id: spec.id,
                category: spec.category,
                code: spec.code,
                regex: Regex::new(spec.regex).unwrap_or_else(|error| {
                    panic!("invalid regex for pattern {}: {error}", spec.id)
                }),
                severity: spec.severity,
                confidence: spec.confidence,
                fix_hint: spec.fix_hint,
                priority: spec.priority,
            })
            .collect::<Vec<_>>();
        patterns.sort_by_key(|pattern| pattern.priority);
        patterns
    })
}

/// Return the highest-priority pattern matching this diagnostic.
pub fn matching_pattern(diagnostic: &Diagnostic) -> Option<&'static ErrorPattern> {
    let haystack = match diagnostic.raw.as_deref() {
        Some(raw) if !raw.is_empty() => format!("{}\n{raw}", diagnostic.message),
        _ => diagnostic.message.clone(),
    };
    patterns()
        .iter()
        .find(|pattern| pattern.matches(diagnostic, &haystack))
}

impl ErrorPattern {
    fn matches(&self, diagnostic: &Diagnostic, haystack: &str) -> bool {
        let code_matches = match self.code {
            None => true,
            Some(expected) => match diagnostic.code.as_deref() {
                Some(actual) => actual.eq_ignore_ascii_case(expected),
                None => haystack.contains(expected),
            },
        };
        code_matches && self.regex.is_match(haystack)
    }
}
