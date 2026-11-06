//! Application grant/risk policy helpers.

use worldbase_protocol::types::{ApplicationGrant, CapabilityRisk};

/// Resolve the effective permission for an application capability. Grants can
/// only make a read operation explicit; they never turn a destructive or
/// external operation into an unattended allow.
pub fn effective_policy(
    risk: CapabilityRisk,
    app_id: &str,
    capability_id: &str,
    grants: &[ApplicationGrant],
) -> &'static str {
    let now = chrono::Utc::now();
    let grant = grants.iter().find(|grant| {
        grant.app_id == app_id
            && !grant.capability_pattern.trim().is_empty()
            && capability_pattern_matches(&grant.capability_pattern, capability_id)
            && grant
                .expires_at
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                .is_none_or(|expires_at| expires_at > now)
    });
    if let Some(grant) = grant {
        match grant.mode.as_str() {
            "deny" => return "deny",
            "allow" if risk == CapabilityRisk::Read => return "allow",
            "allow" => return risk.default_permission(),
            _ => {}
        }
    }
    risk.default_permission()
}

pub fn capability_pattern_matches(pattern: &str, capability_id: &str) -> bool {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return false;
    }
    if pattern == "*" {
        return true;
    }
    if let Some(prefix) = pattern.strip_suffix(".*") {
        return capability_id == prefix
            || capability_id
                .strip_prefix(prefix)
                .is_some_and(|rest| rest.starts_with('.'));
    }
    pattern == capability_id
}

/// Destructive/external operations are never auto-approved in unattended
/// runs. Interactive hosts still get the normal confirmation flow.
pub fn risk_requires_confirmation(risk: CapabilityRisk, _auto_approve: bool) -> bool {
    // Writes are only auto-approved through an explicit, unexpired grant
    // resolved by `effective_policy`; the unattended flag alone must never
    // silence a write confirmation.
    risk != CapabilityRisk::Read
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grant_matching() {
        assert!(capability_pattern_matches("*", "doc.read"));
        assert!(capability_pattern_matches("doc.*", "doc.read"));
        assert!(capability_pattern_matches("doc.*", "doc"));
        assert!(!capability_pattern_matches("doc.*", "docs.read"));
        assert!(capability_pattern_matches("doc.read", "doc.read"));
    }

    #[test]
    fn unattended_destructive_is_never_auto_approved() {
        assert!(risk_requires_confirmation(
            CapabilityRisk::WriteDestructive,
            true
        ));
        assert!(risk_requires_confirmation(
            CapabilityRisk::ExternalEffect,
            true
        ));
        assert!(risk_requires_confirmation(
            CapabilityRisk::WriteReversible,
            true
        ));
        assert!(!risk_requires_confirmation(CapabilityRisk::Read, true));
        assert!(!risk_requires_confirmation(CapabilityRisk::Read, false));
    }

    #[test]
    fn grants_can_allow_reads_but_never_silence_writes() {
        let allow = ApplicationGrant {
            app_id: "worldbase.documents".into(),
            capability_pattern: "doc.*".into(),
            mode: "allow".into(),
            ..Default::default()
        };
        assert_eq!(
            effective_policy(
                CapabilityRisk::Read,
                "worldbase.documents",
                "doc.read",
                std::slice::from_ref(&allow)
            ),
            "allow"
        );
        assert_eq!(
            effective_policy(
                CapabilityRisk::WriteDestructive,
                "worldbase.documents",
                "doc.read",
                std::slice::from_ref(&allow)
            ),
            "ask"
        );

        let deny = ApplicationGrant {
            app_id: "worldbase.documents".into(),
            capability_pattern: "*".into(),
            mode: "deny".into(),
            ..Default::default()
        };
        assert_eq!(
            effective_policy(
                CapabilityRisk::Read,
                "worldbase.documents",
                "doc.read",
                std::slice::from_ref(&deny)
            ),
            "deny"
        );

        assert_eq!(
            effective_policy(CapabilityRisk::Read, "worldbase.documents", "doc.read", &[]),
            "allow"
        );
        assert_eq!(
            effective_policy(
                CapabilityRisk::ExternalEffect,
                "worldbase.documents",
                "doc.read",
                &[]
            ),
            "ask"
        );
    }
}
