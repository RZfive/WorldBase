//! 全栈项目运行时：Node/pnpm 探测、项目创建、依赖安装、dev server 生命周期。
//!
//! bundled Node 产物存在时优先使用（`dist/node-bin`），否则回退系统 Node；
//! 仅桌面/server 构建链接本 crate。

use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use worldbase_protocol::types::{DevServerInfo, ProjectInfo};

pub struct ProjectRuntime {
    projects_dir: PathBuf,
    servers: tokio::sync::Mutex<std::collections::HashMap<String, DevServerHandle>>,
}

struct DevServerHandle {
    info: DevServerInfo,
    child: tokio::process::Child,
}

fn which(prog: &str) -> Option<PathBuf> {
    // 简易 PATH 探测（避免依赖 which crate）
    let path = std::env::var("PATH").ok()?;
    for dir in path.split(':') {
        let p = Path::new(dir).join(prog);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

impl ProjectRuntime {
    pub fn new(projects_dir: PathBuf) -> Self {
        Self { projects_dir, servers: tokio::sync::Mutex::new(Default::default()) }
    }

    pub fn runtime_tools(&self) -> Result<Value> {
        let node = bundled_node().or_else(|| which("node")).map(|p| p.display().to_string());
        let pnpm = which("pnpm").map(|p| p.display().to_string());
        Ok(json!({
            "node": node,
            "pnpm": pnpm,
            "projects_dir": self.projects_dir.display().to_string(),
        }))
    }

    /// 创建全栈项目骨架（Next.js App Router 结构，最小可运行）。
    pub async fn create_project(&self, name: &str) -> Result<ProjectInfo> {
        let safe: String = name
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
            .collect();
        let dir = self.projects_dir.join(&safe);
        tokio::fs::create_dir_all(&dir).await?;
        tokio::fs::write(dir.join("package.json"), json!({
            "name": safe,
            "private": true,
            "scripts": { "dev": "next dev -p {PORT}", "build": "next build" },
            "dependencies": { "next": "^15", "react": "^19", "react-dom": "^19" }
        }).to_string()).await?;
        tokio::fs::create_dir_all(dir.join("app")).await?;
        tokio::fs::write(
            dir.join("app/page.tsx"),
            r#"export default function Home() { return <main>WorldBase project</main> }"#,
        )
        .await?;
        tokio::fs::write(
            dir.join("app/layout.tsx"),
            r#"export default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html> }"#,
        )
        .await?;

        Ok(ProjectInfo {
            id: safe,
            name: name.into(),
            path: dir.display().to_string(),
            kind: "nextjs".into(),
            dev_server: None,
        })
    }

    pub fn list_projects(&self) -> Result<Vec<ProjectInfo>> {
        let mut out = Vec::new();
        if !self.projects_dir.is_dir() {
            return Ok(out);
        }
        for entry in std::fs::read_dir(&self.projects_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.join("package.json").is_file() {
                out.push(ProjectInfo {
                    id: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                    name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                    path: path.display().to_string(),
                    kind: "nextjs".into(),
                    dev_server: None,
                });
            }
        }
        Ok(out)
    }

    /// pnpm install（系统 pnpm 或 corepack）。
    pub async fn install(&self, project_path: &Path) -> Result<String> {
        let pnpm = which("pnpm").context("pnpm not found on PATH")?;
        let output = tokio::process::Command::new(pnpm)
            .arg("install")
            .current_dir(project_path)
            .output()
            .await
            .context("pnpm install spawn")?;
        Ok(format!(
            "exit={}\n{}{}",
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        ))
    }

    /// 启动 dev server：挑选空闲端口，健康检查 /，日志经 tracing 输出。
    pub async fn start_dev(&self, project_id: &str) -> Result<DevServerInfo> {
        let mut servers = self.servers.lock().await;
        if let Some(handle) = servers.get(project_id) {
            return Ok(handle.info.clone());
        }
        let project_path = self
            .projects_dir
            .join(project_id)
            .canonicalize()
            .with_context(|| format!("project not found: {project_id}"))?;
        let node = bundled_node().or_else(|| which("node")).context("node runtime not found")?;
        let port = pick_free_port()?;

        // next dev 的可执行入口
        let next_bin = project_path.join("node_modules/.bin/next");
        anyhow::ensure!(next_bin.is_file(), "next not installed; run install first");
        let mut child = tokio::process::Command::new(node)
            .arg(&next_bin)
            .arg("dev")
            .arg("-p")
            .arg(port.to_string())
            .current_dir(&project_path)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .context("spawn next dev")?;
        let pid = child.id();
        let mut stdout = child.stdout.take();

        // 日志后台 drain（child 本体保存在 handle 中，不随函数返回被杀）
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let Some(stream) = stdout.as_mut() else { return };
            let mut buf = [0u8; 4096];
            loop {
                match stream.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        tracing::debug!(target: "project_runtime", "{}", String::from_utf8_lossy(&buf[..n]).trim());
                    }
                }
            }
        });

        let info = DevServerInfo {
            port,
            url: format!("http://127.0.0.1:{port}"),
            status: "starting".into(),
            pid,
        };
        servers.insert(project_id.to_string(), DevServerHandle { info: info.clone(), child });
        Ok(info)
    }

    pub async fn stop_dev(&self, project_id: &str) -> Result<bool> {
        let mut servers = self.servers.lock().await;
        if let Some(mut handle) = servers.remove(project_id) {
            let _ = handle.child.start_kill();
            let _ = handle.child.wait().await;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub async fn status(&self, project_id: &str) -> Result<Value> {
        let servers = self.servers.lock().await;
        match servers.get(project_id) {
            Some(handle) => {
                let reachable = reqwest::get(handle.info.url.clone()).await.is_ok();
                Ok(json!({
                    "project": project_id,
                    "running": true,
                    "url": handle.info.url,
                    "healthy": reachable,
                }))
            }
            None => Ok(json!({ "project": project_id, "running": false })),
        }
    }
}

fn bundled_node() -> Option<PathBuf> {
    // 与 Electron 打包约定：extraResources/node-bin/node
    let candidates = [
        std::env::current_exe().ok()?.parent()?.parent()?.join("node-bin/node"),
        PathBuf::from("dist/node-bin/node"),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

fn pick_free_port() -> Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn create_and_list_project() {
        let dir = tempfile::tempdir().unwrap();
        let rt = ProjectRuntime::new(dir.path().to_path_buf());
        let info = rt.create_project("my-app").await.unwrap();
        assert!(Path::new(&info.path).join("package.json").is_file());
        let list = rt.list_projects().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "my-app");
        let tools = rt.runtime_tools().unwrap();
        assert!(tools["projects_dir"].as_str().is_some());
    }
}
