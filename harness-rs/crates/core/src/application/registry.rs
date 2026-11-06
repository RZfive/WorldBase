//! Canonical application catalog owned by Rust.
//!
//! The registry keeps records in memory for fast lookup and mirrors every
//! mutation into `worldbase_memory::Store`. Manifests are untrusted; records
//! are validated and tool names are generated before they enter the catalog.

use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

use anyhow::{Context, Result};
use worldbase_memory::Store;
use worldbase_protocol::types::{
    AppCapabilityManifest, AppHealth, AppManifest, AppManifestApp, AppRuntimeManifest,
    ApplicationCallAudit, ApplicationCandidate, ApplicationGrant, ApplicationRecord,
    ApplicationSearchParams, Capabilities, CapabilityAvailability, CapabilityRecord,
    CapabilityRisk, RuntimeKind, TrustLevel,
};
use worldbase_tools::{ApplicationCapabilityProvider, NativeToolCapabilityProvider, Tool};

use super::manifest::{capability_tool_name, manifest_hash, valid_id, validate_manifest};

const MAX_AUDIT_IN_MEMORY: usize = 2_000;
const MAX_CAPABILITIES: usize = 128;

#[derive(Clone, Default)]
struct FeatureRequirements {
    required: Vec<String>,
    excluded: Vec<String>,
}

#[derive(Default)]
struct RegistryState {
    apps: BTreeMap<String, ApplicationRecord>,
    providers: BTreeMap<String, Arc<dyn ApplicationCapabilityProvider>>,
    requirements: BTreeMap<String, FeatureRequirements>,
    grants: Vec<ApplicationGrant>,
    audit: Vec<ApplicationCallAudit>,
}

pub struct ApplicationRegistry {
    store: Arc<Store>,
    state: RwLock<RegistryState>,
    version: AtomicU64,
    reserved_tool_names: RwLock<HashSet<String>>,
}

impl ApplicationRegistry {
    pub fn new(store: Arc<Store>) -> Arc<Self> {
        let registry = Arc::new(Self {
            store,
            state: RwLock::new(RegistryState::default()),
            version: AtomicU64::new(1),
            reserved_tool_names: RwLock::new(HashSet::new()),
        });
        registry.load_persisted();
        registry
    }

    fn load_persisted(&self) {
        match self.store.list_applications() {
            Ok(applications) => {
                let mut state = self.state.write().unwrap();
                for mut record in applications {
                    apply_enabled_availability(&mut record);
                    state.apps.insert(record.app_id.clone(), record);
                }
            }
            Err(error) => {
                tracing::warn!(error = %error, "failed to load persisted applications");
            }
        }
        match self.store.list_application_grants(None) {
            Ok(grants) => {
                self.state.write().unwrap().grants = grants;
            }
            Err(error) => {
                tracing::warn!(error = %error, "failed to load persisted application grants");
            }
        }
    }

    pub fn store(&self) -> &Arc<Store> {
        &self.store
    }

    pub fn version(&self) -> u64 {
        self.version.load(Ordering::SeqCst)
    }

    /// Built-in tool names owned by the base catalog. Application tool names
    /// must never shadow them.
    pub fn set_reserved_tool_names(&self, names: HashSet<String>) {
        *self.reserved_tool_names.write().unwrap() = names;
    }

    pub fn reserved_tool_names(&self) -> HashSet<String> {
        self.reserved_tool_names.read().unwrap().clone()
    }

    pub fn register(
        &self,
        mut record: ApplicationRecord,
        provider: Arc<dyn ApplicationCapabilityProvider>,
    ) -> Result<()> {
        normalize_record(&mut record);
        if let Err(errors) = validate_record(&record) {
            anyhow::bail!("manifest_invalid: {}", errors.join("; "));
        }
        record.manifest_hash = if record.manifest_hash.trim().is_empty() {
            manifest_hash(&record_as_manifest(&record))?
        } else {
            record.manifest_hash.clone()
        };

        if record.runtime_kind == RuntimeKind::ManagedProject {
            record.enabled = self
                .store
                .get_application(&record.app_id)
                .ok()
                .flatten()
                .is_some_and(|persisted| persisted.enabled);
        }
        apply_enabled_availability(&mut record);

        self.check_collisions(&record)?;
        self.store.upsert_application(&record)?;

        let mut state = self.state.write().unwrap();
        state.providers.insert(record.app_id.clone(), provider);
        state.apps.insert(record.app_id.clone(), record);
        drop(state);
        self.invalidate();
        Ok(())
    }

    pub fn register_from_manifest(
        &self,
        manifest: AppManifest,
        provider: Arc<dyn ApplicationCapabilityProvider>,
    ) -> Result<ApplicationRecord> {
        if let Err(errors) = validate_manifest(&manifest) {
            anyhow::bail!("manifest_invalid: {}", errors.join("; "));
        }
        let record = record_from_manifest(&manifest)?;
        let requirements = FeatureRequirements {
            required: manifest.app.required_features.clone(),
            excluded: manifest.app.excluded_features.clone(),
        };
        self.register(record.clone(), provider)?;
        self.state
            .write()
            .unwrap()
            .requirements
            .insert(record.app_id.clone(), requirements);
        Ok(record)
    }

    /// Rebuild the managed-project slice of the catalog. Applications that
    /// disappeared from disk are removed; manifests are untrusted.
    pub fn refresh_managed_projects(
        &self,
        manifests: Vec<(String, AppManifest, Arc<dyn ApplicationCapabilityProvider>)>,
    ) -> Result<()> {
        self.refresh_runtime(RuntimeKind::ManagedProject, manifests)
    }

    /// Rebuild the MCP application slice of the catalog.
    pub fn refresh_mcp(
        &self,
        manifests: Vec<(String, AppManifest, Arc<dyn ApplicationCapabilityProvider>)>,
    ) -> Result<()> {
        self.refresh_runtime(RuntimeKind::McpServer, manifests)
    }

    fn refresh_runtime(
        &self,
        runtime_kind: RuntimeKind,
        manifests: Vec<(String, AppManifest, Arc<dyn ApplicationCapabilityProvider>)>,
    ) -> Result<()> {
        let mut keep = HashSet::new();
        let mut first_error = None;
        for (app_id, manifest, provider) in manifests {
            keep.insert(app_id);
            if let Err(error) = self.register_from_manifest(manifest, provider) {
                first_error.get_or_insert(error);
            }
        }
        let stale = self
            .state
            .read()
            .unwrap()
            .apps
            .values()
            .filter(|app| app.runtime_kind == runtime_kind && !keep.contains(&app.app_id))
            .map(|app| app.app_id.clone())
            .collect::<Vec<_>>();
        for app_id in stale {
            let _ = self.store.delete_application(&app_id);
            let mut state = self.state.write().unwrap();
            state.apps.remove(&app_id);
            state.providers.remove(&app_id);
            state.requirements.remove(&app_id);
            drop(state);
            self.invalidate();
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    pub fn replace_provider(&self, app_id: &str, provider: Arc<dyn ApplicationCapabilityProvider>) {
        let mut state = self.state.write().unwrap();
        state.providers.insert(app_id.to_string(), provider);
        drop(state);
        self.invalidate();
    }

    pub fn set_enabled(&self, app_id: &str, enabled: bool) -> Result<()> {
        let persisted = self.store.set_application_enabled(app_id, enabled)?;
        if !persisted {
            anyhow::bail!("unknown application: {app_id}");
        }
        let mut state = self.state.write().unwrap();
        let app = state
            .apps
            .get_mut(app_id)
            .with_context(|| format!("unknown application: {app_id}"))?;
        app.enabled = enabled;
        apply_enabled_availability(app);
        drop(state);
        self.invalidate();
        Ok(())
    }

    pub fn list(&self) -> Vec<ApplicationRecord> {
        self.state.read().unwrap().apps.values().cloned().collect()
    }

    pub fn get(&self, app_id: &str) -> Option<ApplicationRecord> {
        self.state.read().unwrap().apps.get(app_id).cloned()
    }

    pub fn providers(&self) -> Vec<(String, Arc<dyn ApplicationCapabilityProvider>)> {
        self.state
            .read()
            .unwrap()
            .providers
            .iter()
            .map(|(id, provider)| (id.clone(), provider.clone()))
            .collect()
    }

    pub fn provider_for(&self, app_id: &str) -> Option<Arc<dyn ApplicationCapabilityProvider>> {
        self.state.read().unwrap().providers.get(app_id).cloned()
    }

    pub fn capabilities_for(&self, app_id: &str) -> Vec<CapabilityRecord> {
        self.state
            .read()
            .unwrap()
            .apps
            .get(app_id)
            .map(|app| app.capabilities.clone())
            .unwrap_or_default()
    }

    /// Whether an application is visible to this host after applying the
    /// manifest's platform and required/excluded feature declarations.
    pub fn app_visible(&self, app_id: &str, caps: &Capabilities) -> bool {
        let state = self.state.read().unwrap();
        let Some(app) = state.apps.get(app_id) else {
            return false;
        };
        if !platform_matches(app, caps) {
            return false;
        }
        let Some(requirements) = state.requirements.get(app_id) else {
            return true;
        };
        requirements
            .required
            .iter()
            .all(|feature| caps.features.iter().any(|value| value == feature))
            && requirements
                .excluded
                .iter()
                .all(|feature| !caps.features.iter().any(|value| value == feature))
    }

    pub fn find_capability(
        &self,
        tool_name: &str,
    ) -> Option<(
        ApplicationRecord,
        CapabilityRecord,
        Arc<dyn ApplicationCapabilityProvider>,
    )> {
        let state = self.state.read().unwrap();
        for app in state.apps.values() {
            if let Some(capability) = app
                .capabilities
                .iter()
                .find(|capability| capability.tool_name == tool_name)
            {
                let provider = state.providers.get(&app.app_id)?.clone();
                return Some((app.clone(), capability.clone(), provider));
            }
        }
        None
    }

    pub fn search(
        &self,
        params: &ApplicationSearchParams,
        caps: &Capabilities,
        policy: &dyn Fn(&str) -> bool,
    ) -> Vec<ApplicationCandidate> {
        let query = format!(
            "{} {}",
            params.query.to_lowercase(),
            params.task.as_deref().unwrap_or_default().to_lowercase()
        );
        let terms = query
            .split_whitespace()
            .filter(|term| !term.is_empty())
            .collect::<Vec<_>>();
        let limit = params.max_results.unwrap_or(5).clamp(1, 8);
        let state = self.state.read().unwrap();
        let mut scored = Vec::new();
        for app in state.apps.values() {
            if !app.enabled {
                continue;
            }
            if let Some(app_id) = params.app_id.as_deref() {
                if app.app_id != app_id {
                    continue;
                }
            }
            if let Some(source) = params.source.as_deref() {
                if !source_matches(app, source) {
                    continue;
                }
            }
            if !platform_matches(app, caps) {
                continue;
            }
            if let Some(requirements) = state.requirements.get(&app.app_id) {
                if !features_match(requirements, caps) {
                    continue;
                }
            }
            for capability in &app.capabilities {
                if capability.availability != CapabilityAvailability::Available {
                    continue;
                }
                if !policy(&capability.tool_name) {
                    continue;
                }
                let score = score_candidate(app, capability, &terms);
                if score == 0 && !terms.is_empty() {
                    continue;
                }
                scored.push((
                    score,
                    ApplicationCandidate {
                        tool_name: capability.tool_name.clone(),
                        app_id: app.app_id.clone(),
                        capability_id: capability.capability_id.clone(),
                        title: capability.title.clone(),
                        description: capability.description.clone(),
                        source: app.source_id.clone(),
                        input_hint: schema_hint(&capability.input_schema),
                        risk: capability.risk,
                        trust_level: app.trust_level,
                    },
                ));
            }
        }
        scored.sort_by(|left, right| {
            right
                .0
                .cmp(&left.0)
                .then_with(|| left.1.tool_name.cmp(&right.1.tool_name))
        });
        scored
            .into_iter()
            .take(limit)
            .map(|(_, item)| item)
            .collect()
    }

    pub fn save_grant(&self, mut grant: ApplicationGrant) -> Result<ApplicationGrant> {
        if !valid_id(&grant.app_id) {
            anyhow::bail!("manifest_invalid: invalid grant app id: {}", grant.app_id);
        }
        if grant
            .capability_pattern
            .chars()
            .any(|ch| ch.is_whitespace() || ch == '/')
        {
            anyhow::bail!(
                "manifest_invalid: invalid capability pattern: {}",
                grant.capability_pattern
            );
        }
        if grant.id.trim().is_empty() {
            grant.id = uuid::Uuid::new_v4().to_string();
        }
        if grant.created_at.trim().is_empty() {
            grant.created_at = chrono::Utc::now().to_rfc3339();
        }
        if grant.mode.trim().is_empty() {
            grant.mode = "ask".into();
        }
        if !matches!(grant.mode.as_str(), "allow" | "ask" | "deny") {
            anyhow::bail!("manifest_invalid: unknown grant mode: {}", grant.mode);
        }
        self.store.save_application_grant(&grant)?;
        let mut state = self.state.write().unwrap();
        state.grants.retain(|existing| existing.id != grant.id);
        state.grants.push(grant.clone());
        drop(state);
        self.invalidate();
        Ok(grant)
    }

    pub fn list_grants(&self, app_id: Option<&str>) -> Result<Vec<ApplicationGrant>> {
        match self.store.list_application_grants(app_id) {
            Ok(grants) => Ok(grants),
            Err(error) => {
                tracing::warn!(error = %error, "failed to read persisted application grants");
                Ok(self
                    .state
                    .read()
                    .unwrap()
                    .grants
                    .iter()
                    .filter(|grant| app_id.is_none_or(|id| grant.app_id == id))
                    .cloned()
                    .collect())
            }
        }
    }

    pub fn revoke_grant(&self, grant_id: &str) -> Result<bool> {
        let removed = self.store.revoke_application_grant(grant_id)?;
        let mut state = self.state.write().unwrap();
        state.grants.retain(|grant| grant.id != grant_id);
        drop(state);
        if removed {
            self.invalidate();
        }
        Ok(removed)
    }

    /// Audit writes are best-effort: a persistence failure must never fail the
    /// capability call that produced the record.
    pub fn record_call(&self, mut audit: ApplicationCallAudit) -> Result<()> {
        if audit.created_at.trim().is_empty() {
            audit.created_at = chrono::Utc::now().to_rfc3339();
        }
        if let Err(error) = self.store.add_application_call_audit(&audit) {
            tracing::warn!(error = %error, call_id = %audit.call_id, "failed to persist application audit");
        }
        let mut state = self.state.write().unwrap();
        state.audit.push(audit);
        if state.audit.len() > MAX_AUDIT_IN_MEMORY {
            let excess = state.audit.len() - MAX_AUDIT_IN_MEMORY;
            state.audit.drain(0..excess);
        }
        Ok(())
    }

    pub fn list_audit(
        &self,
        app_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<ApplicationCallAudit>> {
        match self.store.list_application_call_audit(app_id, limit.max(1)) {
            Ok(items) => Ok(items),
            Err(error) => {
                tracing::warn!(error = %error, "failed to read persisted application audit");
                let state = self.state.read().unwrap();
                let mut items = state
                    .audit
                    .iter()
                    .filter(|audit| app_id.is_none_or(|id| audit.app_id == id))
                    .cloned()
                    .collect::<Vec<_>>();
                items.reverse();
                items.truncate(limit.max(1));
                Ok(items)
            }
        }
    }

    pub fn invalidate(&self) {
        self.version.fetch_add(1, Ordering::SeqCst);
    }

    /// Static light apps have no operation API, but they still belong in the
    /// application directory as presentation-only entries.
    pub fn refresh_light_apps(&self) {
        let Ok(apps) = self.store.list_lightapps() else {
            return;
        };
        let mut state = self.state.write().unwrap();
        let mut changed = false;
        for app in apps {
            let app_id = format!("worldbase.lightapp.{}", app.id);
            if state.apps.contains_key(&app_id) {
                continue;
            }
            state.apps.insert(
                app_id.clone(),
                ApplicationRecord {
                    source_id: "lightapp".into(),
                    app_id,
                    name: app.name,
                    version: "1.0.0".into(),
                    description: "Presentation-only light app (no AI operations).".into(),
                    tags: vec!["lightapp".into()],
                    trust_level: TrustLevel::Builtin,
                    enabled: true,
                    platforms: vec!["desktop".into(), "mobile".into()],
                    runtime_kind: RuntimeKind::HostService,
                    capabilities: Vec::new(),
                    health: AppHealth::ready(),
                    last_seen_at: Some(app.created_at),
                    manifest_hash: String::new(),
                    ai_ready: false,
                },
            );
            changed = true;
        }
        if changed {
            self.version.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// Register the first-party applications from SPEC §8.4. Missing native
    /// tools are skipped with a warning; this must never panic during Hub
    /// construction.
    pub fn register_builtin_apps(
        &self,
        tools: &[Arc<dyn Tool>],
        host_provider: Arc<dyn ApplicationCapabilityProvider>,
    ) {
        let tools = tools
            .iter()
            .map(|tool| (tool.name().to_string(), tool.clone()))
            .collect::<BTreeMap<_, _>>();

        let native_apps = [
            (
                "worldbase.documents",
                "Documents",
                "Read, list and draft workspace documents.",
                vec![
                    (
                        "doc.list",
                        "list_documents",
                        "List documents",
                        CapabilityRisk::Read,
                        false,
                    ),
                    (
                        "doc.read",
                        "read_document",
                        "Read a document",
                        CapabilityRisk::Read,
                        false,
                    ),
                    (
                        "doc.draft",
                        "doc_draft",
                        "Draft a document",
                        CapabilityRisk::WriteReversible,
                        true,
                    ),
                ],
            ),
            (
                "worldbase.projects",
                "Projects",
                "Inspect managed projects and their status.",
                vec![
                    (
                        "project.list",
                        "project_list",
                        "List projects",
                        CapabilityRisk::Read,
                        false,
                    ),
                    (
                        "project.status",
                        "get_project_status",
                        "Get project status",
                        CapabilityRisk::Read,
                        false,
                    ),
                ],
            ),
            (
                "worldbase.data",
                "Project data",
                "Query managed project databases.",
                vec![(
                    "project.query",
                    "query_project_database",
                    "Query project database",
                    CapabilityRisk::Read,
                    false,
                )],
            ),
        ];

        for (app_id, name, description, capabilities) in native_apps {
            let mut available = Vec::new();
            let mut providers = BTreeMap::new();
            for (capability_id, tool_name, title, risk, side_effects) in capabilities {
                let Some(tool) = tools.get(tool_name).cloned() else {
                    tracing::warn!(
                        app_id,
                        tool_name,
                        "skipping builtin capability: native tool is not registered"
                    );
                    continue;
                };
                available.push(AppCapabilityManifest {
                    id: capability_id.into(),
                    title: title.into(),
                    description: format!("{title} via the Rust-native {tool_name} tool."),
                    input_schema: tool.input_schema(),
                    output_schema: tool.output_schema(),
                    operation: tool_name.into(),
                    risk,
                    permissions: vec![risk.default_permission().into()],
                    data_scopes: vec!["workspace".into()],
                    side_effects,
                    idempotent: !side_effects,
                    deadline_ms: None,
                });
                providers.insert(
                    tool_name.to_string(),
                    Arc::new(NativeToolCapabilityProvider::new(tool_name, tool))
                        as Arc<dyn ApplicationCapabilityProvider>,
                );
            }
            if available.is_empty() {
                tracing::warn!(app_id, "skipping builtin app: no native tools available");
                continue;
            }
            let manifest = builtin_manifest(
                app_id,
                name,
                description,
                RuntimeKind::HostService,
                &["desktop", "mobile", "cli"],
                available,
            );
            let provider: Arc<dyn ApplicationCapabilityProvider> =
                Arc::new(MultiToolProvider::new(app_id, providers));
            if let Err(error) = self.register_from_manifest(manifest, provider) {
                tracing::warn!(app_id, error = %error, "failed to register builtin app");
            }
        }

        let host_manifest = builtin_manifest(
            "worldbase.host",
            "Host",
            "Narrow desktop host capabilities.",
            RuntimeKind::ElectronHost,
            &["desktop"],
            vec![
                AppCapabilityManifest {
                    id: "host.pick_file".into(),
                    title: "Pick file".into(),
                    description: "Ask the user to pick a file.".into(),
                    input_schema: serde_json::json!({ "type": "object" }),
                    output_schema: None,
                    operation: "host.fs.pick_file".into(),
                    risk: CapabilityRisk::Read,
                    permissions: vec!["allow".into()],
                    data_scopes: vec!["selected_file".into()],
                    side_effects: false,
                    idempotent: true,
                    deadline_ms: None,
                },
                AppCapabilityManifest {
                    id: "host.open_external".into(),
                    title: "Open external".into(),
                    description: "Open a reviewed external URL or file.".into(),
                    input_schema: serde_json::json!({
                        "type": "object",
                        "properties": { "target": { "type": "string" } },
                        "required": ["target"]
                    }),
                    output_schema: None,
                    operation: "host.shell.open_external".into(),
                    risk: CapabilityRisk::ExternalEffect,
                    permissions: vec!["ask".into()],
                    data_scopes: vec!["selected_file".into()],
                    side_effects: true,
                    idempotent: false,
                    deadline_ms: None,
                },
                AppCapabilityManifest {
                    id: "host.notify".into(),
                    title: "Notify".into(),
                    description: "Show a desktop notification.".into(),
                    input_schema: serde_json::json!({
                        "type": "object",
                        "properties": { "message": { "type": "string" } },
                        "required": ["message"]
                    }),
                    output_schema: None,
                    operation: "host.notification.show".into(),
                    risk: CapabilityRisk::WriteReversible,
                    permissions: vec!["ask".into()],
                    data_scopes: vec![],
                    side_effects: true,
                    idempotent: false,
                    deadline_ms: None,
                },
            ],
        );
        if let Err(error) = self.register_from_manifest(host_manifest, host_provider) {
            tracing::warn!(app_id = "worldbase.host", error = %error, "failed to register builtin host app");
        }
    }

    fn check_collisions(&self, record: &ApplicationRecord) -> Result<()> {
        let reserved = self.reserved_tool_names.read().unwrap();
        let state = self.state.read().unwrap();
        let mut seen = HashSet::new();
        for capability in &record.capabilities {
            let tool_name = &capability.tool_name;
            if tool_name.starts_with("mcp__") {
                anyhow::bail!("capability tool name uses reserved mcp__ prefix: {tool_name}");
            }
            if reserved.contains(tool_name) {
                anyhow::bail!("capability tool name collides with a builtin tool: {tool_name}");
            }
            if !seen.insert(tool_name.clone()) {
                anyhow::bail!("duplicate capability tool name: {tool_name}");
            }
            for app in state
                .apps
                .values()
                .filter(|app| app.app_id != record.app_id)
            {
                if app
                    .capabilities
                    .iter()
                    .any(|other| other.tool_name == tool_name.as_str())
                {
                    anyhow::bail!("capability tool name collision: {tool_name}");
                }
            }
        }
        Ok(())
    }
}

fn builtin_manifest(
    app_id: &str,
    name: &str,
    description: &str,
    kind: RuntimeKind,
    platforms: &[&str],
    capabilities: Vec<AppCapabilityManifest>,
) -> AppManifest {
    AppManifest {
        schema_version: 1,
        app: AppManifestApp {
            id: app_id.into(),
            name: name.into(),
            version: env!("CARGO_PKG_VERSION").into(),
            description: description.into(),
            tags: vec!["builtin".into()],
            platforms: platforms.iter().map(|value| (*value).to_string()).collect(),
            required_features: Vec::new(),
            excluded_features: Vec::new(),
            trust_level: TrustLevel::Builtin,
            signature: None,
        },
        runtime: AppRuntimeManifest {
            kind,
            activation: "always".into(),
            health_check: None,
        },
        capabilities,
        ai_integration: None,
    }
}

struct MultiToolProvider {
    provider_ref: String,
    providers: BTreeMap<String, Arc<dyn ApplicationCapabilityProvider>>,
}

impl MultiToolProvider {
    fn new(
        provider_ref: &str,
        providers: BTreeMap<String, Arc<dyn ApplicationCapabilityProvider>>,
    ) -> Self {
        Self {
            provider_ref: provider_ref.into(),
            providers,
        }
    }

    fn select(
        &self,
        capability: &CapabilityRecord,
    ) -> Result<&Arc<dyn ApplicationCapabilityProvider>> {
        let operation = if capability.provider_ref.trim().is_empty() {
            capability.tool_name.as_str()
        } else {
            capability.provider_ref.as_str()
        };
        self.providers
            .get(operation)
            .with_context(|| format!("provider_unavailable: unknown operation {operation}"))
    }
}

#[async_trait::async_trait]
impl ApplicationCapabilityProvider for MultiToolProvider {
    fn provider_ref(&self) -> &str {
        &self.provider_ref
    }

    async fn health(&self, app: &ApplicationRecord) -> Result<AppHealth> {
        match self.providers.values().next() {
            Some(provider) => provider.health(app).await,
            None => Ok(AppHealth::unknown()),
        }
    }

    async fn ensure_ready(
        &self,
        app: &ApplicationRecord,
        ctx: &worldbase_protocol::types::CallContext,
    ) -> Result<worldbase_protocol::types::RuntimeLease> {
        let provider = self
            .providers
            .values()
            .next()
            .context("provider_unavailable: no native tools registered")?;
        provider.ensure_ready(app, ctx).await
    }

    async fn invoke(
        &self,
        capability: &CapabilityRecord,
        input: serde_json::Value,
        ctx: &worldbase_protocol::types::CallContext,
        services: &worldbase_tools::ToolServices,
    ) -> Result<worldbase_protocol::types::CapabilityResult> {
        self.select(capability)?
            .invoke(capability, input, ctx, services)
            .await
    }
}

fn normalize_record(record: &mut ApplicationRecord) {
    for capability in &mut record.capabilities {
        capability.app_id = record.app_id.clone();
        capability.tool_name = capability_tool_name(&record.app_id, &capability.capability_id);
        if capability.provider_ref.trim().is_empty() {
            capability.provider_ref = capability.capability_id.clone();
        }
    }
}

fn apply_enabled_availability(record: &mut ApplicationRecord) {
    for capability in &mut record.capabilities {
        capability.availability = if record.enabled {
            if capability.availability == CapabilityAvailability::Disabled {
                CapabilityAvailability::Available
            } else {
                capability.availability
            }
        } else {
            CapabilityAvailability::Disabled
        };
    }
}

fn validate_record(record: &ApplicationRecord) -> std::result::Result<(), Vec<String>> {
    let mut errors = Vec::new();
    if !valid_id(&record.app_id) {
        errors.push(format!("invalid app id: {}", record.app_id));
    }
    if record.name.trim().is_empty() {
        errors.push("app name is required".into());
    }
    if record.version.trim().is_empty() {
        errors.push("app version is required".into());
    }
    if record.capabilities.len() > MAX_CAPABILITIES {
        errors.push(format!(
            "too many capabilities: {} (max {MAX_CAPABILITIES})",
            record.capabilities.len()
        ));
    }
    if record.capabilities.is_empty() && record.ai_ready {
        errors.push("ai_ready application has no capabilities".into());
    }
    let mut capability_ids = HashSet::new();
    let mut tool_names = HashSet::new();
    for capability in &record.capabilities {
        if !valid_id(&capability.capability_id) {
            errors.push(format!(
                "invalid capability id: {}",
                capability.capability_id
            ));
        }
        if !capability_ids.insert(capability.capability_id.clone()) {
            errors.push(format!(
                "duplicate capability id: {}",
                capability.capability_id
            ));
        }
        if capability.tool_name.trim().is_empty() {
            errors.push(format!(
                "capability {} has no tool name",
                capability.capability_id
            ));
        }
        if !capability.tool_name.starts_with("app__") {
            errors.push(format!(
                "capability tool must use app__ namespace: {}",
                capability.tool_name
            ));
        }
        if !tool_names.insert(capability.tool_name.clone()) {
            errors.push(format!(
                "duplicate capability tool name: {}",
                capability.tool_name
            ));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

fn record_from_manifest(manifest: &AppManifest) -> Result<ApplicationRecord> {
    let hash = manifest_hash(manifest)?;
    let enabled = manifest.app.trust_level == TrustLevel::Builtin
        || manifest.runtime.kind == RuntimeKind::HostService;
    let capabilities = manifest
        .capabilities
        .iter()
        .map(|capability| CapabilityRecord {
            app_id: manifest.app.id.clone(),
            capability_id: capability.id.clone(),
            tool_name: capability_tool_name(&manifest.app.id, &capability.id),
            title: capability.title.clone(),
            description: capability.description.clone(),
            input_schema: capability.input_schema.clone(),
            output_schema: capability.output_schema.clone(),
            risk: capability.risk,
            permissions: capability.permissions.clone(),
            data_scopes: capability.data_scopes.clone(),
            provider_ref: capability.operation.clone(),
            availability: if enabled {
                CapabilityAvailability::Available
            } else {
                CapabilityAvailability::Disabled
            },
            side_effects: capability.side_effects,
            idempotent: capability.idempotent,
            deadline_ms: capability.deadline_ms,
        })
        .collect::<Vec<_>>();
    Ok(ApplicationRecord {
        source_id: if manifest.app.trust_level == TrustLevel::Builtin {
            "builtin".into()
        } else {
            format!("manifest:{}", manifest.app.id)
        },
        app_id: manifest.app.id.clone(),
        name: manifest.app.name.clone(),
        version: manifest.app.version.clone(),
        description: manifest.app.description.clone(),
        tags: manifest.app.tags.clone(),
        trust_level: manifest.app.trust_level,
        enabled,
        platforms: manifest.app.platforms.clone(),
        runtime_kind: manifest.runtime.kind,
        capabilities,
        health: AppHealth::unknown(),
        last_seen_at: Some(chrono::Utc::now().to_rfc3339()),
        manifest_hash: hash,
        ai_ready: manifest.ai_integration.as_deref() != Some("none"),
    })
}

fn record_as_manifest(record: &ApplicationRecord) -> AppManifest {
    AppManifest {
        schema_version: 1,
        app: AppManifestApp {
            id: record.app_id.clone(),
            name: record.name.clone(),
            version: if record.version.trim().is_empty() {
                "0.0.0".into()
            } else {
                record.version.clone()
            },
            description: record.description.clone(),
            tags: record.tags.clone(),
            platforms: record.platforms.clone(),
            required_features: Vec::new(),
            excluded_features: Vec::new(),
            trust_level: record.trust_level,
            signature: None,
        },
        runtime: AppRuntimeManifest {
            kind: record.runtime_kind,
            activation: "on-demand".into(),
            health_check: None,
        },
        capabilities: record
            .capabilities
            .iter()
            .map(|capability| AppCapabilityManifest {
                id: capability.capability_id.clone(),
                title: capability.title.clone(),
                description: capability.description.clone(),
                input_schema: capability.input_schema.clone(),
                output_schema: capability.output_schema.clone(),
                operation: capability.provider_ref.clone(),
                risk: capability.risk,
                permissions: capability.permissions.clone(),
                data_scopes: capability.data_scopes.clone(),
                side_effects: capability.side_effects,
                idempotent: capability.idempotent,
                deadline_ms: capability.deadline_ms,
            })
            .collect(),
        ai_integration: None,
    }
}

fn source_matches(app: &ApplicationRecord, source: &str) -> bool {
    if source.is_empty() {
        return true;
    }
    if source == "app" || source == app.source_id || source == app.app_id {
        return true;
    }
    if let Some(rest) = app.source_id.strip_prefix(source) {
        if rest.starts_with(':') || rest.starts_with('_') {
            return true;
        }
    }
    let runtime = match app.runtime_kind {
        RuntimeKind::HostService => "host_service",
        RuntimeKind::ManagedProject => "managed_project",
        RuntimeKind::McpServer => "mcp_server",
        RuntimeKind::ElectronHost => "electron_host",
        RuntimeKind::Plugin => "plugin",
    };
    source == runtime
}

fn platform_matches(app: &ApplicationRecord, caps: &Capabilities) -> bool {
    let host = normalize_platform(&caps.platform);
    if app.platforms.is_empty() {
        return app.runtime_kind != RuntimeKind::ElectronHost || host == "desktop";
    }
    app.platforms.iter().any(|platform| {
        let declared = normalize_platform(platform);
        declared == host || (host == "desktop" && declared == "electron")
    })
}

fn normalize_platform(platform: &str) -> &str {
    match platform {
        "electron" => "desktop",
        "mobile-ios" | "mobile-android" | "mobile" | "ios" | "android" => "mobile",
        "cli" => "cli",
        "server" => "server",
        _ => "desktop",
    }
}

fn features_match(requirements: &FeatureRequirements, caps: &Capabilities) -> bool {
    if requirements
        .required
        .iter()
        .any(|feature| !caps.has(feature) || caps.excluded(feature))
    {
        return false;
    }
    !requirements
        .excluded
        .iter()
        .any(|feature| caps.has(feature) && !caps.excluded(feature))
}

fn score_candidate(app: &ApplicationRecord, capability: &CapabilityRecord, terms: &[&str]) -> u32 {
    if terms.is_empty() {
        return 1;
    }
    let haystack = format!(
        "{} {} {} {} {}",
        app.app_id, app.name, capability.capability_id, capability.title, capability.description
    )
    .to_lowercase();
    let tags = app.tags.join(" ").to_lowercase();
    let mut score = 0u32;
    for term in terms {
        if capability.capability_id.to_lowercase() == *term
            || capability.tool_name.to_lowercase() == *term
        {
            score += 100;
        } else if capability.capability_id.to_lowercase().starts_with(term) {
            score += 40;
        } else if haystack.contains(term) {
            score += 10;
        }
        if tags.contains(term) {
            score += 6;
        }
    }
    score
}

fn schema_hint(schema: &serde_json::Value) -> Option<serde_json::Value> {
    let properties = schema.get("properties")?.as_object()?;
    let keys = properties.keys().cloned().collect::<Vec<_>>();
    (!keys.is_empty()).then(|| serde_json::json!(keys))
}

/// Risk metadata is stored on the capability; this helper keeps the mapping in
/// one place for policy checks.
pub fn capability_risk(record: &CapabilityRecord) -> CapabilityRisk {
    record.risk
}
