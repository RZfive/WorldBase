use super::{Action, Geometry};
use anyhow::{bail, ensure, Context, Result};
#[cfg(target_os = "windows")]
use serde_json::{json, Value};
use std::process::Stdio;
use tokio::{
    io::AsyncReadExt,
    process::Command,
    time::{timeout, Duration},
};
use tokio_util::sync::CancellationToken;

pub(super) async fn output(command: &mut Command) -> Result<Vec<u8>> {
    command
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().context("start desktop backend")?;
    let stdout = child.stdout.take().context("backend stdout unavailable")?;
    let stderr = child.stderr.take().context("backend stderr unavailable")?;
    let result=timeout(Duration::from_secs(20),async {
        let read_out=async {let mut data=Vec::new();stdout.take(64*1024*1024+1).read_to_end(&mut data).await?;ensure!(data.len()<=64*1024*1024,"capture exceeds output limit");Ok::<_,anyhow::Error>(data)};
        let read_err=async {let mut data=Vec::new();stderr.take(16385).read_to_end(&mut data).await?;ensure!(data.len()<=16384,"backend error exceeds output limit");Ok::<_,anyhow::Error>(data)};
        let wait=async {Ok::<_,anyhow::Error>(child.wait().await?)};
        let (out,err,status)=tokio::try_join!(read_out,read_err,wait)?;
        // Do not echo input text or scripts in errors/logs.
        ensure!(status.success(),"desktop backend failed ({status}); check OS permissions and installed backend ({} error bytes)",err.len());
        Ok(out)
    }).await.context("desktop backend timed out; operation outcome may be unknown")?;
    if result.is_err() {
        let _ = child.kill().await;
    }
    result
}

pub(super) async fn geometry() -> Result<Geometry> {
    #[cfg(target_os = "macos")]
    {
        return super::macos::geometry();
    }
    #[cfg(target_os = "windows")]
    {
        return Ok(serde_json::from_value(
            windows(json!({"mode":"geometry"})).await?,
        )?);
    }
    #[cfg(target_os = "linux")]
    {
        x11()?;
        let bytes = output(Command::new("xdotool").arg("getdisplaygeometry")).await?;
        let text = String::from_utf8(bytes)?;
        let values = text
            .split_whitespace()
            .map(str::parse::<f64>)
            .collect::<std::result::Result<Vec<_>, _>>()?;
        ensure!(values.len() == 2, "invalid X11 geometry");
        return Ok(Geometry {
            x: 0.0,
            y: 0.0,
            width: values[0],
            height: values[1],
        });
    }
    #[allow(unreachable_code)]
    {
        bail!("unsupported desktop platform")
    }
}

pub(super) async fn capture() -> Result<(Vec<u8>, Geometry, String)> {
    #[cfg(target_os = "macos")]
    {
        super::macos::check_capture()?;
        let bounds = geometry().await?;
        let focus = mac_focus().await?;
        // Private directory + RAII cleanup, including errors and cancellation.
        let temp = tempfile::Builder::new()
            .prefix("worldbase-screen-")
            .tempdir()?;
        let path = temp.path().join("screen.png");
        output(
            Command::new("/usr/sbin/screencapture")
                .args(["-x", "-m", "-t", "png"])
                .arg(&path),
        )
        .await?;
        ensure!(
            tokio::fs::metadata(&path).await?.len() <= 64 * 1024 * 1024,
            "capture too large"
        );
        let bytes = tokio::fs::read(path).await?;
        ensure!(
            bounds == geometry().await? && focus == mac_focus().await?,
            "desktop changed during capture; retry observe"
        );
        return Ok((bytes, bounds, focus));
    }
    #[cfg(target_os = "windows")]
    {
        use base64::Engine;
        let value = windows(json!({"mode":"capture"})).await?;
        let geometry = serde_json::from_value(value["geometry"].clone())?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(value["image"].as_str().context("missing screen image")?)?;
        return Ok((
            bytes,
            geometry,
            value["focus"].as_str().context("missing focus")?.into(),
        ));
    }
    #[cfg(target_os = "linux")]
    {
        x11()?;
        let bounds = geometry().await?;
        let focus = x_focus().await?;
        // X11 only: do not mix Wayland portal/grim images with XWayland input.
        let bytes = output(Command::new("import").args(["-window", "root", "png:-"])).await?;
        ensure!(
            bounds == geometry().await? && focus == x_focus().await?,
            "desktop changed during capture; retry observe"
        );
        let (w, h) = image::io::Reader::new(std::io::Cursor::new(&bytes))
            .with_guessed_format()?
            .into_dimensions()?;
        ensure!(
            w as f64 == bounds.width && h as f64 == bounds.height,
            "X11 capture/input geometry mismatch"
        );
        return Ok((bytes, bounds, focus));
    }
    #[allow(unreachable_code)]
    {
        bail!("unsupported desktop platform")
    }
}

#[cfg(target_os = "macos")]
async fn mac_focus() -> Result<String> {
    let bytes=output(Command::new("/usr/bin/osascript").args(["-e", "tell application \"System Events\" to get unix id of first application process whose frontmost is true"])).await?;
    let pid = String::from_utf8(bytes)?.trim().parse::<u32>()?;
    Ok(pid.to_string())
}

pub(super) async fn perform(action: &Action, focus: &str, abort: &CancellationToken) -> Result<()> {
    ensure!(!abort.is_cancelled(), "desktop control cancelled");
    #[cfg(target_os = "macos")]
    {
        if matches!(action, Action::Type { .. } | Action::Key { .. }) {
            ensure!(
                mac_focus().await? == focus,
                "foreground app changed since observation; focus the target and observe again"
            );
        }
        return super::macos::perform(action, abort);
    }
    #[cfg(target_os = "windows")]
    {
        windows(json!({"mode":"action","input":action,"focus":focus})).await?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        x11()?;
        if matches!(action, Action::Type { .. } | Action::Key { .. }) {
            ensure!(
                x_focus().await? == focus,
                "foreground window changed; focus target and observe again"
            );
        }
        ensure!(!abort.is_cancelled(), "desktop control cancelled");
        let args = linux_args(action);
        output(Command::new("xdotool").args(args)).await?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    {
        bail!("unsupported desktop platform")
    }
}

#[cfg(target_os = "linux")]
fn x11() -> Result<()> {
    ensure!(std::env::var_os("WAYLAND_DISPLAY").is_none() && std::env::var("XDG_SESSION_TYPE").unwrap_or_default()!="wayland", "Wayland control is not implemented: RemoteDesktop portal/libei is required. Do not use XWayland fallback.");
    ensure!(
        std::env::var_os("DISPLAY").is_some(),
        "no X11 desktop; DISPLAY is missing"
    );
    Ok(())
}
#[cfg(target_os = "linux")]
async fn x_focus() -> Result<String> {
    Ok(
        String::from_utf8(output(Command::new("xdotool").arg("getwindowfocus")).await?)?
            .trim()
            .parse::<u64>()?
            .to_string(),
    )
}
#[cfg(any(target_os = "linux", test))]
fn linux_args(action: &Action) -> Vec<String> {
    match action {
        Action::Click { x, y, .. } | Action::DoubleClick { x, y, .. } => vec![
            "mousemove".into(),
            "--sync".into(),
            x.to_string(),
            y.to_string(),
            "click".into(),
            "--repeat".into(),
            if matches!(action, Action::DoubleClick { .. }) {
                "2"
            } else {
                "1"
            }
            .into(),
            "1".into(),
        ],
        Action::Type { text, .. } => vec![
            "type".into(),
            "--clearmodifiers".into(),
            "--delay".into(),
            "1".into(),
            "--".into(),
            text.clone(),
        ],
        Action::Key { key, .. } => vec![
            "key".into(),
            "--clearmodifiers".into(),
            match key.as_str() {
                "Enter" => "Return",
                "Backspace" => "BackSpace",
                "Space" => "space",
                "PageUp" => "Prior",
                "PageDown" => "Next",
                k => k,
            }
            .into(),
        ],
        Action::Scroll { x, y, delta_y, .. } => vec![
            "mousemove".into(),
            "--sync".into(),
            x.to_string(),
            y.to_string(),
            "click".into(),
            "--repeat".into(),
            delta_y.unsigned_abs().to_string(),
            if *delta_y > 0 { "4" } else { "5" }.into(),
        ],
    }
}

#[cfg(target_os = "windows")]
async fn windows(payload: Value) -> Result<Value> {
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(&payload)?);
    let bytes = output(
        Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                include_str!("windows.ps1"),
            ])
            .env("WORLDBASE_COMPUTER_INPUT", encoded),
    )
    .await?;
    Ok(serde_json::from_slice(&bytes)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn linux_literal_text_cannot_be_an_option_or_script() {
        let text = "--file /etc/passwd; $(touch /tmp/not-run)";
        let args = linux_args(&Action::Type {
            observation_id: "id".into(),
            text: text.into(),
        });
        assert_eq!(&args[args.len() - 2..], &["--", text]);
    }
    #[test]
    fn scroll_has_consistent_direction_and_magnitude() {
        let args = linux_args(&Action::Scroll {
            observation_id: "id".into(),
            x: 0,
            y: 0,
            delta_y: 3,
        });
        assert_eq!(&args[args.len() - 2..], &["3", "4"]);
    }
    #[test]
    fn windows_uses_fixed_script_and_unicode_input_not_sendkeys() {
        let script = include_str!("windows.ps1");
        assert!(script.contains("FromBase64String"));
        assert!(script.contains("SendInput"));
        assert!(!script.contains("SendWait"));
        assert!(!script.contains("Invoke-Expression"));
    }
}
