//! 命令执行：tokio 子进程 + 超时 + 输出捕获 + macOS Seatbelt 沙箱。
//!
//! 仅桌面/server 构建链接本 crate；移动端在握手时排除 subprocess 能力。

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;

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

/// 执行命令。`sandbox=true` 时在 macOS 上经 `sandbox-exec` 限制写入仅限
/// 工作目录与临时目录（对齐 TS 版 Seatbelt 方案）。
pub async fn run(req: &ExecRequest, workspace: &Path) -> Result<ExecResult> {
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
        .stdin(std::process::Stdio::null())
        .spawn()
        .with_context(|| format!("spawn {}", req.program))?;

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

    let timed_out;
    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => {
            timed_out = false;
            Some(status)
        }
        Ok(Err(e)) => return Err(e).context("wait child"),
        Err(_) => {
            timed_out = true;
            let _ = child.kill().await;
            None
        }
    };

    let stdout = read_stdout.await.unwrap_or_default();
    let stderr = read_stderr.await.unwrap_or_default();
    // 输出截断保护
    let clamp = |s: String| {
        if s.len() > 200_000 {
            format!("{}…(truncated)", &s[..200_000])
        } else {
            s
        }
    };

    Ok(ExecResult {
        exit_code: status.map(|s| s.code().unwrap_or(-1) as i64).unwrap_or(-1),
        stdout: clamp(stdout),
        stderr: clamp(stderr),
        timed_out,
        duration_ms: started.elapsed().as_millis() as u64,
    })
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
            args: vec!["-c".into(), "echo x > /Users/tanyafang/seatbelt-probe".into()],
            cwd: None,
            env: Default::default(),
            timeout_secs: Some(10),
            sandbox: true,
        };
        let _ = result;
        let result2 = run(&req2, dir.path()).await.unwrap();
        assert_ne!(result2.exit_code, 0, "seatbelt should block write outside workspace");
    }
}
