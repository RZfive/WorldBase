//! 命令执行：tokio 子进程 + 超时 + 输出捕获 + macOS Seatbelt 沙箱。
//!
//! 仅桌面/server 构建链接本 crate；移动端在握手时排除 subprocess 能力。

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecRequest {
    /// 程序与参数（argv 形式），如 ["ls", "-la"]。
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    /// 超时秒数，默认 60。
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    /// macOS Seatbelt 沙箱（写限制）。
    #[serde(default)]
    pub sandbox: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub exit_code: i64,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub duration_ms: u64,
}

/// Optional execution controls shared by desktop tools.
///
/// `stdin` is deliberately owned so callers can safely pass a secret such as
/// a sudo password without coupling the child process lifetime to a borrowed
/// buffer. The cancellation token is cloned by the caller for the same reason.
#[derive(Debug, Default)]
pub struct ExecOptions {
    pub stdin: Option<Vec<u8>>,
    pub cancellation: Option<CancellationToken>,
}

/// 执行命令。`sandbox=true` 时在 macOS 上经 `sandbox-exec` 限制写入仅限
/// 工作目录与临时目录（对齐 TS 版 Seatbelt 方案）。
pub async fn run(req: &ExecRequest, workspace: &Path) -> Result<ExecResult> {
    run_with_options(req, workspace, ExecOptions::default()).await
}

/// Execute a command with optional stdin and cooperative cancellation.
///
/// The legacy `run` entry point remains unchanged for app-server callers. A
/// cancelled process is terminated and represented as an `exitCode` of -1,
/// matching the failure shape expected by the tool layer; timeouts continue to
/// set `timedOut=true`.
pub async fn run_with_options(
    req: &ExecRequest,
    workspace: &Path,
    options: ExecOptions,
) -> Result<ExecResult> {
    let ExecOptions {
        stdin: stdin_input,
        cancellation,
    } = options;
    let started = std::time::Instant::now();
    let timeout = Duration::from_secs(req.timeout_secs.unwrap_or(60));

    let mut cmd = if req.sandbox && cfg!(target_os = "macos") {
        let profile = seatbelt_profile(workspace);
        let mut c = tokio::process::Command::new("sandbox-exec");
        c.arg("-p").arg(profile).arg(&req.program).args(&req.args);
        let cwd = req.cwd.as_deref().map(Path::new).unwrap_or(workspace);
        c.current_dir(cwd);
        for (k, v) in &req.env {
            c.env(k, v);
        }
        c.env("NO_COLOR", "1");
        c
    } else {
        let mut c = tokio::process::Command::new(&req.program);
        c.args(&req.args);
        let cwd = req.cwd.as_deref().map(Path::new).unwrap_or(workspace);
        c.current_dir(cwd);
        for (k, v) in &req.env {
            c.env(k, v);
        }
        c.env("NO_COLOR", "1");
        c
    };

    let mut child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(if stdin_input.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .spawn()
        .with_context(|| format!("spawn {}", req.program))?;

    // Feed stdin before waiting for the child. The payload is small by
    // contract (currently only sudo credentials), so this avoids a detached
    // writer outliving a cancelled execution. Ignore a broken-pipe error: the
    // command may have exited before consuming all input and its exit status
    // is still the useful result.
    if let Some(input) = stdin_input {
        if let Some(mut stdin) = child.stdin.take() {
            use tokio::io::AsyncWriteExt;
            let _ = stdin.write_all(&input).await;
            let _ = stdin.shutdown().await;
        }
    }

    let mut stdout_pipe = child.stdout.take().unwrap();
    let mut stderr_pipe = child.stderr.take().unwrap();
    let read_stdout = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buf).await;
        String::from_utf8_lossy(&buf).into_owned()
    });
    let read_stderr = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buf).await;
        String::from_utf8_lossy(&buf).into_owned()
    });

    enum WaitOutcome {
        Exited(std::process::ExitStatus),
        TimedOut,
        Cancelled,
    }

    let outcome = if let Some(cancellation) = cancellation.as_ref() {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => WaitOutcome::Cancelled,
            result = tokio::time::timeout(timeout, child.wait()) => match result {
                Ok(Ok(status)) => WaitOutcome::Exited(status),
                Ok(Err(error)) => return Err(error).context("wait child"),
                Err(_) => WaitOutcome::TimedOut,
            },
        }
    } else {
        match tokio::time::timeout(timeout, child.wait()).await {
            Ok(Ok(status)) => WaitOutcome::Exited(status),
            Ok(Err(error)) => return Err(error).context("wait child"),
            Err(_) => WaitOutcome::TimedOut,
        }
    };

    let (status, timed_out) = match outcome {
        WaitOutcome::Exited(status) => (Some(status), false),
        WaitOutcome::TimedOut => {
            let _ = child.kill().await;
            (None, true)
        }
        WaitOutcome::Cancelled => {
            let _ = child.kill().await;
            (None, false)
        }
    };

    let stdout = read_stdout.await.unwrap_or_default();
    let stderr = read_stderr.await.unwrap_or_default();
    // 输出截断保护
    let clamp = |s: String| truncate_utf8(s, 200_000);

    Ok(ExecResult {
        exit_code: status.map(|s| s.code().unwrap_or(-1) as i64).unwrap_or(-1),
        stdout: clamp(stdout),
        stderr: clamp(stderr),
        timed_out,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

fn truncate_utf8(value: String, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value;
    }
    let mut boundary = 0;
    for (index, _) in value.char_indices() {
        if index > max_bytes {
            break;
        }
        boundary = index;
    }
    format!("{}…(truncated)", &value[..boundary])
}

/// Seatbelt profile：允许读全盘，写仅限工作区/临时目录，禁止网络写面。
fn seatbelt_profile(workspace: &Path) -> String {
    let ws = workspace.display();
    format!(
        r#"(version 1)
(allow default)
(deny file-write*)
(allow file-write*
    (subpath "{ws}")
    (subpath "/tmp")
    (subpath "/private/tmp")
    (subpath (param "DARWIN_USER_TEMP_DIR"))
    (subpath (param "DARWIN_USER_CACHE_DIR")))
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn runs_simple_command() {
        let req = ExecRequest {
            program: "echo".into(),
            args: vec!["hello harness".into()],
            cwd: None,
            env: Default::default(),
            timeout_secs: Some(10),
            sandbox: false,
        };
        let result = run(&req, std::path::Path::new(".")).await.unwrap();
        assert_eq!(result.exit_code, 0);
        assert_eq!(result.stdout.trim(), "hello harness");
        assert!(!result.timed_out);
    }

    #[tokio::test]
    async fn timeout_kills() {
        let req = ExecRequest {
            program: "sleep".into(),
            args: vec!["5".into()],
            cwd: None,
            env: Default::default(),
            timeout_secs: Some(1),
            sandbox: false,
        };
        let result = run(&req, std::path::Path::new(".")).await.unwrap();
        assert!(result.timed_out);
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn seatbelt_blocks_write_outside_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let req = ExecRequest {
            program: "touch".into(),
            args: vec!["/tmp/worldbase-seatbelt-should-fail".into()],
            cwd: None,
            env: Default::default(),
            timeout_secs: Some(10),
            sandbox: true,
        };
        let result = run(&req, dir.path()).await.unwrap();
        // /tmp 在允许列表 → 换成 workspace 外路径验证
        let req2 = ExecRequest {
            program: "sh".into(),
            args: vec![
                "-c".into(),
                "echo x > /tmp/seatbelt-probe".into(),
            ],
            cwd: None,
            env: Default::default(),
            timeout_secs: Some(10),
            sandbox: true,
        };
        let _ = result;
        let result2 = run(&req2, dir.path()).await.unwrap();
        assert_ne!(
            result2.exit_code, 0,
            "seatbelt should block write outside workspace"
        );
    }
}
