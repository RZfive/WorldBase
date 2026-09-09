//! Rust-owned Image Studio library regression coverage.
//!
//! These tests exercise the dispatcher boundary used by Electron's
//! `studio-img://` protocol. In particular, thumbnail generation must stay in
//! Rust after switching harnesses, including for images created by the legacy
//! TypeScript gallery before the switch.

use std::ffi::OsString;
use std::sync::{Arc, Mutex, OnceLock};
use worldbase_core::dispatcher::ConnectionContext;
use worldbase_core::Hub;
use worldbase_protocol::method;
use worldbase_protocol::rpc::ErrorObject;
use worldbase_protocol::types::{Capabilities, ImageEntry};

static IMAGE_LIBRARY_ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

struct WorldbaseHomeRestore(Option<OsString>);

impl Drop for WorldbaseHomeRestore {
    fn drop(&mut self) {
        if let Some(value) = self.0.take() {
            std::env::set_var("WORLDBASE_HOME", value);
        } else {
            std::env::remove_var("WORLDBASE_HOME");
        }
    }
}

async fn dispatch(
    hub: &Arc<Hub>,
    ctx: &ConnectionContext,
    method_name: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, ErrorObject> {
    worldbase_core::dispatcher::dispatch(hub, ctx, method_name, params).await
}

#[test]
fn rust_library_read_generates_webp_thumbnails_and_falls_back_for_unsupported_sources() {
    // `Store::default_dir()` intentionally follows Electron's data-dir
    // contract. Serialize the short-lived environment override so this test
    // never writes to a developer's actual image library.
    let _environment_guard = IMAGE_LIBRARY_ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap();
    let data_dir = std::env::temp_dir().join(format!(
        "worldbase-rust-image-library-{}",
        uuid::Uuid::new_v4()
    ));
    let previous_home = std::env::var_os("WORLDBASE_HOME");
    std::env::set_var("WORLDBASE_HOME", &data_dir);
    let _restore_home = WorldbaseHomeRestore(previous_home);

    let library_dir = data_dir.join("image-library");
    let workspace = data_dir.join("workspace");
    std::fs::create_dir_all(&library_dir).unwrap();
    std::fs::create_dir_all(&workspace).unwrap();

    let store = Arc::new(worldbase_memory::Store::open(&data_dir.join("app.sqlite")).unwrap());
    let hub = Hub::new(workspace, store.clone()).unwrap();
    let ctx = ConnectionContext::new(Capabilities::desktop());

    // A legacy gallery file with no `thumbName` metadata. Generate it through
    // the same PNG encoder supported by the runtime decoder so this test only
    // exercises the thumbnail ownership boundary.
    let png_id = "legacy-png";
    let png_file = format!("{png_id}.png");
    image::RgbaImage::from_pixel(1, 1, image::Rgba([12, 34, 56, 255]))
        .save(library_dir.join(&png_file))
        .unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        store
            .add_image(&ImageEntry {
                id: png_id.into(),
                prompt: "legacy png".into(),
                provider_id: None,
                model: String::new(),
                file: png_file.clone(),
                created_at: "2026-08-30T00:00:00Z".into(),
                folder: String::new(),
                tags: Vec::new(),
                meta: serde_json::json!({}),
            })
            .unwrap();

        let thumb = dispatch(
            &hub,
            &ctx,
            method::STUDIO_LIBRARY_READ,
            serde_json::json!({ "id": png_id, "variant": "thumb" }),
        )
        .await
        .unwrap();
        assert!(
            thumb["dataUrl"]
                .as_str()
                .unwrap()
                .starts_with("data:image/webp;base64,"),
            "thumbnail response: {thumb}"
        );
        let persisted_png = store.get_image(png_id).unwrap().unwrap();
        assert_eq!(persisted_png.meta["thumbName"], "legacy-png.thumb.webp");
        assert!(library_dir.join("legacy-png.thumb.webp").is_file());

        let full = dispatch(
            &hub,
            &ctx,
            method::STUDIO_LIBRARY_READ,
            serde_json::json!({ "id": png_id, "variant": "full" }),
        )
        .await
        .unwrap();
        assert!(full["dataUrl"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));

        // SVG remains an Electron-compatible original-file fallback because
        // the intentionally narrow Rust image decoder does not rasterize it.
        let svg_id = "legacy-svg";
        let svg_file = format!("{svg_id}.svg");
        std::fs::write(
            library_dir.join(&svg_file),
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\" height=\"1\"/>",
        )
        .unwrap();
        store
            .add_image(&ImageEntry {
                id: svg_id.into(),
                prompt: "legacy svg".into(),
                provider_id: None,
                model: String::new(),
                file: svg_file,
                created_at: "2026-08-30T00:00:00Z".into(),
                folder: String::new(),
                tags: Vec::new(),
                meta: serde_json::json!({}),
            })
            .unwrap();
        let unsupported = dispatch(
            &hub,
            &ctx,
            method::STUDIO_LIBRARY_READ,
            serde_json::json!({ "id": svg_id, "variant": "thumb" }),
        )
        .await
        .unwrap();
        assert!(unsupported["dataUrl"]
            .as_str()
            .unwrap()
            .starts_with("data:image/svg+xml;base64,"));
        assert!(store
            .get_image(svg_id)
            .unwrap()
            .unwrap()
            .meta
            .get("thumbName")
            .is_none());

        assert!(dispatch(
            &hub,
            &ctx,
            method::STUDIO_LIBRARY_READ,
            serde_json::json!({ "id": png_id, "variant": "invalid" }),
        )
        .await
        .is_err());
    });

    let _ = std::fs::remove_dir_all(&data_dir);
}
