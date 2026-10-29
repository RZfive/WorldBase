//! Language Server Protocol diagnostic, symbol, and definition ingestion.
//!
//! This module is intentionally transport-free: it parses LSP JSON payloads
//! into the coding crate's normalized types. A live language-server client can
//! feed these payloads into [`crate::error_analyzer`].

use crate::error_analyzer::{analyze_diagnostics, DiagnosisReport};
use crate::model::{Diagnostic, DiagnosticSeverity};
use anyhow::{Context, Result};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Zero-based LSP position.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LspPosition {
    pub line: u32,
    pub character: u32,
}

/// Zero-based half-open LSP range.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LspRange {
    pub start: LspPosition,
    pub end: LspPosition,
}

/// An LSP location (`file://` URI plus range).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LspLocation {
    pub uri: String,
    pub range: LspRange,
}

/// The subset of LSP diagnostics needed for normalization.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDiagnostic {
    pub range: LspRange,
    #[serde(default)]
    pub severity: Option<u8>,
    #[serde(default)]
    pub code: Option<Value>,
    #[serde(default)]
    pub source: Option<String>,
    pub message: String,
    #[serde(default)]
    pub related_information: Option<Value>,
    #[serde(default)]
    pub tags: Option<Vec<u8>>,
    #[serde(default)]
    pub data: Option<Value>,
}

/// `textDocument/publishDiagnostics` notification parameters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PublishDiagnosticsParams {
    pub uri: String,
    #[serde(default)]
    pub version: Option<i64>,
    pub diagnostics: Vec<LspDiagnostic>,
}

/// Hierarchical document symbol used by `textDocument/documentSymbol`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDocumentSymbol {
    pub name: String,
    #[serde(default)]
    pub detail: Option<String>,
    pub kind: LspSymbolKind,
    pub range: LspRange,
    pub selection_range: LspRange,
    #[serde(default)]
    pub children: Vec<LspDocumentSymbol>,
}

/// Flat symbol information used by workspace/symbol responses.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspSymbolInformation {
    pub name: String,
    pub kind: LspSymbolKind,
    pub location: LspLocation,
    #[serde(default)]
    pub container_name: Option<String>,
}

/// The 26 standard LSP symbol kinds plus a tolerant fallback for future kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LspSymbolKind {
    File,
    Module,
    Namespace,
    Package,
    Class,
    Method,
    Property,
    Field,
    Constructor,
    Enum,
    Interface,
    Function,
    Variable,
    Constant,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Key,
    Null,
    EnumMember,
    Struct,
    Event,
    Operator,
    TypeParameter,
    Unknown(u8),
}

impl LspSymbolKind {
    /// Stable lowercase name for diagnostics and UI display.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Module => "module",
            Self::Namespace => "namespace",
            Self::Package => "package",
            Self::Class => "class",
            Self::Method => "method",
            Self::Property => "property",
            Self::Field => "field",
            Self::Constructor => "constructor",
            Self::Enum => "enum",
            Self::Interface => "interface",
            Self::Function => "function",
            Self::Variable => "variable",
            Self::Constant => "constant",
            Self::String => "string",
            Self::Number => "number",
            Self::Boolean => "boolean",
            Self::Array => "array",
            Self::Object => "object",
            Self::Key => "key",
            Self::Null => "null",
            Self::EnumMember => "enumMember",
            Self::Struct => "struct",
            Self::Event => "event",
            Self::Operator => "operator",
            Self::TypeParameter => "typeParameter",
            Self::Unknown(_) => "unknown",
        }
    }

    /// Numeric LSP SymbolKind value.
    pub fn as_u8(self) -> u8 {
        match self {
            Self::File => 1,
            Self::Module => 2,
            Self::Namespace => 3,
            Self::Package => 4,
            Self::Class => 5,
            Self::Method => 6,
            Self::Property => 7,
            Self::Field => 8,
            Self::Constructor => 9,
            Self::Enum => 10,
            Self::Interface => 11,
            Self::Function => 12,
            Self::Variable => 13,
            Self::Constant => 14,
            Self::String => 15,
            Self::Number => 16,
            Self::Boolean => 17,
            Self::Array => 18,
            Self::Object => 19,
            Self::Key => 20,
            Self::Null => 21,
            Self::EnumMember => 22,
            Self::Struct => 23,
            Self::Event => 24,
            Self::Operator => 25,
            Self::TypeParameter => 26,
            Self::Unknown(code) => code,
        }
    }

    /// Map an LSP numeric kind, preserving unknown values for forward
    /// compatibility instead of failing the whole response.
    pub fn from_u8(code: u8) -> Self {
        match code {
            1 => Self::File,
            2 => Self::Module,
            3 => Self::Namespace,
            4 => Self::Package,
            5 => Self::Class,
            6 => Self::Method,
            7 => Self::Property,
            8 => Self::Field,
            9 => Self::Constructor,
            10 => Self::Enum,
            11 => Self::Interface,
            12 => Self::Function,
            13 => Self::Variable,
            14 => Self::Constant,
            15 => Self::String,
            16 => Self::Number,
            17 => Self::Boolean,
            18 => Self::Array,
            19 => Self::Object,
            20 => Self::Key,
            21 => Self::Null,
            22 => Self::EnumMember,
            23 => Self::Struct,
            24 => Self::Event,
            25 => Self::Operator,
            26 => Self::TypeParameter,
            other => Self::Unknown(other),
        }
    }
}

impl From<u8> for LspSymbolKind {
    fn from(value: u8) -> Self {
        Self::from_u8(value)
    }
}

impl From<LspSymbolKind> for u8 {
    fn from(value: LspSymbolKind) -> Self {
        value.as_u8()
    }
}

impl Serialize for LspSymbolKind {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_u8(self.as_u8())
    }
}

impl<'de> Deserialize<'de> for LspSymbolKind {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let code = u8::deserialize(deserializer)?;
        Ok(Self::from_u8(code))
    }
}

/// Hover contents normalized to plain text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LspHover {
    pub contents: String,
}

impl<'de> Deserialize<'de> for LspHover {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        let contents = value.get("contents").unwrap_or(&value);
        hover_contents(contents)
            .map(|contents| Self { contents })
            .ok_or_else(|| serde::de::Error::custom("invalid LSP hover contents"))
    }
}

/// Convert an LSP `file://` URI into a filesystem path.
///
/// Supports percent-encoded UTF-8 and Windows drive letters. Only the `file`
/// scheme is accepted; malformed URIs are rejected rather than guessed.
pub fn file_uri_to_path(uri: &str) -> Result<PathBuf> {
    let (scheme, rest) = uri
        .split_once(':')
        .with_context(|| format!("malformed file URI: {uri}"))?;
    anyhow::ensure!(
        scheme.eq_ignore_ascii_case("file"),
        "unsupported URI scheme: {uri}"
    );
    let rest = rest
        .strip_prefix("//")
        .with_context(|| format!("malformed file URI: {uri}"))?;
    let rest = rest
        .get(..10)
        .filter(|prefix| prefix.eq_ignore_ascii_case("localhost/"))
        .map(|_| format!("/{}", &rest[10..]))
        .unwrap_or_else(|| rest.to_string());
    let decoded = percent_decode(&rest).with_context(|| format!("decode file URI: {uri}"))?;
    if decoded.is_empty() {
        anyhow::bail!("file URI has no path: {uri}");
    }

    let mut path = decoded;
    if path.starts_with('/') && is_windows_drive(&path[1..]) {
        path.remove(0);
    } else if !path.starts_with('/') && !is_windows_drive(&path) {
        anyhow::bail!("file URI must contain an absolute path: {uri}");
    }

    Ok(PathBuf::from(path))
}

/// Convert a path into a best-effort `file://` URI.
///
/// Relative paths are resolved against the current directory so the result is
/// absolute. Path separators are normalized to `/` and non-URI bytes are
/// percent-encoded, which makes `file_uri_to_path` round-trip deterministic.
pub fn path_to_file_uri(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    let normalized = if path.is_absolute() || is_windows_drive(&normalized) {
        normalized
    } else {
        std::env::current_dir()
            .map(|directory| directory.join(path).to_string_lossy().replace('\\', "/"))
            .unwrap_or(normalized)
    };
    if is_windows_drive(&normalized) {
        format!("file:///{}", percent_encode(&normalized))
    } else if normalized.starts_with('/') {
        format!("file://{}", percent_encode(&normalized))
    } else {
        format!("file:///{}", percent_encode(&normalized))
    }
}

fn is_windows_drive(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn percent_decode(value: &str) -> Result<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                anyhow::bail!("truncated percent escape");
            }
            let high = hex_value(bytes[index + 1]).context("invalid percent escape")?;
            let low = hex_value(bytes[index + 2]).context("invalid percent escape")?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).context("file URI is not valid UTF-8")
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.' | b'~' | b':') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// Normalize LSP severity.
///
/// 1 = Error, 2 = Warning, 3 = Information and 4 = Hint map to `Info`.
/// Missing or unknown severities are treated as Warning; a missing severity is
/// not evidence that a diagnostic is fatal.
pub fn lsp_severity_to_diagnostic(severity: Option<u8>) -> DiagnosticSeverity {
    match severity {
        Some(1) => DiagnosticSeverity::Error,
        Some(3 | 4) => DiagnosticSeverity::Info,
        Some(_) | None => DiagnosticSeverity::Warning,
    }
}

/// Normalize one LSP diagnostic. LSP positions are zero-based; the normalized
/// diagnostic uses one-based line and column numbers.
pub fn diagnostic_from_lsp(path: &Path, diagnostic: &LspDiagnostic) -> Diagnostic {
    Diagnostic {
        severity: lsp_severity_to_diagnostic(diagnostic.severity),
        message: diagnostic.message.clone(),
        code: diagnostic_code(&diagnostic.code),
        file: Some(path.to_path_buf()),
        line: Some(diagnostic.range.start.line.saturating_add(1)),
        column: Some(diagnostic.range.start.character.saturating_add(1)),
        confidence: 1.0,
        raw: serde_json::to_string(diagnostic).ok(),
    }
}

fn diagnostic_code(code: &Option<Value>) -> Option<String> {
    match code {
        Some(Value::String(value)) => Some(value.clone()),
        Some(Value::Number(value)) => Some(value.to_string()),
        _ => None,
    }
}

/// Parse a `textDocument/publishDiagnostics` payload.
pub fn parse_publish_diagnostics(value: &Value) -> Result<Vec<Diagnostic>> {
    let params: PublishDiagnosticsParams =
        serde_json::from_value(value.clone()).context("invalid publishDiagnostics payload")?;
    let path = file_uri_to_path(&params.uri)?;
    Ok(params
        .diagnostics
        .iter()
        .map(|diagnostic| diagnostic_from_lsp(&path, diagnostic))
        .collect())
}

/// Convert LSP diagnostics and run the shared error analyzer.
pub fn analyze_lsp_diagnostics(value: &Value) -> Result<DiagnosisReport> {
    let diagnostics = parse_publish_diagnostics(value)?;
    Ok(analyze_diagnostics(&diagnostics))
}

/// Merge normalized diagnostics without duplicates.
///
/// Deduplication uses code/file/line/column/message only. The first occurrence
/// wins, including its severity, confidence, and raw payload.
pub fn merge_lsp_diagnostics(existing: &[Diagnostic], lsp: &[Diagnostic]) -> Vec<Diagnostic> {
    let mut seen = HashSet::new();
    let mut merged = Vec::with_capacity(existing.len() + lsp.len());
    for diagnostic in existing.iter().chain(lsp) {
        let key = (
            diagnostic.code.clone(),
            diagnostic.file.clone(),
            diagnostic.line,
            diagnostic.column,
            diagnostic.message.clone(),
        );
        if seen.insert(key) {
            merged.push(diagnostic.clone());
        }
    }
    merged
}

/// Parse `textDocument/definition` responses.
///
/// Accepts a single Location, an array of Locations, or a LocationLink
/// (`targetUri` + `targetRange`). Invalid entries are skipped so one malformed
/// result cannot discard the rest.
pub fn parse_definition_response(value: &Value) -> Vec<LspLocation> {
    match value {
        Value::Array(items) => items.iter().filter_map(definition_location).collect(),
        Value::Object(_) => definition_location(value).into_iter().collect(),
        _ => Vec::new(),
    }
}

fn definition_location(value: &Value) -> Option<LspLocation> {
    let object = value.as_object()?;
    if let Some(target_uri) = object.get("targetUri").and_then(Value::as_str) {
        let target_range = object.get("targetRange")?.clone();
        let range = serde_json::from_value(target_range).ok()?;
        return Some(LspLocation {
            uri: target_uri.to_string(),
            range,
        });
    }
    serde_json::from_value(value.clone()).ok()
}

/// Parse hierarchical `documentSymbol` results.
pub fn parse_document_symbols(value: &Value) -> Vec<LspDocumentSymbol> {
    match value {
        Value::Array(_) => serde_json::from_value(value.clone()).unwrap_or_default(),
        Value::Object(_) => serde_json::from_value(value.clone())
            .ok()
            .into_iter()
            .collect(),
        _ => Vec::new(),
    }
}

/// Parse flat `workspace/symbol` results.
pub fn parse_symbol_information(value: &Value) -> Vec<LspSymbolInformation> {
    match value {
        Value::Array(_) => serde_json::from_value(value.clone()).unwrap_or_default(),
        Value::Object(_) => serde_json::from_value(value.clone())
            .ok()
            .into_iter()
            .collect(),
        _ => Vec::new(),
    }
}

/// Parse hover contents into plain text.
///
/// Supports MarkupContent (`{ kind, value }`), MarkedString (string or
/// `{ language, value }`), and arrays of MarkedString. Array entries are joined
/// with newlines.
pub fn parse_hover(value: &Value) -> Option<String> {
    serde_json::from_value::<LspHover>(value.clone())
        .ok()
        .map(|hover| hover.contents)
}

fn hover_contents(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Object(object) => object
            .get("value")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        Value::Array(items) => {
            let parts = items
                .iter()
                .filter_map(hover_contents)
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n"))
            }
        }
        _ => None,
    }
}
