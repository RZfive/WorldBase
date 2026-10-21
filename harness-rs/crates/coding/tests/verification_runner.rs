use std::{collections::VecDeque, path::PathBuf, sync::Mutex};

use anyhow::Result;
use async_trait::async_trait;
use worldbase_coding::verification_runner::{
    run_profile, run_profile_with_timeout, VerificationExecutor,
};
use worldbase_coding::{
    CommandOutcome, PackageManager, ProjectKind, VerificationCheckKind, VerificationCommand,
    VerificationProfile,
};

#[derive(Debug, Clone)]
enum FakeReply {
    Outcome {
        exit_code: Option<i32>,
        stdout: &'static str,
        stderr: &'static str,
        timed_out: bool,
        cancelled: bool,
    },
    Error(&'static str),
}

impl FakeReply {
    fn success() -> Self {
        Self::Outcome {
            exit_code: Some(0),
            stdout: "",
            stderr: "",
            timed_out: false,
            cancelled: false,
        }
    }

    fn failure(stderr: &'static str) -> Self {
        Self::Outcome {
            exit_code: Some(1),
            stdout: "",
            stderr,
            timed_out: false,
            cancelled: false,
        }
    }

    fn timeout() -> Self {
        Self::Outcome {
            exit_code: None,
            stdout: "",
            stderr: "verification command timed out",
            timed_out: true,
            cancelled: false,
        }
    }

    fn cancelled() -> Self {
        Self::Outcome {
            exit_code: Some(0),
            stdout: "",
            stderr: "verification command cancelled",
            timed_out: false,
            cancelled: true,
        }
    }

    fn executor_error(message: &'static str) -> Self {
        Self::Error(message)
    }
}

struct FakeExecutor {
    replies: Mutex<VecDeque<FakeReply>>,
    calls: Mutex<Vec<VerificationCommand>>,
    timeouts: Mutex<Vec<u64>>,
}

impl FakeExecutor {
    fn new(replies: Vec<FakeReply>) -> Self {
        Self {
            replies: Mutex::new(replies.into()),
            calls: Mutex::new(Vec::new()),
            timeouts: Mutex::new(Vec::new()),
        }
    }

    fn calls(&self) -> Vec<VerificationCommand> {
        self.calls.lock().expect("calls lock").clone()
    }

    fn timeouts(&self) -> Vec<u64> {
        self.timeouts.lock().expect("timeouts lock").clone()
    }
}

#[async_trait]
impl VerificationExecutor for FakeExecutor {
    async fn execute(
        &self,
        command: &VerificationCommand,
        timeout_ms: u64,
    ) -> Result<CommandOutcome> {
        self.calls.lock().expect("calls lock").push(command.clone());
        self.timeouts
            .lock()
            .expect("timeouts lock")
            .push(timeout_ms);

        let reply = self
            .replies
            .lock()
            .expect("replies lock")
            .pop_front()
            .expect("fake executor received an unexpected command");

        match reply {
            FakeReply::Outcome {
                exit_code,
                stdout,
                stderr,
                timed_out,
                cancelled,
            } => Ok(CommandOutcome {
                command: command.clone(),
                exit_code,
                stdout: stdout.to_string(),
                stderr: stderr.to_string(),
                timed_out,
                cancelled,
                duration_ms: 1,
            }),
            FakeReply::Error(message) => Err(anyhow::anyhow!(message)),
        }
    }
}

fn command(description: &str, required: bool) -> VerificationCommand {
    VerificationCommand {
        kind: VerificationCheckKind::Test,
        program: "fake-verifier".to_string(),
        args: vec![description.to_string()],
        required,
        description: description.to_string(),
    }
}

fn profile(commands: Vec<VerificationCommand>) -> VerificationProfile {
    VerificationProfile {
        project_kind: ProjectKind::FrontendNode,
        package_manager: Some(PackageManager::Npm),
        root: PathBuf::from("/workspace"),
        commands,
        source: "verification runner test fixture".to_string(),
    }
}

#[tokio::test]
async fn success_runs_sequentially_and_passes() {
    let commands = vec![command("typecheck", true), command("test", true)];
    let expected_calls = commands.clone();
    let executor = FakeExecutor::new(vec![FakeReply::success(), FakeReply::success()]);

    let evidence = run_profile(&profile(commands), &executor, 10).await;

    assert!(evidence.passed);
    assert!(!evidence.cancelled);
    assert!(!evidence.timed_out);
    assert_eq!(evidence.outcomes.len(), 2);
    assert!(evidence.outcomes.iter().all(CommandOutcome::succeeded));
    assert!(evidence.diagnostics.is_empty());
    assert_eq!(executor.calls(), expected_calls);
    assert_eq!(
        executor.timeouts(),
        vec![
            worldbase_coding::verification_runner::DEFAULT_COMMAND_TIMEOUT_MS,
            worldbase_coding::verification_runner::DEFAULT_COMMAND_TIMEOUT_MS,
        ]
    );
}

#[tokio::test]
async fn required_failure_short_circuits_and_preserves_outcomes() {
    let commands = vec![command("typecheck", true), command("test", true)];
    let executor = FakeExecutor::new(vec![FakeReply::failure(
        "src/app.ts(3,4): error TS2322: Type mismatch",
    )]);

    let evidence = run_profile(&profile(commands), &executor, 10).await;

    assert!(!evidence.passed);
    assert_eq!(evidence.outcomes.len(), 1);
    assert_eq!(evidence.outcomes[0].exit_code, Some(1));
    assert_eq!(executor.calls().len(), 1);
    assert_eq!(evidence.diagnostics.len(), 1);
    assert_eq!(evidence.diagnostics[0].code.as_deref(), Some("TS2322"));
}

#[tokio::test]
async fn optional_failure_continues_and_required_success_still_passes() {
    let commands = vec![command("lint", false), command("test", true)];
    let executor = FakeExecutor::new(vec![
        FakeReply::failure("src/app.ts:2:3 error Unexpected token  no-unused-vars"),
        FakeReply::success(),
    ]);

    let evidence = run_profile(&profile(commands), &executor, 10).await;

    assert!(evidence.passed);
    assert_eq!(evidence.outcomes.len(), 2);
    assert_eq!(executor.calls().len(), 2);
    assert!(!evidence.outcomes[0].succeeded());
    assert!(evidence.outcomes[1].succeeded());
    assert_eq!(evidence.diagnostics.len(), 1);
}

#[tokio::test]
async fn timeout_and_cancellation_are_terminal_and_never_pass() {
    let timeout_executor = FakeExecutor::new(vec![FakeReply::timeout(), FakeReply::success()]);
    let timeout_evidence = run_profile(
        &profile(vec![command("test", true), command("build", true)]),
        &timeout_executor,
        10,
    )
    .await;

    assert!(!timeout_evidence.passed);
    assert!(timeout_evidence.timed_out);
    assert!(!timeout_evidence.cancelled);
    assert_eq!(timeout_evidence.outcomes.len(), 1);
    assert_eq!(timeout_executor.calls().len(), 1);
    assert_eq!(timeout_evidence.diagnostics.len(), 1);

    let cancel_executor = FakeExecutor::new(vec![FakeReply::cancelled(), FakeReply::success()]);
    let cancel_evidence = run_profile(
        &profile(vec![command("test", true), command("build", true)]),
        &cancel_executor,
        10,
    )
    .await;

    assert!(!cancel_evidence.passed);
    assert!(cancel_evidence.cancelled);
    assert!(!cancel_evidence.timed_out);
    assert_eq!(cancel_evidence.outcomes.len(), 1);
    assert_eq!(cancel_executor.calls().len(), 1);
    assert_eq!(cancel_evidence.diagnostics.len(), 1);
}

#[tokio::test]
async fn executor_errors_become_failed_outcomes() {
    let executor = FakeExecutor::new(vec![FakeReply::executor_error("executor unavailable")]);

    let evidence = run_profile(&profile(vec![command("test", true)]), &executor, 10).await;

    assert!(!evidence.passed);
    assert_eq!(evidence.outcomes.len(), 1);
    assert_eq!(evidence.outcomes[0].exit_code, None);
    assert!(!evidence.outcomes[0].timed_out);
    assert!(!evidence.outcomes[0].cancelled);
    assert!(evidence.outcomes[0]
        .stderr
        .contains("verification executor error: executor unavailable"));
    assert_eq!(evidence.diagnostics.len(), 1);
    assert_eq!(executor.calls().len(), 1);
}

#[tokio::test]
async fn max_commands_is_a_hard_cap_and_unrun_required_commands_fail_the_run() {
    let commands = vec![
        command("typecheck", true),
        command("lint", true),
        command("test", true),
    ];
    let executor = FakeExecutor::new(vec![
        FakeReply::success(),
        FakeReply::success(),
        FakeReply::success(),
    ]);

    let evidence = run_profile(&profile(commands), &executor, 2).await;

    assert!(!evidence.passed);
    assert_eq!(evidence.outcomes.len(), 2);
    assert_eq!(executor.calls().len(), 2);
    assert_eq!(executor.calls()[0].description, "typecheck");
    assert_eq!(executor.calls()[1].description, "lint");
}

#[tokio::test]
async fn duplicate_diagnostics_are_removed_in_first_seen_order() {
    let line = "src/app.ts(3,4): error TS2322: Type mismatch";
    let executor = FakeExecutor::new(vec![FakeReply::Outcome {
        exit_code: Some(1),
        stdout: line,
        stderr: line,
        timed_out: false,
        cancelled: false,
    }]);

    let evidence = run_profile(&profile(vec![command("typecheck", true)]), &executor, 10).await;

    assert!(!evidence.passed);
    assert_eq!(evidence.diagnostics.len(), 1);
    assert_eq!(evidence.diagnostics[0].message, "Type mismatch");
}

#[tokio::test]
async fn empty_profile_never_passes_and_explicit_timeout_reaches_executor() {
    let empty_executor = FakeExecutor::new(Vec::new());
    let empty_evidence = run_profile(&profile(Vec::new()), &empty_executor, 10).await;
    assert!(!empty_evidence.passed);
    assert!(empty_evidence.outcomes.is_empty());
    assert!(empty_executor.calls().is_empty());

    let executor = FakeExecutor::new(vec![FakeReply::success()]);
    let evidence =
        run_profile_with_timeout(&profile(vec![command("test", false)]), &executor, 10, 4_321)
            .await;
    assert!(evidence.passed);
    assert_eq!(executor.timeouts(), vec![4_321]);
}
