//! Per-run tool catalog with atomic activation and versioning.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use async_trait::async_trait;
use serde_json::Value;
use worldbase_protocol::types::{
    ApplicationCandidate, ApplicationRecord, ApplicationSearchParams, ApplicationSearchResult,
    Capabilities, CapabilityAvailability, CapabilityRecord, CapabilityRisk, ToolDescriptor,
    ToolVisibility, TrustLevel,
};
use worldbase_tools::{ApplicationCapabilityProvider, CapabilityTool, Tool, ToolCatalogRuntime};

use super::registry::ApplicationRegistry;

const DEFAULT_MAX_RESULTS: usize = 5;
const MAX_RESULTS_LIMIT: usize = 8;
const MAX_CACHE_ENTRIES: usize = 256;

/// Routing guidance returned with every `search_tools` result. It tells the
/// main model that local app capabilities are directly callable and that the
/// runtime starts the owning application on demand.
pub const LOCAL_APP_GUIDANCE: &str = "These are local app capabilities. Invoking one starts its app runtime automatically if needed. Prefer them over web/browser/UI automation.";

#[derive(Clone)]
pub struct CatalogEntry {
    pub descriptor: ToolDescriptor,
    pub tool: Arc<dyn Tool>,
    pub visibility: ToolVisibility,
}

#[derive(Clone)]
pub struct SkillCatalogEntry {
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
    pub instructions: String,
    pub source: String,
}

struct RunCatalogState {
    version: u64,
    active: BTreeMap<String, CatalogEntry>,
    active_skills: BTreeMap<String, SkillCatalogEntry>,
}

pub struct RunCatalogSnapshot {
    pub version: u64,
    pub entries: Vec<CatalogEntry>,
    pub active_skill_instructions: Vec<String>,
}

enum SearchHit {
    App {
        candidate: ApplicationCandidate,
        score: u32,
    },
    Base {
        candidate: ApplicationCandidate,
        entry: CatalogEntry,
        score: u32,
    },
    Skill {
        candidate: ApplicationCandidate,
        skill: SkillCatalogEntry,
        score: u32,
    },
}

impl SearchHit {
    fn score(&self) -> u32 {
        match self {
            Self::App { score, .. } | Self::Base { score, .. } | Self::Skill { score, .. } => {
                *score
            }
        }
    }

    fn name(&self) -> &str {
        match self {
            Self::App { candidate, .. }
            | Self::Base { candidate, .. }
            | Self::Skill { candidate, .. } => &candidate.tool_name,
        }
    }

    /// Tie-break priority for equal lexical scores. Local app capabilities are
    /// preferred over base (builtin/MCP) tools and skills because invoking one
    /// also starts its app runtime on demand.
    fn source_priority(&self) -> u8 {
        match self {
            Self::App { .. } => 0,
            Self::Base { .. } => 1,
            Self::Skill { .. } => 2,
        }
    }

    fn candidate(&self) -> ApplicationCandidate {
        match self {
            Self::App { candidate, .. }
            | Self::Base { candidate, .. }
            | Self::Skill { candidate, .. } => candidate.clone(),
        }
    }
}

pub struct RunToolCatalog {
    stream_id: String,
    token: String,
    registry: Arc<ApplicationRegistry>,
    base: Vec<CatalogEntry>,
    skills: Vec<SkillCatalogEntry>,
    caps: Capabilities,
    state: RwLock<RunCatalogState>,
    registry_version: AtomicU64,
    cache: Mutex<HashMap<String, ApplicationSearchResult>>,
    /// Run-policy predicate. `new` defaults to allow-all for tests and
    /// standalone catalogs; the agent passes the policy-filtered base names.
    policy_allowed: Arc<dyn Fn(&str) -> bool + Send + Sync>,
}

impl RunToolCatalog {
    pub fn new(
        stream_id: String,
        token: String,
        registry: Arc<ApplicationRegistry>,
        base: Vec<CatalogEntry>,
        skills: Vec<SkillCatalogEntry>,
        caps: Capabilities,
    ) -> Arc<Self> {
        Self::new_with_policy(
            stream_id,
            token,
            registry,
            base,
            skills,
            caps,
            Arc::new(|_| true),
        )
    }

    pub fn new_with_policy(
        stream_id: String,
        token: String,
        registry: Arc<ApplicationRegistry>,
        base: Vec<CatalogEntry>,
        skills: Vec<SkillCatalogEntry>,
        caps: Capabilities,
        policy_allowed: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    ) -> Arc<Self> {
        let registry_version = registry.version();
        Arc::new(Self {
            stream_id,
            token,
            registry,
            base,
            skills,
            caps,
            state: RwLock::new(RunCatalogState {
                version: 1,
                active: BTreeMap::new(),
                active_skills: BTreeMap::new(),
            }),
            registry_version: AtomicU64::new(registry_version),
            cache: Mutex::new(HashMap::new()),
            policy_allowed,
        })
    }

    pub fn stream_id(&self) -> &str {
        &self.stream_id
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn snapshot(&self) -> RunCatalogSnapshot {
        let state = self.state.read().unwrap();
        let mut entries = Vec::new();
        let mut names = HashSet::new();
        for entry in &self.base {
            if entry.visibility == ToolVisibility::AlwaysOn
                && names.insert(entry.descriptor.name.clone())
            {
                entries.push(entry.clone());
            }
        }
        for entry in state.active.values() {
            if entry.visibility == ToolVisibility::Discoverable
                && names.insert(entry.descriptor.name.clone())
            {
                entries.push(entry.clone());
            }
        }
        RunCatalogSnapshot {
            version: state.version,
            entries,
            active_skill_instructions: state
                .active_skills
                .values()
                .map(|skill| skill.instructions.clone())
                .collect(),
        }
    }

    pub fn activate(&self, names: &[String]) -> anyhow::Result<Vec<String>> {
        let active_names = self
            .state
            .read()
            .unwrap()
            .active
            .keys()
            .cloned()
            .collect::<HashSet<_>>();
        let mut activated = Vec::new();
        let mut pending = Vec::new();
        let mut pending_names = HashSet::new();
        for name in names {
            if active_names.contains(name) || pending_names.contains(name) {
                activated.push(name.clone());
                continue;
            }
            let Some(entry) = self.resolve_entry(name) else {
                continue;
            };
            pending_names.insert(name.clone());
            pending.push(entry);
            activated.push(name.clone());
        }
        self.commit_activation(pending, Vec::new());
        Ok(activated)
    }

    pub fn catalog_version(&self) -> u64 {
        self.state.read().unwrap().version
    }

    pub fn active_tool_names(&self) -> Vec<String> {
        self.state.read().unwrap().active.keys().cloned().collect()
    }

    pub fn active_skill_instructions(&self) -> Vec<String> {
        self.state
            .read()
            .unwrap()
            .active_skills
            .values()
            .map(|skill| skill.instructions.clone())
            .collect()
    }

    pub fn refresh_from_registry(&self) -> bool {
        let current = self.registry.version();
        let previous = self.registry_version.swap(current, Ordering::SeqCst);
        if current == previous {
            return false;
        }
        {
            let mut state = self.state.write().unwrap();
            state.active.retain(|_, entry| !is_app_entry(entry));
            state.version = state.version.saturating_add(1);
        }
        self.cache.lock().unwrap().clear();
        true
    }

    fn resolve_entry(&self, name: &str) -> Option<CatalogEntry> {
        if let Some(entry) = self.base.iter().find(|entry| {
            entry.descriptor.name == name && entry.visibility == ToolVisibility::Discoverable
        }) {
            return Some(entry.clone());
        }
        self.app_entry(name)
    }

    fn app_entry(&self, name: &str) -> Option<CatalogEntry> {
        if !(self.policy_allowed)(name) {
            return None;
        }
        let (app, capability, provider) = self.registry.find_capability(name)?;
        if !app.enabled || capability.availability != CapabilityAvailability::Available {
            return None;
        }
        if !platform_matches(&app, &self.caps) {
            return None;
        }
        Some(build_app_entry(app, capability, provider))
    }

    fn commit_activation(
        &self,
        entries: Vec<CatalogEntry>,
        skills: Vec<SkillCatalogEntry>,
    ) -> bool {
        let mut changed = false;
        {
            let mut state = self.state.write().unwrap();
            for entry in entries {
                let name = entry.descriptor.name.clone();
                if state.active.contains_key(&name) {
                    continue;
                }
                state.active.insert(name, entry);
                changed = true;
            }
            for skill in skills {
                if state.active_skills.contains_key(&skill.name) {
                    continue;
                }
                let name = skill.name.clone();
                state.active_skills.insert(name, skill);
                changed = true;
            }
            if changed {
                state.version = state.version.saturating_add(1);
            }
        }
        if changed {
            self.cache.lock().unwrap().clear();
        }
        changed
    }

    fn collect_hits(&self, request: &ApplicationSearchParams, terms: &[&str]) -> Vec<SearchHit> {
        if terms.is_empty() {
            return Vec::new();
        }
        let mut hits = Vec::new();
        let mut seen = HashSet::new();

        let policy = |name: &str| (self.policy_allowed)(name);
        for candidate in self.registry.search(request, &self.caps, &policy) {
            // Base entries are handled by the lexical base search below; only
            // registry-only capabilities need this path.
            if self
                .base
                .iter()
                .any(|entry| entry.descriptor.name == candidate.tool_name)
            {
                continue;
            }
            let tags = self
                .registry
                .get(&candidate.app_id)
                .map(|app| app.tags)
                .unwrap_or_default();
            let score = score_app_candidate(&candidate, &tags, terms);
            if score == 0 || !seen.insert(candidate.tool_name.clone()) {
                continue;
            }
            hits.push(SearchHit::App { candidate, score });
        }

        for entry in &self.base {
            if entry.visibility != ToolVisibility::Discoverable {
                continue;
            }
            if !base_app_matches(request.app_id.as_deref(), &entry.descriptor) {
                continue;
            }
            if !base_source_matches(request.source.as_deref(), &entry.descriptor) {
                continue;
            }
            let aliases = [
                entry.descriptor.source.as_deref().unwrap_or_default(),
                entry.descriptor.app_id.as_deref().unwrap_or_default(),
            ];
            let score = lexical_score(
                terms,
                &entry.descriptor.name,
                &aliases,
                &entry.descriptor.description,
                &entry.descriptor.tags,
            );
            if score == 0 || !seen.insert(entry.descriptor.name.clone()) {
                continue;
            }
            hits.push(SearchHit::Base {
                candidate: candidate_from_descriptor(&entry.descriptor),
                entry: entry.clone(),
                score,
            });
        }

        if request.app_id.is_none() {
            for skill in &self.skills {
                if !skill_source_matches(request.source.as_deref(), skill) {
                    continue;
                }
                if self
                    .base
                    .iter()
                    .any(|entry| entry.descriptor.name == skill.name)
                    || self.registry.find_capability(&skill.name).is_some()
                {
                    continue;
                }
                let aliases = [skill.source.as_str()];
                let score = lexical_score(
                    terms,
                    &skill.name,
                    &aliases,
                    &skill.description,
                    &skill.tags,
                );
                if score == 0 || !seen.insert(skill.name.clone()) {
                    continue;
                }
                hits.push(SearchHit::Skill {
                    candidate: candidate_from_skill(skill),
                    skill: skill.clone(),
                    score,
                });
            }
        }

        hits.sort_by(|left, right| {
            right
                .score()
                .cmp(&left.score())
                .then_with(|| left.source_priority().cmp(&right.source_priority()))
                .then_with(|| left.name().cmp(right.name()))
        });
        hits
    }
}

#[async_trait]
impl ToolCatalogRuntime for RunToolCatalog {
    async fn search_and_activate(
        &self,
        request: ApplicationSearchParams,
    ) -> anyhow::Result<ApplicationSearchResult> {
        self.refresh_from_registry();
        let normalized = normalize_query(&request);
        let limit = request
            .max_results
            .unwrap_or(DEFAULT_MAX_RESULTS)
            .clamp(1, MAX_RESULTS_LIMIT);
        let lookup_key = cache_key(self.catalog_version(), &normalized, &request, limit);
        if let Some(cached) = self.cache.lock().unwrap().get(&lookup_key).cloned() {
            return Ok(cached);
        }

        let terms = normalized.split_whitespace().collect::<Vec<_>>();
        let hits = self.collect_hits(&request, &terms);

        let mut candidates = Vec::new();
        let mut activated = Vec::new();
        let mut skills_activated = Vec::new();
        let mut entries = Vec::new();
        let mut skills = Vec::new();
        for hit in hits.into_iter().take(limit) {
            let name = hit.name().to_string();
            candidates.push(hit.candidate());
            match hit {
                SearchHit::App { candidate, .. } => {
                    if let Some(entry) = self.app_entry(&candidate.tool_name) {
                        activated.push(name);
                        entries.push(entry);
                    }
                }
                SearchHit::Base { entry, .. } => {
                    activated.push(name);
                    entries.push(entry);
                }
                SearchHit::Skill { skill, .. } => {
                    skills_activated.push(name);
                    skills.push(skill);
                }
            }
        }
        self.commit_activation(entries, skills);
        let catalog_version = self.catalog_version();
        let result = ApplicationSearchResult {
            candidates,
            activated,
            skills_activated,
            catalog_version,
            guidance: LOCAL_APP_GUIDANCE.to_string(),
        };
        if result.activated.len() + result.skills_activated.len() == result.candidates.len() {
            let key = cache_key(catalog_version, &normalized, &request, limit);
            let mut cache = self.cache.lock().unwrap();
            if cache.len() >= MAX_CACHE_ENTRIES {
                cache.clear();
            }
            cache.insert(key, result.clone());
        }
        Ok(result)
    }

    fn catalog_version(&self) -> u64 {
        self.state.read().unwrap().version
    }

    fn active_tool_names(&self) -> Vec<String> {
        self.state.read().unwrap().active.keys().cloned().collect()
    }

    fn active_skill_instructions(&self) -> Vec<String> {
        self.state
            .read()
            .unwrap()
            .active_skills
            .values()
            .map(|skill| skill.instructions.clone())
            .collect()
    }

    fn invalidate(&self) {
        {
            let mut state = self.state.write().unwrap();
            state.version = state.version.saturating_add(1);
            state.active.clear();
            state.active_skills.clear();
        }
        self.cache.lock().unwrap().clear();
    }
}

fn build_app_entry(
    app: ApplicationRecord,
    capability: CapabilityRecord,
    provider: Arc<dyn ApplicationCapabilityProvider>,
) -> CatalogEntry {
    let tool: Arc<dyn Tool> = Arc::new(CapabilityTool::new(
        provider,
        app.clone(),
        capability.clone(),
    ));
    let mut descriptor = tool.descriptor();
    descriptor.app_id = Some(app.app_id.clone());
    descriptor.capability_id = Some(capability.capability_id.clone());
    descriptor.source = Some(format!("app:{}", app.app_id));
    descriptor.risk = Some(capability.risk);
    descriptor.manifest_hash = Some(app.manifest_hash);
    descriptor.visibility = ToolVisibility::Discoverable;
    CatalogEntry {
        descriptor,
        tool,
        visibility: ToolVisibility::Discoverable,
    }
}

fn is_app_entry(entry: &CatalogEntry) -> bool {
    entry.descriptor.app_id.is_some()
        || entry
            .descriptor
            .source
            .as_deref()
            .is_some_and(|source| source.starts_with("app:"))
}

fn platform_matches(app: &ApplicationRecord, caps: &Capabilities) -> bool {
    if app.platforms.is_empty() {
        return true;
    }
    let platform = if caps.platform.starts_with("mobile") {
        "mobile"
    } else if caps.platform == "cli" {
        "cli"
    } else if caps.platform == "server" {
        "server"
    } else {
        "desktop"
    };
    app.platforms.iter().any(|value| value == platform)
}

fn normalize_query(request: &ApplicationSearchParams) -> String {
    [
        request.query.as_str(),
        request.task.as_deref().unwrap_or_default(),
    ]
    .join(" ")
    .split_whitespace()
    .map(str::to_lowercase)
    .collect::<Vec<_>>()
    .join(" ")
}

fn cache_key(
    version: u64,
    normalized_query: &str,
    request: &ApplicationSearchParams,
    limit: usize,
) -> String {
    format!(
        "{}|{}|{}|{}|{}",
        version,
        normalized_query,
        request.app_id.as_deref().unwrap_or_default(),
        request.source.as_deref().unwrap_or_default(),
        limit
    )
}

fn base_app_matches(app_id: Option<&str>, descriptor: &ToolDescriptor) -> bool {
    app_id.is_none_or(|app_id| descriptor.app_id.as_deref() == Some(app_id))
}

fn base_source_matches(filter: Option<&str>, descriptor: &ToolDescriptor) -> bool {
    let Some(filter) = filter else {
        return true;
    };
    let Some(source) = descriptor.source.as_deref() else {
        return filter == "builtin";
    };
    match filter {
        "builtin" => source == "builtin" || source.starts_with("builtin:"),
        "mcp" => source == "mcp" || source.starts_with("mcp:"),
        "app" => source == "app" || source.starts_with("app:"),
        "skill" => source == "skill" || source.starts_with("skill:"),
        _ => {
            source == filter
                || source
                    .strip_prefix(filter)
                    .is_some_and(|rest| rest.starts_with(':'))
        }
    }
}

fn skill_source_matches(filter: Option<&str>, skill: &SkillCatalogEntry) -> bool {
    let Some(filter) = filter else {
        return true;
    };
    match filter {
        "skill" => true,
        "app" | "mcp" | "builtin" => false,
        _ => {
            skill.source == filter
                || skill
                    .source
                    .strip_prefix(filter)
                    .is_some_and(|rest| rest.starts_with(':'))
                || filter
                    .strip_prefix("skill:")
                    .is_some_and(|name| name == skill.name)
        }
    }
}

fn score_app_candidate(candidate: &ApplicationCandidate, tags: &[String], terms: &[&str]) -> u32 {
    let aliases = [
        candidate.title.as_str(),
        candidate.app_id.as_str(),
        candidate.capability_id.as_str(),
        candidate.source.as_str(),
    ];
    lexical_score(
        terms,
        &candidate.tool_name,
        &aliases,
        &candidate.description,
        tags,
    )
}

fn lexical_score(
    terms: &[&str],
    name: &str,
    aliases: &[&str],
    description: &str,
    tags: &[String],
) -> u32 {
    let name = name.to_lowercase();
    let description = description.to_lowercase();
    let alias_set = aliases
        .iter()
        .flat_map(|alias| tokenize_aliases(alias))
        .collect::<HashSet<_>>();
    let tags = tags
        .iter()
        .map(|tag| tag.to_lowercase())
        .collect::<Vec<_>>();
    let mut score = 0u32;
    for term in terms {
        let term = *term;
        if name == term {
            score += 100;
        } else if name.starts_with(term) {
            score += 50;
        } else if name.contains(term) {
            score += 30;
        }
        if alias_set.contains(term) {
            score += 40;
        } else if alias_set.iter().any(|token| token.starts_with(term)) {
            score += 15;
        }
        if tags.iter().any(|tag| tag.as_str() == term) {
            score += 25;
        } else if tags.iter().any(|tag| tag.contains(term)) {
            score += 12;
        }
        if description.contains(term) {
            score += 8;
        }
    }
    score
}

fn tokenize_aliases(value: &str) -> Vec<String> {
    value
        .split(|character: char| !character.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(str::to_lowercase)
        .collect()
}

fn candidate_from_descriptor(descriptor: &ToolDescriptor) -> ApplicationCandidate {
    ApplicationCandidate {
        tool_name: descriptor.name.clone(),
        app_id: descriptor.app_id.clone().unwrap_or_default(),
        // Base-catalog entries are not owned by an application manifest.
        app_name: String::new(),
        capability_id: descriptor.capability_id.clone().unwrap_or_default(),
        title: descriptor.name.clone(),
        description: descriptor.description.clone(),
        source: descriptor
            .source
            .clone()
            .unwrap_or_else(|| "builtin".into()),
        input_hint: schema_hint(&descriptor.input_schema),
        risk: descriptor.risk.unwrap_or_default(),
        trust_level: TrustLevel::Builtin,
    }
}

fn candidate_from_skill(skill: &SkillCatalogEntry) -> ApplicationCandidate {
    ApplicationCandidate {
        tool_name: skill.name.clone(),
        app_id: String::new(),
        app_name: String::new(),
        capability_id: String::new(),
        title: skill.name.clone(),
        description: skill.description.clone(),
        source: if skill.source.trim().is_empty() {
            format!("skill:{}", skill.name)
        } else {
            skill.source.clone()
        },
        input_hint: None,
        risk: CapabilityRisk::Read,
        trust_level: TrustLevel::Builtin,
    }
}

fn schema_hint(schema: &Value) -> Option<Value> {
    let properties = schema.get("properties")?.as_object()?;
    let keys = properties.keys().cloned().collect::<Vec<_>>();
    (!keys.is_empty()).then(|| serde_json::json!(keys))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct EchoTool;

    #[async_trait]
    impl Tool for EchoTool {
        fn name(&self) -> &str {
            "echo"
        }

        fn description(&self) -> &str {
            "Echo input"
        }

        fn input_schema(&self) -> Value {
            json!({ "type": "object" })
        }

        fn visibility(&self) -> ToolVisibility {
            ToolVisibility::Discoverable
        }

        async fn execute(
            &self,
            input: Value,
            _services: &worldbase_tools::ToolServices,
        ) -> anyhow::Result<Value> {
            Ok(input)
        }
    }

    #[tokio::test]
    async fn application_catalog_cache_is_versioned_and_cleared() {
        let dir =
            std::env::temp_dir().join(format!("worldbase-catalog-unit-{}", uuid::Uuid::new_v4()));
        let store = Arc::new(worldbase_memory::Store::open(&dir.join("app.sqlite")).unwrap());
        let registry = ApplicationRegistry::new(store);
        let tool: Arc<dyn Tool> = Arc::new(EchoTool);
        let entry = CatalogEntry {
            descriptor: tool.descriptor(),
            tool,
            visibility: ToolVisibility::Discoverable,
        };
        let catalog = RunToolCatalog::new(
            "stream".into(),
            "token".into(),
            registry,
            vec![entry],
            Vec::new(),
            Capabilities::desktop(),
        );
        let request = ApplicationSearchParams {
            query: "echo".into(),
            ..ApplicationSearchParams::default()
        };
        let first = catalog.search_and_activate(request.clone()).await.unwrap();
        assert_eq!(catalog.cache.lock().unwrap().len(), 1);
        assert!(first.candidates[0].app_name.is_empty());
        assert_eq!(first.guidance, LOCAL_APP_GUIDANCE);
        let second = catalog.search_and_activate(request.clone()).await.unwrap();
        assert_eq!(first.catalog_version, second.catalog_version);
        assert_eq!(catalog.cache.lock().unwrap().len(), 1);
        catalog.invalidate();
        assert!(catalog.cache.lock().unwrap().is_empty());
        let third = catalog.search_and_activate(request).await.unwrap();
        assert!(third.catalog_version > second.catalog_version);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn app_candidates_carry_registry_app_name_and_guidance() {
        let dir = std::env::temp_dir().join(format!(
            "worldbase-catalog-app-name-{}",
            uuid::Uuid::new_v4()
        ));
        let store = Arc::new(worldbase_memory::Store::open(&dir.join("app.sqlite")).unwrap());
        let registry = ApplicationRegistry::new(store);
        let manifest: worldbase_protocol::types::AppManifest = serde_json::from_value(json!({
            "schemaVersion": 1,
            "app": {
                "id": "worldbase.echoes",
                "name": "Echo Suite",
                "version": "1.0.0",
                "description": "Echo capabilities",
                "tags": ["echo"],
                "platforms": ["desktop"],
                "trustLevel": "builtin"
            },
            "runtime": { "kind": "host_service", "activation": "always" },
            "capabilities": [{
                "id": "echo.run",
                "title": "Echo",
                "description": "Echoes input",
                "operation": "echo"
            }]
        }))
        .unwrap();
        let tool: Arc<dyn Tool> = Arc::new(EchoTool);
        registry
            .register_from_manifest(
                manifest,
                Arc::new(worldbase_tools::NativeToolCapabilityProvider::new(
                    "worldbase.echoes",
                    tool,
                )),
            )
            .expect("register app");
        let catalog = RunToolCatalog::new(
            "stream".into(),
            "token".into(),
            registry,
            Vec::new(),
            Vec::new(),
            Capabilities::desktop(),
        );
        let result = catalog
            .search_and_activate(ApplicationSearchParams {
                query: "echo".into(),
                ..ApplicationSearchParams::default()
            })
            .await
            .unwrap();
        assert_eq!(result.candidates.len(), 1);
        assert_eq!(result.candidates[0].app_name, "Echo Suite");
        assert_eq!(result.guidance, LOCAL_APP_GUIDANCE);
        assert_eq!(
            result.activated,
            vec![result.candidates[0].tool_name.clone()]
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
