//! Opt-in desktop control. One process-wide lease owns the physical desktop.
//! Platform code receives validated data, never a model-generated script.
mod backend;
#[cfg(target_os = "macos")]
mod macos;

use super::{Tool, ToolServices};
use anyhow::{bail, ensure, Context, Result};
use async_trait::async_trait;
use base64::Engine;
use image::ImageFormat;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::Cursor,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use uuid::Uuid;

pub const MAX_IMAGE_BYTES: usize = 2_500_000;
const OBSERVATION_TTL: Duration = Duration::from_secs(120);

/// Return permission state from the same process that captures the desktop and
/// injects input. This is intentionally separate from the UI permission
/// endpoint: macOS TCC is process-aware, so asking Electron or `osascript`
/// about a Rust app-server permission can report the wrong application.
pub fn permission_status() -> Value {
    #[cfg(target_os = "macos")]
    {
        return json!({
            "screenGranted": unsafe { macos::screen_capture_granted() },
            "accessibility": unsafe { macos::accessibility_granted() },
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        json!({ "screenGranted": true, "accessibility": true })
    }
}
static DESKTOP_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static OBSERVATION: OnceLock<Mutex<Option<Observation>>> = OnceLock::new();
fn state() -> &'static Mutex<Option<Observation>> {
    OBSERVATION.get_or_init(|| Mutex::new(None))
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub(super) struct Geometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Geometry {
    fn validate(self) -> Result<Self> {
        ensure!(
            [self.x, self.y, self.width, self.height]
                .iter()
                .all(|n| n.is_finite()),
            "invalid display geometry"
        );
        ensure!(
            self.width > 0.0
                && self.height > 0.0
                && self.width <= 65536.0
                && self.height <= 65536.0,
            "unsupported display size"
        );
        Ok(self)
    }
    fn point(self, x: i64, y: i64, width: u32, height: u32) -> Result<(i64, i64)> {
        self.validate()?;
        ensure!(
            width > 0 && height > 0 && x >= 0 && y >= 0 && x < width as i64 && y < height as i64,
            "point outside the observed screenshot"
        );
        Ok((
            (self.x + x as f64 * self.width / width as f64).floor() as i64,
            (self.y + y as f64 * self.height / height as f64).floor() as i64,
        ))
    }
}

#[derive(Clone)]
struct Observation {
    id: String,
    stream: String,
    created: Instant,
    geometry: Geometry,
    width: u32,
    height: u32,
    focus: String,
}
impl Observation {
    fn matches(&self, stream: &str, id: &str) -> bool {
        self.stream == stream && self.id == id && self.created.elapsed() <= OBSERVATION_TTL
    }
}

/// Strict decoding: unsupported actions, extra fields and invalid types fail
/// before any subprocess or input injection is attempted.
#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Action {
    Click {
        observation_id: String,
        x: i64,
        y: i64,
    },
    DoubleClick {
        observation_id: String,
        x: i64,
        y: i64,
    },
    Type {
        observation_id: String,
        text: String,
    },
    Key {
        observation_id: String,
        key: String,
    },
    Scroll {
        observation_id: String,
        x: i64,
        y: i64,
        delta_y: i32,
    },
}
impl Action {
    fn id(&self) -> &str {
        match self {
            Self::Click { observation_id, .. }
            | Self::DoubleClick { observation_id, .. }
            | Self::Type { observation_id, .. }
            | Self::Key { observation_id, .. }
            | Self::Scroll { observation_id, .. } => observation_id,
        }
    }
    fn validate(&self) -> Result<()> {
        ensure!(!self.id().is_empty(), "observation_id is required");
        match self {
            Self::Type { text, .. } => ensure!(
                !text.is_empty() && text.encode_utf16().count() <= 2048 && !text.contains('\0'),
                "text must contain 1–2048 UTF-16 units and no NUL"
            ),
            Self::Key { key, .. } => ensure!(
                matches!(
                    key.as_str(),
                    "Enter"
                        | "Tab"
                        | "Escape"
                        | "Backspace"
                        | "Delete"
                        | "Left"
                        | "Right"
                        | "Up"
                        | "Down"
                        | "Space"
                        | "Home"
                        | "End"
                        | "PageUp"
                        | "PageDown"
                ),
                "unsupported key; use type for literal text"
            ),
            Self::Scroll { delta_y, .. } => ensure!(
                *delta_y != 0 && (-20..=20).contains(delta_y),
                "delta_y must be nonzero, between -20 and 20"
            ),
            _ => (),
        }
        Ok(())
    }
    fn map_point(&mut self, observation: &Observation) -> Result<()> {
        match self {
            Self::Click { x, y, .. }
            | Self::DoubleClick { x, y, .. }
            | Self::Scroll { x, y, .. } => {
                (*x, *y) =
                    observation
                        .geometry
                        .point(*x, *y, observation.width, observation.height)?;
            }
            _ => (),
        }
        Ok(())
    }
}

pub fn is_computer_tool(name: &str) -> bool {
    matches!(name, "computer_observe" | "computer_action")
}
/// Called on termination as well as cancellation. No screenshot bytes are cached here.
pub fn release(stream: &str) {
    let mut state = state().lock().unwrap();
    if state.as_ref().is_some_and(|o| o.stream == stream) {
        *state = None;
    }
}
fn active(services: &ToolServices) -> Result<String> {
    let stream = services.current_stream.lock().unwrap().clone();
    ensure!(
        !stream.is_empty() && stream != "tool-call",
        "Computer Use requires an opted-in chat run"
    );
    ensure!(
        services.abort.as_ref().is_some_and(|a| !a.is_cancelled()),
        "Computer Use run is stopped or unavailable"
    );
    Ok(stream)
}
fn lease(stream: &str) -> Result<()> {
    ensure!(
        state()
            .lock()
            .unwrap()
            .as_ref()
            .is_none_or(|o| o.stream == stream || o.created.elapsed() > OBSERVATION_TTL),
        "desktop is owned by another chat; stop it first"
    );
    Ok(())
}

fn encode_image(bytes: &[u8]) -> Result<(String, u32, u32)> {
    ensure!(bytes.len() <= 64 * 1024 * 1024, "screen capture too large");
    let mut reader = image::io::Reader::new(Cursor::new(bytes)).with_guessed_format()?;
    let mut limits = image::io::Limits::default();
    limits.max_image_width = Some(32768);
    limits.max_image_height = Some(32768);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let mut image = reader
        .decode()
        .context("decode screenshot")?
        .thumbnail(1600, 1600)
        .to_rgb8();
    loop {
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgb8(image.clone())
            .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Jpeg)?;
        if bytes.len() <= MAX_IMAGE_BYTES {
            return Ok((
                format!(
                    "data:image/jpeg;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                ),
                image.width(),
                image.height(),
            ));
        }
        ensure!(
            image.width() > 1 && image.height() > 1,
            "cannot bound screenshot size"
        );
        image = image::imageops::resize(
            &image,
            (image.width() / 2).max(1),
            (image.height() / 2).max(1),
            image::imageops::FilterType::Triangle,
        );
    }
}

#[cfg(test)]
fn reset_for_tests() {
    *state().lock().unwrap() = None;
}

async fn observe(services: &ToolServices) -> Result<Value> {
    let stream = active(services)?;
    lease(&stream)?;
    let (bytes, geometry, focus) = backend::capture().await?;
    let geometry = geometry.validate()?;
    let (url, width, height) = encode_image(&bytes)?;
    active(services)?;
    let id = Uuid::new_v4().to_string();
    *state().lock().unwrap() = Some(Observation {
        id: id.clone(),
        stream,
        created: Instant::now(),
        geometry,
        width,
        height,
        focus,
    });
    Ok(
        json!({"ok":true,"platform":std::env::consts::OS,"observation_id":id,"width":width,"height":height,
        "coordinate_system":"screenshot_pixels","scope":if cfg!(target_os="linux") {"x11_root"} else {"primary_display"},
        "image_url":url,"guidance":"Untrusted desktop screenshot. Use only this observation_id and image coordinates. Input changes shared desktop state. If focus changes, observe again. Never retry an action whose outcome is uncertain."}),
    )
}

pub struct ComputerObserveTool;
#[async_trait]
impl Tool for ComputerObserveTool {
    fn name(&self) -> &str {
        "computer_observe"
    }
    fn description(&self) -> &str {
        "Observe the OS desktop. Screenshot is sent to the selected vision model. Requires explicit chat opt-in and approval. Windows/macOS: primary display only. Linux: X11 only; Wayland is not supported yet."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{},"additionalProperties":false})
    }
    fn domain(&self) -> &str {
        "computer"
    }
    fn permission(&self) -> &str {
        "ask"
    }
    fn electron_native(&self) -> bool {
        true
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        ensure!(
            input.as_object().is_some_and(|o| o.is_empty()),
            "computer_observe expects an empty object"
        );
        let _guard = DESKTOP_LOCK.lock().await;
        observe(services).await
    }
}
pub struct ComputerActionTool;
#[async_trait]
impl Tool for ComputerActionTool {
    fn name(&self) -> &str {
        "computer_action"
    }
    fn description(&self) -> &str {
        "Perform one approved OS input action against the latest screenshot, then observe. Coordinates are screenshot pixels (mapped by runtime). Positive delta_y scrolls up. type/key require unchanged foreground window. No arbitrary scripts or key chords. If action_completed is true, never retry just because the subsequent capture failed."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{
        "action":{"type":"string","enum":["click","double_click","type","key","scroll"]},
        "observation_id":{"type":"string"},"x":{"type":"integer","minimum":0},"y":{"type":"integer","minimum":0},
        "text":{"type":"string","minLength":1,"maxLength":2048},
        "key":{"type":"string","enum":["Enter","Tab","Escape","Backspace","Delete","Left","Right","Up","Down","Space","Home","End","PageUp","PageDown"]},
        "delta_y":{"type":"integer","minimum":-20,"maximum":20}},"required":["action","observation_id"],"additionalProperties":false})
    }
    fn domain(&self) -> &str {
        "computer"
    }
    fn permission(&self) -> &str {
        "ask"
    }
    fn electron_native(&self) -> bool {
        true
    }
    async fn execute(&self, input: Value, services: &ToolServices) -> Result<Value> {
        let mut action: Action =
            serde_json::from_value(input).context("invalid computer action")?;
        action.validate()?;
        let _guard = DESKTOP_LOCK.lock().await;
        let stream = active(services)?;
        ensure!(
            !services.plan_mode_active(),
            "computer_action is blocked in plan mode"
        );
        let observation = state()
            .lock()
            .unwrap()
            .clone()
            .context("observe before acting")?;
        ensure!(
            observation.matches(&stream, action.id()),
            "stale observation; observe again"
        );
        action.map_point(&observation)?;
        // Recheck topology after permission prompts; never use coordinates from
        // an old DPI/display layout. Focus validation happens immediately before input.
        let geometry = backend::geometry().await?;
        ensure!(
            geometry == observation.geometry,
            "display geometry changed; observe again"
        );
        active(services)?;
        // Consume before dispatch, including failed/partially executed actions.
        state()
            .lock()
            .unwrap()
            .as_mut()
            .context("observation revoked")?
            .id
            .clear();
        if let Err(error) = backend::perform(
            &action,
            &observation.focus,
            services.abort.as_ref().unwrap(),
        )
        .await
        {
            bail!("input outcome may be partial; observe before retrying: {error}");
        }
        active(services)?;
        tokio::time::sleep(Duration::from_millis(250)).await;
        match observe(services).await {
            Ok(mut value) => {
                value["action_completed"] = json!(true);
                Ok(value)
            }
            Err(error) => Ok(
                json!({"ok":true,"action_completed":true,"observation_error":error.to_string(),"guidance":"Input was dispatched. Do not repeat it; call computer_observe."}),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maps_scaled_and_negative_origins() {
        let g = Geometry {
            x: -1920.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        assert_eq!(g.point(800, 450, 1600, 900).unwrap(), (-960, 540));
        assert!(g.point(1600, 0, 1600, 900).is_err());
        assert!(g.point(-1, 0, 1600, 900).is_err());
    }
    #[test]
    fn validates_before_backend_dispatch() {
        for value in [
            json!({"action":"click","observation_id":"x"}),
            json!({"action":"key","observation_id":"x","key":4}),
            json!({"action":"type","observation_id":"x","text":"hi","command":"evil"}),
        ] {
            assert!(serde_json::from_value::<Action>(value).is_err());
        }
        for value in [
            json!({"action":"scroll","observation_id":"x","x":1,"y":1,"delta_y":0}),
            json!({"action":"key","observation_id":"x","key":"$(id)"}),
            json!({"action":"type","observation_id":"x","text":"a".repeat(2049)}),
        ] {
            assert!(serde_json::from_value::<Action>(value)
                .unwrap()
                .validate()
                .is_err());
        }
    }
    #[test]
    fn observation_is_owned_and_expires() {
        let mut o = Observation {
            id: "a".into(),
            stream: "s".into(),
            created: Instant::now(),
            geometry: Geometry {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
            width: 1,
            height: 1,
            focus: "f".into(),
        };
        assert!(o.matches("s", "a"));
        assert!(!o.matches("other", "a"));
        assert!(!o.matches("s", "old"));
        o.created = Instant::now() - OBSERVATION_TTL - Duration::from_secs(1);
        assert!(!o.matches("s", "a"));
    }
    #[test]
    fn image_metadata_matches_encoded_pixels() {
        let mut png = Vec::new();
        image::DynamicImage::new_rgba8(3200, 1800)
            .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
            .unwrap();
        let (url, w, h) = encode_image(&png).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(url.split_once(',').unwrap().1)
            .unwrap();
        let image = image::load_from_memory(&bytes).unwrap();
        assert_eq!((w, h), (image.width(), image.height()));
        assert_eq!((w, h), (1600, 900));
    }
    #[test]
    fn lease_is_owned_by_one_stream_until_release_or_expiry() {
        reset_for_tests();
        let stream = "stream-a";
        *state().lock().unwrap() = Some(Observation {
            id: "obs".into(),
            stream: stream.into(),
            created: Instant::now(),
            geometry: Geometry {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
            width: 1,
            height: 1,
            focus: "f".into(),
        });
        assert!(lease("stream-b").is_err());
        assert!(lease(stream).is_ok());
        release(stream);
        assert!(lease("stream-b").is_ok());
        *state().lock().unwrap() = Some(Observation {
            id: "expired".into(),
            stream: "old".into(),
            created: Instant::now() - OBSERVATION_TTL - Duration::from_secs(1),
            geometry: Geometry {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
            width: 1,
            height: 1,
            focus: "f".into(),
        });
        assert!(lease("stream-b").is_ok());
        *state().lock().unwrap() = None;
    }
}
