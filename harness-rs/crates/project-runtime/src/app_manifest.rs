use crate::{normalize_project_id, ProjectRuntime};
use anyhow::{Context, Result};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use worldbase_protocol::types::{AppManifest, CapabilityRisk, RuntimeKind, TrustLevel};

pub const APP_MANIFEST_RELATIVE_PATH: &str = ".worldbase/app-capabilities.json";
pub const APP_REVOCATIONS_RELATIVE_PATH: &str = ".worldbase/app-revocations.json";

const MAX_MANIFEST_BYTES: usize = 512 * 1024;
const MAX_SCHEMA_BYTES: usize = 64 * 1024;
const MAX_SCHEMA_DEPTH: usize = 12;
const MAX_CAPABILITIES: usize = 128;
const MAX_ID_BYTES: usize = 128;

#[derive(Debug, Default, Clone)]
pub struct RevokedApps {
    pub app_ids: HashSet<String>,
    pub manifest_hashes: HashSet<String>,
}

impl RevokedApps {
    fn is_empty(&self) -> bool {
        self.app_ids.is_empty() && self.manifest_hashes.is_empty()
    }

    fn contains(&self, manifest: &AppManifest, hash: &str) -> bool {
        self.app_ids.contains(&manifest.app.id)
            || self.manifest_hashes.contains(hash)
            || self
                .manifest_hashes
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(hash))
    }
}

pub fn load_manifest(project_root: &Path) -> Result<Option<AppManifest>> {
    let path = project_root.join(APP_MANIFEST_RELATIVE_PATH);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| format!("read app manifest {}", path.display()))
        }
    };
    anyhow::ensure!(
        text.len() <= MAX_MANIFEST_BYTES,
        "manifest_invalid: manifest exceeds {MAX_MANIFEST_BYTES} bytes"
    );
    let manifest: AppManifest = serde_json::from_str(&text)
        .with_context(|| format!("parse app manifest {}", path.display()))?;
    validate_manifest(&manifest)
        .map_err(|errors| anyhow::anyhow!("manifest_invalid: {}", errors.join("; ")))?;

    let revoked = load_revocations(project_root)?;
    if !revoked.is_empty() {
        let hash = manifest_hash(&manifest)?;
        anyhow::ensure!(
            !revoked.contains(&manifest, &hash),
            "manifest_invalid: app is revoked: {}",
            manifest.app.id
        );
    }
    Ok(Some(manifest))
}

pub fn list_manifests(projects_root: &Path) -> Result<Vec<(String, AppManifest)>> {
    if !projects_root.is_dir() {
        return Ok(Vec::new());
    }
    let root_revoked = load_revocations(projects_root)?;
    let mut projects = fs::read_dir(projects_root)?.collect::<std::result::Result<Vec<_>, _>>()?;
    projects.sort_by_key(|entry| entry.file_name());

    let mut manifests = Vec::new();
    for entry in projects {
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let project_id = entry.file_name().to_string_lossy().into_owned();
        if project_id.is_empty() {
            continue;
        }
        match load_manifest(&entry.path()) {
            Ok(Some(manifest)) => {
                if !root_revoked.is_empty() {
                    let hash = manifest_hash(&manifest)?;
                    if root_revoked.contains(&manifest, &hash) {
                        tracing::warn!(project = %project_id, app = %manifest.app.id, "skipping revoked app manifest");
                        continue;
                    }
                }
                manifests.push((project_id, manifest));
            }
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(project = %project_id, error = %error, "skipping invalid app manifest");
            }
        }
    }
    Ok(manifests)
}

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
    if manifest.app.version.trim().is_empty() {
        errors.push("app.version is required".into());
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

    let mut capability_ids = HashSet::new();
    for capability in &manifest.capabilities {
        if !valid_id(&capability.id) {
            errors.push(format!("invalid capability id: {}", capability.id));
        }
        if !capability_ids.insert(capability.id.clone()) {
            errors.push(format!("duplicate capability id: {}", capability.id));
        }
        if capability.operation.trim().is_empty() {
            errors.push(format!(
                "capability {} has an empty operation",
                capability.id
            ));
        }
        if let Err(error) = validate_schema(&capability.input_schema, 0) {
            errors.push(format!("capability {} inputSchema: {error}", capability.id));
        }
        if let Some(output_schema) = capability.output_schema.as_ref() {
            if let Err(error) = validate_schema(output_schema, 0) {
                errors.push(format!(
                    "capability {} outputSchema: {error}",
                    capability.id
                ));
            }
        }
        if capability.risk == CapabilityRisk::ExternalEffect && !capability.side_effects {
            errors.push(format!(
                "capability {} is external_effect but does not declare sideEffects",
                capability.id
            ));
        }
    }

    if let Some(health_check) = manifest.runtime.health_check.as_deref() {
        if !capability_ids.contains(health_check) {
            errors.push(format!(
                "runtime.healthCheck references unknown capability: {health_check}"
            ));
        }
    }

    if manifest.runtime.kind == RuntimeKind::ManagedProject
        && manifest.app.trust_level == TrustLevel::Builtin
    {
        errors.push("managed projects cannot claim builtin trust".into());
    }

    if let Some(signature) = manifest
        .app
        .signature
        .as_deref()
        .map(str::trim)
        .filter(|signature| !signature.is_empty())
    {
        match manifest_hash(manifest) {
            Ok(hash) if signature.eq_ignore_ascii_case(&hash) => {}
            Ok(_) => errors.push("signature does not match manifest hash".into()),
            Err(error) => errors.push(format!("unable to compute manifest hash: {error}")),
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

pub fn manifest_hash(manifest: &AppManifest) -> Result<String> {
    let mut value = serde_json::to_value(manifest)?;
    if let Some(app) = value.get_mut("app").and_then(Value::as_object_mut) {
        app.remove("signature");
    }
    let canonical = canonicalize(&value);
    let encoded = serde_json::to_vec(&canonical)?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

pub fn load_revocations(project_root: &Path) -> Result<RevokedApps> {
    let path = project_root.join(APP_REVOCATIONS_RELATIVE_PATH);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RevokedApps::default())
        }
        Err(error) => {
            return Err(error).with_context(|| format!("read app revocations {}", path.display()))
        }
    };
    let value: Value = serde_json::from_str(&text)
        .with_context(|| format!("parse app revocations {}", path.display()))?;
    let mut revoked = RevokedApps::default();
    collect_revocations(&value, &mut revoked);
    Ok(revoked)
}

fn collect_revocations(value: &Value, revoked: &mut RevokedApps) {
    match value {
        Value::Array(items) => {
            for item in items {
                match item {
                    Value::String(app_id) => {
                        revoked.app_ids.insert(app_id.trim().to_string());
                    }
                    Value::Object(_) => collect_revocations(item, revoked),
                    _ => {}
                }
            }
        }
        Value::Object(map) => {
            for (key, item) in map {
                match key.as_str() {
                    "apps" | "revokedApps" | "appIds" | "app_ids" => {
                        collect_string_set(item, &mut revoked.app_ids);
                    }
                    "hashes" | "revokedHashes" | "manifestHashes" | "signatures" => {
                        collect_string_set(item, &mut revoked.manifest_hashes);
                    }
                    "appId" | "app_id" => {
                        if let Some(app_id) = item.as_str() {
                            revoked.app_ids.insert(app_id.trim().to_string());
                        }
                    }
                    "manifestHash" | "manifest_hash" | "hash" | "signature" => {
                        if let Some(hash) = item.as_str() {
                            revoked.manifest_hashes.insert(hash.trim().to_string());
                        }
                    }
                    _ => collect_revocations(item, revoked),
                }
            }
        }
        _ => {}
    }
    revoked.app_ids.retain(|value| !value.is_empty());
    revoked.manifest_hashes.retain(|value| !value.is_empty());
}

fn collect_string_set(value: &Value, target: &mut HashSet<String>) {
    match value {
        Value::String(value) => {
            target.insert(value.trim().to_string());
        }
        Value::Array(items) => {
            for item in items {
                if let Some(value) = item.as_str() {
                    target.insert(value.trim().to_string());
                }
            }
        }
        _ => {}
    }
}

fn validate_schema(value: &Value, depth: usize) -> std::result::Result<(), String> {
    if depth > MAX_SCHEMA_DEPTH {
        return Err("schema nesting is too deep".into());
    }
    let encoded = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    if encoded.len() > MAX_SCHEMA_BYTES {
        return Err("schema exceeds size limit".into());
    }
    match value {
        Value::Object(map) => {
            if let Some(reference) = map.get("$ref").and_then(Value::as_str) {
                if !reference.starts_with('#') {
                    return Err("remote $ref is not allowed".into());
                }
            }
            for child in map.values() {
                validate_schema(child, depth + 1)?;
            }
        }
        Value::Array(items) => {
            for child in items {
                validate_schema(child, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn valid_id(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        && value
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_alphanumeric())
}

fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys = map.keys().collect::<Vec<_>>();
            keys.sort();
            let mut sorted = Map::new();
            for key in keys {
                sorted.insert(key.clone(), canonicalize(&map[key]));
            }
            Value::Object(sorted)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonicalize).collect()),
        other => other.clone(),
    }
}

impl ProjectRuntime {
    pub fn app_manifest(&self, project_id: &str) -> Result<Option<AppManifest>> {
        let project_id = normalize_project_id(project_id)?;
        if let Some(manifest) = self
            .app_manifests
            .lock()
            .expect("app manifest lock poisoned")
            .get(project_id)
        {
            return Ok(Some(manifest.clone()));
        }
        let root = self.project_root(project_id)?;
        let manifest = load_manifest(&root)?;
        if let Some(manifest) = manifest.as_ref() {
            self.app_manifests
                .lock()
                .expect("app manifest lock poisoned")
                .insert(project_id.to_string(), manifest.clone());
        }
        Ok(manifest)
    }

    pub fn list_app_manifests(&self) -> Result<Vec<(String, AppManifest)>> {
        list_manifests(&self.projects_dir)
    }

    pub(crate) fn cache_app_manifest(&self, project_id: &str, manifest: AppManifest) {
        self.app_manifests
            .lock()
            .expect("app manifest lock poisoned")
            .insert(project_id.to_string(), manifest);
    }

    pub fn app_manifest_cached(&self, project_id: &str) -> Option<AppManifest> {
        self.app_manifests
            .lock()
            .expect("app manifest lock poisoned")
            .get(project_id)
            .cloned()
    }
}
