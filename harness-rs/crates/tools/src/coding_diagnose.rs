//! Native coding diagnosis tool.
//!
//! Combines normalized compiler diagnostics, optional LSP publishDiagnostics
//! payloads, and optional package-manager output into one deterministic report
//! with a repair plan. It never writes files or executes package commands.

use crate::compat_tools::resolve_coding_workspace;
use crate::{Tool, ToolServices};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use worldbase_coding::{
    analyze_dependency_diagnostics, analyze_diagnostics, analyze_package_manager_output,
    parse_package_manifest, parse_publish_diagnostics, plan_repair, CodingPolicy, DependencyIssue,
    DependencyIssueKind, DependencyReport, Diagnostic, PackageManifest,
};

pub struct CodingDiagnoseTool;

#[async_trait]
impl Tool for CodingDiagnoseTool {
    fn name(&self) -> &str {
        "coding_diagnose"
    }

    fn description(&self) -> &str {
        "Combine compiler diagnostics, optional LSP publishDiagnostics, and package-manager output into a structured diagnosis, dependency report, and repair plan. Read-only; does not execute commands."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_id": {
                    "type": "string",
                    "description": "Optional managed project ID. Omit to use the conversation's active project or selected folder workspace."
                },
                "diagnostics": {
                    "type": "array",
                    "description": "Normalized diagnostics (severity, message, code, file, line, column, confidence, raw).",
                    "items": { "type": "object" }
                },
                "lsp_diagnostics": {
                    "type": "object",
                    "description": "Raw LSP publishDiagnostics params: { uri, diagnostics: [...] }."
                },
                "package_manager_output": {
                    "type": "string",
                    "description": "Raw npm/pnpm/yarn/bun failure output."
                },
                "manifest": {
                    "type": "object",
                    "description": "package.json content. Overrides the project manifest."
                },
                "repair_attempt": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "Completed repair rounds, used by the repair planner."
                },
                "previous_signatures": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Failure signatures from earlier rounds."
                }
            }
        })
    }

    fn domain(&self) -> &str {
        "desktop"
    }

    fn permission(&self) -> &str {
        "allow"
    }

    fn electron_native(&self) -> bool {
        true
    }

    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let mut diagnostics = parse_diagnostics(&input)?;

        if let Some(lsp) = input.get("lsp_diagnostics") {
            diagnostics.extend(parse_publish_diagnostics(lsp)?);
        }

        let manifest = load_manifest(&input, services).await?;
        let package_manager = manifest
            .as_ref()
            .and_then(|manifest| manifest.package_manager);
        let repair_attempt = input
            .get("repair_attempt")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(u32::MAX as u64) as u32;
        let previous_signatures = input
            .get("previous_signatures")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let diagnosis = analyze_diagnostics(&diagnostics);
        let mut dependency =
            analyze_dependency_diagnostics(&diagnostics, manifest.as_ref(), package_manager);
        if let Some(output) = input
            .get("package_manager_output")
            .and_then(Value::as_str)
            .filter(|output| !output.trim().is_empty())
        {
            let output_report =
                analyze_package_manager_output(output, manifest.as_ref(), package_manager);
            dependency = merge_dependency_reports(dependency, output_report);
        }
        let policy = CodingPolicy::default();
        let repair = plan_repair(&diagnosis, &previous_signatures, repair_attempt, &policy);

        Ok(json!({
            "diagnosis": diagnosis,
            "dependency": dependency,
            "repair": repair,
        }))
    }
}

fn parse_diagnostics(input: &Value) -> Result<Vec<Diagnostic>> {
    let Some(values) = input.get("diagnostics") else {
        return Ok(Vec::new());
    };
    let array = values
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("diagnostics must be an array"))?;
    serde_json::from_value(Value::Array(array.clone()))
        .map_err(|error| anyhow::anyhow!("invalid diagnostics payload: {error}"))
}

async fn load_manifest(input: &Value, services: &ToolServices) -> Result<Option<PackageManifest>> {
    if let Some(manifest) = input.get("manifest") {
        return parse_package_manifest(manifest).map(Some);
    }
    let Ok(workspace) = resolve_coding_workspace(input, services) else {
        return Ok(None);
    };
    let path = workspace.root.join("package.json");
    if !path.is_file() {
        return Ok(None);
    }
    let text = tokio::fs::read_to_string(&path).await?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| anyhow::anyhow!("invalid package.json at {}: {error}", path.display()))?;
    parse_package_manifest(&value).map(Some)
}

fn merge_dependency_reports(
    mut base: DependencyReport,
    extra: DependencyReport,
) -> DependencyReport {
    for issue in extra.issues {
        if !base
            .issues
            .iter()
            .any(|existing| same_issue(existing, &issue))
        {
            base.issues.push(issue);
        }
    }
    for command in extra.commands {
        if !base.commands.contains(&command) {
            base.commands.push(command);
        }
    }
    base.affected_packages = affected_packages(&base.issues);
    base.has_issues = !base.issues.is_empty();
    base.primary_kind = base
        .issues
        .first()
        .map(|issue| issue.kind)
        .unwrap_or(DependencyIssueKind::Unknown);
    base.summary = format!(
        "{} dependency issue(s) across {} package(s).",
        base.issues.len(),
        base.affected_packages.len()
    );
    base
}

fn same_issue(left: &DependencyIssue, right: &DependencyIssue) -> bool {
    left.kind == right.kind
        && left.package == right.package
        && left.file == right.file
        && left.message == right.message
}

fn affected_packages(issues: &[DependencyIssue]) -> Vec<String> {
    let mut packages = BTreeSet::new();
    for issue in issues {
        if let Some(package) = &issue.package {
            packages.insert(package.clone());
        }
    }
    packages.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{HostBridge, Tool};
    use serde_json::json;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    fn services(root: &Path) -> (ToolServices, PathBuf) {
        let workspace = root.join("workspace");
        let projects = root.join("projects");
        let project = projects.join("alpha");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        let store = Arc::new(worldbase_memory::Store::open(&root.join("store.sqlite")).unwrap());
        let services = ToolServices {
            host: Arc::new(HostBridge::new()),
            current_stream: Arc::new(std::sync::Mutex::new(String::new())),
            abort: None,
            workspace,
            folder_workspace: None,
            target_project_id: None,
            created_project_id: Arc::new(std::sync::Mutex::new(None)),
            allowed_mcp_server_ids: None,
            plan_goal: Arc::new(std::sync::Mutex::new(None)),
            todo_items: Arc::new(std::sync::Mutex::new(Vec::new())),
            read_files: Arc::new(std::sync::Mutex::new(std::collections::HashSet::new())),
            visible_tool_catalog: None,
            store: store.clone(),
            memory_queue: None,
            memory_scopes: Vec::new(),
            skills: Arc::new(worldbase_skills::SkillRegistry::new(vec![])),
            scheduler: Arc::new(worldbase_scheduler::Scheduler::new(store)),
            mcp: Arc::new(worldbase_mcp_client::McpManager::default()),
            projects: Arc::new(worldbase_project_runtime::ProjectRuntime::new(projects)),
            group_collaboration: None,
            subagent_runtime: None,
        };
        (services, project)
    }

    fn lsp_payload() -> Value {
        json!({
            "uri": "file:///workspace/src/main.ts",
            "diagnostics": [{
                "range": {
                    "start": { "line": 11, "character": 6 },
                    "end": { "line": 11, "character": 18 }
                },
                "severity": 1,
                "code": "TS2307",
                "message": "Cannot find module 'left-pad' or its corresponding type declarations."
            }]
        })
    }

    #[tokio::test]
    async fn combines_lsp_and_package_manager_output() {
        let temp = tempfile::tempdir().unwrap();
        let (services, project) = services(temp.path());
        std::fs::write(
            project.join("package.json"),
            r#"{"name":"alpha","dependencies":{"left-pad":"^1.3.0"}}"#,
        )
        .unwrap();

        let result = CodingDiagnoseTool
            .execute(
                json!({
                    "project_id": "alpha",
                    "lsp_diagnostics": lsp_payload(),
                    "package_manager_output": "ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile",
                    "repair_attempt": 0
                }),
                &services,
            )
            .await
            .unwrap();

        assert_eq!(result["diagnosis"]["errorCount"], 1);
        assert!(result["dependency"]["issues"].as_array().unwrap().len() >= 1);
        assert!(result["repair"]["shouldRetry"].as_bool().unwrap());
    }

    #[tokio::test]
    async fn accepts_normalized_diagnostics_and_explicit_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let (services, _project) = services(temp.path());
        let result = CodingDiagnoseTool
            .execute(
                json!({
                    "diagnostics": [{
                        "severity": "error",
                        "message": "Cannot find module 'zod'.",
                        "code": "TS2307",
                        "file": "src/main.ts",
                        "line": 1,
                        "column": 1,
                        "confidence": 0.95
                    }],
                    "manifest": { "name": "alpha" }
                }),
                &services,
            )
            .await
            .unwrap();

        assert_eq!(result["diagnosis"]["errorCount"], 1);
        assert_eq!(result["dependency"]["issues"][0]["kind"], "missingPackage");
    }

    #[tokio::test]
    async fn repeated_signature_stops_repair() {
        let temp = tempfile::tempdir().unwrap();
        let (services, _project) = services(temp.path());
        let first = CodingDiagnoseTool
            .execute(
                json!({
                    "diagnostics": [{
                        "severity": "error",
                        "message": "Cannot find name 'x'.",
                        "code": "TS2304",
                        "file": "src/main.ts",
                        "line": 1,
                        "column": 1,
                        "confidence": 0.95
                    }]
                }),
                &services,
            )
            .await
            .unwrap();
        let signature = first["diagnosis"]["failureSignature"]
            .as_str()
            .unwrap()
            .to_string();
        let second = CodingDiagnoseTool
            .execute(
                json!({
                    "diagnostics": [{
                        "severity": "error",
                        "message": "Cannot find name 'x'.",
                        "code": "TS2304",
                        "file": "src/main.ts",
                        "line": 1,
                        "column": 1,
                        "confidence": 0.95
                    }],
                    "previous_signatures": [signature],
                    "repair_attempt": 1
                }),
                &services,
            )
            .await
            .unwrap();
        assert_eq!(second["repair"]["stopReason"], "repeatedFailure");
        assert!(!second["repair"]["shouldRetry"].as_bool().unwrap());
    }
}
