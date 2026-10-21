//! Native coding verification tool.
//!
//! The tool detects the target project's verification profile, executes the
//! planned commands through the existing managed-command policy, and returns
//! structured evidence. It does not implement a second command runtime.

use crate::compat_tools::{project_path, run_managed_command, CommandPolicy};
use crate::{Tool, ToolServices};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use worldbase_coding::verification_runner::{run_profile_with_timeout, VerificationExecutor};
use worldbase_coding::{
    detect_profile, CodingPolicy, CommandOutcome, VerificationCommand, VerificationProfile,
};

pub struct CodingVerifyTool;

#[async_trait]
impl Tool for CodingVerifyTool {
    fn name(&self) -> &str {
        "coding_verify"
    }

    fn description(&self) -> &str {
        "Run the detected project verification profile (typecheck, lint, tests, and build) through the managed project command policy. Use this after code edits before reporting a coding task as completed."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_id": {
                    "type": "string",
                    "description": "Managed project ID whose verification profile should run."
                }
            },
            "required": ["project_id"]
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
        let (project_id, root) = project_path(&input, services)?;
        let profile = detect_profile(&root)?;
        if profile.commands.is_empty() {
            return Ok(json!({
                "passed": false,
                "projectId": project_id,
                "reason": "no_supported_verification_profile",
                "profile": profile_payload(&profile),
                "outcomes": [],
                "diagnostics": []
            }));
        }

        let policy = CodingPolicy::default();
        let executor = ProjectCommandExecutor {
            services,
            project_id: &project_id,
            root: &root,
        };
        let evidence = run_profile_with_timeout(
            &profile,
            &executor,
            policy.max_verification_commands,
            policy.command_timeout_ms,
        )
        .await;

        Ok(json!({
            "passed": evidence.passed,
            "projectId": project_id,
            "profile": profile_payload(&evidence.profile),
            "outcomes": evidence.outcomes.iter().map(outcome_payload).collect::<Vec<_>>(),
            "diagnostics": evidence.diagnostics
        }))
    }
}

struct ProjectCommandExecutor<'a> {
    services: &'a ToolServices,
    project_id: &'a str,
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
        let value = run_managed_command(
            &program,
            self.root,
            (timeout_ms / 1_000).max(1),
            Some(self.project_id),
            false,
            Some(self.root),
            Some(self.services.projects.clone()),
            CommandPolicy::Project,
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
    use worldbase_coding::{PackageManager, ProjectKind, VerificationCheckKind};

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
}
