//! Deterministic capability snapshot extraction from discovery/status tools.
//!
//! The ledger stores capabilities as a replaceable snapshot. Parsing is
//! deliberately tool-gated so unrelated JSON payloads that happen to contain a
//! `candidates` field are not mistaken for capability evidence. A returned
//! `Some(empty)` means a capability query succeeded and reported no entries;
//! `None` means the result is unrelated or malformed.

use std::collections::HashSet;

use serde_json::{Map, Value};

use super::ledger::{CapabilitySummary, RunStateLedger};

pub const GET_PROJECT_STATUS_TOOL: &str = "get_project_status";
pub const SEARCH_TOOLS_TOOL: &str = "search_tools";

/// Deterministic snapshot representation accepted by the run-state ledger.
pub type CapabilitySnapshot = Vec<CapabilitySummary>;

/// Extract a capability snapshot from a known capability query/status result.
///
/// `get_project_status` is read from `aiApplication.capabilityDetails`, while
/// `search_tools` is read from `candidates` + `activated`. As a conservative
/// fallback, an unambiguous top-level `capabilities` array is supported for
/// other capability-oriented tools. Invalid payloads return `None`.
pub fn capability_snapshot_from_tool_result(
    tool_name: &str,
    result: &Value,
) -> Option<CapabilitySnapshot> {
    let object = result.as_object()?;
    let specialized = match tool_name {
        GET_PROJECT_STATUS_TOOL => parse_project_status(object),
        SEARCH_TOOLS_TOOL => parse_search_tools(object),
        _ => None,
    };
    specialized.or_else(|| parse_top_level_capabilities(object))
}

/// Alias for callers that describe the operation as extraction.
pub fn extract_capability_snapshot(tool_name: &str, result: &Value) -> Option<CapabilitySnapshot> {
    capability_snapshot_from_tool_result(tool_name, result)
}

/// Alias for callers that describe the operation as parsing.
pub fn parse_capability_snapshot(tool_name: &str, result: &Value) -> Option<CapabilitySnapshot> {
    capability_snapshot_from_tool_result(tool_name, result)
}

/// Alias with the shortest call-site name.
pub fn snapshot_from_tool_result(tool_name: &str, result: &Value) -> Option<CapabilitySnapshot> {
    capability_snapshot_from_tool_result(tool_name, result)
}

/// Replace the ledger snapshot only when extraction produced one.
///
/// `Some(empty)` clears stale capabilities. `None` leaves the existing ledger
/// state untouched. Returns whether the snapshot was applied.
pub fn apply_capability_snapshot(
    ledger: &mut RunStateLedger,
    snapshot: Option<CapabilitySnapshot>,
) -> bool {
    match snapshot {
        Some(capabilities) => {
            ledger.replace_capabilities(capabilities);
            true
        }
        None => false,
    }
}

/// Alias for ledger-focused call sites.
pub fn apply_snapshot_to_ledger(
    ledger: &mut RunStateLedger,
    snapshot: Option<CapabilitySnapshot>,
) -> bool {
    apply_capability_snapshot(ledger, snapshot)
}

/// Parse and immediately apply a tool result when it contains a snapshot.
pub fn apply_tool_result_capability_snapshot(
    ledger: &mut RunStateLedger,
    tool_name: &str,
    result: &Value,
) -> bool {
    apply_capability_snapshot(
        ledger,
        capability_snapshot_from_tool_result(tool_name, result),
    )
}

fn parse_project_status(object: &Map<String, Value>) -> Option<CapabilitySnapshot> {
    let ai_application = object_value(object, &["aiApplication", "ai_application"])?;
    let details = ["capabilityDetails", "capability_details"]
        .iter()
        .find_map(|name| ai_application.get(*name))?;
    let details = details.as_array()?;
    if details.is_empty() {
        return Some(Vec::new());
    }

    let availability =
        object_string(ai_application, &["status"]).unwrap_or_else(|| "unknown".into());
    let capabilities = details
        .iter()
        .filter_map(|detail| parse_capability_entry(detail, &availability))
        .collect::<Vec<_>>();
    finalize_snapshot(capabilities, true)
}

fn parse_search_tools(object: &Map<String, Value>) -> Option<CapabilitySnapshot> {
    let candidates = object.get("candidates")?.as_array()?;
    if candidates.is_empty() {
        return Some(Vec::new());
    }

    let activated = match object.get("activated") {
        Some(value) => activated_identifiers(value)?,
        None => HashSet::new(),
    };

    let mut capabilities = Vec::new();
    for candidate in candidates {
        let Some(candidate) = candidate.as_object() else {
            continue;
        };
        let Some(title) = required_string(candidate, &["title"]) else {
            continue;
        };
        let tool_name = optional_string(candidate, &["tool_name", "toolName"]);
        let id = optional_string(candidate, &["capability_id", "capabilityId"])
            .or_else(|| tool_name.clone());
        let Some(id) = id else {
            continue;
        };
        let risk = optional_string(candidate, &["risk"]).unwrap_or_else(|| "unknown".into());
        let active = activated.contains(&id)
            || tool_name
                .as_deref()
                .is_some_and(|name| activated.contains(name));
        capabilities.push(CapabilitySummary {
            id,
            title,
            risk,
            availability: if active { "active" } else { "available" }.into(),
        });
    }

    finalize_snapshot(capabilities, true)
}

fn parse_top_level_capabilities(object: &Map<String, Value>) -> Option<CapabilitySnapshot> {
    let capabilities = object.get("capabilities")?.as_array()?;
    if capabilities.is_empty() {
        return Some(Vec::new());
    }

    let default_availability =
        object_string(object, &["availability", "status"]).unwrap_or_else(|| "unknown".into());
    let parsed = capabilities
        .iter()
        .filter_map(|capability| {
            let capability = capability.as_object()?;
            let entry_availability = object_string(capability, &["availability", "status"])
                .or_else(|| {
                    capability
                        .get("active")
                        .and_then(Value::as_bool)
                        .map(|active| if active { "active" } else { "available" }.to_string())
                })
                .unwrap_or_else(|| default_availability.clone());
            parse_capability_entry(&Value::Object(capability.clone()), &entry_availability)
        })
        .collect::<Vec<_>>();

    finalize_snapshot(parsed, true)
}

fn parse_capability_entry(value: &Value, availability: &str) -> Option<CapabilitySummary> {
    let object = value.as_object()?;
    let id = required_string(object, &["id", "capability_id", "capabilityId"])?;
    let title = required_string(object, &["title"])?;
    let risk = optional_string(object, &["risk"]).unwrap_or_else(|| "unknown".into());
    Some(CapabilitySummary {
        id,
        title,
        risk,
        availability: availability.to_string(),
    })
}

fn activated_identifiers(value: &Value) -> Option<HashSet<String>> {
    let entries = value.as_array()?;
    Some(
        entries
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .map(ToOwned::to_owned)
            .collect(),
    )
}

fn finalize_snapshot(
    mut capabilities: CapabilitySnapshot,
    had_input_entries: bool,
) -> Option<CapabilitySnapshot> {
    if had_input_entries && capabilities.is_empty() {
        return None;
    }
    capabilities.sort_by(|left, right| {
        (&left.id, &left.title, &left.risk, &left.availability).cmp(&(
            &right.id,
            &right.title,
            &right.risk,
            &right.availability,
        ))
    });
    capabilities.dedup_by(|left, right| left.id == right.id);
    Some(capabilities)
}

fn object_value<'a>(
    object: &'a Map<String, Value>,
    names: &[&str],
) -> Option<&'a Map<String, Value>> {
    names
        .iter()
        .find_map(|name| object.get(*name).and_then(Value::as_object))
}

fn object_string(object: &Map<String, Value>, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        object
            .get(*name)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    })
}

fn optional_string(object: &Map<String, Value>, names: &[&str]) -> Option<String> {
    object_string(object, names)
}

fn required_string(object: &Map<String, Value>, names: &[&str]) -> Option<String> {
    object_string(object, names)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn project_status_uses_ai_application_status_and_details() {
        let result = json!({
            "status": "running",
            "aiApplication": {
                "status": "disabled",
                "capabilityDetails": [
                    {
                        "id": "z.capability",
                        "title": "Z capability",
                        "risk": "external",
                        "permissions": ["network"]
                    },
                    {
                        "id": "a.capability",
                        "title": "A capability",
                        "risk": "read"
                    },
                    {
                        "id": "",
                        "title": "invalid empty id",
                        "risk": "read"
                    }
                ]
            }
        });

        let snapshot = capability_snapshot_from_tool_result("get_project_status", &result).unwrap();
        assert_eq!(
            snapshot
                .iter()
                .map(|capability| capability.id.as_str())
                .collect::<Vec<_>>(),
            vec!["a.capability", "z.capability"]
        );
        assert!(snapshot
            .iter()
            .all(|capability| capability.availability == "disabled"));
        assert_eq!(snapshot[0].title, "A capability");
        assert_eq!(snapshot[1].risk, "external");
    }

    #[test]
    fn search_candidates_use_capability_id_and_activation() {
        let result = json!({
            "candidates": [
                {
                    "toolName": "app__z",
                    "capabilityId": "z.capability",
                    "title": "Z capability",
                    "risk": "external"
                },
                {
                    "tool_name": "app__a",
                    "capability_id": "a.capability",
                    "title": "A capability",
                    "risk": "read"
                },
                {
                    "toolName": "tool.only",
                    "title": "Tool-only candidate",
                    "risk": "write_reversible"
                }
            ],
            "activated": ["app__z", "a.capability"]
        });

        let snapshot = capability_snapshot_from_tool_result("search_tools", &result).unwrap();
        assert_eq!(
            snapshot
                .iter()
                .map(|capability| (capability.id.as_str(), capability.availability.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("a.capability", "active"),
                ("tool.only", "available"),
                ("z.capability", "active"),
            ]
        );
    }

    #[test]
    fn duplicate_ids_are_deterministic_and_sorted() {
        let first = json!({
            "candidates": [
                {"capabilityId": "same", "title": "Beta", "risk": "read"},
                {"capabilityId": "z", "title": "Z", "risk": "read"},
                {"capabilityId": "same", "title": "Alpha", "risk": "read"}
            ],
            "activated": []
        });
        let second = json!({
            "candidates": [
                {"capabilityId": "same", "title": "Alpha", "risk": "read"},
                {"capabilityId": "same", "title": "Beta", "risk": "read"},
                {"capabilityId": "z", "title": "Z", "risk": "read"}
            ],
            "activated": []
        });

        let first = capability_snapshot_from_tool_result("search_tools", &first).unwrap();
        let second = capability_snapshot_from_tool_result("search_tools", &second).unwrap();
        assert_eq!(first, second);
        assert_eq!(
            first
                .iter()
                .map(|capability| (capability.id.as_str(), capability.title.as_str()))
                .collect::<Vec<_>>(),
            vec![("same", "Alpha"), ("z", "Z")]
        );
    }

    #[test]
    fn unrelated_tool_result_returns_none() {
        let result = json!({
            "candidates": [
                {"toolName": "not-a-capability", "title": "Unrelated"}
            ]
        });
        assert!(capability_snapshot_from_tool_result("read_file", &result).is_none());
        assert!(capability_snapshot_from_tool_result(
            "get_project_status",
            &json!({"status":"ok"})
        )
        .is_none());
    }

    #[test]
    fn invalid_payloads_return_none_but_real_empty_queries_return_some_empty() {
        assert!(capability_snapshot_from_tool_result(
            "search_tools",
            &json!({"candidates": "not-an-array"})
        )
        .is_none());
        assert!(capability_snapshot_from_tool_result(
            "search_tools",
            &json!({"candidates": [{"title": "missing id"}]})
        )
        .is_none());
        assert!(capability_snapshot_from_tool_result(
            "get_project_status",
            &json!({"aiApplication": {"status": "ready", "capabilityDetails": "bad"}})
        )
        .is_none());
        assert!(capability_snapshot_from_tool_result(
            "get_project_status",
            &json!({"aiApplication": {"status": "ready", "capabilityDetails": [{}]}})
        )
        .is_none());
        assert!(capability_snapshot_from_tool_result(
            "list_capabilities",
            &json!({"capabilities": ["ambiguous-id-only"]})
        )
        .is_none());

        assert_eq!(
            capability_snapshot_from_tool_result(
                "search_tools",
                &json!({"candidates": [], "activated": []})
            ),
            Some(Vec::new())
        );
        assert_eq!(
            capability_snapshot_from_tool_result(
                "get_project_status",
                &json!({"aiApplication": {"status": "ready", "capabilityDetails": []}})
            ),
            Some(Vec::new())
        );
        assert_eq!(
            capability_snapshot_from_tool_result("list_capabilities", &json!({"capabilities": []})),
            Some(Vec::new())
        );
    }

    #[test]
    fn unambiguous_top_level_capability_array_is_supported() {
        let result = json!({
            "status": "ready",
            "capabilities": [
                {"id": "b", "title": "B", "risk": "read"},
                {
                    "id": "a",
                    "title": "A",
                    "risk": "external",
                    "availability": "disabled"
                }
            ]
        });

        let snapshot = capability_snapshot_from_tool_result("list_capabilities", &result).unwrap();
        assert_eq!(
            snapshot
                .iter()
                .map(|capability| (capability.id.as_str(), capability.availability.as_str()))
                .collect::<Vec<_>>(),
            vec![("a", "disabled"), ("b", "ready")]
        );
    }

    #[test]
    fn apply_helper_replaces_only_for_some_snapshots() {
        let mut ledger = RunStateLedger::default();
        ledger.replace_capabilities(vec![CapabilitySummary {
            id: "old".into(),
            title: "Old".into(),
            risk: "read".into(),
            availability: "ready".into(),
        }]);

        assert!(!apply_capability_snapshot(&mut ledger, None));
        assert_eq!(ledger.capabilities[0].id, "old");

        assert!(apply_capability_snapshot(&mut ledger, Some(Vec::new())));
        assert!(ledger.capabilities.is_empty());

        let snapshot = capability_snapshot_from_tool_result(
            "get_project_status",
            &json!({
                "aiApplication": {
                    "status": "invalid",
                    "capabilityDetails": [
                        {"id": "new", "title": "New", "risk": "read"}
                    ]
                }
            }),
        );
        assert!(apply_tool_result_capability_snapshot(
            &mut ledger,
            "get_project_status",
            &json!({
                "aiApplication": {
                    "status": "invalid",
                    "capabilityDetails": [
                        {"id": "new", "title": "New", "risk": "read"}
                    ]
                }
            })
        ));
        assert_eq!(ledger.capabilities.len(), 1);
        assert_eq!(ledger.capabilities[0].id, "new");
        assert_eq!(ledger.capabilities[0].availability, "invalid");
        assert!(snapshot.is_some());
    }
}
