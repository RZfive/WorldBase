//! Application capability platform persistence tests.

use worldbase_memory::Store;
use worldbase_protocol::types::{
    AppHealth, ApplicationCallAudit, ApplicationGrant, ApplicationRecord, CapabilityAvailability,
    CapabilityRecord, CapabilityRisk, RuntimeKind, TrustLevel,
};

fn temp_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "worldbase-application-store-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn open_store() -> Store {
    let dir = temp_dir();
    Store::open(&dir.join("app.sqlite")).unwrap()
}

fn capability(app_id: &str, capability_id: &str) -> CapabilityRecord {
    CapabilityRecord {
        app_id: app_id.into(),
        capability_id: capability_id.into(),
        tool_name: format!("app__{app_id}__{capability_id}"),
        title: format!("Capability {capability_id}"),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": { "query": { "type": "string" } }
        }),
        risk: CapabilityRisk::WriteReversible,
        permissions: vec!["ask".into()],
        data_scopes: vec!["project".into()],
        provider_ref: "managed-project".into(),
        availability: CapabilityAvailability::Available,
        ..Default::default()
    }
}

fn application(app_id: &str, enabled: bool) -> ApplicationRecord {
    ApplicationRecord {
        source_id: "local".into(),
        app_id: app_id.into(),
        name: format!("App {app_id}"),
        version: "1.0.0".into(),
        description: "demo application".into(),
        tags: vec!["demo".into()],
        trust_level: TrustLevel::Community,
        enabled,
        platforms: vec!["desktop".into()],
        runtime_kind: RuntimeKind::ManagedProject,
        capabilities: vec![
            capability(app_id, "invoice.list"),
            capability(app_id, "invoice.read"),
        ],
        health: AppHealth {
            status: "ready".into(),
            detail: None,
            checked_at: Some("2026-01-01T00:00:00Z".into()),
        },
        last_seen_at: Some("2026-01-01T00:00:00Z".into()),
        manifest_hash: "manifest-hash".into(),
        ai_ready: true,
    }
}

fn grant(id: &str, app_id: &str, pattern: &str, created_at: &str) -> ApplicationGrant {
    ApplicationGrant {
        id: id.into(),
        app_id: app_id.into(),
        capability_pattern: pattern.into(),
        permissions: vec!["allow".into()],
        data_scope: vec!["project".into()],
        mode: "allow".into(),
        expires_at: Some("2027-01-01T00:00:00Z".into()),
        created_at: created_at.into(),
    }
}

fn audit(call_id: &str, app_id: &str, created_at: &str) -> ApplicationCallAudit {
    ApplicationCallAudit {
        call_id: call_id.into(),
        conversation_id: Some("conv-1".into()),
        app_id: app_id.into(),
        capability_id: "invoice.list".into(),
        status: "ok".into(),
        duration_ms: 42,
        approval_id: Some("approval-1".into()),
        created_at: created_at.into(),
    }
}

#[test]
fn application_round_trip_and_capability_replacement() {
    let store = open_store();
    assert!(store.list_applications().unwrap().is_empty());

    let record = application("invoice-app", true);
    store.upsert_application(&record).unwrap();

    let loaded = store.get_application("invoice-app").unwrap().unwrap();
    assert_eq!(loaded.app_id, "invoice-app");
    assert_eq!(loaded.source_id, "local");
    assert_eq!(loaded.name, "App invoice-app");
    assert_eq!(loaded.trust_level, TrustLevel::Community);
    assert_eq!(loaded.runtime_kind, RuntimeKind::ManagedProject);
    assert!(loaded.enabled);
    assert_eq!(loaded.capabilities.len(), 2);
    assert!(loaded
        .capabilities
        .iter()
        .any(|capability| capability.capability_id == "invoice.list"));

    let listed = store.list_applications().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].app_id, "invoice-app");

    store
        .replace_application_capabilities(
            "invoice-app",
            &[capability("invoice-app", "invoice.export")],
        )
        .unwrap();
    let loaded = store.get_application("invoice-app").unwrap().unwrap();
    assert_eq!(loaded.capabilities.len(), 1);
    assert_eq!(loaded.capabilities[0].capability_id, "invoice.export");

    store.upsert_application(&record).unwrap();
    assert_eq!(
        store
            .get_application("invoice-app")
            .unwrap()
            .unwrap()
            .capabilities
            .len(),
        2
    );

    assert!(store.get_application("missing").unwrap().is_none());
}

#[test]
fn enable_disable_and_delete_application() {
    let store = open_store();
    store
        .upsert_application(&application("invoice-app", true))
        .unwrap();

    assert!(store.set_application_enabled("invoice-app", false).unwrap());
    let loaded = store.get_application("invoice-app").unwrap().unwrap();
    assert!(!loaded.enabled);

    assert!(store.set_application_enabled("invoice-app", true).unwrap());
    assert!(
        store
            .get_application("invoice-app")
            .unwrap()
            .unwrap()
            .enabled
    );

    assert!(!store.set_application_enabled("missing", true).unwrap());

    store
        .save_application_grant(&grant(
            "grant-1",
            "invoice-app",
            "*",
            "2026-01-01T00:00:00Z",
        ))
        .unwrap();
    assert!(store.delete_application("invoice-app").unwrap());
    assert!(store.get_application("invoice-app").unwrap().is_none());
    assert!(store.list_applications().unwrap().is_empty());
    assert!(store
        .list_application_grants(Some("invoice-app"))
        .unwrap()
        .is_empty());
    assert!(!store.delete_application("invoice-app").unwrap());
}

trait RecordEnabledForTest {
    fn record_enabled_for_test(&self) -> bool;
}

impl RecordEnabledForTest for ApplicationRecord {
    fn record_enabled_for_test(&self) -> bool {
        self.enabled
    }
}

#[test]
fn grant_round_trip_filter_and_revoke() {
    let store = open_store();
    store
        .save_application_grant(&grant(
            "grant-1",
            "app-a",
            "invoice.*",
            "2026-01-01T00:00:00Z",
        ))
        .unwrap();
    store
        .save_application_grant(&grant("grant-2", "app-b", "*", "2026-01-02T00:00:00Z"))
        .unwrap();

    let all = store.list_application_grants(None).unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].id, "grant-2");

    let filtered = store.list_application_grants(Some("app-a")).unwrap();
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].id, "grant-1");
    assert_eq!(filtered[0].capability_pattern, "invoice.*");
    assert_eq!(filtered[0].permissions, vec!["allow".to_string()]);
    assert_eq!(filtered[0].data_scope, vec!["project".to_string()]);
    assert_eq!(
        filtered[0].expires_at.as_deref(),
        Some("2027-01-01T00:00:00Z")
    );

    let mut updated = grant("grant-1", "app-a", "*", "2026-01-03T00:00:00Z");
    updated.mode = "deny".into();
    updated.permissions = vec!["deny".into()];
    store.save_application_grant(&updated).unwrap();
    let filtered = store.list_application_grants(Some("app-a")).unwrap();
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].mode, "deny");
    assert_eq!(filtered[0].permissions, vec!["deny".to_string()]);

    let generated = ApplicationGrant {
        id: String::new(),
        ..grant("", "app-a", "*", "")
    };
    store.save_application_grant(&generated).unwrap();
    let filtered = store.list_application_grants(Some("app-a")).unwrap();
    assert_eq!(filtered.len(), 2);
    assert!(filtered.iter().all(|grant| !grant.id.is_empty()));
    assert!(filtered.iter().all(|grant| !grant.created_at.is_empty()));

    assert!(store.revoke_application_grant("grant-1").unwrap());
    assert!(!store.revoke_application_grant("grant-1").unwrap());
    assert_eq!(
        store.list_application_grants(Some("app-a")).unwrap().len(),
        1
    );
}

#[test]
fn call_audit_limit_and_filter() {
    let store = open_store();
    for index in 0..5 {
        let app_id = if index == 4 { "app-b" } else { "app-a" };
        store
            .add_application_call_audit(&audit(
                &format!("call-{index}"),
                app_id,
                &format!("2026-01-0{}T00:00:00Z", index + 1),
            ))
            .unwrap();
    }

    let all = store.list_application_call_audit(None, 10).unwrap();
    assert_eq!(all.len(), 5);
    assert_eq!(all[0].call_id, "call-4");
    assert_eq!(all[4].call_id, "call-0");

    let limited = store.list_application_call_audit(Some("app-a"), 2).unwrap();
    assert_eq!(limited.len(), 2);
    assert_eq!(limited[0].call_id, "call-3");
    assert_eq!(limited[1].call_id, "call-2");
    assert!(limited.iter().all(|audit| audit.app_id == "app-a"));
    assert_eq!(limited[0].duration_ms, 42);
    assert_eq!(limited[0].approval_id.as_deref(), Some("approval-1"));

    assert!(store
        .list_application_call_audit(Some("app-a"), 0)
        .unwrap()
        .is_empty());
    assert!(store
        .list_application_call_audit(Some("missing"), 10)
        .unwrap()
        .is_empty());

    store
        .add_application_call_audit(&audit("call-0", "app-a", "2026-01-09T00:00:00Z"))
        .unwrap();
    let all = store.list_application_call_audit(None, 10).unwrap();
    assert_eq!(all.len(), 5);
    assert_eq!(all[0].call_id, "call-0");
}
