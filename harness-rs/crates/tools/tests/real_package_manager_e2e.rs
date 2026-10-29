use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use worldbase_tools::coding_fix::CodingFixDependenciesTool;
use worldbase_tools::{HostBridge, Tool, ToolServices};

const GATE_ENV: &str = "WORLDBASE_REAL_PM_E2E";
const INSTALLED_PACKAGE: &str = "is-number";
const LOCKFILES: &[&str] = &["pnpm-lock.yaml", "package-lock.json"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PackageManagerKind {
    Pnpm,
    Npm,
}

impl PackageManagerKind {
    fn binary(self) -> &'static str {
        match self {
            Self::Pnpm => "pnpm",
            Self::Npm => "npm",
        }
    }

    fn label(self) -> &'static str {
        self.binary()
    }

    fn add_command(self, package: &str) -> String {
        match self {
            Self::Pnpm => format!("pnpm add {package}"),
            Self::Npm => format!("npm install {package}"),
        }
    }
}

struct AvailablePackageManager {
    kind: PackageManagerKind,
    version: String,
}

impl AvailablePackageManager {
    fn package_manager_field(&self) -> String {
        format!("{}@{}", self.kind.label(), self.version)
    }
}

fn gate_enabled() -> bool {
    std::env::var(GATE_ENV)
        .map(|value| value == "1")
        .unwrap_or(false)
}

fn probe_package_manager(kind: PackageManagerKind) -> Option<AvailablePackageManager> {
    let output = Command::new(kind.binary())
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if version.is_empty() {
        return None;
    }
    Some(AvailablePackageManager { kind, version })
}

fn detect_package_manager() -> Option<AvailablePackageManager> {
    let pnpm = probe_package_manager(PackageManagerKind::Pnpm);
    let npm = probe_package_manager(PackageManagerKind::Npm);
    println!(
        "package managers: pnpm={}, npm={}",
        pnpm.as_ref()
            .map(|manager| manager.version.as_str())
            .unwrap_or("not found"),
        npm.as_ref()
            .map(|manager| manager.version.as_str())
            .unwrap_or("not found")
    );
    pnpm.or(npm)
}

struct Fixture {
    temp: tempfile::TempDir,
    project: PathBuf,
    services: ToolServices,
}

impl Fixture {
    fn new(package_manager: &AvailablePackageManager, project_id: &str) -> Self {
        let temp = tempfile::Builder::new()
            .prefix("worldbase-real-pm-e2e-")
            .tempdir()
            .expect("create temp project root");
        let workspace = temp.path().join("workspace");
        let projects = temp.path().join("projects");
        let project = projects.join(project_id);
        std::fs::create_dir_all(&workspace).expect("create workspace");
        std::fs::create_dir_all(&project).expect("create project");

        let manifest = json!({
            "name": format!(
                "worldbase-real-pm-e2e-{}-{}",
                project_id,
                std::process::id()
            ),
            "version": "1.0.0",
            "private": true,
            "packageManager": package_manager.package_manager_field()
        });
        std::fs::write(
            project.join("package.json"),
            serde_json::to_vec_pretty(&manifest).expect("serialize package.json"),
        )
        .expect("write package.json");

        let store = Arc::new(
            worldbase_memory::Store::open(&temp.path().join("store.sqlite"))
                .expect("open test store"),
        );
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

        Self {
            temp,
            project,
            services,
        }
    }

    fn root(&self) -> &Path {
        self.temp.path()
    }

    fn read_manifest(&self) -> Value {
        let text =
            std::fs::read_to_string(self.project.join("package.json")).expect("read package.json");
        serde_json::from_str(&text).expect("parse package.json")
    }
}

fn manifest_dependencies(manifest: &Value) -> Vec<String> {
    let mut names = [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
    ]
    .iter()
    .filter_map(|key| manifest.get(*key).and_then(Value::as_object))
    .flat_map(|dependencies| dependencies.keys().cloned())
    .collect::<Vec<_>>();
    names.sort();
    names
}

fn print_outcomes(label: &str, result: &Value) {
    println!(
        "{label}: applied={} packageManager={} elapsedOutcomes={}",
        result["applied"],
        result["packageManager"],
        result["outcomes"].as_array().map(Vec::len).unwrap_or(0)
    );
    for outcome in result["outcomes"].as_array().into_iter().flatten() {
        println!(
            "  command={} exitCode={} durationMs={} reason={} timedOut={} cancelled={}",
            outcome["command"],
            outcome["exitCode"],
            outcome["durationMs"],
            outcome["reason"],
            outcome["timedOut"],
            outcome["cancelled"]
        );
        let stdout = outcome["stdout"].as_str().unwrap_or_default().trim();
        let stderr = outcome["stderr"].as_str().unwrap_or_default().trim();
        if !stdout.is_empty() {
            println!("    stdout: {}", preview(stdout));
        }
        if !stderr.is_empty() {
            println!("    stderr: {}", preview(stderr));
        }
    }
}

fn preview(text: &str) -> String {
    const LIMIT: usize = 1500;
    if text.chars().count() <= LIMIT {
        return text.to_string();
    }
    let head = text.chars().take(LIMIT).collect::<String>();
    format!("{head}...[truncated]")
}

fn print_final_dependencies(project: &Path) {
    let text = std::fs::read_to_string(project.join("package.json")).expect("read package.json");
    let manifest: Value = serde_json::from_str(&text).expect("parse package.json");
    println!(
        "final dependency list: {:?}",
        manifest_dependencies(&manifest)
    );
    for key in ["dependencies", "devDependencies"] {
        let dependencies = manifest.get(key).cloned().unwrap_or_else(|| json!({}));
        println!("final {key}: {dependencies}");
    }
}

fn contains_dependency(manifest: &Value, package: &str) -> bool {
    [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
    ]
    .iter()
    .any(|key| {
        manifest
            .get(*key)
            .and_then(Value::as_object)
            .is_some_and(|dependencies| dependencies.contains_key(package))
    })
}

fn unique_missing_package() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time")
        .as_nanos();
    format!("worldbase-e2e-missing-{}-{nanos}", std::process::id()).to_ascii_lowercase()
}

async fn registry_reachable(package_manager: &AvailablePackageManager, cwd: &Path) -> bool {
    let mut command = tokio::process::Command::new(package_manager.kind.binary());
    match package_manager.kind {
        PackageManagerKind::Pnpm => {
            command.args(["view", INSTALLED_PACKAGE, "version"]);
        }
        PackageManagerKind::Npm => {
            command.args(["view", INSTALLED_PACKAGE, "version", "--silent"]);
        }
    }
    command
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    match tokio::time::timeout(Duration::from_secs(30), command.status()).await {
        Ok(Ok(status)) => {
            println!(
                "registry probe: {} view exitCode={:?}",
                package_manager.kind.label(),
                status.code()
            );
            status.success()
        }
        Ok(Err(error)) => {
            eprintln!("registry probe failed to spawn: {error}");
            false
        }
        Err(_) => {
            eprintln!("registry probe timed out after 30s");
            false
        }
    }
}

#[tokio::test]
async fn real_package_manager_installs_missing_dependency() {
    if !gate_enabled() {
        eprintln!("skipping real package-manager E2E: set {GATE_ENV}=1 to enable it");
        return;
    }
    let package_manager = detect_package_manager()
        .unwrap_or_else(|| panic!("{GATE_ENV}=1 but neither pnpm nor npm is available on PATH"));
    let fixture = Fixture::new(&package_manager, "alpha");
    println!(
        "using {} {} in {}",
        package_manager.kind.label(),
        package_manager.version,
        fixture.project.display()
    );

    let started = Instant::now();
    let result = CodingFixDependenciesTool
        .execute(
            json!({
                "project_id": "alpha",
                "package_manager_output": format!("Cannot find module '{INSTALLED_PACKAGE}'"),
                "dry_run": false,
                "confirm": true,
                "timeout_seconds": 120
            }),
            &fixture.services,
        )
        .await
        .expect("coding_fix_dependencies execution");
    println!("wall duration: {}ms", started.elapsed().as_millis());
    print_outcomes("install case", &result);
    print_final_dependencies(&fixture.project);

    let outcomes = result["outcomes"]
        .as_array()
        .expect("outcomes array in tool result");
    assert!(
        !outcomes.is_empty(),
        "expected at least one package-manager command: {result}"
    );
    assert!(
        outcomes.iter().any(|outcome| {
            outcome["exitCode"].as_i64() == Some(0) && outcome["reason"] == "completed"
        }),
        "expected at least one successful package-manager command: {result}"
    );
    assert_eq!(
        result["applied"], true,
        "tool did not report applied: {result}"
    );
    assert!(
        result["plannedCommands"]
            .as_array()
            .is_some_and(|planned| planned
                .contains(&json!(package_manager.kind.add_command(INSTALLED_PACKAGE)))),
        "expected {} in planned commands: {result}",
        package_manager.kind.add_command(INSTALLED_PACKAGE)
    );

    let manifest = fixture.read_manifest();
    assert!(
        contains_dependency(&manifest, INSTALLED_PACKAGE),
        "package.json does not contain {INSTALLED_PACKAGE}: {manifest}"
    );
    let installed_manifest = fixture
        .project
        .join("node_modules")
        .join(INSTALLED_PACKAGE)
        .join("package.json");
    assert!(
        installed_manifest.is_file(),
        "missing installed package manifest: {}",
        installed_manifest.display()
    );
    let lockfile = LOCKFILES
        .iter()
        .find(|name| fixture.project.join(name).is_file())
        .unwrap_or_else(|| panic!("no lockfile created in {}", fixture.project.display()));
    println!("lockfile: {lockfile}");
}

#[tokio::test]
async fn real_package_manager_failed_install_is_not_applied() {
    if !gate_enabled() {
        eprintln!("skipping real package-manager E2E: set {GATE_ENV}=1 to enable it");
        return;
    }
    let package_manager = detect_package_manager()
        .unwrap_or_else(|| panic!("{GATE_ENV}=1 but neither pnpm nor npm is available on PATH"));
    let fixture = Fixture::new(&package_manager, "beta");

    if !registry_reachable(&package_manager, fixture.root()).await {
        eprintln!(
            "skipping failure-safe case: npm registry is unreachable, so a network failure cannot be distinguished from a missing-package failure"
        );
        return;
    }

    let missing_package = unique_missing_package();
    println!(
        "using {} {} for missing package {missing_package}",
        package_manager.kind.label(),
        package_manager.version
    );
    let result = CodingFixDependenciesTool
        .execute(
            json!({
                "project_id": "beta",
                "package_manager_output": format!("Cannot find module '{missing_package}'"),
                "dry_run": false,
                "confirm": true,
                "timeout_seconds": 120
            }),
            &fixture.services,
        )
        .await
        .expect("coding_fix_dependencies execution");
    print_outcomes("failure case", &result);
    print_final_dependencies(&fixture.project);

    assert_eq!(
        result["applied"], false,
        "failed install must not report applied: {result}"
    );
    let outcomes = result["outcomes"]
        .as_array()
        .expect("outcomes array in tool result");
    assert!(
        !outcomes.is_empty(),
        "expected a failed package-manager command: {result}"
    );
    assert!(
        outcomes.iter().all(|outcome| {
            outcome["exitCode"].as_i64() != Some(0) || outcome["reason"] != "completed"
        }),
        "nonexistent package install unexpectedly succeeded: {result}"
    );
    let failed = outcomes.last().expect("failed outcome");
    assert_ne!(
        failed["reason"], "completed",
        "failure outcome was marked completed: {result}"
    );
    assert!(
        failed["exitCode"].as_i64() != Some(0),
        "failure outcome has a zero exit code: {result}"
    );

    let manifest = fixture.read_manifest();
    assert!(
        !contains_dependency(&manifest, &missing_package),
        "failed install modified package.json with {missing_package}: {manifest}"
    );
}
