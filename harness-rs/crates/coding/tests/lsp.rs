use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use worldbase_coding::lsp::{
    analyze_lsp_diagnostics, diagnostic_from_lsp, file_uri_to_path, lsp_severity_to_diagnostic,
    merge_lsp_diagnostics, parse_definition_response, parse_document_symbols, parse_hover,
    parse_publish_diagnostics, parse_symbol_information, path_to_file_uri, LspDiagnostic, LspHover,
    LspPosition, LspRange, LspSymbolKind,
};
use worldbase_coding::{DiagnosticSeverity, ErrorCategory};

fn range(start_line: u32, start_character: u32, end_line: u32, end_character: u32) -> Value {
    json!({
        "start": { "line": start_line, "character": start_character },
        "end": { "line": end_line, "character": end_character }
    })
}

fn diagnostic(
    severity: Option<u8>,
    code: Option<Value>,
    message: &str,
    line: u32,
    character: u32,
) -> Value {
    let mut value = json!({
        "range": range(line, character, line, character + 1),
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

fn publish(uri: &str, diagnostics: Vec<Value>) -> Value {
    json!({ "uri": uri, "diagnostics": diagnostics })
}

#[test]
fn normalizes_typescript_publish_diagnostics_to_one_based_positions() {
    let payload = publish(
        "file:///workspace/src/App.ts",
        vec![diagnostic(
            Some(1),
            Some(json!("TS2304")),
            "Cannot find name 'missingValue'.",
            11,
            6,
        )],
    );

    let diagnostics = parse_publish_diagnostics(&payload).unwrap();
    assert_eq!(diagnostics.len(), 1);
    let diagnostic = &diagnostics[0];
    assert_eq!(diagnostic.severity, DiagnosticSeverity::Error);
    assert_eq!(diagnostic.code.as_deref(), Some("TS2304"));
    assert_eq!(
        diagnostic.file.as_deref(),
        Some(Path::new("/workspace/src/App.ts"))
    );
    assert_eq!(diagnostic.line, Some(12));
    assert_eq!(diagnostic.column, Some(7));
    assert_eq!(diagnostic.confidence, 1.0);
    assert_eq!(diagnostic.message, "Cannot find name 'missingValue'.");
    let raw = diagnostic.raw.as_deref().unwrap();
    assert!(raw.contains("TS2304"));
    assert!(raw.contains("missingValue"));
}

#[test]
fn maps_all_four_lsp_severities_and_defaults_missing_to_warning() {
    let payload = publish(
        "file:///workspace/src/severity.ts",
        vec![
            diagnostic(Some(1), Some(json!("E")), "error", 0, 0),
            diagnostic(Some(2), Some(json!("W")), "warning", 0, 1),
            diagnostic(Some(3), Some(json!("I")), "information", 0, 2),
            diagnostic(Some(4), Some(json!("H")), "hint", 0, 3),
            diagnostic(None, Some(json!("N")), "missing", 0, 4),
        ],
    );

    let diagnostics = parse_publish_diagnostics(&payload).unwrap();
    assert_eq!(
        diagnostics
            .iter()
            .map(|diagnostic| diagnostic.severity)
            .collect::<Vec<_>>(),
        vec![
            DiagnosticSeverity::Error,
            DiagnosticSeverity::Warning,
            DiagnosticSeverity::Info,
            DiagnosticSeverity::Info,
            DiagnosticSeverity::Warning,
        ]
    );
    assert_eq!(
        lsp_severity_to_diagnostic(None),
        DiagnosticSeverity::Warning
    );
    assert_eq!(
        lsp_severity_to_diagnostic(Some(99)),
        DiagnosticSeverity::Warning
    );
}

#[test]
fn supports_string_and_numeric_diagnostic_codes() {
    let payload = publish(
        "file:///workspace/src/codes.ts",
        vec![
            diagnostic(Some(1), Some(json!("TS2322")), "string code", 0, 0),
            diagnostic(Some(1), Some(json!(2304)), "numeric code", 1, 0),
            diagnostic(Some(1), None, "no code", 2, 0),
        ],
    );

    let diagnostics = parse_publish_diagnostics(&payload).unwrap();
    assert_eq!(diagnostics[0].code.as_deref(), Some("TS2322"));
    assert_eq!(diagnostics[1].code.as_deref(), Some("2304"));
    assert_eq!(diagnostics[2].code, None);
}

#[test]
fn ignores_unknown_fields_in_diagnostic_payloads() {
    let payload = json!({
        "uri": "file:///workspace/src/unknown.ts",
        "version": 7,
        "unknownTopLevel": { "future": true },
        "diagnostics": [{
            "range": {
                "start": { "line": 3, "character": 2, "future": 1 },
                "end": { "line": 3, "character": 8 }
            },
            "severity": 1,
            "code": "TS1000",
            "source": "typescript",
            "message": "future field diagnostic",
            "relatedInformation": [{ "message": "related" }],
            "tags": [1],
            "data": { "future": true },
            "unknownDiagnosticField": "ignored"
        }]
    });

    let diagnostics = parse_publish_diagnostics(&payload).unwrap();
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].line, Some(4));
    assert_eq!(diagnostics[0].column, Some(3));
}

#[test]
fn rejects_invalid_and_non_file_uris() {
    let non_file = publish(
        "https://example.com/src/App.ts",
        vec![diagnostic(Some(1), None, "nope", 0, 0)],
    );
    assert!(parse_publish_diagnostics(&non_file)
        .unwrap_err()
        .to_string()
        .contains("unsupported URI scheme"));

    assert!(file_uri_to_path("file:/tmp/App.ts").is_err());
    assert!(file_uri_to_path("file:///tmp/%ZZ.ts").is_err());
    assert!(file_uri_to_path("file:///tmp/%FF.ts").is_err());
    assert!(file_uri_to_path("file:///tmp/App.ts").is_ok());
}

#[test]
fn decodes_percent_escapes_and_handles_windows_drives() {
    assert_eq!(
        file_uri_to_path("file:///tmp/hello%20world/%E4%BD%A0.ts").unwrap(),
        PathBuf::from("/tmp/hello world/你.ts")
    );
    assert_eq!(
        file_uri_to_path("file:///C:/Users/Test/App.ts").unwrap(),
        PathBuf::from("C:/Users/Test/App.ts")
    );
    assert_eq!(
        file_uri_to_path("file:///c:/Users/Test/App.ts").unwrap(),
        PathBuf::from("c:/Users/Test/App.ts")
    );
    assert_eq!(
        file_uri_to_path("file://localhost/tmp/App.ts").unwrap(),
        PathBuf::from("/tmp/App.ts")
    );

    let original = PathBuf::from("/tmp/hello world/你.ts");
    let uri = path_to_file_uri(&original);
    assert!(uri.contains("%20"));
    assert!(uri.contains("%E4%BD%A0"));
    assert_eq!(file_uri_to_path(&uri).unwrap(), original);

    let windows = PathBuf::from("C:/Users/Test/App.ts");
    let windows_uri = path_to_file_uri(&windows);
    assert_eq!(windows_uri, "file:///C:/Users/Test/App.ts");
    assert_eq!(file_uri_to_path(&windows_uri).unwrap(), windows);
}

#[test]
fn parses_location_array_and_location_link_definition_responses() {
    let location = json!({
        "uri": "file:///workspace/src/App.ts",
        "range": range(2, 4, 2, 12)
    });
    let single = parse_definition_response(&location);
    assert_eq!(single.len(), 1);
    assert_eq!(single[0].uri, "file:///workspace/src/App.ts");
    assert_eq!(
        single[0].range.start,
        LspPosition {
            line: 2,
            character: 4
        }
    );

    let array = parse_definition_response(&json!([
        location,
        {
            "uri": "file:///workspace/src/Other.ts",
            "range": range(1, 0, 1, 4)
        }
    ]));
    assert_eq!(array.len(), 2);
    assert_eq!(array[1].uri, "file:///workspace/src/Other.ts");

    let link = parse_definition_response(&json!({
        "targetUri": "file:///workspace/src/Linked.ts",
        "targetRange": range(5, 2, 8, 1),
        "targetSelectionRange": range(5, 2, 5, 9),
        "originSelectionRange": range(0, 0, 0, 3)
    }));
    assert_eq!(link.len(), 1);
    assert_eq!(link[0].uri, "file:///workspace/src/Linked.ts");
    assert_eq!(
        link[0].range,
        LspRange {
            start: LspPosition {
                line: 5,
                character: 2
            },
            end: LspPosition {
                line: 8,
                character: 1
            },
        }
    );

    assert!(parse_definition_response(&json!(null)).is_empty());
}

#[test]
fn parses_nested_document_symbols_and_symbol_information() {
    let symbols = json!([{
        "name": "App",
        "detail": "component",
        "kind": 12,
        "range": range(0, 0, 9, 0),
        "selectionRange": range(0, 9, 0, 12),
        "children": [{
            "name": "render",
            "kind": 6,
            "range": range(2, 2, 6, 3),
            "selectionRange": range(2, 11, 2, 17),
            "unknownChildField": true
        }],
        "unknownSymbolField": "ignored"
    }]);

    let documents = parse_document_symbols(&symbols);
    assert_eq!(documents.len(), 1);
    assert_eq!(documents[0].name, "App");
    assert_eq!(documents[0].detail.as_deref(), Some("component"));
    assert_eq!(documents[0].kind, LspSymbolKind::Function);
    assert_eq!(documents[0].children.len(), 1);
    assert_eq!(documents[0].children[0].name, "render");
    assert_eq!(documents[0].children[0].kind, LspSymbolKind::Method);

    let information = json!([{
        "name": "loadConfig",
        "kind": 12,
        "location": {
            "uri": "file:///workspace/src/config.ts",
            "range": range(4, 0, 8, 1)
        },
        "containerName": "config",
        "unknownField": 1
    }]);
    let flat = parse_symbol_information(&information);
    assert_eq!(flat.len(), 1);
    assert_eq!(flat[0].name, "loadConfig");
    assert_eq!(flat[0].kind, LspSymbolKind::Function);
    assert_eq!(flat[0].container_name.as_deref(), Some("config"));
}

#[test]
fn symbol_kind_mapping_covers_all_26_standard_kinds() {
    let expected_names = [
        "file",
        "module",
        "namespace",
        "package",
        "class",
        "method",
        "property",
        "field",
        "constructor",
        "enum",
        "interface",
        "function",
        "variable",
        "constant",
        "string",
        "number",
        "boolean",
        "array",
        "object",
        "key",
        "null",
        "enumMember",
        "struct",
        "event",
        "operator",
        "typeParameter",
    ];
    for (index, name) in expected_names.iter().enumerate() {
        let code = (index + 1) as u8;
        let kind = LspSymbolKind::from_u8(code);
        assert_eq!(kind.as_u8(), code);
        assert_eq!(kind.as_str(), *name);
        assert_eq!(u8::from(kind), code);
    }
    let future = LspSymbolKind::from_u8(99);
    assert_eq!(future, LspSymbolKind::Unknown(99));
    assert_eq!(future.as_u8(), 99);
    assert_eq!(future.as_str(), "unknown");
}

#[test]
fn parses_hover_content_variants() {
    assert_eq!(
        parse_hover(&json!({ "contents": { "kind": "markdown", "value": "**App**" } })),
        Some("**App**".to_string())
    );
    assert_eq!(
        parse_hover(&json!({ "contents": "plain hover" })),
        Some("plain hover".to_string())
    );
    assert_eq!(
        parse_hover(&json!({
            "contents": { "language": "typescript", "value": "const value = 1" }
        })),
        Some("const value = 1".to_string())
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
    assert_eq!(parse_hover(&json!({})), None);

    let hover: LspHover =
        serde_json::from_value(json!({ "contents": { "kind": "markdown", "value": "doc" } }))
            .unwrap();
    assert_eq!(hover.contents, "doc");
}

#[test]
fn lsp_diagnostics_feed_ts2304_analysis() {
    let payload = publish(
        "file:///workspace/src/App.ts",
        vec![diagnostic(
            Some(1),
            Some(json!("TS2304")),
            "Cannot find name 'missingValue'.",
            11,
            6,
        )],
    );

    let report = analyze_lsp_diagnostics(&payload).unwrap();
    assert_eq!(report.error_count, 1);
    assert_eq!(report.primary_category, ErrorCategory::Type);
    assert_eq!(
        report
            .matches
            .iter()
            .map(|pattern_match| pattern_match.pattern_id.as_str())
            .collect::<Vec<_>>(),
        vec!["ts-2304"]
    );
}

#[test]
fn merge_deduplicates_and_preserves_first_seen_order() {
    let existing = parse_publish_diagnostics(&publish(
        "file:///workspace/src/merge.ts",
        vec![
            diagnostic(Some(1), Some(json!("TS1")), "first", 0, 0),
            diagnostic(Some(2), Some(json!("TS2")), "second", 1, 0),
        ],
    ))
    .unwrap();
    let lsp = parse_publish_diagnostics(&publish(
        "file:///workspace/src/merge.ts",
        vec![
            diagnostic(Some(1), Some(json!("TS2")), "second", 1, 0),
            diagnostic(Some(1), Some(json!("TS3")), "third", 2, 0),
        ],
    ))
    .unwrap();

    let merged = merge_lsp_diagnostics(&existing, &lsp);
    assert_eq!(
        merged
            .iter()
            .map(|diagnostic| diagnostic.message.as_str())
            .collect::<Vec<_>>(),
        vec!["first", "second", "third"]
    );
    assert_eq!(merged[1], existing[1], "first occurrence wins");
    assert_eq!(merged.len(), 3);
}

#[test]
fn diagnostic_from_lsp_keeps_raw_payload_and_one_based_columns() {
    let value = diagnostic(
        Some(1),
        Some(json!(2304)),
        "Cannot find name 'value'.",
        0,
        0,
    );
    let diagnostic: LspDiagnostic = serde_json::from_value(value).unwrap();
    let normalized = diagnostic_from_lsp(Path::new("src/App.ts"), &diagnostic);
    assert_eq!(normalized.line, Some(1));
    assert_eq!(normalized.column, Some(1));
    assert_eq!(normalized.code.as_deref(), Some("2304"));
    assert!(normalized
        .raw
        .as_deref()
        .is_some_and(|raw| raw.contains("\"code\":2304")));
}
