//! Application manifest validation and stable tool naming.
//!
//! Validation is deliberately conservative: manifests are untrusted input and
//! may only reference capability IDs, not commands, URLs or IPC channels.

use std::collections::HashSet;
use std::sync::OnceLock;

use anyhow::Result;
use regex::Regex;
use serde_json::Value;
use sha2::{Digest, Sha256};
use worldbase_protocol::types::{
    AppCapabilityManifest, AppManifest, CapabilityRisk, RuntimeKind, TrustLevel,
};

const MAX_SCHEMA_BYTES: usize = 64 * 1024;
const MAX_SCHEMA_DEPTH: usize = 12;
const MAX_CAPABILITIES: usize = 128;
const MAX_PLATFORMS: usize = 8;
const MAX_TAGS: usize = 32;
const MAX_TAG_LEN: usize = 64;
const MAX_DEADLINE_MS: u64 = 10 * 60 * 1000;

const KNOWN_PLATFORMS: &[&str] = &[
    "desktop",
    "mobile",
    "mobile-ios",
    "mobile-android",
    "cli",
    "server",
    "electron",
];

pub fn validate_manifest(manifest: &AppManifest) -> std::result::Result<(), Vec<String>> {
    let mut errors = Vec::new();
    if manifest.schema_version != 1 {
        errors.push(format!(
            "unsupported schemaVersion {} (expected 1)",
            manifest.schema_version
        ));
    }
    if !valid_id(&manifest.app.id) {
        errors.push(format!("invalid app id: {}", manifest.app.id));
    }
    if !valid_version(&manifest.app.version) {
        errors.push(format!("invalid app version: {}", manifest.app.version));
    }
    if manifest.app.name.trim().is_empty() {
        errors.push("app.name is required".into());
    }
    if manifest.app.platforms.len() > MAX_PLATFORMS {
        errors.push(format!(
            "too many platforms: {} (max {MAX_PLATFORMS})",
            manifest.app.platforms.len()
        ));
    }
    let mut platforms = HashSet::new();
    for platform in &manifest.app.platforms {
        if !KNOWN_PLATFORMS.contains(&platform.as_str()) {
            errors.push(format!("unknown platform: {platform}"));
        }
        if !platforms.insert(platform) {
            errors.push(format!("duplicate platform: {platform}"));
        }
    }
    if manifest.app.tags.len() > MAX_TAGS {
        errors.push(format!(
            "too many tags: {} (max {MAX_TAGS})",
            manifest.app.tags.len()
        ));
    }
    for tag in &manifest.app.tags {
        if tag.trim().is_empty() || tag.len() > MAX_TAG_LEN {
            errors.push(format!("invalid tag: {tag}"));
        }
    }
    for feature in manifest
        .app
        .required_features
        .iter()
        .chain(manifest.app.excluded_features.iter())
    {
        if feature.trim().is_empty() || feature.len() > MAX_TAG_LEN {
            errors.push(format!("invalid feature name: {feature}"));
        }
    }
    if let Some(overlap) = manifest
        .app
        .required_features
        .iter()
        .find(|feature| manifest.app.excluded_features.contains(feature))
    {
        errors.push(format!("feature {overlap} is both required and excluded"));
    }

    if manifest.capabilities.len() > MAX_CAPABILITIES {
        errors.push(format!(
            "too many capabilities: {} (max {MAX_CAPABILITIES})",
            manifest.capabilities.len()
        ));
    }
    if manifest.capabilities.is_empty() && manifest.ai_integration.as_deref() != Some("none") {
        errors.push("at least one capability is required unless aiIntegration is \"none\"".into());
    }
    if manifest
        .ai_integration
        .as_deref()
        .is_some_and(|value| value.trim().is_empty())
    {
        errors.push("aiIntegration must not be empty when present".into());
    }

    let mut capability_ids = HashSet::new();
    let mut tool_names = HashSet::new();
    for capability in &manifest.capabilities {
        if !valid_id(&capability.id) {
            errors.push(format!("invalid capability id: {}", capability.id));
        }
        if !capability_ids.insert(capability.id.clone()) {
            errors.push(format!("duplicate capability id: {}", capability.id));
        }
        let tool_name = capability_tool_name(&manifest.app.id, &capability.id);
        if !tool_names.insert(tool_name.clone()) {
            errors.push(format!(
                "capability id collides after tool-name sanitization: {tool_name}"
            ));
        }
        validate_capability(manifest, capability, &mut errors);
    }

    if let Some(health_check) = manifest.runtime.health_check.as_deref() {
        if !capability_ids.contains(health_check) {
            errors.push(format!(
                "runtime.healthCheck references unknown capability: {health_check}"
            ));
        }
    }
    if manifest.runtime.activation.trim().is_empty() {
        errors.push("runtime.activation is required".into());
    }

    if manifest.runtime.kind == RuntimeKind::ManagedProject
        && manifest.app.trust_level == TrustLevel::Builtin
    {
        errors.push("managed projects cannot claim builtin trust".into());
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

fn validate_capability(
    manifest: &AppManifest,
    capability: &AppCapabilityManifest,
    errors: &mut Vec<String>,
) {
    if !valid_operation(&capability.operation) {
        errors.push(format!(
            "capability {} has an invalid operation: {}",
            capability.id, capability.operation
        ));
    }
    if let Err(error) = validate_schema(&capability.input_schema) {
        errors.push(format!("capability {} inputSchema: {error}", capability.id));
    }
    if let Some(output_schema) = capability.output_schema.as_ref() {
        if let Err(error) = validate_schema(output_schema) {
            errors.push(format!(
                "capability {} outputSchema: {error}",
                capability.id
            ));
        }
    }
    if !valid_token_list(&capability.permissions) {
        errors.push(format!(
            "capability {} has invalid permissions",
            capability.id
        ));
    }
    if !valid_token_list(&capability.data_scopes) {
        errors.push(format!(
            "capability {} has invalid dataScopes",
            capability.id
        ));
    }
    if matches!(
        capability.risk,
        CapabilityRisk::WriteDestructive | CapabilityRisk::ExternalEffect
    ) && !capability.side_effects
    {
        errors.push(format!(
            "capability {} is {:?} but does not declare sideEffects",
            capability.id, capability.risk
        ));
    }
    if capability.risk == CapabilityRisk::Read && capability.side_effects {
        errors.push(format!(
            "capability {} is read-only but declares sideEffects",
            capability.id
        ));
    }
    if let Some(deadline_ms) = capability.deadline_ms {
        if deadline_ms == 0 || deadline_ms > MAX_DEADLINE_MS {
            errors.push(format!(
                "capability {} deadlineMs must be between 1 and {MAX_DEADLINE_MS}",
                capability.id
            ));
        }
    }
    if manifest.runtime.kind == RuntimeKind::ManagedProject && capability.id.trim().is_empty() {
        errors.push("managed capability id is required".into());
    }
}

pub(crate) fn valid_id(value: &str) -> bool {
    id_regex().is_match(value)
}

fn id_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$").unwrap())
}

fn valid_version(value: &str) -> bool {
    version_regex().is_match(value)
}

fn version_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$").unwrap())
}

fn valid_operation(value: &str) -> bool {
    operation_regex().is_match(value)
}

fn operation_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$").unwrap())
}

fn valid_token_list(values: &[String]) -> bool {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    let regex = REGEX.get_or_init(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$").unwrap());
    values.iter().all(|value| regex.is_match(value))
}

fn validate_schema(value: &Value) -> std::result::Result<(), String> {
    let encoded = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    if encoded.len() > MAX_SCHEMA_BYTES {
        return Err("schema exceeds size limit".into());
    }
    validate_schema_node(value, 0)
}

fn validate_schema_node(value: &Value, depth: usize) -> std::result::Result<(), String> {
    if depth > MAX_SCHEMA_DEPTH {
        return Err("schema nesting is too deep".into());
    }
    match value {
        Value::Object(map) => {
            if let Some(reference) = map.get("$ref").and_then(Value::as_str) {
                if !reference.starts_with('#') {
                    return Err("remote $ref is not allowed".into());
                }
            }
            for child in map.values() {
                validate_schema_node(child, depth + 1)?;
            }
        }
        Value::Array(items) => {
            for child in items {
                validate_schema_node(child, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub fn manifest_hash(manifest: &AppManifest) -> Result<String> {
    let mut value = serde_json::to_value(manifest)?;
    // The signature is detached metadata; trusting it must not change the
    // identity of the manifest it signs. Keep this byte-for-byte compatible
    // with the project-runtime revocation/signature hash.
    if let Some(app) = value.get_mut("app").and_then(Value::as_object_mut) {
        app.remove("signature");
    }
    let canonical = canonicalize(&value);
    let encoded = serde_json::to_vec(&canonical)?;
    let digest = Sha256::digest(encoded);
    Ok(format!("{digest:x}"))
}

fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys = map.keys().collect::<Vec<_>>();
            keys.sort();
            let mut sorted = serde_json::Map::new();
            for key in keys {
                sorted.insert(key.clone(), canonicalize(&map[key]));
            }
            Value::Object(sorted)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonicalize).collect()),
        other => other.clone(),
    }
}

pub fn capability_tool_name(app_id: &str, capability_id: &str) -> String {
    let app = sanitize_component(app_id, 40);
    let capability = sanitize_component(capability_id, 40);
    format!("app__{app}__{capability}")
}

fn sanitize_component(value: &str, max_len: usize) -> String {
    let mut output = String::new();
    for ch in value.chars() {
        if output.len() >= max_len {
            break;
        }
        if ch.is_ascii_alphanumeric() {
            output.push(ch.to_ascii_lowercase());
        } else {
            output.push('_');
        }
    }
    let trimmed = output.trim_matches('_').to_string();
    if trimmed.is_empty() {
        "app".into()
    } else {
        trimmed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn manifest() -> AppManifest {
        serde_json::from_value(json!({
            "schemaVersion": 1,
            "app": {
                "id": "worldbase.tasks",
                "name": "Tasks",
                "version": "1.0.0",
                "platforms": ["desktop"],
                "trustLevel": "builtin"
            },
            "runtime": { "kind": "host_service" },
            "capabilities": [{
                "id": "task.search",
                "title": "Search",
                "description": "Search tasks",
                "inputSchema": { "type": "object" },
                "operation": "tasks.search",
                "risk": "read"
            }]
        }))
        .unwrap()
    }

    #[test]
    fn validates_and_hashes() {
        let manifest = manifest();
        validate_manifest(&manifest).unwrap();
        let hash = manifest_hash(&manifest).unwrap();
        assert_eq!(hash.len(), 64);
        assert_eq!(
            capability_tool_name("worldbase.tasks", "task.search"),
            "app__worldbase_tasks__task_search"
        );
    }

    #[test]
    fn hash_is_stable_and_signature_detached() {
        let mut manifest = manifest();
        let hash = manifest_hash(&manifest).unwrap();
        manifest.app.signature = Some("detached-signature".into());
        assert_eq!(hash, manifest_hash(&manifest).unwrap());
    }

    #[test]
    fn rejects_remote_refs_and_duplicate_ids() {
        let mut manifest = manifest();
        manifest.capabilities[0].input_schema =
            json!({ "type": "object", "properties": { "x": { "$ref": "https://evil" } } });
        manifest.capabilities.push(manifest.capabilities[0].clone());
        let errors = validate_manifest(&manifest).unwrap_err();
        assert!(errors.iter().any(|error| error.contains("remote $ref")));
        assert!(errors
            .iter()
            .any(|error| error.contains("duplicate capability")));
    }

    #[test]
    fn rejects_unknown_health_check() {
        let mut manifest = manifest();
        manifest.runtime.health_check = Some("missing.health".into());
        let errors = validate_manifest(&manifest).unwrap_err();
        assert!(errors.iter().any(|error| error.contains("healthCheck")));
    }

    #[test]
    fn rejects_invalid_ids_versions_and_operations() {
        let mut manifest = manifest();
        manifest.app.id = "../evil".into();
        manifest.app.version = "1.0.0 / ../../".into();
        manifest.capabilities[0].id = "task search".into();
        manifest.capabilities[0].operation = "https://evil.example/run".into();
        let errors = validate_manifest(&manifest).unwrap_err();
        assert!(errors.iter().any(|error| error.contains("invalid app id")));
        assert!(errors
            .iter()
            .any(|error| error.contains("invalid app version")));
        assert!(errors
            .iter()
            .any(|error| error.contains("invalid capability id")));
        assert!(errors
            .iter()
            .any(|error| error.contains("invalid operation")));
    }

    #[test]
    fn rejects_schema_depth_and_oversize() {
        let mut value = manifest();
        let mut nested = json!({ "type": "object" });
        for _ in 0..(MAX_SCHEMA_DEPTH + 2) {
            nested = json!({ "type": "object", "properties": { "next": nested } });
        }
        value.capabilities[0].input_schema = nested;
        let errors = validate_manifest(&value).unwrap_err();
        assert!(errors.iter().any(|error| error.contains("too deep")));

        let mut value = manifest();
        let padding = "x".repeat(MAX_SCHEMA_BYTES + 1);
        value.capabilities[0].input_schema = json!({
            "type": "object",
            "description": padding
        });
        let errors = validate_manifest(&value).unwrap_err();
        assert!(errors.iter().any(|error| error.contains("size limit")));
    }

    #[test]
    fn rejects_risk_permission_inconsistencies() {
        let mut value = manifest();
        value.capabilities[0].risk = CapabilityRisk::WriteDestructive;
        let errors = validate_manifest(&value).unwrap_err();
        assert!(errors.iter().any(|error| error.contains("sideEffects")));

        let mut value = manifest();
        value.capabilities[0].side_effects = true;
        let errors = validate_manifest(&value).unwrap_err();
        assert!(errors.iter().any(|error| error.contains("sideEffects")));

        let mut value = manifest();
        value.capabilities[0].permissions = vec!["allow all".into()];
        value.capabilities[0].data_scopes = vec!["../".into()];
        let errors = validate_manifest(&value).unwrap_err();
        assert!(errors.iter().any(|error| error.contains("permissions")));
        assert!(errors.iter().any(|error| error.contains("dataScopes")));
    }

    #[test]
    fn rejects_too_many_capabilities_and_bad_platforms() {
        let mut manifest = manifest();
        manifest.app.platforms = vec!["desktop".into(), "desktop".into(), "toaster".into()];
        for index in 0..=MAX_CAPABILITIES {
            let mut capability = manifest.capabilities[0].clone();
            capability.id = format!("task.search{index}");
            manifest.capabilities.push(capability);
        }
        let errors = validate_manifest(&manifest).unwrap_err();
        assert!(errors
            .iter()
            .any(|error| error.contains("too many capabilities")));
        assert!(errors
            .iter()
            .any(|error| error.contains("duplicate platform")));
        assert!(errors
            .iter()
            .any(|error| error.contains("unknown platform")));
    }
}
