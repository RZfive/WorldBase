//! Native coding verification tool.
//!
//! The tool detects the target project's verification profile, executes the
//! planned commands through the existing managed-command policy, and returns
//! structured evidence. It does not implement a second command runtime.

use crate::compat_tools::{
    resolve_coding_workspace, run_managed_command, CodingWorkspace, CommandPolicy,
};
use crate::{Tool, ToolServices};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use worldbase_coding::verification_runner::{run_profile_with_timeout, VerificationExecutor};
use worldbase_coding::{
    detect_profile, select_minimal_profile, CodingPolicy, CommandOutcome, VerificationCommand,
    VerificationProfile,
};

const MAX_CHANGED_FILES: usize = 200;

pub struct CodingVerifyTool;

#[async_trait]
impl Tool for CodingVerifyTool {
    fn name(&self) -> &str {
        "coding_verify"
    }

    fn description(&self) -> &str {
        "Run the detected verification profile (typecheck, lint, tests, and build) for the active managed project or selected folder workspace. Use this after code edits before reporting a coding task as completed."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_id": {
                    "type": "string",
                    "description": "Optional managed project ID. Omit to use the conversation's active project or selected folder workspace."
                },
                "changed_files": {
                    "type": "array",
                    "items": { "type": "string" },
                    "maxItems": MAX_CHANGED_FILES,
                    "description": "Optional project-relative files changed in this run. Selects the smallest safe verification command set; omit it for the full profile."
                },
                "files": {
                    "type": "array",
                    "items": { "type": "string" },
                    "maxItems": MAX_CHANGED_FILES,
                    "description": "Compatibility alias for changed_files."
                }
            },
            // project_id is optional: folder workspaces are first-class coding roots.
        })
    }

    fn domain(&self) -> &str {
        "desktop"
    }

    fn permission(&self) -> &str {
        "ask"
    }

    fn electron_native(&self) -> bool {
        true
    }

    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let workspace = resolve_coding_workspace(&input, services)?;
        let root = workspace.root.clone();
        let changed_files = changed_files_from_input(&input, &root)?;
        let profile = detect_profile(&root)?;
        let selected = select_minimal_profile(&profile, &changed_files);
        let selection = selection_payload(&selected, changed_files.len());

        // Docs-only changes select no commands: nothing can fail, so report a
        // clean result instead of inventing a command or running the full set.
        // This also applies when the project has no detectable verification
        // profile at all; code changes still retain the existing unsupported
        // result below.
        if selected.commands.is_empty()
            && (!profile.commands.is_empty() || changed_files_are_docs_only(&changed_files))
        {
            return Ok(json!({
                "passed": true,
                "projectId": workspace.project_id.as_deref(),
                "workspaceKind": workspace_kind(&workspace),
                "selection": selection,
                "profile": profile_payload(&selected),
                "outcomes": [],
                "diagnostics": []
            }));
        }

        if profile.commands.is_empty() {
            return Ok(json!({
                "passed": false,
                "projectId": workspace.project_id.as_deref(),
                "workspaceKind": workspace_kind(&workspace),
                "reason": "no_supported_verification_profile",
                "selection": selection,
                "profile": profile_payload(&profile),
                "outcomes": [],
                "diagnostics": []
            }));
        }

        let policy = CodingPolicy::default();
        let executor = ProjectCommandExecutor {
            services,
            workspace: &workspace,
            root: &root,
        };
        let evidence = run_profile_with_timeout(
            &selected,
            &executor,
            policy.max_verification_commands,
            policy.command_timeout_ms,
        )
        .await;

        Ok(json!({
            "passed": evidence.passed,
            "projectId": workspace.project_id.as_deref(),
            "workspaceKind": workspace_kind(&workspace),
            "selection": selection,
            "profile": profile_payload(&evidence.profile),
            "outcomes": evidence.outcomes.iter().map(outcome_payload).collect::<Vec<_>>(),
            "diagnostics": evidence.diagnostics
        }))
    }
}

fn changed_files_from_input(input: &Value, root: &Path) -> Result<Vec<PathBuf>> {
    let Some(raw) = input.get("changed_files").or_else(|| input.get("files")) else {
        return Ok(Vec::new());
    };
    let Some(entries) = raw.as_array() else {
        anyhow::bail!("changed_files must be an array of strings");
    };
    anyhow::ensure!(
        entries.len() <= MAX_CHANGED_FILES,
        "changed_files supports at most {MAX_CHANGED_FILES} entries, got {}",
        entries.len()
    );

    let mut seen = HashSet::new();
    let mut files = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        let Some(value) = entry.as_str() else {
            anyhow::bail!("changed_files[{index}] must be a string");
        };
        anyhow::ensure!(
            !value.trim().is_empty(),
            "changed_files[{index}] must be a non-empty string"
        );
        let path = PathBuf::from(value);
        if path.is_absolute() {
            anyhow::ensure!(
                path.starts_with(root),
                "changed_files[{index}] is outside the project root: {value}"
            );
            anyhow::ensure!(
                !path
                    .components()
                    .any(|component| matches!(component, Component::ParentDir)),
                "changed_files[{index}] contains parent traversal: {value}"
            );
        }
        if seen.insert(path.clone()) {
            files.push(path);
        }
    }
    Ok(files)
}

fn changed_files_are_docs_only(files: &[PathBuf]) -> bool {
    !files.is_empty()
        && files.iter().all(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    matches!(
                        extension.to_ascii_lowercase().as_str(),
                        "md" | "mdx"
                            | "txt"
                            | "png"
                            | "jpg"
                            | "jpeg"
                            | "gif"
                            | "svg"
                            | "webp"
                            | "avif"
                            | "ico"
                            | "bmp"
                            | "tiff"
                    )
                })
        })
}

fn selection_payload(profile: &VerificationProfile, changed_file_count: usize) -> Value {
    json!({
        "changedFiles": changed_file_count,
        "commands": profile.commands.iter().map(|command| command.kind.label()).collect::<Vec<_>>(),
        "source": profile.source
    })
}

struct ProjectCommandExecutor<'a> {
    services: &'a ToolServices,
    workspace: &'a CodingWorkspace,
    root: &'a Path,
}

#[async_trait]
impl VerificationExecutor for ProjectCommandExecutor<'_> {
    async fn execute(
        &self,
        command: &VerificationCommand,
        timeout_ms: u64,
    ) -> Result<CommandOutcome> {
        if self
            .services
            .abort
            .as_ref()
            .is_some_and(|abort| abort.is_cancelled())
        {
            return Ok(CommandOutcome {
                command: command.clone(),
                exit_code: None,
                stdout: String::new(),
                stderr: "verification cancelled before command start".into(),
                timed_out: false,
                cancelled: true,
                duration_ms: 0,
            });
        }

        let program = if command.args.is_empty() {
            command.program.clone()
        } else {
            format!("{} {}", command.program, command.args.join(" "))
        };
        let spill_dir: PathBuf = self.services.store.data_dir().join("tool-results");
        let started = std::time::Instant::now();
        let (project_id, policy) = if self.workspace.is_project() {
            (self.workspace.project_id.as_deref(), CommandPolicy::Project)
        } else {
            (None, CommandPolicy::Workspace)
        };
        let value = run_managed_command(
            &program,
            self.root,
            (timeout_ms / 1_000).max(1),
            project_id,
            false,
            Some(self.root),
            Some(self.services.projects.clone()),
            policy,
            Some(&spill_dir),
        )
        .await?;

        Ok(CommandOutcome {
            command: command.clone(),
            exit_code: value
                .get("exitCode")
                .or_else(|| value.get("exit_code"))
                .and_then(Value::as_i64)
                .and_then(|code| i32::try_from(code).ok()),
            stdout: value
                .get("stdout")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            stderr: value
                .get("stderr")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            timed_out: value
                .get("timedOut")
                .or_else(|| value.get("timed_out"))
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || value.get("status").and_then(Value::as_str) == Some("running"),
            cancelled: self
                .services
                .abort
                .as_ref()
                .is_some_and(|abort| abort.is_cancelled()),
            duration_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        })
    }
}

fn workspace_kind(workspace: &CodingWorkspace) -> &'static str {
    if workspace.is_project() {
        "managed_project"
    } else {
        "folder"
    }
}

fn profile_payload(profile: &VerificationProfile) -> Value {
    json!({
        "projectKind": profile.project_kind,
        "packageManager": profile.package_manager,
        "source": profile.source,
        "commands": profile.commands.iter().map(|command| json!({
            "kind": command.kind,
            "program": command.program,
            "args": command.args,
            "required": command.required,
            "description": command.description
        })).collect::<Vec<_>>()
    })
}

fn outcome_payload(outcome: &CommandOutcome) -> Value {
    json!({
        "kind": outcome.command.kind,
        "program": outcome.command.program,
        "args": outcome.command.args,
        "exitCode": outcome.exit_code,
        "timedOut": outcome.timed_out,
        "cancelled": outcome.cancelled,
        "durationMs": outcome.duration_ms,
        "stdout": outcome.stdout,
        "stderr": outcome.stderr
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use worldbase_coding::{PackageManager, ProjectKind, VerificationCheckKind};

    fn profile(root: &Path) -> VerificationProfile {
        let command = |kind: VerificationCheckKind| VerificationCommand {
            kind,
            program: "pnpm".into(),
            args: vec!["run".into(), kind.label().into()],
            required: true,
            description: kind.label().into(),
        };
        VerificationProfile {
            project_kind: ProjectKind::FrontendNode,
            package_manager: Some(PackageManager::Pnpm),
            root: root.to_path_buf(),
            commands: vec![
                command(VerificationCheckKind::Typecheck),
                command(VerificationCheckKind::Lint),
                command(VerificationCheckKind::Test),
                command(VerificationCheckKind::Build),
            ],
            source: "package.json".into(),
        }
    }

    fn services(root: &Path) -> (ToolServices, PathBuf) {
        let workspace = root.join("workspace");
        let projects = root.join("projects");
        let project = projects.join("alpha");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        let store = Arc::new(worldbase_memory::Store::open(&root.join("store.sqlite")).unwrap());
        let services = ToolServices {
            host: Arc::new(crate::HostBridge::new()),
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

    fn kinds(profile: &VerificationProfile) -> Vec<&'static str> {
        profile
            .commands
            .iter()
            .map(|command| command.kind.label())
            .collect()
    }

    #[test]
    fn profile_payload_does_not_expose_absolute_root() {
        let profile = VerificationProfile {
            project_kind: ProjectKind::FrontendNode,
            package_manager: Some(PackageManager::Pnpm),
            root: PathBuf::from("/private/secret/project"),
            commands: vec![VerificationCommand {
                kind: VerificationCheckKind::Build,
                program: "pnpm".into(),
                args: vec!["run".into(), "build".into()],
                required: true,
                description: "build".into(),
            }],
            source: "package.json".into(),
        };
        let payload = profile_payload(&profile).to_string();
        assert!(!payload.contains("/private/secret/project"));
        assert!(payload.contains("pnpm"));
    }

    #[test]
    fn coding_verify_descriptor_is_native_and_permissioned() {
        let tool = CodingVerifyTool;
        assert_eq!(tool.name(), "coding_verify");
        assert!(tool.electron_native());
        assert_eq!(tool.domain(), "desktop");
        assert_eq!(tool.permission(), "ask");
    }

    #[test]
    fn schema_advertises_changed_files_and_files_alias() {
        let schema = CodingVerifyTool.input_schema();
        assert_eq!(schema["properties"]["changed_files"]["type"], "array");
        assert_eq!(schema["properties"]["changed_files"]["maxItems"], 200);
        assert_eq!(schema["properties"]["files"]["type"], "array");
    }

    #[test]
    fn code_changes_select_typecheck_lint_and_test_without_build() {
        let root = Path::new("/workspace/project");
        let files =
            changed_files_from_input(&json!({ "changed_files": ["src/lib/math.ts"] }), root)
                .unwrap();
        let selected = select_minimal_profile(&profile(root), &files);
        assert_eq!(kinds(&selected), vec!["typecheck", "lint", "test"]);
        let selection = selection_payload(&selected, files.len());
        assert_eq!(selection["changedFiles"], 1);
        assert_eq!(selection["commands"], json!(["typecheck", "lint", "test"]));
    }

    #[test]
    fn manifest_changes_keep_the_full_profile() {
        let root = Path::new("/workspace/project");
        let files =
            changed_files_from_input(&json!({ "changed_files": ["package.json"] }), root).unwrap();
        let selected = select_minimal_profile(&profile(root), &files);
        assert_eq!(kinds(&selected), vec!["typecheck", "lint", "test", "build"]);
    }

    #[test]
    fn files_alias_deduplicates_while_preserving_first_seen_order() {
        let root = Path::new("/workspace/project");
        let files = changed_files_from_input(
            &json!({ "files": ["src/b.ts", "src/a.ts", "src/b.ts"] }),
            root,
        )
        .unwrap();
        assert_eq!(
            files,
            vec![PathBuf::from("src/b.ts"), PathBuf::from("src/a.ts")]
        );
    }

    #[test]
    fn absolute_paths_outside_the_project_are_rejected() {
        let error = changed_files_from_input(
            &json!({ "changed_files": ["/tmp/outside/file.ts"] }),
            Path::new("/workspace/project"),
        )
        .unwrap_err();
        assert!(error.to_string().contains("outside the project root"));
    }

    #[test]
    fn more_than_two_hundred_changed_files_are_rejected() {
        let files = (0..=MAX_CHANGED_FILES)
            .map(|index| format!("src/file-{index}.ts"))
            .collect::<Vec<_>>();
        let error = changed_files_from_input(
            &json!({ "changed_files": files }),
            Path::new("/workspace/project"),
        )
        .unwrap_err();
        assert!(error.to_string().contains("at most 200"));
    }

    #[test]
    fn selection_payload_does_not_expose_the_project_root() {
        let root = Path::new("/private/secret/project");
        let files = vec![PathBuf::from("src/lib/math.ts")];
        let selected = select_minimal_profile(&profile(root), &files);
        let payload = selection_payload(&selected, files.len()).to_string();
        assert!(!payload.contains("/private/secret/project"));
        assert!(payload.contains("typecheck"));
        assert!(payload.contains("minimal"));
    }

    #[tokio::test]
    async fn docs_only_changes_pass_without_running_commands() {
        let temp = tempfile::tempdir().unwrap();
        let (tool_services, project) = services(temp.path());
        std::fs::write(
            project.join("package.json"),
            json!({
                "name": "verify-selection-test",
                "scripts": {
                    "typecheck": "echo typecheck",
                    "lint": "echo lint",
                    "test": "echo test",
                    "build": "echo build"
                }
            })
            .to_string(),
        )
        .unwrap();

        let result = CodingVerifyTool
            .execute(
                json!({
                    "project_id": "alpha",
                    "changed_files": ["docs/guide.md"]
                }),
                &tool_services,
            )
            .await
            .unwrap();

        assert_eq!(result["passed"], true);
        assert_eq!(result["selection"]["commands"], json!([]));
        assert_eq!(result["outcomes"], json!([]));
        assert_eq!(result["diagnostics"], json!([]));

        // A docs-only change needs no verification even when no package.json
        // profile can be detected.
        let bare = tempfile::tempdir().unwrap();
        let (bare_services, _) = services(bare.path());
        let bare_result = CodingVerifyTool
            .execute(
                json!({
                    "project_id": "alpha",
                    "files": ["README.md"]
                }),
                &bare_services,
            )
            .await
            .unwrap();
        assert_eq!(bare_result["passed"], true);
        assert_eq!(bare_result["selection"]["commands"], json!([]));
        assert_eq!(bare_result["outcomes"], json!([]));
    }
}
