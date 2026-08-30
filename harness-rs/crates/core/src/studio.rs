//! 图像生成服务（对齐桌面 Image Studio 精简版）：
//! 任意 openai 协议供应商的 images 接口；无 key 时确定性 SVG 占位图。
//! 文件落 `WORLDBASE_HOME/image-library/`，索引入库，事件经流通道下发。

use crate::hub::Hub;
use anyhow::Result;
use std::sync::Arc;
use worldbase_protocol::event::EventKind;
use worldbase_protocol::types::{ImageEntry, ImageGenerateParams, ImageQuery};
use worldbase_providers::generate_images;
use worldbase_providers::{pixel_size, size_for, ImageParams};

pub struct StudioService;

impl StudioService {
    /// 发起生成任务：立即返回任务 stream_id；完成时发 image_ready 事件。
    pub fn generate(hub: Arc<Hub>, params: ImageGenerateParams) -> Result<String> {
        let stream_id = format!("studio-{}", uuid::Uuid::new_v4());
        let stream_id_task = stream_id.clone();
        tokio::spawn(async move {
            let stream_id = stream_id_task;
            hub.emit(&stream_id, EventKind::Notice { text: "生成任务开始".into() }).await;
            let result = Self::run(&hub, &params).await;
            match result {
                Ok(entries) => {
                    for entry in entries {
                        hub.emit(&stream_id, EventKind::ImageReady { entry: entry.clone() }).await;
                    }
                    hub.emit(&stream_id, EventKind::Done { stop_reason: "generated".into() }).await;
                }
                Err(e) => {
                    hub.emit(&stream_id, EventKind::Error { message: e.to_string() }).await;
                }
            }
        });
        Ok(stream_id)
    }

    #[allow(dead_code)]
    async fn run(hub: &Arc<Hub>, params: &ImageGenerateParams) -> Result<Vec<ImageEntry>> {
        // 供应商解析：参数指定 > active
        let providers = hub.providers_config();
        let entry = params
            .provider_id
            .as_ref()
            .and_then(|pid| providers.providers.iter().find(|p| &p.id == pid).cloned())
            .or_else(|| hub.active_provider_entry())
            .ok_or_else(|| anyhow::anyhow!("no provider configured"))?;

        let n = params.n.unwrap_or(1).clamp(1, 4);
        let model = params
            .model
            .as_deref()
            .filter(|m| !m.is_empty())
            .unwrap_or(entry.active_model.as_str());
        let image_params = ImageParams {
            prompt: &params.prompt,
            negative_prompt: params.negative_prompt.as_deref(),
            aspect: params.aspect.as_deref(),
            resolution: params.resolution.as_deref(),
            quality: params.quality.as_deref(),
            format: params.format.as_deref(),
            n,
            input_image_b64: params.input_image_b64.as_deref(),
        };
        let images = generate_images(&entry, model, &image_params).await?;

        // 落盘 + 入库
        let dir = worldbase_memory::Store::default_dir().join("image-library");
        std::fs::create_dir_all(&dir)?;
        let mut entries = Vec::new();
        for img in images {
            let id = uuid::Uuid::new_v4().to_string();
            let file = format!("{id}.{}", img.ext);
            let path = dir.join(&file);
            std::fs::write(&path, &img.bytes)?;
            let meta = serde_json::json!({
                "aspect": params.aspect,
                "resolution": params.resolution,
                "quality": params.quality,
                "format": params.format,
                "negativePrompt": params.negative_prompt,
                "mode": if params.mode.is_empty() { "generate" } else { &params.mode },
                "bytes": img.bytes.len(),
            });
            let entry_rec = ImageEntry {
                id: id.clone(),
                prompt: params.prompt.clone(),
                provider_id: Some(entry.id.clone()),
                model: model.to_string(),
                file,
                created_at: worldbase_protocol::event::now_rfc3339(),
                folder: String::new(),
                tags: vec![],
                meta,
            };
            hub.store.add_image(&entry_rec)?;
            entries.push(entry_rec);
        }
        Ok(entries)
    }

    /// 轻应用落盘目录。
    pub fn lightapp_dir() -> std::path::PathBuf {
        worldbase_memory::Store::default_dir().join("lightweight-apps")
    }

    /// 保存 Agent 生成的单页应用。
    pub fn save_lightapp(name: &str, html: &str) -> Result<worldbase_protocol::types::LightApp> {
        let id = uuid::Uuid::new_v4().to_string();
        let dir = Self::lightapp_dir().join(&id);
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("index.html"), html)?;
        let app = worldbase_protocol::types::LightApp {
            id: id.clone(),
            name: name.to_string(),
            created_at: worldbase_protocol::event::now_rfc3339(),
        };
        Ok(app)
    }

    /// 读取单页应用 HTML。
    pub fn read_lightapp(id: &str) -> Result<String> {
        let path = Self::lightapp_dir()
            .join(id)
            .join("index.html");
        anyhow::ensure!(
            path.starts_with(Self::lightapp_dir()),
            "invalid lightapp id"
        );
        Ok(std::fs::read_to_string(path)?)
    }

    /// 读取图片字节（serve /studio/{id} 用）。
    pub fn read_image_bytes(hub: &Hub, id: &str) -> Result<(Vec<u8>, String)> {
        let entry = hub
            .store
            .get_image(id)?
            .ok_or_else(|| anyhow::anyhow!("image not found: {id}"))?;
        let path = worldbase_memory::Store::default_dir()
            .join("image-library")
            .join(&entry.file);
        let bytes = std::fs::read(&path)?;
        let mime = if entry.file.ends_with(".svg") {
            "image/svg+xml"
        } else if entry.file.ends_with(".jpg") || entry.file.ends_with(".jpeg") {
            "image/jpeg"
        } else if entry.file.ends_with(".webp") {
            "image/webp"
        } else {
            "image/png"
        };
        Ok((bytes, mime.to_string()))
    }
}
