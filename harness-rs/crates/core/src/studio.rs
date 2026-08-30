//! 图像生成服务（对齐桌面 Image Studio 精简版）：
//! 任意 openai 协议供应商的 images 接口；无 key 时确定性 SVG 占位图。
//! 文件落 `WORLDBASE_HOME/image-library/`，索引入库，事件经流通道下发。

use crate::hub::Hub;
use anyhow::Result;
use base64::Engine;
use std::sync::Arc;
use worldbase_protocol::event::EventKind;
use worldbase_protocol::types::{ImageEntry, ImageGenerateParams};
use worldbase_providers::generate_images;
use worldbase_providers::ImageParams;

const MAX_STUDIO_INPUT_IMAGES: usize = 4;

pub struct StudioService;

impl StudioService {
    /// 发起生成任务：立即返回任务 stream_id；完成时发 image_ready 事件。
    pub fn generate(hub: Arc<Hub>, params: ImageGenerateParams) -> Result<String> {
        let stream_id = format!("studio-{}", uuid::Uuid::new_v4());
        let stream_id_task = stream_id.clone();
        tokio::spawn(async move {
            let stream_id = stream_id_task;
            hub.emit(
                &stream_id,
                EventKind::Notice {
                    text: "生成任务开始".into(),
                },
            )
            .await;
            let result = Self::run(&hub, &params).await;
            match result {
                Ok(entries) => {
                    for entry in entries {
                        hub.emit(
                            &stream_id,
                            EventKind::ImageReady {
                                entry: entry.clone(),
                            },
                        )
                        .await;
                    }
                    hub.emit(
                        &stream_id,
                        EventKind::Done {
                            stop_reason: "generated".into(),
                        },
                    )
                    .await;
                }
                Err(e) => {
                    hub.emit(
                        &stream_id,
                        EventKind::Error {
                            message: e.to_string(),
                        },
                    )
                    .await;
                }
            }
        });
        Ok(stream_id)
    }

    #[allow(dead_code)]
    async fn run(hub: &Arc<Hub>, params: &ImageGenerateParams) -> Result<Vec<ImageEntry>> {
        // 供应商解析：参数指定 > active
        let n = params.n.unwrap_or(1).clamp(1, 4);
        let (entry, model) = resolve_studio_image_target(hub, params)?;
        let is_edit = params.mode.trim().eq_ignore_ascii_case("edit");
        let (input_image_b64, input_images) = studio_edit_inputs(params, is_edit)?;
        let image_params = ImageParams {
            prompt: &params.prompt,
            negative_prompt: params.negative_prompt.as_deref(),
            aspect: params.aspect.as_deref(),
            size: params.size.as_deref(),
            resolution: params.resolution.as_deref(),
            quality: params.quality.as_deref(),
            format: params.format.as_deref(),
            n,
            input_image_b64,
            input_images_b64: input_images
                .iter()
                .map(|input| image_base64_from_data_url(input))
                .collect(),
            input_image_mimes: input_images
                .iter()
                .map(|input| image_mime_from_data_url(input))
                .collect(),
        };
        let images = generate_images(&entry, &model, &image_params).await?;

        // 落盘 + 入库
        let dir = worldbase_memory::Store::default_dir().join("image-library");
        std::fs::create_dir_all(&dir)?;
        let mut entries = Vec::new();
        for img in images {
            let id = uuid::Uuid::new_v4().to_string();
            let source_image_file_names = write_studio_source_images(&dir, &id, params, is_edit);
            let file = format!("{id}.{}", img.ext);
            let path = dir.join(&file);
            std::fs::write(&path, &img.bytes)?;
            let thumbnail = worldbase_memory::Store::write_image_library_thumbnail(&dir, &id, &file);
            let mut meta = serde_json::json!({
                "aspect": params.aspect,
                "size": params.size,
                "resolution": params.resolution,
                "quality": params.quality,
                "format": params.format,
                "negativePrompt": params.negative_prompt,
                "mode": if params.mode.is_empty() { "generate" } else { &params.mode },
                "bytes": img.bytes.len(),
                "inputCount": source_image_file_names.len(),
                "sourceImageFileNames": source_image_file_names,
            });
            if let Some(thumbnail) = thumbnail {
                let metadata = meta
                    .as_object_mut()
                    .expect("Studio metadata is always a JSON object");
                metadata.insert("thumbName".into(), thumbnail.name.into());
                metadata.insert("width".into(), thumbnail.width.into());
                metadata.insert("height".into(), thumbnail.height.into());
            }
            let entry_rec = ImageEntry {
                id: id.clone(),
                prompt: params.prompt.clone(),
                provider_id: Some(entry.id.clone()),
                model: model.clone(),
                file,
                created_at: worldbase_protocol::event::now_rfc3339(),
                folder: params.folder.clone().unwrap_or_default(),
                tags: params.tags.clone(),
                meta,
            };
            hub.store.add_image(&entry_rec)?;
            worldbase_memory::Store::write_image_library_mirror(&dir, &entry_rec)?;
            entries.push(entry_rec);
        }
        let folders = hub.store.list_image_folders()?;
        worldbase_memory::Store::write_image_folder_mirror(&dir, &folders)?;
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
        let path = Self::lightapp_dir().join(id).join("index.html");
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

fn studio_edit_inputs<'a>(
    params: &'a ImageGenerateParams,
    is_edit: bool,
) -> Result<(Option<&'a str>, Vec<&'a str>)> {
    if !is_edit {
        return Ok((None, Vec::new()));
    }
    anyhow::ensure!(
        params.input_images.len() <= MAX_STUDIO_INPUT_IMAGES,
        "image edit accepts at most {MAX_STUDIO_INPUT_IMAGES} input images"
    );
    let input_images: Vec<&str> = params
        .input_images
        .iter()
        .map(String::as_str)
        .filter(|input| !input.trim().is_empty())
        .collect();
    let input_image_b64 = params
        .input_image_b64
        .as_deref()
        .map(str::trim)
        .filter(|input| !input.is_empty())
        .map(image_base64_from_data_url);
    anyhow::ensure!(
        input_image_b64.is_some() || !input_images.is_empty(),
        "image edit requires at least one input image"
    );
    Ok((input_image_b64, input_images))
}

fn model_supports_image_mode(
    provider: &worldbase_protocol::types::ProviderEntry,
    model: &str,
    edit: bool,
) -> bool {
    match provider
        .models
        .iter()
        .find(|candidate| candidate.id == model)
    {
        Some(model) => {
            if edit {
                model.image_editing
            } else {
                model.image_generation
            }
        }
        None => provider.models.is_empty() || (!edit && provider.image_generation),
    }
}

fn image_model_for_studio_provider(
    provider: &worldbase_protocol::types::ProviderEntry,
    requested_model: Option<&str>,
    edit: bool,
) -> Option<String> {
    if let Some(model) = requested_model
        .map(str::trim)
        .filter(|model| !model.is_empty())
    {
        return model_supports_image_mode(provider, model, edit).then(|| model.to_string());
    }
    if model_supports_image_mode(provider, &provider.active_model, edit) {
        return Some(provider.active_model.clone());
    }
    provider
        .models
        .iter()
        .find(|model| {
            if edit {
                model.image_editing
            } else {
                model.image_generation
            }
        })
        .map(|model| model.id.clone())
}

fn resolve_studio_image_target(
    hub: &Hub,
    params: &ImageGenerateParams,
) -> Result<(worldbase_protocol::types::ProviderEntry, String)> {
    let providers = hub.providers_config();
    let edit = params.mode.trim().eq_ignore_ascii_case("edit");
    let requested_provider = params
        .provider_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    if let Some(provider_id) = requested_provider {
        let provider = providers
            .providers
            .iter()
            .find(|provider| provider.id == provider_id)
            .ok_or_else(|| anyhow::anyhow!("image provider not found: {provider_id}"))?;
        let model = image_model_for_studio_provider(provider, params.model.as_deref(), edit)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "selected model does not support image {}",
                    if edit { "editing" } else { "generation" }
                )
            })?;
        return Ok((provider.clone(), model));
    }

    let mut candidates: Vec<&worldbase_protocol::types::ProviderEntry> =
        providers.providers.iter().collect();
    if let Some(active_id) = providers.active_provider_id.as_deref() {
        if let Some(index) = candidates
            .iter()
            .position(|provider| provider.id == active_id)
        {
            let active = candidates.remove(index);
            candidates.insert(0, active);
        }
    }
    candidates
        .into_iter()
        .find_map(|provider| {
            image_model_for_studio_provider(provider, params.model.as_deref(), edit)
                .map(|model| (provider.clone(), model))
        })
        .ok_or_else(|| {
            anyhow::anyhow!(
                "no provider configured for image {}",
                if edit { "editing" } else { "generation" }
            )
        })
}

fn image_base64_from_data_url(input: &str) -> &str {
    input
        .split_once(",")
        .map(|(_, base64)| base64)
        .unwrap_or(input)
}

fn image_mime_from_data_url(input: &str) -> &str {
    input
        .strip_prefix("data:")
        .and_then(|value| value.split_once(';').map(|(mime, _)| mime))
        .filter(|mime| mime.starts_with("image/"))
        .unwrap_or("image/png")
}

fn image_extension_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/svg+xml" => "svg",
        _ => "png",
    }
}

/// Preserve the inputs of an edit beside its output so a later TS fallback can
/// reopen the edit with the same source images. Invalid data is ignored here:
/// the provider has already accepted the edit, and losing a malformed preview
/// must not discard a billable generated result.
fn write_studio_source_images(
    directory: &std::path::Path,
    id: &str,
    params: &ImageGenerateParams,
    is_edit: bool,
) -> Vec<String> {
    if !is_edit {
        return Vec::new();
    }
    let mut inputs = Vec::new();
    if let Some(input) = params
        .input_image_b64
        .as_deref()
        .map(str::trim)
        .filter(|input| !input.is_empty())
    {
        inputs.push(input);
    }
    inputs.extend(
        params
            .input_images
            .iter()
            .map(String::as_str)
            .map(str::trim)
            .filter(|input| !input.is_empty()),
    );

    let mut names = Vec::new();
    for input in inputs.into_iter().take(MAX_STUDIO_INPUT_IMAGES) {
        let payload = image_base64_from_data_url(input);
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(payload) else {
            continue;
        };
        let index = names.len();
        let name = format!(
            "{id}-src{index}.{}",
            image_extension_for_mime(image_mime_from_data_url(input))
        );
        if std::fs::write(directory.join(&name), bytes).is_ok() {
            names.push(name);
        }
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(
        mode: &str,
        input_image_b64: Option<&str>,
        input_images: Vec<&str>,
    ) -> ImageGenerateParams {
        ImageGenerateParams {
            prompt: "test".into(),
            mode: mode.into(),
            negative_prompt: None,
            aspect: None,
            size: None,
            resolution: None,
            quality: None,
            format: None,
            n: None,
            provider_id: None,
            model: None,
            input_image_b64: input_image_b64.map(str::to_string),
            input_images: input_images.into_iter().map(str::to_string).collect(),
            folder: None,
            tags: vec![],
        }
    }

    #[test]
    fn studio_edit_inputs_normalizes_and_limits_reference_images() {
        let edit = params(
            "edit",
            Some("data:image/png;base64,aGVsbG8="),
            vec!["data:image/webp;base64,d29ybGQ="],
        );
        let (single, inputs) = studio_edit_inputs(&edit, true).unwrap();
        assert_eq!(single, Some("aGVsbG8="));
        assert_eq!(inputs, vec!["data:image/webp;base64,d29ybGQ="]);

        let empty = params("edit", None, vec![]);
        assert!(studio_edit_inputs(&empty, true).is_err());

        let too_many = params("edit", None, vec!["a", "b", "c", "d", "e"]);
        assert!(studio_edit_inputs(&too_many, true).is_err());

        let generate = params("generate", None, vec!["ignored"]);
        assert_eq!(
            studio_edit_inputs(&generate, false).unwrap(),
            (None, vec![])
        );
    }

    #[test]
    fn studio_edit_sources_are_written_with_electron_compatible_names() {
        let directory =
            std::env::temp_dir().join(format!("worldbase-studio-source-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let edit = params(
            "edit",
            None,
            vec![
                "data:image/jpeg;base64,aGVsbG8=",
                "data:image/webp;base64,d29ybGQ=",
            ],
        );

        let names = write_studio_source_images(&directory, "output", &edit, true);

        assert_eq!(names, vec!["output-src0.jpg", "output-src1.webp"]);
        assert_eq!(std::fs::read(directory.join(&names[0])).unwrap(), b"hello");
        assert_eq!(std::fs::read(directory.join(&names[1])).unwrap(), b"world");
        let _ = std::fs::remove_dir_all(directory);
    }

}
