use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};
use worldbase_core::application::{
    ApplicationRegistry, CatalogEntry, RunToolCatalog, SkillCatalogEntry,
};
use worldbase_protocol::types::{
    AppHealth, ApplicationRecord, ApplicationSearchParams, CallContext, Capabilities,
    CapabilityAvailability, CapabilityRecord, CapabilityResult, CapabilityRisk, RuntimeKind,
    RuntimeLease, ToolVisibility, TrustLevel,
};
use worldbase_tools::{ApplicationCapabilityProvider, Tool, ToolCatalogRuntime};

struct TestDir(std::path::PathBuf);

impl TestDir {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("worldbase-catalog-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn db_path(&self) -> std::path::PathBuf {
        self.0.join("app.sqlite")
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn registry() -> (TestDir, Arc<ApplicationRegistry>) {
    let dir = TestDir::new();
    let store = Arc::new(worldbase_memory::Store::open(&dir.db_path()).unwrap());
    let registry = ApplicationRegistry::new(store);
    (dir, registry)
}

struct EchoProvider;

#[async_trait]
impl ApplicationCapabilityProvider for EchoProvider {
    fn provider_ref(&self) -> &str {
        "test.echo"
    }

    async fn health(&self, _app: &ApplicationRecord) -> anyhow::Result<AppHealth> {
        Ok(AppHealth::ready())
    }

    async fn ensure_ready(
        &self,
        app: &ApplicationRecord,
        _ctx: &CallContext,
    ) -> anyhow::Result<RuntimeLease> {
        Ok(RuntimeLease {
            lease_id: "lease".into(),
            app_id: app.app_id.clone(),
            expires_at_ms: 0,
            runtime_kind: RuntimeKind::HostService,
        })
    }

    async fn invoke(
        &self,
        _capability: &CapabilityRecord,
        input: Value,
        _ctx: &CallContext,
        _services: &worldbase_tools::ToolServices,
    ) -> anyhow::Result<CapabilityResult> {
        Ok(CapabilityResult::ok(input))
    }
}

fn app_record(
    app_id: &str,
    capability_id: &str,
    tool_name: &str,
    title: &str,
    tags: &[&str],
    platforms: &[&str],
) -> ApplicationRecord {
    ApplicationRecord {
        source_id: format!("test:{app_id}"),
        app_id: app_id.into(),
        name: title.into(),
        version: "1.0.0".into(),
        description: format!("{title} app"),
        tags: tags.iter().map(|tag| (*tag).to_string()).collect(),
        trust_level: TrustLevel::Builtin,
        enabled: true,
        platforms: platforms
            .iter()
            .map(|platform| (*platform).to_string())
            .collect(),
        runtime_kind: RuntimeKind::HostService,
        capabilities: vec![CapabilityRecord {
            app_id: app_id.into(),
            capability_id: capability_id.into(),
            tool_name: tool_name.into(),
            title: title.into(),
            description: format!("{title} capability"),
            input_schema: json!({ "type": "object" }),
            output_schema: None,
            risk: CapabilityRisk::Read,
            permissions: Vec::new(),
            data_scopes: Vec::new(),
            provider_ref: "test.echo".into(),
            availability: CapabilityAvailability::Available,
            side_effects: false,
            idempotent: true,
            deadline_ms: None,
        }],
        health: AppHealth::ready(),
        last_seen_at: None,
        manifest_hash: format!("hash-{app_id}"),
        ai_ready: true,
    }
}

struct StaticTool {
    name: String,
    description: String,
    visibility: ToolVisibility,
    source: Option<String>,
    tags: Vec<String>,
}

#[async_trait]
impl Tool for StaticTool {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> &str {
        &self.description
    }

    fn input_schema(&self) -> Value {
        json!({ "type": "object" })
    }

    fn visibility(&self) -> ToolVisibility {
        self.visibility
    }

    fn source(&self) -> Option<&str> {
        self.source.as_deref()
    }

    fn tags(&self) -> &[String] {
        &self.tags
    }

    async fn execute(
        &self,
        input: Value,
        _services: &worldbase_tools::ToolServices,
    ) -> anyhow::Result<Value> {
        Ok(input)
    }
}

fn base_entry(
    name: &str,
    visibility: ToolVisibility,
    source: Option<&str>,
    tags: &[&str],
    description: &str,
) -> CatalogEntry {
    let tool: Arc<dyn Tool> = Arc::new(StaticTool {
        name: name.into(),
        description: description.into(),
        visibility,
        source: source.map(str::to_string),
        tags: tags.iter().map(|tag| (*tag).to_string()).collect(),
    });
    CatalogEntry {
        descriptor: tool.descriptor(),
        tool,
        visibility,
    }
}

fn run_catalog(
    registry: Arc<ApplicationRegistry>,
    base: Vec<CatalogEntry>,
    skills: Vec<SkillCatalogEntry>,
    caps: Capabilities,
) -> Arc<RunToolCatalog> {
    RunToolCatalog::new(
        "stream-1".into(),
        "token-1".into(),
        registry,
        base,
        skills,
        caps,
    )
}

#[tokio::test]
async fn always_on_stays_and_discoverable_is_hidden_until_search() {
    let (_dir, registry) = registry();
    let base = vec![
        base_entry(
            "read_file",
            ToolVisibility::AlwaysOn,
            None,
            &[],
            "Read a file",
        ),
        base_entry(
            "mcp__docs_search",
            ToolVisibility::Discoverable,
            Some("mcp:docs"),
            &["documents"],
            "Search documents",
        ),
    ];
    let catalog = run_catalog(registry, base, Vec::new(), Capabilities::desktop());
    let snapshot = catalog.snapshot();
    assert_eq!(snapshot.version, 1);
    assert_eq!(snapshot.entries.len(), 1);
    assert_eq!(snapshot.entries[0].descriptor.name, "read_file");

    let result = catalog
        .search_and_activate(ApplicationSearchParams {
            query: "documents".into(),
            ..ApplicationSearchParams::default()
        })
        .await
        .unwrap();
    assert_eq!(result.activated, vec!["mcp__docs_search".to_string()]);
    assert!(result
        .candidates
        .iter()
        .any(|candidate| candidate.tool_name == "mcp__docs_search"));

    let snapshot = catalog.snapshot();
    assert_eq!(snapshot.version, 2);
    let names = snapshot
        .entries
        .iter()
        .map(|entry| entry.descriptor.name.as_str())
        .collect::<Vec<_>>();
    assert!(names.contains(&"read_file"));
    assert!(names.contains(&"mcp__docs_search"));
}

#[tokio::test]
async fn search_activates_app_capability_and_exposes_descriptor_metadata() {
    let (_dir, registry) = registry();
    let tool_name = "app__worldbase_documents__doc_read";
    registry
        .register(
            app_record(
                "worldbase.documents",
                "doc.read",
                tool_name,
                "Read document",
                &["documents"],
                &["desktop"],
            ),
            Arc::new(EchoProvider),
        )
        .unwrap();
    let catalog = run_catalog(registry, Vec::new(), Vec::new(), Capabilities::desktop());
    let result = catalog
        .search_and_activate(ApplicationSearchParams {
            query: "read document".into(),
            ..ApplicationSearchParams::default()
        })
        .await
        .unwrap();
    assert_eq!(result.activated, vec![tool_name.to_string()]);
    let candidate = result
        .candidates
        .iter()
        .find(|candidate| candidate.tool_name == tool_name)
        .unwrap();
    assert_eq!(candidate.app_id, "worldbase.documents");
    assert_eq!(candidate.capability_id, "doc.read");

    let snapshot = catalog.snapshot();
    let entry = snapshot
        .entries
        .iter()
        .find(|entry| entry.descriptor.name == tool_name)
        .unwrap();
    assert_eq!(
        entry.descriptor.app_id.as_deref(),
        Some("worldbase.documents")
    );
    assert_eq!(entry.descriptor.capability_id.as_deref(), Some("doc.read"));
    assert_eq!(
        entry.descriptor.source.as_deref(),
        Some("app:worldbase.documents")
    );
    assert_eq!(entry.descriptor.risk, Some(CapabilityRisk::Read));
}

#[tokio::test]
async fn activate_accepts_registry_capabilities() {
    let (_dir, registry) = registry();
    let tool_name = "app__worldbase_documents__doc_read";
    registry
        .register(
            app_record(
                "worldbase.documents",
                "doc.read",
                tool_name,
                "Read document",
                &["documents"],
                &["desktop"],
            ),
            Arc::new(EchoProvider),
        )
        .unwrap();
    let catalog = run_catalog(registry, Vec::new(), Vec::new(), Capabilities::desktop());
    let activated = catalog.activate(&[tool_name.to_string()]).unwrap();
    assert_eq!(activated, vec![tool_name.to_string()]);
    assert_eq!(catalog.catalog_version(), 2);
    assert_eq!(catalog.active_tool_names(), vec![tool_name.to_string()]);
}

#[tokio::test]
async fn activate_is_atomic_and_idempotent() {
    let (_dir, registry) = registry();
    let base = vec![
        base_entry(
            "tool_a",
            ToolVisibility::Discoverable,
            Some("mcp:bulk"),
            &["bulk"],
            "Bulk a",
        ),
        base_entry(
            "tool_b",
            ToolVisibility::Discoverable,
            Some("mcp:bulk"),
            &["bulk"],
            "Bulk b",
        ),
        base_entry(
            "tool_c",
            ToolVisibility::Discoverable,
            Some("mcp:bulk"),
            &["bulk"],
            "Bulk c",
        ),
    ];
    let catalog = run_catalog(registry, base, Vec::new(), Capabilities::desktop());
    let names = vec![
        "tool_a".to_string(),
        "tool_b".to_string(),
        "tool_c".to_string(),
    ];
    assert_eq!(catalog.activate(&names).unwrap(), names);
    assert_eq!(catalog.catalog_version(), 2);
    assert_eq!(catalog.activate(&names).unwrap(), names);
    assert_eq!(catalog.catalog_version(), 2);
    assert_eq!(catalog.snapshot().entries.len(), 3);
}

#[tokio::test]
async fn search_activates_skill_instructions() {
    let (_dir, registry) = registry();
    let skills = vec![SkillCatalogEntry {
        name: "pdf".into(),
        description: "Work with PDF documents".into(),
        tags: vec!["pdf".into(), "documents".into()],
        instructions: "Always use pdftotext.".into(),
        source: "skill:pdf".into(),
    }];
    let catalog = run_catalog(registry, Vec::new(), skills, Capabilities::desktop());
    let result = catalog
        .search_and_activate(ApplicationSearchParams {
            query: "pdf".into(),
            ..ApplicationSearchParams::default()
        })
        .await
        .unwrap();
    assert_eq!(result.skills_activated, vec!["pdf".to_string()]);
    assert!(result.activated.is_empty());
    assert_eq!(
        catalog.active_skill_instructions(),
        vec!["Always use pdftotext.".to_string()]
    );
    assert_eq!(
        catalog.snapshot().active_skill_instructions,
        vec!["Always use pdftotext.".to_string()]
    );
}

#[tokio::test]
async fn repeated_search_reuses_result_until_invalidated() {
    let (_dir, registry) = registry();
    let base = vec![base_entry(
        "mcp__docs_search",
        ToolVisibility::Discoverable,
        Some("mcp:docs"),
        &["documents"],
        "Search documents",
    )];
    let catalog = run_catalog(registry, base, Vec::new(), Capabilities::desktop());
    let request = ApplicationSearchParams {
        query: "documents".into(),
        ..ApplicationSearchParams::default()
    };
    let first = catalog.search_and_activate(request.clone()).await.unwrap();
    let second = catalog.search_and_activate(request.clone()).await.unwrap();
    assert_eq!(first.catalog_version, second.catalog_version);
    assert_eq!(first.activated, second.activated);
    assert_eq!(first.candidates.len(), second.candidates.len());

    catalog.invalidate();
    let third = catalog.search_and_activate(request).await.unwrap();
    assert!(third.catalog_version > second.catalog_version);
    assert_eq!(third.activated, vec!["mcp__docs_search".to_string()]);
}

#[tokio::test]
async fn registry_change_drops_active_app_entries_and_requires_research() {
    let (_dir, registry) = registry();
    let tool_name = "app__worldbase_documents__doc_read";
    registry
        .register(
            app_record(
                "worldbase.documents",
                "doc.read",
                tool_name,
                "Read document",
                &["documents"],
                &["desktop"],
            ),
            Arc::new(EchoProvider),
        )
        .unwrap();
    let catalog = run_catalog(
        registry.clone(),
        Vec::new(),
        Vec::new(),
        Capabilities::desktop(),
    );
    let request = ApplicationSearchParams {
        query: "read document".into(),
        ..ApplicationSearchParams::default()
    };
    let result = catalog.search_and_activate(request.clone()).await.unwrap();
    assert_eq!(result.activated, vec![tool_name.to_string()]);
    let version_before = catalog.catalog_version();

    registry.set_enabled("worldbase.documents", false).unwrap();
    assert!(catalog.refresh_from_registry());
    assert!(catalog.active_tool_names().is_empty());
    assert!(!catalog.refresh_from_registry());
    assert!(catalog.catalog_version() > version_before);
    assert!(catalog.snapshot().entries.is_empty());

    let result = catalog.search_and_activate(request).await.unwrap();
    assert!(result.activated.is_empty());
    assert!(result.candidates.is_empty());
}

#[tokio::test]
async fn base_names_win_collisions_and_duplicate_entries_are_deduped() {
    let (_dir, registry) = registry();
    let colliding = "app__collision__do_thing";
    registry
        .register(
            app_record(
                "collision",
                "do.thing",
                colliding,
                "Do thing",
                &["collision"],
                &["desktop"],
            ),
            Arc::new(EchoProvider),
        )
        .unwrap();
    let base = vec![
        base_entry(
            colliding,
            ToolVisibility::AlwaysOn,
            None,
            &["collision"],
            "Builtin collision",
        ),
        base_entry(
            "dup_tool",
            ToolVisibility::Discoverable,
            Some("mcp:dup"),
            &["dup"],
            "Duplicate",
        ),
        base_entry(
            "dup_tool",
            ToolVisibility::Discoverable,
            Some("mcp:dup"),
            &["dup"],
            "Duplicate",
        ),
    ];
    let catalog = run_catalog(registry, base, Vec::new(), Capabilities::desktop());

    let result = catalog
        .search_and_activate(ApplicationSearchParams {
            query: "collision".into(),
            ..ApplicationSearchParams::default()
        })
        .await
        .unwrap();
    assert!(result.candidates.is_empty());
    assert!(result.activated.is_empty());
    let snapshot = catalog.snapshot();
    assert_eq!(snapshot.entries.len(), 1);
    assert_eq!(snapshot.entries[0].descriptor.name, colliding);

    let result = catalog
        .search_and_activate(ApplicationSearchParams {
            query: "duplicate".into(),
            ..ApplicationSearchParams::default()
        })
        .await
        .unwrap();
    assert_eq!(result.candidates.len(), 1);
    assert_eq!(result.activated, vec!["dup_tool".to_string()]);
    let snapshot = catalog.snapshot();
    let count = snapshot
        .entries
        .iter()
        .filter(|entry| entry.descriptor.name == "dup_tool")
        .count();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn search_respects_default_and_hard_max_results() {
    let (_dir, registry) = registry();
    let base = (0..10)
        .map(|index| {
            base_entry(
                &format!("discoverable_{index}"),
                ToolVisibility::Discoverable,
                Some("mcp:bulk"),
                &["bulk"],
                "Bulk tool",
            )
        })
        .collect::<Vec<_>>();
    let catalog = run_catalog(
        registry.clone(),
        base.clone(),
        Vec::new(),
        Capabilities::desktop(),
    );
    let result = catalog
        .search_and_activate(ApplicationSearchParams {
            query: "bulk".into(),
            ..ApplicationSearchParams::default()
        })
        .await
        .unwrap();
    assert_eq!(result.candidates.len(), 5);
    assert_eq!(result.activated.len(), 5);

    let catalog = run_catalog(registry, base, Vec::new(), Capabilities::desktop());
    let result = catalog
        .search_and_activate(ApplicationSearchParams {
            query: "bulk".into(),
            max_results: Some(99),
            ..ApplicationSearchParams::default()
        })
        .await
        .unwrap();
    assert_eq!(result.candidates.len(), 8);
    assert_eq!(result.activated.len(), 8);
}

#[tokio::test]
async fn search_honors_platform_capabilities() {
    let (_dir, registry) = registry();
    let tool_name = "app__worldbase_mobile__mobile_read";
    registry
        .register(
            app_record(
                "worldbase.mobile",
                "mobile.read",
                tool_name,
                "Mobile read",
                &["mobile"],
                &["mobile"],
            ),
            Arc::new(EchoProvider),
        )
        .unwrap();
    let desktop = run_catalog(
        registry.clone(),
        Vec::new(),
        Vec::new(),
        Capabilities::desktop(),
    );
    let result = desktop
        .search_and_activate(ApplicationSearchParams {
            query: "mobile".into(),
            ..ApplicationSearchParams::default()
        })
        .await
        .unwrap();
    assert!(result.candidates.is_empty());
    assert!(result.activated.is_empty());

    let mobile = run_catalog(
        registry,
        Vec::new(),
        Vec::new(),
        Capabilities::mobile("mobile-ios"),
    );
    let result = mobile
        .search_and_activate(ApplicationSearchParams {
            query: "mobile".into(),
            ..ApplicationSearchParams::default()
        })
        .await
        .unwrap();
    assert_eq!(result.activated, vec![tool_name.to_string()]);
}
