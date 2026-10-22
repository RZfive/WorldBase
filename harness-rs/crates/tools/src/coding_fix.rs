//! Native dependency fix execution tool.
//!
//! Turns dependency-analyzer output into a small, allow-listed plan of package
//! manager commands and executes that plan through the existing managed
//! project command policy. The tool never runs general shell commands, removal
//! commands, lifecycle scripts, or package specs that point at paths, URLs, or
//! git repositories.

use crate::compat_tools::{project_path, run_managed_command, CommandPolicy};
use crate::{Tool, ToolServices};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::Path;
use std::time::Instant;
use tokio_util::sync::CancellationToken;
use worldbase_coding::{
    analyze_dependency_diagnostics, analyze_package_manager_output, detect_package_manager,
    parse_package_manifest, CodingPolicy, DependencyIssue, Diagnostic, PackageManager,
    PackageManifest,
};

const MAX_TIMEOUT_SECONDS: u64 = 300;
const LOCKFILES: &[&str] = &[
    "pnpm-lock.yaml",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "bun.lockb",
    "bun.lock",
];

pub struct CodingFixDependenciesTool;

#[async_trait]
impl Tool for CodingFixDependenciesTool {
    fn name(&self) -> &str {
        "coding_fix_dependencies"
    }

    fn description(&self) -> &str {
        "Plan and apply safe dependency fixes produced by the dependency analyzer. Only package-manager add/install commands are allowed; dry-run is the default and actual execution requires confirm=true."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_id": {
                    "type": "string",
                    "description": "Managed project ID whose package.json and lockfiles are analyzed and where commands run."
                },
                "issues": {
                    "type": "array",
                    "description": "Dependency issues from coding_diagnose (kind + suggestedFix) or normalized compiler diagnostics. When omitted, package.json is read and analyzed.",
                    "items": { "type": "object" }
                },
                "package_manager_output": {
                    "type": "string",
                    "description": "Raw npm/pnpm/yarn/bun failure output to analyze into dependency issues."
                },
                "dry_run": {
                    "type": "boolean",
                    "default": true,
                    "description": "Return the validated plan without executing it. Defaults to true."
                },
                "confirm": {
                    "type": "boolean",
                    "default": false,
                    "description": "Required to be true when dry_run is false."
                },
                "timeout_seconds": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_TIMEOUT_SECONDS,
                    "description": "Per-command foreground timeout. Defaults to the coding policy timeout and is capped at 300 seconds."
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
        if !services.is_tool_allowed_in_plan_mode(self.name()) {
            anyhow::bail!("coding_fix_dependencies is not available in plan mode");
        }

        let (project_id, root) = project_path(&input, services)?;
        let manifest = load_manifest(&root).await?;
        let package_manager = detect_for_root(manifest.as_ref(), &root);
        let commands = dependency_commands(&input, manifest.as_ref(), package_manager)?;

        let mut planned = Vec::new();
        let mut seen = HashSet::new();
        for command in commands {
            let validated = validate_fix_command(&command).map_err(|error| {
                anyhow::anyhow!("rejected dependency fix command `{command}`: {error}")
            })?;
            if seen.insert(validated.clone()) {
                planned.push(validated);
            }
        }

        let dry_run = input
            .get("dry_run")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        if dry_run {
            return Ok(output_payload(
                &project_id,
                package_manager,
                true,
                &planned,
                None,
            ));
        }

        let confirm = input
            .get("confirm")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        anyhow::ensure!(
            confirm,
            "confirm must be true to execute dependency fixes; use dry_run to inspect the plan"
        );

        let timeout_seconds = timeout_seconds(&input);
        let executor = ManagedCommandExecutor {
            services,
            project_id: &project_id,
            root: &root,
            timeout_seconds,
        };
        let execution = run_commands(&planned, &executor, services.abort.as_ref()).await;
        Ok(output_payload(
            &project_id,
            package_manager,
            false,
            &planned,
            Some(&execution),
        ))
    }
}

async fn load_manifest(root: &Path) -> Result<Option<PackageManifest>> {
    let path = root.join("package.json");
    if !path.is_file() {
        return Ok(None);
    }
    let text = tokio::fs::read_to_string(&path).await?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| anyhow::anyhow!("invalid package.json at {}: {error}", path.display()))?;
    parse_package_manifest(&value).map(Some)
}

fn detect_for_root(manifest: Option<&PackageManifest>, root: &Path) -> Option<PackageManager> {
    let lockfiles = LOCKFILES
        .iter()
        .copied()
        .filter(|name| root.join(name).is_file())
        .collect::<Vec<_>>();
    detect_package_manager(manifest, &lockfiles)
}

fn dependency_commands(
    input: &Value,
    manifest: Option<&PackageManifest>,
    package_manager: Option<PackageManager>,
) -> Result<Vec<String>> {
    let mut commands = Vec::new();
    let mut analyzed = false;

    if let Some(value) = input.get("issues") {
        analyzed = true;
        let (issues, diagnostics) = parse_issues(value)?;
        for issue in issues {
            if let Some(fix) = issue.suggested_fix {
                commands.push(fix.command);
            }
        }
        if !diagnostics.is_empty() {
            let report = analyze_dependency_diagnostics(&diagnostics, manifest, package_manager);
            commands.extend(report.commands);
        }
    }

    if let Some(output) = input
        .get("package_manager_output")
        .and_then(Value::as_str)
        .filter(|output| !output.trim().is_empty())
    {
        analyzed = true;
        let report = analyze_package_manager_output(output, manifest, package_manager);
        commands.extend(report.commands);
    }

    if !analyzed {
        let report = analyze_dependency_diagnostics(&[], manifest, package_manager);
        commands.extend(report.commands);
    }

    Ok(commands)
}

fn parse_issues(value: &Value) -> Result<(Vec<DependencyIssue>, Vec<Diagnostic>)> {
    let array = value
        .as_array()
        .or_else(|| value.get("issues").and_then(Value::as_array))
        .ok_or_else(|| anyhow::anyhow!("issues must be an array of dependency issues"))?;

    let mut issues = Vec::new();
    let mut diagnostics = Vec::new();
    for (index, entry) in array.iter().enumerate() {
        if entry.get("kind").is_some() {
            let issue: DependencyIssue =
                serde_json::from_value(entry.clone()).map_err(|error| {
                    anyhow::anyhow!("invalid dependency issue at issues[{index}]: {error}")
                })?;
            issues.push(issue);
        } else {
            let diagnostic: Diagnostic =
                serde_json::from_value(entry.clone()).map_err(|error| {
                    anyhow::anyhow!("invalid diagnostic at issues[{index}]: {error}")
                })?;
            diagnostics.push(diagnostic);
        }
    }
    Ok((issues, diagnostics))
}

fn timeout_seconds(input: &Value) -> u64 {
    let default = (CodingPolicy::default().command_timeout_ms / 1_000).max(1);
    input
        .get("timeout_seconds")
        .and_then(Value::as_u64)
        .unwrap_or(default)
        .clamp(1, MAX_TIMEOUT_SECONDS)
}

fn output_payload(
    project_id: &str,
    package_manager: Option<PackageManager>,
    dry_run: bool,
    planned: &[String],
    execution: Option<&FixExecution>,
) -> Value {
    let executed = execution.is_some() && !planned.is_empty();
    let applied = execution.is_some_and(|execution| execution.applied);
    let stopped_at = execution.and_then(|execution| execution.stopped_at);
    let stopped_command = stopped_at.and_then(|index| planned.get(index)).cloned();
    let outcomes = execution
        .map(|execution| {
            execution
                .outcomes
                .iter()
                .map(FixOutcome::payload)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let summary = if dry_run {
        if planned.is_empty() {
            "No dependency fixes to plan.".to_string()
        } else {
            format!(
                "Dry run: {} dependency fix command(s) planned; no commands executed.",
                planned.len()
            )
        }
    } else if planned.is_empty() {
        "No dependency fixes to apply.".to_string()
    } else if applied {
        format!("Applied {} dependency fix command(s).", planned.len())
    } else {
        let index = stopped_at.unwrap_or(0);
        let completed = execution.map(|execution| execution.outcomes.len());
        let completed = completed
            .unwrap_or_default()
            .saturating_sub(usize::from(stopped_at.is_some() && index < planned.len()));
        format!(
            "Stopped at command {} of {}: {}. Applied {completed} command(s) successfully.",
            index + 1,
            planned.len(),
            stopped_command.as_deref().unwrap_or("unknown command")
        )
    };

    json!({
        "projectId": project_id,
        "packageManager": package_manager_label(package_manager),
        "dryRun": dry_run,
        "plannedCommands": planned,
        "executed": executed,
        "applied": applied,
        "stoppedAt": stopped_at,
        "stoppedCommand": stopped_command,
        "outcomes": outcomes,
        "summary": summary
    })
}

fn package_manager_label(package_manager: Option<PackageManager>) -> Value {
    match package_manager {
        Some(PackageManager::Pnpm) => json!("pnpm"),
        Some(PackageManager::Npm) => json!("npm"),
        Some(PackageManager::Yarn) => json!("yarn"),
        Some(PackageManager::Bun) => json!("bun"),
        None => Value::Null,
    }
}

/// Validate one analyzer-produced command and return its normalized form.
///
/// The grammar is deliberately tiny: a known package manager, `add` (with an
/// optional `-D`/`-d`) or `install`, and validated package specs. Anything that
/// could become a second shell command, a script invocation, a removal, or a
/// non-registry spec is rejected.
fn validate_fix_command(command: &str) -> Result<String> {
    let command = command.trim();
    anyhow::ensure!(!command.is_empty(), "command must not be empty");
    anyhow::ensure!(
        !command.chars().any(char::is_control),
        "command must be a single logical line"
    );
    for character in command.chars() {
        anyhow::ensure!(
            !matches!(
                character,
                ';' | '&'
                    | '|'
                    | '`'
                    | '$'
                    | '('
                    | ')'
                    | '<'
                    | '>'
                    | '{'
                    | '}'
                    | '['
                    | ']'
                    | '*'
                    | '?'
                    | '!'
                    | '#'
                    | '"'
                    | '\''
                    | '\\'
                    | ','
                    | '%'
            ),
            "command contains unsupported character `{character}`"
        );
    }

    let tokens = command.split_whitespace().collect::<Vec<_>>();
    anyhow::ensure!(!tokens.is_empty(), "command must not be empty");
    let manager = tokens[0];
    let verb = tokens
        .get(1)
        .copied()
        .ok_or_else(|| anyhow::anyhow!("missing package manager subcommand"))?;
    let arguments = &tokens[2..];

    match (manager, verb) {
        ("npm", "install") => validate_npm_install(arguments)?,
        ("pnpm" | "yarn", "add") => validate_add(arguments, "-D")?,
        ("bun", "add") => validate_add(arguments, "-d")?,
        ("pnpm" | "yarn" | "bun", "install") => {
            anyhow::ensure!(
                arguments.is_empty(),
                "`{manager} install` does not accept additional arguments"
            );
        }
        ("pnpm" | "npm" | "yarn" | "bun", _) => anyhow::bail!(
            "only add/install commands are allowed; `{manager} {verb}` is not supported"
        ),
        _ => anyhow::bail!("unsupported package manager or command `{manager}`"),
    }

    Ok(tokens.join(" "))
}

fn validate_npm_install(arguments: &[&str]) -> Result<()> {
    if arguments.is_empty() {
        return Ok(());
    }
    let specs = if arguments[0] == "-D" {
        anyhow::ensure!(
            arguments.len() > 1,
            "npm install -D requires at least one package"
        );
        &arguments[1..]
    } else {
        arguments
    };
    validate_specs(specs)
}

fn validate_add(arguments: &[&str], dev_flag: &str) -> Result<()> {
    anyhow::ensure!(!arguments.is_empty(), "add requires at least one package");
    let specs = if arguments[0] == dev_flag {
        anyhow::ensure!(
            arguments.len() > 1,
            "{dev_flag} requires at least one package"
        );
        &arguments[1..]
    } else if arguments[0].starts_with('-') {
        anyhow::bail!("unsupported package manager flag `{}`", arguments[0]);
    } else {
        arguments
    };
    validate_specs(specs)
}

fn validate_specs(specs: &[&str]) -> Result<()> {
    anyhow::ensure!(!specs.is_empty(), "at least one package is required");
    for spec in specs {
        validate_package_spec(spec)?;
    }
    Ok(())
}

fn validate_package_spec(spec: &str) -> Result<()> {
    anyhow::ensure!(!spec.is_empty(), "package spec must not be empty");
    anyhow::ensure!(
        !spec.starts_with('-'),
        "package spec must not be a flag: `{spec}`"
    );
    anyhow::ensure!(
        !spec.chars().any(char::is_whitespace),
        "package spec must not contain whitespace"
    );

    let (name, version) =
        split_package_spec(spec).ok_or_else(|| anyhow::anyhow!("invalid package spec `{spec}`"))?;
    anyhow::ensure!(
        is_valid_package_name(name),
        "unsupported package name `{name}`"
    );
    if let Some(version) = version {
        anyhow::ensure!(!version.is_empty(), "empty package version in `{spec}`");
        anyhow::ensure!(
            is_valid_version(version),
            "unsupported package version `{version}`"
        );
    }
    Ok(())
}

fn split_package_spec(spec: &str) -> Option<(&str, Option<&str>)> {
    if let Some(rest) = spec.strip_prefix('@') {
        if let Some(index) = rest.find('@') {
            let index = index + 1;
            let name = &spec[..index];
            let version = &spec[index + 1..];
            return (!name.is_empty() && !version.is_empty()).then_some((name, Some(version)));
        }
        return Some((spec, None));
    }

    match spec.find('@') {
        Some(index) => {
            let name = &spec[..index];
            let version = &spec[index + 1..];
            (!name.is_empty() && !version.is_empty()).then_some((name, Some(version)))
        }
        None => Some((spec, None)),
    }
}

fn is_valid_package_name(name: &str) -> bool {
    if let Some(rest) = name.strip_prefix('@') {
        let Some((scope, package)) = rest.split_once('/') else {
            return false;
        };
        !scope.is_empty()
            && !package.is_empty()
            && !package.contains('/')
            && is_name_component(scope)
            && is_name_component(package)
    } else {
        !name.is_empty() && !name.contains('/') && is_name_component(name)
    }
}

fn is_name_component(component: &str) -> bool {
    component
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
}

fn is_valid_version(version: &str) -> bool {
    version.chars().all(|character| {
        character.is_ascii_alphanumeric()
            || matches!(character, '.' | '-' | '+' | '^' | '~' | '=' | '_')
    })
}

struct FixExecution {
    applied: bool,
    stopped_at: Option<usize>,
    outcomes: Vec<FixOutcome>,
}

/// Why a command stopped the plan. `completed` is the only success reason;
/// every other reason makes the execution stop at that command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CommandOutcomeReason {
    Completed,
    SpawnError,
    Timeout,
    NonZeroExit,
    Cancelled,
}

impl CommandOutcomeReason {
    fn label(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::SpawnError => "spawn_error",
            Self::Timeout => "timeout",
            Self::NonZeroExit => "non_zero_exit",
            Self::Cancelled => "cancelled",
        }
    }
}

struct FixOutcome {
    command: String,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
    cancelled: bool,
    duration_ms: u64,
    reason: CommandOutcomeReason,
}

impl FixOutcome {
    fn cancelled(command: &str) -> Self {
        Self {
            command: command.to_string(),
            exit_code: None,
            stdout: String::new(),
            stderr: "dependency fix cancelled before command start".into(),
            timed_out: false,
            cancelled: true,
            duration_ms: 0,
            reason: CommandOutcomeReason::Cancelled,
        }
    }

    fn succeeded(&self) -> bool {
        self.reason == CommandOutcomeReason::Completed && self.exit_code == Some(0)
    }

    fn payload(&self) -> Value {
        json!({
            "command": self.command,
            "exitCode": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "timedOut": self.timed_out,
            "cancelled": self.cancelled,
            "durationMs": self.duration_ms,
            "reason": self.reason.label()
        })
    }
}

struct CommandRun {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
    cancelled: bool,
    spawn_error: bool,
    duration_ms: u64,
}

impl CommandRun {
    fn reason(&self) -> CommandOutcomeReason {
        if self.cancelled {
            CommandOutcomeReason::Cancelled
        } else if self.timed_out {
            CommandOutcomeReason::Timeout
        } else if self.spawn_error {
            CommandOutcomeReason::SpawnError
        } else if self.exit_code == Some(0) {
            CommandOutcomeReason::Completed
        } else if self.exit_code.is_some() {
            CommandOutcomeReason::NonZeroExit
        } else {
            CommandOutcomeReason::SpawnError
        }
    }
}

#[async_trait]
trait FixCommandExecutor: Send + Sync {
    async fn run(&self, command: &str) -> Result<CommandRun>;
}

async fn run_commands(
    commands: &[String],
    executor: &dyn FixCommandExecutor,
    abort: Option<&CancellationToken>,
) -> FixExecution {
    let mut outcomes = Vec::new();
    let mut stopped_at = None;

    for (index, command) in commands.iter().enumerate() {
        if abort.is_some_and(CancellationToken::is_cancelled) {
            outcomes.push(FixOutcome::cancelled(command));
            stopped_at = Some(index);
            break;
        }

        let run = executor.run(command).await;
        let outcome = match run {
            Ok(run) => {
                let reason = run.reason();
                FixOutcome {
                    command: command.clone(),
                    exit_code: run.exit_code,
                    stdout: run.stdout,
                    stderr: run.stderr,
                    timed_out: run.timed_out,
                    cancelled: run.cancelled,
                    duration_ms: run.duration_ms,
                    reason,
                }
            }
            Err(error) => FixOutcome {
                command: command.clone(),
                exit_code: None,
                stdout: String::new(),
                stderr: error.to_string(),
                timed_out: false,
                cancelled: false,
                duration_ms: 0,
                reason: CommandOutcomeReason::SpawnError,
            },
        };
        let succeeded = outcome.succeeded();
        outcomes.push(outcome);
        if !succeeded {
            stopped_at = Some(index);
            break;
        }
    }

    FixExecution {
        applied: !commands.is_empty() && stopped_at.is_none(),
        stopped_at,
        outcomes,
    }
}

struct ManagedCommandExecutor<'a> {
    services: &'a ToolServices,
    project_id: &'a str,
    root: &'a Path,
    timeout_seconds: u64,
}

#[async_trait]
impl FixCommandExecutor for ManagedCommandExecutor<'_> {
    async fn run(&self, command: &str) -> Result<CommandRun> {
        if self
            .services
            .abort
            .as_ref()
            .is_some_and(|abort| abort.is_cancelled())
        {
            return Ok(CommandRun {
                exit_code: None,
                stdout: String::new(),
                stderr: "dependency fix cancelled before command start".into(),
                timed_out: false,
                cancelled: true,
                spawn_error: false,
                duration_ms: 0,
            });
        }

        let spill_dir = self.services.store.data_dir().join("tool-results");
        let started = Instant::now();
        let value = run_managed_command(
            command,
            self.root,
            self.timeout_seconds,
            Some(self.project_id),
            false,
            Some(self.root),
            Some(self.services.projects.clone()),
            CommandPolicy::Project,
            Some(&spill_dir),
        )
        .await?;

        Ok(CommandRun {
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
            spawn_error: value.get("reason").and_then(Value::as_str) == Some("spawn_error"),
            duration_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::HostBridge;
    use serde_json::json;
    use std::collections::VecDeque;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

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

    fn write_manifest(project: &Path, package_manager: &str) {
        std::fs::write(
            project.join("package.json"),
            json!({
                "name": "alpha",
                "packageManager": package_manager
            })
            .to_string(),
        )
        .unwrap();
    }

    fn dependency_issue(command: &str) -> Value {
        json!({
            "kind": "missingPackage",
            "package": "left-pad",
            "message": "Cannot find module 'left-pad'.",
            "confidence": 0.9,
            "suggestedFix": {
                "action": "install",
                "package": "left-pad",
                "version": null,
                "command": command,
                "reason": "test"
            }
        })
    }

    #[tokio::test]
    async fn dry_run_returns_the_plan_without_executing() {
        let temp = tempfile::tempdir().unwrap();
        let (services, project) = services(temp.path());
        write_manifest(&project, "pnpm@9.0.0");

        let result = CodingFixDependenciesTool
            .execute(
                json!({
                    "project_id": "alpha",
                    "issues": [
                        dependency_issue("pnpm add left-pad"),
                        dependency_issue("pnpm add left-pad")
                    ],
                    "dry_run": true
                }),
                &services,
            )
            .await
            .unwrap();

        assert_eq!(result["dryRun"], true);
        assert_eq!(result["packageManager"], "pnpm");
        assert_eq!(result["plannedCommands"], json!(["pnpm add left-pad"]));
        assert_eq!(result["executed"], false);
        assert_eq!(result["applied"], false);
        assert_eq!(result["stoppedAt"], Value::Null);
        assert_eq!(result["outcomes"], json!([]));
    }

    #[tokio::test]
    async fn confirm_is_required_for_execution() {
        let temp = tempfile::tempdir().unwrap();
        let (services, project) = services(temp.path());
        write_manifest(&project, "pnpm@9.0.0");

        let error = CodingFixDependenciesTool
            .execute(
                json!({
                    "project_id": "alpha",
                    "issues": [dependency_issue("pnpm add left-pad")],
                    "dry_run": false
                }),
                &services,
            )
            .await
            .unwrap_err();

        assert!(error.to_string().contains("confirm must be true"));
    }

    #[tokio::test]
    async fn cancelled_execution_reports_cancelled_without_running_commands() {
        let temp = tempfile::tempdir().unwrap();
        let (mut services, project) = services(temp.path());
        write_manifest(&project, "pnpm@9.0.0");
        let abort = CancellationToken::new();
        abort.cancel();
        services.abort = Some(abort);

        let result = CodingFixDependenciesTool
            .execute(
                json!({
                    "project_id": "alpha",
                    "issues": [dependency_issue("pnpm add left-pad")],
                    "dry_run": false,
                    "confirm": true
                }),
                &services,
            )
            .await
            .unwrap();

        assert_eq!(result["dryRun"], false);
        assert_eq!(result["applied"], false);
        assert_eq!(result["stoppedAt"], 0);
        assert_eq!(result["outcomes"][0]["command"], "pnpm add left-pad");
        assert_eq!(result["outcomes"][0]["exitCode"], Value::Null);
        assert_eq!(result["outcomes"][0]["cancelled"], true);
        assert_eq!(result["outcomes"][0]["timedOut"], false);
        assert_eq!(result["outcomes"][0]["reason"], "cancelled");
    }

    #[tokio::test]
    async fn plan_mode_rejects_the_tool() {
        let temp = tempfile::tempdir().unwrap();
        let (services, project) = services(temp.path());
        write_manifest(&project, "pnpm@9.0.0");
        assert!(services.enter_plan_mode("inspect"));

        let error = CodingFixDependenciesTool
            .execute(
                json!({
                    "project_id": "alpha",
                    "issues": [dependency_issue("pnpm add left-pad")],
                    "dry_run": true
                }),
                &services,
            )
            .await
            .unwrap_err();

        assert!(error.to_string().contains("plan mode"));
    }

    #[test]
    fn allowlisted_commands_pass_validation() {
        for command in [
            "pnpm add left-pad",
            "pnpm add left-pad zod",
            "pnpm add -D @types/node@^20.0.0",
            "pnpm install",
            "npm install left-pad",
            "npm install -D typescript",
            "npm install",
            "yarn add react",
            "yarn add -D vitest@^1.0.0",
            "yarn install",
            "bun add zod",
            "bun add -d @types/bun",
            "bun install",
        ] {
            assert_eq!(validate_fix_command(command).unwrap(), command);
        }
    }

    #[test]
    fn unsafe_commands_and_specs_are_rejected() {
        for command in [
            "rm -rf /",
            "bash -c 'echo hi'",
            "pnpm remove left-pad",
            "npm uninstall left-pad",
            "yarn remove left-pad",
            "pnpm run build",
            "pnpm dlx create-app",
            "pnpm add ../local-package",
            "pnpm add ./local-package",
            "pnpm add /tmp/local-package",
            "pnpm add file:../local-package",
            "pnpm add https://example.com/package.tgz",
            "pnpm add git+https://github.com/user/repo.git",
            "pnpm add github:user/repo",
            "pnpm add user/repo",
            "pnpm add --force left-pad",
            "pnpm add -g left-pad",
            "npm install --global left-pad",
            "pnpm add left-pad; rm -rf /",
            "pnpm add $(whoami)",
            "pnpm add `whoami`",
            "pnpm add left-pad && echo done",
            "pnpm add left-pad@*",
            "pnpm add \"left-pad\"",
            "pnpm add",
            "pnpm add -D",
            "pnpm install extra",
            "npm install -D",
        ] {
            assert!(
                validate_fix_command(command).is_err(),
                "{command} should be rejected"
            );
        }
    }

    #[tokio::test]
    async fn unsafe_issue_commands_are_rejected_before_planning() {
        let temp = tempfile::tempdir().unwrap();
        let (services, project) = services(temp.path());
        write_manifest(&project, "pnpm@9.0.0");

        let error = CodingFixDependenciesTool
            .execute(
                json!({
                    "project_id": "alpha",
                    "issues": [dependency_issue("pnpm remove left-pad")],
                    "dry_run": true
                }),
                &services,
            )
            .await
            .unwrap_err();

        assert!(format!("{error:#}").contains("rejected dependency fix command"));
    }

    #[tokio::test]
    async fn package_manager_output_is_analyzed_and_planned() {
        let temp = tempfile::tempdir().unwrap();
        let (services, project) = services(temp.path());
        write_manifest(&project, "npm@10.0.0");

        let result = CodingFixDependenciesTool
            .execute(
                json!({
                    "project_id": "alpha",
                    "package_manager_output": "Cannot find module 'zod' or its corresponding type declarations.",
                    "dry_run": true
                }),
                &services,
            )
            .await
            .unwrap();

        assert_eq!(result["packageManager"], "npm");
        assert_eq!(result["plannedCommands"], json!(["npm install zod"]));
    }

    #[tokio::test]
    async fn package_manager_output_plans_multiple_commands() {
        let temp = tempfile::tempdir().unwrap();
        let (services, project) = services(temp.path());
        write_manifest(&project, "npm@10.0.0");

        let result = CodingFixDependenciesTool
            .execute(
                json!({
                    "project_id": "alpha",
                    "package_manager_output": "Cannot find module 'zod'.\nCannot find module 'left-pad'.",
                    "dry_run": true
                }),
                &services,
            )
            .await
            .unwrap();

        let planned = result["plannedCommands"].as_array().unwrap();
        assert_eq!(planned.len(), 2);
        assert!(planned.contains(&json!("npm install zod")));
        assert!(planned.contains(&json!("npm install left-pad")));
        assert_eq!(result["applied"], false);
        assert_eq!(result["outcomes"], json!([]));
    }

    #[tokio::test]
    async fn raw_diagnostics_are_analyzed_into_commands() {
        let temp = tempfile::tempdir().unwrap();
        let (services, project) = services(temp.path());
        write_manifest(&project, "yarn@4.0.0");

        let result = CodingFixDependenciesTool
            .execute(
                json!({
                    "project_id": "alpha",
                    "issues": [{
                        "severity": "error",
                        "message": "Cannot find module 'zod'.",
                        "code": "TS2307",
                        "file": "src/main.ts",
                        "line": 1,
                        "column": 1,
                        "confidence": 0.95
                    }],
                    "dry_run": true
                }),
                &services,
            )
            .await
            .unwrap();

        assert_eq!(result["packageManager"], "yarn");
        assert_eq!(result["plannedCommands"], json!(["yarn add zod"]));
    }

    #[derive(Clone, Copy)]
    enum FakeResponse {
        Success,
        Failure { exit_code: i32 },
        Timeout,
        Cancelled,
        SpawnError,
    }

    struct FakeRunner {
        calls: Mutex<Vec<String>>,
        responses: Mutex<VecDeque<FakeResponse>>,
        cancel_after: Option<usize>,
        abort: Option<CancellationToken>,
    }

    impl FakeRunner {
        fn new(responses: Vec<FakeResponse>) -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                responses: Mutex::new(responses.into()),
                cancel_after: None,
                abort: None,
            }
        }

        fn cancelling_after(mut self, abort: CancellationToken, calls: usize) -> Self {
            self.cancel_after = Some(calls);
            self.abort = Some(abort);
            self
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl FixCommandExecutor for FakeRunner {
        async fn run(&self, command: &str) -> Result<CommandRun> {
            let call_count = {
                let mut calls = self.calls.lock().unwrap();
                calls.push(command.to_string());
                calls.len()
            };
            if self.cancel_after == Some(call_count) {
                if let Some(abort) = &self.abort {
                    abort.cancel();
                }
            }

            let response = self
                .responses
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(FakeResponse::Success);
            Ok(match response {
                FakeResponse::Success => CommandRun {
                    exit_code: Some(0),
                    stdout: "ok".into(),
                    stderr: String::new(),
                    timed_out: false,
                    cancelled: false,
                    spawn_error: false,
                    duration_ms: 1,
                },
                FakeResponse::Failure { exit_code } => CommandRun {
                    exit_code: Some(exit_code),
                    stdout: String::new(),
                    stderr: "boom".into(),
                    timed_out: false,
                    cancelled: false,
                    spawn_error: false,
                    duration_ms: 2,
                },
                FakeResponse::Timeout => CommandRun {
                    exit_code: None,
                    stdout: String::new(),
                    stderr: "timed out".into(),
                    timed_out: true,
                    cancelled: false,
                    spawn_error: false,
                    duration_ms: 5,
                },
                FakeResponse::Cancelled => CommandRun {
                    exit_code: None,
                    stdout: String::new(),
                    stderr: "cancelled".into(),
                    timed_out: false,
                    cancelled: true,
                    spawn_error: false,
                    duration_ms: 0,
                },
                FakeResponse::SpawnError => return Err(anyhow::anyhow!("spawn failed")),
            })
        }
    }

    fn commands(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[tokio::test]
    async fn execution_runs_sequentially_and_stops_at_the_first_failure() {
        let executor = FakeRunner::new(vec![
            FakeResponse::Success,
            FakeResponse::Failure { exit_code: 1 },
            FakeResponse::Success,
        ]);
        let execution = run_commands(
            &commands(&["pnpm add a", "pnpm add b", "pnpm add c"]),
            &executor,
            None,
        )
        .await;

        assert_eq!(executor.calls(), ["pnpm add a", "pnpm add b"]);
        assert!(!execution.applied);
        assert_eq!(execution.stopped_at, Some(1));
        assert_eq!(execution.outcomes.len(), 2);
        assert_eq!(
            execution.outcomes[0].reason,
            CommandOutcomeReason::Completed
        );
        assert_eq!(execution.outcomes[1].exit_code, Some(1));
        assert_eq!(execution.outcomes[1].stderr, "boom");
        assert_eq!(
            execution.outcomes[1].reason,
            CommandOutcomeReason::NonZeroExit
        );
    }

    #[tokio::test]
    async fn timeout_stops_execution_and_is_not_applied() {
        let executor = FakeRunner::new(vec![FakeResponse::Success, FakeResponse::Timeout]);
        let execution =
            run_commands(&commands(&["pnpm add a", "pnpm add b"]), &executor, None).await;

        assert!(!execution.applied);
        assert_eq!(execution.stopped_at, Some(1));
        assert!(execution.outcomes[1].timed_out);
        assert_eq!(execution.outcomes[1].reason, CommandOutcomeReason::Timeout);
        assert_eq!(executor.calls(), ["pnpm add a", "pnpm add b"]);
    }

    #[tokio::test]
    async fn cancellation_stops_before_the_next_command() {
        let abort = CancellationToken::new();
        let executor = FakeRunner::new(vec![FakeResponse::Success, FakeResponse::Success])
            .cancelling_after(abort.clone(), 1);
        let execution = run_commands(
            &commands(&["pnpm add a", "pnpm add b", "pnpm add c"]),
            &executor,
            Some(&abort),
        )
        .await;

        assert_eq!(executor.calls(), ["pnpm add a"]);
        assert!(!execution.applied);
        assert_eq!(execution.stopped_at, Some(1));
        assert_eq!(execution.outcomes.len(), 2);
        assert!(execution.outcomes[1].cancelled);
        assert_eq!(
            execution.outcomes[1].reason,
            CommandOutcomeReason::Cancelled
        );
    }

    #[tokio::test]
    async fn cancellation_before_the_first_command_runs_nothing() {
        let abort = CancellationToken::new();
        abort.cancel();
        let executor = FakeRunner::new(vec![FakeResponse::Success]);
        let execution = run_commands(
            &commands(&["pnpm add a", "pnpm add b"]),
            &executor,
            Some(&abort),
        )
        .await;

        assert!(executor.calls().is_empty());
        assert!(!execution.applied);
        assert_eq!(execution.stopped_at, Some(0));
        assert_eq!(execution.outcomes.len(), 1);
        assert!(execution.outcomes[0].cancelled);
        assert_eq!(
            execution.outcomes[0].reason,
            CommandOutcomeReason::Cancelled
        );
    }

    #[tokio::test]
    async fn runner_reported_cancellation_stops_execution() {
        let executor = FakeRunner::new(vec![FakeResponse::Cancelled, FakeResponse::Success]);
        let execution =
            run_commands(&commands(&["pnpm add a", "pnpm add b"]), &executor, None).await;

        assert_eq!(executor.calls(), ["pnpm add a"]);
        assert!(!execution.applied);
        assert_eq!(execution.stopped_at, Some(0));
        assert!(execution.outcomes[0].cancelled);
        assert_eq!(
            execution.outcomes[0].reason,
            CommandOutcomeReason::Cancelled
        );
    }

    #[tokio::test]
    async fn spawn_errors_are_reported_and_stop_execution() {
        let executor = FakeRunner::new(vec![FakeResponse::SpawnError, FakeResponse::Success]);
        let execution =
            run_commands(&commands(&["pnpm add a", "pnpm add b"]), &executor, None).await;

        assert_eq!(executor.calls(), ["pnpm add a"]);
        assert!(!execution.applied);
        assert_eq!(execution.stopped_at, Some(0));
        assert_eq!(execution.outcomes[0].exit_code, None);
        assert!(execution.outcomes[0].stderr.contains("spawn failed"));
        assert_eq!(
            execution.outcomes[0].reason,
            CommandOutcomeReason::SpawnError
        );
    }

    #[tokio::test]
    async fn successful_execution_is_applied() {
        let executor = FakeRunner::new(vec![FakeResponse::Success, FakeResponse::Success]);
        let execution =
            run_commands(&commands(&["pnpm add a", "pnpm install"]), &executor, None).await;

        assert!(execution.applied);
        assert_eq!(execution.stopped_at, None);
        assert_eq!(execution.outcomes.len(), 2);
        assert!(execution.outcomes.iter().all(FixOutcome::succeeded));
        assert!(execution
            .outcomes
            .iter()
            .all(|outcome| outcome.reason == CommandOutcomeReason::Completed));
    }

    #[tokio::test]
    async fn outcome_payload_contains_execution_details() {
        let executor = FakeRunner::new(vec![
            FakeResponse::Success,
            FakeResponse::Failure { exit_code: 3 },
        ]);
        let execution =
            run_commands(&commands(&["pnpm add a", "pnpm add b"]), &executor, None).await;

        let success = execution.outcomes[0].payload();
        let mut keys = success
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>();
        keys.sort();
        assert_eq!(
            keys,
            [
                "cancelled",
                "command",
                "durationMs",
                "exitCode",
                "reason",
                "stderr",
                "stdout",
                "timedOut"
            ]
        );
        assert_eq!(success["command"], "pnpm add a");
        assert_eq!(success["exitCode"], 0);
        assert_eq!(success["stdout"], "ok");
        assert_eq!(success["stderr"], "");
        assert_eq!(success["timedOut"], false);
        assert_eq!(success["cancelled"], false);
        assert_eq!(success["durationMs"], 1);
        assert_eq!(success["reason"], "completed");

        let failure = execution.outcomes[1].payload();
        assert_eq!(failure["command"], "pnpm add b");
        assert_eq!(failure["exitCode"], 3);
        assert_eq!(failure["stdout"], "");
        assert_eq!(failure["stderr"], "boom");
        assert_eq!(failure["timedOut"], false);
        assert_eq!(failure["cancelled"], false);
        assert_eq!(failure["durationMs"], 2);
        assert_eq!(failure["reason"], "non_zero_exit");
    }

    #[tokio::test]
    async fn output_shape_is_stable() {
        let temp = tempfile::tempdir().unwrap();
        let (services, project) = services(temp.path());
        write_manifest(&project, "pnpm@9.0.0");

        let result = CodingFixDependenciesTool
            .execute(
                json!({
                    "project_id": "alpha",
                    "issues": [dependency_issue("pnpm add left-pad")]
                }),
                &services,
            )
            .await
            .unwrap();

        let mut keys = result
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>();
        keys.sort();
        assert_eq!(
            keys,
            [
                "applied",
                "dryRun",
                "executed",
                "outcomes",
                "packageManager",
                "plannedCommands",
                "projectId",
                "stoppedAt",
                "stoppedCommand",
                "summary"
            ]
        );

        assert_eq!(result["dryRun"], true);
        assert_eq!(result["stoppedCommand"], Value::Null);
        assert_eq!(
            result["summary"],
            "Dry run: 1 dependency fix command(s) planned; no commands executed."
        );
    }
}
