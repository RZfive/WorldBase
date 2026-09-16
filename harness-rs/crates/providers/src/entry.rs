//! 供应商条目解析与图像生成。

use super::Provider;
use crate::api_protocol::ApiProtocol;
use crate::{AnthropicProvider, MockProvider, OpenAIProvider, OpenAIResponsesProvider};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use worldbase_protocol::types::ProviderEntry;

const IMAGE_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

fn is_dall_e_model(model: &str) -> bool {
    let normalized = model.to_ascii_lowercase();
    normalized.contains("dall-e") || normalized.contains("dalle")
}

fn is_dall_e_2_model(model: &str) -> bool {
    let normalized = model.to_ascii_lowercase();
    normalized.contains("dall-e-2")
        || normalized.contains("dalle-2")
        || normalized.contains("dalle2")
}

fn is_dall_e_3_model(model: &str) -> bool {
    let normalized = model.to_ascii_lowercase();
    normalized.contains("dall-e-3")
        || normalized.contains("dalle-3")
        || normalized.contains("dalle3")
}

fn dall_e_3_size_for(aspect: Option<&str>) -> &'static str {
    match aspect.unwrap_or("1:1") {
        "3:2" | "4:3" | "16:9" => "1792x1024",
        "2:3" | "3:4" | "9:16" => "1024x1792",
        _ => "1024x1024",
    }
}

fn normalized_dall_e_size<'a>(
    model: &str,
    explicit_size: Option<&'a str>,
    aspect: Option<&str>,
) -> Option<&'a str> {
    if is_dall_e_2_model(model) {
        return Some(
            explicit_size
                .filter(|size| matches!(*size, "256x256" | "512x512" | "1024x1024"))
                .unwrap_or("1024x1024"),
        );
    }
    if is_dall_e_3_model(model) {
        return Some(
            explicit_size
                .filter(|size| matches!(*size, "1024x1024" | "1792x1024" | "1024x1792"))
                .unwrap_or_else(|| dall_e_3_size_for(aspect)),
        );
    }
    None
}

fn is_gpt_image_model(model: &str) -> bool {
    model.to_ascii_lowercase().contains("gpt-image")
}

/// Resolve the chat wire protocol from the stored `apiProtocol` value. There
/// is deliberately no base-URL guessing: the desktop settings page pins auto
/// entries through probe-based detection before syncing them here, so an
/// unpinned entry (legacy stores, env fallbacks, mobile) uses the safest
/// default — Chat Completions.
pub fn resolve_protocol(entry: &ProviderEntry) -> ApiProtocol {
    ApiProtocol::from_stored(&entry.api_protocol)
}

/// 由供应商条目构建 chat provider；无 api_key 时回退 mock（保持全链路可演示）。
pub fn create_provider_from_entry(entry: &ProviderEntry) -> Result<std::sync::Arc<dyn Provider>> {
    if entry.api_key.trim().is_empty() {
        return Ok(std::sync::Arc::new(MockProvider::default_script(
            entry.active_model.clone(),
        )));
    }
    match resolve_protocol(entry) {
        ApiProtocol::Anthropic => Ok(std::sync::Arc::new(AnthropicProvider::new(
            entry.api_key.clone(),
            entry.active_model.clone(),
            non_empty(Some(entry.base_url.clone())),
        )?)),
        ApiProtocol::OpenAiResponses => Ok(std::sync::Arc::new(OpenAIResponsesProvider::new(
            entry.api_key.clone(),
            entry.active_model.clone(),
            non_empty(Some(entry.base_url.clone())),
        ))),
        ApiProtocol::OpenAiChat => {
            let (image_generation, image_editing) = entry
                .models
                .iter()
                .find(|model| model.id == entry.active_model)
                .map(|model| (model.image_generation, model.image_editing))
                .unwrap_or((entry.image_generation, false));
            Ok(std::sync::Arc::new(
                OpenAIProvider::new(
                    entry.api_key.clone(),
                    entry.active_model.clone(),
                    non_empty(Some(entry.base_url.clone())),
                )
                .with_image_capabilities(image_generation, image_editing),
            ))
        }
    }
}

fn non_empty(url: Option<String>) -> Option<String> {
    url.filter(|u| !u.trim().is_empty())
}

/// 生成的图片字节。
pub struct GeneratedImage {
    pub bytes: Vec<u8>,
    pub ext: &'static str,
}

/// 全参数生图请求（对齐桌面 ImageStudio）。
pub struct ImageParams<'a> {
    pub prompt: &'a str,
    pub negative_prompt: Option<&'a str>,
    pub aspect: Option<&'a str>,
    /// Explicit pixel size (for example 1024x1024). It takes precedence over
    /// aspect/resolution when a provider accepts a concrete size.
    pub size: Option<&'a str>,
    /// "1K" | "2K" | "4K"
    pub resolution: Option<&'a str>,
    /// auto | low | medium | high
    pub quality: Option<&'a str>,
    /// png | jpeg | webp
    pub format: Option<&'a str>,
    pub n: u32,
    /// Backward-compatible single edit reference image (base64).
    pub input_image_b64: Option<&'a str>,
    /// Edit-mode reference images. When present, this takes precedence over
    /// `input_image_b64` and is sent using Electron's image/image[] contract.
    pub input_images_b64: Vec<&'a str>,
    /// MIME types paired with `input_images_b64`. Unknown/missing entries use
    /// image/png so older raw-base64 callers remain supported.
    pub input_image_mimes: Vec<&'a str>,
}

#[derive(Clone)]
struct ImageRequestOptions {
    negative_prompt: Option<String>,
    quality: Option<String>,
    output_format: Option<String>,
    response_format: Option<&'static str>,
}

#[derive(Clone, Copy)]
enum ImageRequestKind {
    Generation,
    StandardEdit,
    ArkEdit,
}

impl ImageRequestOptions {
    fn new(model: &str, params: &ImageParams<'_>, kind: ImageRequestKind) -> Self {
        let is_dall_e = is_dall_e_model(model);
        let is_gpt_image = is_gpt_image_model(model);
        let quality = params.quality.and_then(|quality| {
            let quality = quality.trim();
            if quality.is_empty() {
                None
            } else if is_dall_e {
                (quality == "high").then(|| "hd".to_string())
            } else {
                Some(quality.to_string())
            }
        });
        let output_format = (!is_dall_e)
            .then(|| params.format.map(str::trim))
            .flatten()
            .filter(|format| !format.is_empty())
            .map(str::to_string);
        let response_format = match (is_gpt_image, kind) {
            (true, _) | (_, ImageRequestKind::StandardEdit) => None,
            (false, ImageRequestKind::ArkEdit) => Some("url"),
            (false, ImageRequestKind::Generation) => Some("b64_json"),
        };
        Self {
            negative_prompt: (!matches!(kind, ImageRequestKind::StandardEdit))
                .then(|| params.negative_prompt.map(str::trim))
                .flatten()
                .filter(|prompt| !prompt.is_empty())
                .map(str::to_string),
            quality,
            output_format,
            response_format,
        }
    }

    fn ext(&self) -> &'static str {
        ext_of(self.output_format.as_deref())
    }

    fn remove_rejected_field(&mut self, status: reqwest::StatusCode, error: &str) -> bool {
        if !matches!(status.as_u16(), 400 | 422) {
            return false;
        }
        for (field, present) in [
            ("negative_prompt", self.negative_prompt.is_some()),
            ("quality", self.quality.is_some()),
            ("output_format", self.output_format.is_some()),
            ("response_format", self.response_format.is_some()),
        ] {
            if present && rejected_image_field(error, field) {
                match field {
                    "negative_prompt" => self.negative_prompt = None,
                    "quality" => self.quality = None,
                    "output_format" => self.output_format = None,
                    "response_format" => self.response_format = None,
                    _ => unreachable!(),
                }
                return true;
            }
        }
        false
    }
}

fn rejected_image_field(error: &str, field: &str) -> bool {
    let error = error.to_ascii_lowercase();
    let spaced_field = field.replace('_', " ");
    let markers = [
        "unsupported",
        "not supported",
        "does not support",
        "unknown",
        "unrecognized",
        "invalid",
        "extra",
        "not permitted",
        "unexpected",
    ];
    [field, spaced_field.as_str()].iter().any(|needle| {
        error.match_indices(needle).any(|(index, _)| {
            let mut start = index.saturating_sub(128);
            while !error.is_char_boundary(start) {
                start += 1;
            }
            let mut end = (index + needle.len() + 128).min(error.len());
            while !error.is_char_boundary(end) {
                end -= 1;
            }
            markers
                .iter()
                .any(|marker| error[start..end].contains(marker))
        })
    })
}

fn apply_json_image_options(body: &mut Value, options: &ImageRequestOptions) {
    if let Some(value) = &options.negative_prompt {
        body["negative_prompt"] = json!(value);
    }
    if let Some(value) = &options.quality {
        body["quality"] = json!(value);
    }
    if let Some(value) = &options.output_format {
        body["output_format"] = json!(value);
    }
    if let Some(value) = options.response_format {
        body["response_format"] = json!(value);
    }
}

/// OpenAI images 接口生图/改图（gpt-image-1 / dall-e-3 等任意 openai 协议端点）。
/// 无 api_key 时生成确定性 SVG 占位图（mock 演示链路）。
pub async fn generate_images(
    entry: &ProviderEntry,
    model: &str,
    params: &ImageParams<'_>,
) -> Result<Vec<GeneratedImage>> {
    let requested_n = params.n.clamp(1, 4);
    // DALL-E 3 accepts exactly one image per HTTP request. The Studio contract
    // still promises up to four outputs, so generation fans out below instead
    // of silently reducing the requested count.
    let n = if is_dall_e_3_model(model) {
        1
    } else {
        requested_n
    };
    let explicit_size = params
        .size
        .filter(|size| !size.trim().is_empty())
        .map(str::trim);
    let explicit_pixel_size = explicit_size
        .and_then(|size| size.split_once('x'))
        .and_then(|(width, height)| {
            let width = width.trim().parse::<u32>().ok()?;
            let height = height.trim().parse::<u32>().ok()?;
            width.checked_mul(height)
        });
    // OpenAI's own image endpoints infer or constrain size. Many OpenAI-
    // compatible services use different pixel-size tiers (for example Ark's
    // Seedream models require >= 3,686,400 pixels), so let those services pick
    // their default unless the user explicitly chose a size.
    let normalized_model = model.to_ascii_lowercase();
    let normalized_base_url = entry.base_url.to_ascii_lowercase();
    let uses_openai_image_sizes = is_gpt_image_model(model)
        || is_dall_e_model(model)
        || normalized_base_url.contains("api.openai.com");
    let uses_ark_image_contract = normalized_model.contains("doubao-seedream")
        || normalized_model.contains("seedream")
        || normalized_base_url.contains("volces.com");
    let size = if let Some(size) = normalized_dall_e_size(model, explicit_size, params.aspect) {
        size
    } else if uses_openai_image_sizes {
        // Resolution labels such as "1K" are queue metadata, not an OpenAI
        // size argument. Convert them to an endpoint-supported pixel size.
        if explicit_pixel_size.is_some() {
            explicit_size
        } else {
            Some(size_for(params.aspect, params.resolution))
        }
        .unwrap_or_default()
    } else {
        // Queued requests always carry a non-empty size label for restart parity.
        // Only a real WxH value can be forwarded; tier labels let the provider
        // select its own (often much larger) default.
        if explicit_pixel_size.is_some_and(|pixels| {
            // Seedream 5 Lite rejects smaller OpenAI defaults. Queue requests
            // carry those defaults, so treat them as a resolution hint instead
            // of forwarding an unsupported size.
            !(uses_ark_image_contract && pixels < 3_686_400)
        }) {
            explicit_size.unwrap_or_default()
        } else {
            ""
        }
    };
    let uses_ark_edit_contract = uses_ark_image_contract;
    if entry.api_key.trim().is_empty() {
        return Ok((0..requested_n)
            .map(|i| mock_placeholder(params.prompt, Some(size), i))
            .collect());
    }

    let base = entry.base_url.trim();
    let generations_url = crate::urls::image_generations_url(base)?;
    let edits_url = crate::urls::image_edits_url(base)?;
    let client = crate::http::client();

    // 编辑模式：multipart /images/edits. Electron sends one image as
    // `image`, and more than one as repeated `image[]` fields.
    let edit_inputs: Vec<(&str, &str)> = if !params.input_images_b64.is_empty() {
        params
            .input_images_b64
            .iter()
            .enumerate()
            .map(|(index, b64)| {
                let mime = params
                    .input_image_mimes
                    .get(index)
                    .copied()
                    .filter(|mime| mime.starts_with("image/"))
                    .unwrap_or("image/png");
                (*b64, mime)
            })
            .collect()
    } else {
        params
            .input_image_b64
            .map(|b64| vec![(b64, "image/png")])
            .unwrap_or_default()
    };
    if !edit_inputs.is_empty() {
        if is_dall_e_3_model(model) {
            bail!("DALL-E 3 does not support image editing");
        }
        if is_dall_e_2_model(model) && edit_inputs.len() > 1 {
            bail!("DALL-E 2 image editing accepts exactly one input image");
        }
        if uses_ark_edit_contract {
            let image_values = edit_inputs
                .iter()
                .map(|(b64, mime)| format!("data:{mime};base64,{b64}"))
                .collect::<Vec<_>>();
            let image = if image_values.len() == 1 {
                Value::String(image_values[0].clone())
            } else {
                json!(image_values)
            };
            let mut options = ImageRequestOptions::new(model, params, ImageRequestKind::ArkEdit);
            let request_timeout = IMAGE_REQUEST_TIMEOUT;
            let resp = loop {
                let mut body = json!({
                    "model": model,
                    "prompt": params.prompt,
                    "n": n,
                    "image": image,
                });
                apply_json_image_options(&mut body, &options);
                let resp =
                    crate::http::send_with_retry_timeout("image edit", request_timeout, || {
                        client
                            .post(generations_url.clone())
                            .bearer_auth(&entry.api_key)
                            .json(&body)
                            .timeout(request_timeout)
                    })
                    .await
                    .context("image edit request failed")?;
                let status = resp.status();
                if status.is_success() {
                    break resp;
                }
                let text = resp.text().await.unwrap_or_default();
                if !options.remove_rejected_field(status, &text) {
                    bail!("image api error ({status}): {text}");
                }
            };
            let value: Value = resp.json().await.context("parse image response")?;
            let out = collect_images(value, &client, options.ext()).await?;
            anyhow::ensure!(!out.is_empty(), "image api returned no images");
            return Ok(out);
        }

        use base64::Engine;
        let multiple = edit_inputs.len() > 1;
        let uploads = edit_inputs
            .iter()
            .enumerate()
            .map(|(index, (b64, mime))| {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(b64)
                    .with_context(|| format!("decode input image {index}"))?;
                let extension = match *mime {
                    "image/jpeg" | "image/jpg" => "jpg",
                    "image/webp" => "webp",
                    "image/gif" => "gif",
                    "image/svg+xml" => "svg",
                    _ => "png",
                };
                Ok((bytes, (*mime).to_string(), extension))
            })
            .collect::<Result<Vec<_>>>()?;
        let mut options = ImageRequestOptions::new(model, params, ImageRequestKind::StandardEdit);
        let request_timeout = IMAGE_REQUEST_TIMEOUT;
        let resp = loop {
            let resp = crate::http::send_fallible_with_retry_timeout(
                "image edit",
                request_timeout,
                || {
                    let mut form = reqwest::multipart::Form::new()
                        .text("model", model.to_string())
                        .text("prompt", params.prompt.to_string())
                        .text("n", n.to_string());
                    if !size.trim().is_empty() {
                        form = form.text("size", size.to_string());
                    }
                    if let Some(negative_prompt) = &options.negative_prompt {
                        form = form.text("negative_prompt", negative_prompt.clone());
                    }
                    if let Some(quality) = &options.quality {
                        form = form.text("quality", quality.clone());
                    }
                    if let Some(format) = &options.output_format {
                        form = form.text("output_format", format.clone());
                    }
                    if let Some(format) = options.response_format {
                        form = form.text("response_format", format.to_string());
                    }
                    for (index, (bytes, mime, extension)) in uploads.iter().enumerate() {
                        let part = reqwest::multipart::Part::bytes(bytes.clone())
                            .file_name(format!("image-{index}.{extension}"))
                            .mime_str(mime)?;
                        form = form.part(if multiple { "image[]" } else { "image" }, part);
                    }
                    Ok(client
                        .post(edits_url.clone())
                        .bearer_auth(&entry.api_key)
                        .multipart(form)
                        .timeout(request_timeout))
                },
            )
            .await
            .context("image edit request failed")?;
            let status = resp.status();
            if status.is_success() {
                break resp;
            }
            let text = resp.text().await.unwrap_or_default();
            if !options.remove_rejected_field(status, &text) {
                bail!("image api error ({status}): {text}");
            }
        };
        let value: Value = resp.json().await.context("parse image response")?;
        let out = collect_images(value, &client, options.ext()).await?;
        anyhow::ensure!(!out.is_empty(), "image api returned no images");
        return Ok(out);
    }

    // 生成模式：JSON /images/generations
    let mut options = ImageRequestOptions::new(model, params, ImageRequestKind::Generation);
    let request_timeout = IMAGE_REQUEST_TIMEOUT;
    let request_count = if is_dall_e_3_model(model) {
        requested_n
    } else {
        1
    };
    let mut out = Vec::new();
    for _ in 0..request_count {
        let resp = loop {
            let mut body = json!({ "model": model, "prompt": params.prompt, "n": n });
            if !size.trim().is_empty() {
                body["size"] = json!(size);
            }
            apply_json_image_options(&mut body, &options);
            let resp =
                crate::http::send_with_retry_timeout("image generation", request_timeout, || {
                    client
                        .post(generations_url.clone())
                        .bearer_auth(&entry.api_key)
                        .json(&body)
                        .timeout(request_timeout)
                })
                .await
                .context("image generation request failed")?;
            let status = resp.status();
            if status.is_success() {
                break resp;
            }
            let text = resp.text().await.unwrap_or_default();
            if !options.remove_rejected_field(status, &text) {
                bail!("image api error ({status}): {text}");
            }
        };
        let value: Value = resp.json().await.context("parse image response")?;
        let mut generated = collect_images(value, &client, options.ext()).await?;
        anyhow::ensure!(!generated.is_empty(), "image api returned no images");
        out.append(&mut generated);
    }
    out.truncate(requested_n as usize);
    Ok(out)
}

async fn collect_images(
    value: Value,
    client: &reqwest::Client,
    ext: &'static str,
) -> Result<Vec<GeneratedImage>> {
    let mut out = Vec::new();
    if let Some(items) = value["data"].as_array() {
        for item in items {
            if let Some(b64) = item["b64_json"].as_str() {
                use base64::Engine;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(b64)
                    .context("decode b64 image")?;
                let ext = image_ext_from_bytes(&bytes).unwrap_or(ext);
                out.push(GeneratedImage { bytes, ext });
            } else if let Some(url) = item["url"].as_str() {
                let response = crate::http::send_with_retry("image download", || client.get(url))
                    .await
                    .context("image download request failed")?;
                let status = response.status();
                if !status.is_success() {
                    bail!("image download failed with HTTP {status}");
                }
                let content_type_ext = response
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .and_then(image_ext_from_content_type);
                let bytes = response.bytes().await.context("read downloaded image")?;
                let ext = content_type_ext
                    .or_else(|| image_ext_from_bytes(&bytes))
                    .unwrap_or(ext);
                out.push(GeneratedImage {
                    bytes: bytes.to_vec(),
                    ext,
                });
            }
        }
    }
    Ok(out)
}

fn image_ext_from_content_type(content_type: &str) -> Option<&'static str> {
    match content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "image/png" => Some("png"),
        _ => None,
    }
}

fn image_ext_from_bytes(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("jpg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

fn ext_of(format: Option<&str>) -> &'static str {
    match format {
        Some("jpeg") | Some("jpg") => "jpg",
        Some("webp") => "webp",
        _ => "png",
    }
}

/// 宽高比 → API 尺寸（gpt-image-1 支持 1024x1024 / 1536x1024 / 1024x1536）。
pub fn size_for(aspect: Option<&str>, _resolution: Option<&str>) -> &'static str {
    // Resolution only changes the mock rendering size; the real image API
    // accepts the fixed sizes above and has no separate resolution tier.
    match aspect.unwrap_or("1:1") {
        "3:2" | "4:3" | "16:9" => "1536x1024",
        "2:3" | "3:4" | "9:16" => "1024x1536",
        _ => "1024x1024",
    }
}

/// mock 绘制像素尺寸（aspect × resolution，桌面同款 560–3840px 取整）。
pub fn pixel_size(aspect: Option<&str>, resolution: Option<&str>) -> (u32, u32) {
    let base = match resolution.unwrap_or("1K") {
        "2K" => 2048u32,
        "4K" => 3840u32,
        _ => 1024u32,
    };
    let (w, h) = match aspect.unwrap_or("1:1") {
        "3:2" => (base * 3 / 2, base),
        "2:3" => (base, base * 3 / 2),
        "16:9" => (base * 16 / 9, base),
        "9:16" => (base, base * 16 / 9),
        "4:3" => (base * 4 / 3, base),
        "3:4" => (base, base * 4 / 3),
        _ => (base, base),
    };
    (w / 16 * 16, h / 16 * 16)
}

/// 确定性 SVG 占位图（按 prompt 哈希上色）。
fn mock_placeholder(prompt: &str, size: Option<&str>, index: u32) -> GeneratedImage {
    let parts: Vec<u32> = size
        .unwrap_or("1024x1024")
        .split('x')
        .filter_map(|p| p.parse().ok())
        .collect();
    let (w, h) = (
        parts.first().copied().unwrap_or(1024),
        parts.get(1).copied().unwrap_or(1024),
    );
    let hash: u64 = prompt.bytes().fold(0xcbf29ce484222325u64, |acc, b| {
        (acc ^ b as u64)
            .wrapping_mul(0x100000001b3)
            .wrapping_add(index as u64)
    });
    let hue = hash % 360;
    let hue2 = (hue + 120) % 360;
    let short: String = prompt.chars().take(24).collect();
    let svg = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl({hue}, 65%, 55%)"/>
    <stop offset="1" stop-color="hsl({hue2}, 70%, 40%)"/>
  </linearGradient></defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <text x="50%" y="46%" text-anchor="middle" font-family="sans-serif" font-size="{}" fill="rgba(255,255,255,0.92)">{short}</text>
  <text x="50%" y="56%" text-anchor="middle" font-family="sans-serif" font-size="{}" fill="rgba(255,255,255,0.55)">mock image #{index}</text>
</svg>"#,
        w / 20,
        w / 40,
    );
    GeneratedImage {
        bytes: svg.into_bytes(),
        ext: "svg",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn read_http_request(socket: &mut tokio::net::TcpStream) -> Vec<u8> {
        let mut buffer = Vec::new();
        let mut body_length = None;
        loop {
            let mut chunk = [0u8; 4096];
            let count = socket.read(&mut chunk).await.unwrap();
            assert!(count > 0, "client closed HTTP request before completing it");
            buffer.extend_from_slice(&chunk[..count]);
            if let Some(header_end) = buffer.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                if body_length.is_none() {
                    let headers = String::from_utf8_lossy(&buffer[..header_end]);
                    body_length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .or(Some(0));
                }
                let expected = header_end + 4 + body_length.unwrap_or(0);
                if buffer.len() >= expected {
                    return buffer;
                }
            }
        }
    }

    #[test]
    fn size_mapping() {
        assert_eq!(size_for(Some("1:1"), Some("1K")), "1024x1024");
        assert_eq!(size_for(Some("16:9"), Some("1K")), "1536x1024");
        assert_eq!(pixel_size(Some("16:9"), Some("2K")), (3632, 2048));
        assert_eq!(pixel_size(Some("1:1"), Some("4K")), (3840, 3840));
    }

    #[test]
    fn dall_e_omits_non_hd_quality_levels() {
        for quality in ["auto", "low", "medium"] {
            let mut params = image_test_params();
            params.quality = Some(quality);
            let options =
                ImageRequestOptions::new("dall-e-3", &params, ImageRequestKind::Generation);
            assert!(options.quality.is_none(), "quality {quality}");
            assert!(options.output_format.is_none());
            assert_eq!(options.response_format, Some("b64_json"));
        }
    }

    #[test]
    fn detects_actual_image_extension() {
        assert_eq!(image_ext_from_bytes(b"\x89PNG\r\n\x1a\nrest"), Some("png"));
        assert_eq!(image_ext_from_bytes(&[0xff, 0xd8, 0xff, 0]), Some("jpg"));
        assert_eq!(
            image_ext_from_bytes(b"RIFF\x00\x00\x00\x00WEBP"),
            Some("webp")
        );
        assert_eq!(
            image_ext_from_content_type("image/jpeg; charset=binary"),
            Some("jpg")
        );
    }

    #[test]
    fn protocol_resolution_normalizes_stored_values() {
        let mut e = ProviderEntry {
            id: "p1".into(),
            name: "官方".into(),
            base_url: "https://api.anthropic.com".into(),
            api_key: "k".into(),
            api_protocol: "".into(),
            models: vec![worldbase_protocol::types::ModelInfo {
                id: "claude-sonnet-4".into(),
                context_window_k: 200,
                input_price: 3.0,
                output_price: 15.0,
                cache_read_price: 0.3,
                image_generation: false,
                image_editing: false,
            }],
            active_model: "claude-sonnet-4".into(),
            temperature: None,
            enable_thinking: false,
            image_generation: false,
        };
        // Auto never guesses from the base URL — even the official Anthropic
        // domain stays on Chat Completions until detection pins a protocol.
        assert_eq!(resolve_protocol(&e), ApiProtocol::OpenAiChat);
        e.api_protocol = "openai".into();
        assert_eq!(resolve_protocol(&e), ApiProtocol::OpenAiChat);
        e.api_protocol = "openai-chat".into();
        assert_eq!(resolve_protocol(&e), ApiProtocol::OpenAiChat);
        e.api_protocol = "openai-responses".into();
        assert_eq!(resolve_protocol(&e), ApiProtocol::OpenAiResponses);
        e.api_protocol = "anthropic".into();
        assert_eq!(resolve_protocol(&e), ApiProtocol::Anthropic);

        e.api_protocol.clear();
        e.base_url = "https://gateway.example/api/anthropic".into();
        assert_eq!(resolve_protocol(&e), ApiProtocol::OpenAiChat);
    }

    #[test]
    fn creates_responses_provider_for_openai_responses_protocol() {
        let e = ProviderEntry {
            id: "p".into(),
            name: "官方".into(),
            base_url: "https://api.openai.com/v1".into(),
            api_key: "k".into(),
            api_protocol: "openai-responses".into(),
            models: vec![],
            active_model: "gpt-5.1".into(),
            temperature: None,
            enable_thinking: false,
            image_generation: false,
        };
        let provider = create_provider_from_entry(&e).unwrap();
        assert_eq!(provider.name(), "openai-responses");
    }

    #[tokio::test]
    async fn mock_image_generation() {
        let e = ProviderEntry {
            id: "p".into(),
            name: "m".into(),
            base_url: String::new(),
            api_key: String::new(),
            api_protocol: "".into(),
            models: vec![],
            active_model: "mock-image".into(),
            temperature: None,
            enable_thinking: false,
            image_generation: true,
        };
        let mut params = ImageParams {
            prompt: "一只赛博朋克猫",
            negative_prompt: None,
            aspect: Some("1:1"),
            size: None,
            resolution: Some("1K"),
            quality: Some("auto"),
            format: Some("png"),
            n: 2,
            input_image_b64: None,
            input_images_b64: vec![],
            input_image_mimes: vec![],
        };
        let imgs = generate_images(&e, "mock-image", &params).await.unwrap();
        assert_eq!(imgs.len(), 2);
        assert_eq!(imgs[0].ext, "svg");
        assert!(imgs[0].bytes.starts_with(b"<svg"));

        params.n = 4;
        let imgs = generate_images(&e, "dall-e-3", &params).await.unwrap();
        assert_eq!(imgs.len(), 4);
    }

    #[tokio::test]
    async fn image_edit_retries_and_rebuilds_all_multipart_fields() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for attempt in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = read_http_request(&mut socket).await;
                let request = String::from_utf8_lossy(&request);
                assert!(request.starts_with("POST /images/edits HTTP/1.1"));
                assert!(request.contains("name=\"size\"\r\n\r\n1536x1024"));
                assert!(request.contains("name=\"quality\"\r\n\r\nhigh"));
                assert!(request.contains("name=\"output_format\"\r\n\r\nwebp"));
                assert!(!request.contains("name=\"negative_prompt\""));
                assert!(!request.contains("name=\"response_format\""));
                assert_eq!(request.matches("name=\"image[]\"").count(), 2);
                let (status, body) = if attempt == 0 {
                    ("503 Service Unavailable", r#"{"error":"retry"}"#)
                } else {
                    ("200 OK", r#"{"data":[{"b64_json":"aGVsbG8="}]}"#)
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });

        let entry = ProviderEntry {
            id: "image".into(),
            name: "Image".into(),
            base_url: format!("http://{address}"),
            api_key: "test-key".into(),
            api_protocol: "openai".into(),
            models: vec![],
            active_model: "compatible-image-edit".into(),
            temperature: None,
            enable_thinking: false,
            image_generation: true,
        };
        let params = ImageParams {
            prompt: "combine the references",
            negative_prompt: Some("no text"),
            aspect: Some("3:2"),
            size: Some("1536x1024"),
            resolution: Some("2K"),
            quality: Some("high"),
            format: Some("webp"),
            n: 1,
            input_image_b64: None,
            input_images_b64: vec!["aGVsbG8=", "d29ybGQ="],
            input_image_mimes: vec!["image/png", "image/jpeg"],
        };
        let images = generate_images(&entry, "compatible-image-edit", &params)
            .await
            .unwrap();
        server.await.unwrap();
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].ext, "webp");
        assert_eq!(images[0].bytes, b"hello");
    }

    #[tokio::test]
    async fn dall_e_3_fans_out_single_image_requests_with_valid_parameters() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for _ in 0..4 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = read_http_request(&mut socket).await;
                let body = String::from_utf8_lossy(&request)
                    .split_once("\r\n\r\n")
                    .map(|(_, body)| body.to_string())
                    .unwrap();
                let payload: Value = serde_json::from_str(&body).unwrap();
                assert_eq!(payload["quality"], "hd");
                assert_eq!(payload["response_format"], "b64_json");
                assert_eq!(payload["n"], 1);
                assert_eq!(payload["size"], "1792x1024");
                assert!(payload.get("output_format").is_none());
                let response = r#"{"data":[{"b64_json":"aGVsbG8="}]}"#;
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{response}",
                            response.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            }
        });

        let entry = image_test_entry(address);
        let mut params = image_test_params();
        params.quality = Some("high");
        params.format = Some("webp");
        params.aspect = Some("16:9");
        // The shared UI may restore a GPT Image size and a multi-image count;
        // both must be normalized before they reach DALL-E 3.
        params.size = Some("1536x1024");
        params.n = 4;
        let images = generate_images(&entry, "dall-e-3", &params).await.unwrap();
        server.await.unwrap();
        assert_eq!(images.len(), 4);
        assert!(images.iter().all(|image| image.ext == "png"));
    }

    #[test]
    fn dall_e_versions_use_only_their_documented_sizes() {
        assert_eq!(
            normalized_dall_e_size("dall-e-2", Some("1536x1024"), Some("9:16")),
            Some("1024x1024")
        );
        assert_eq!(
            normalized_dall_e_size("dall-e-2", Some("512x512"), Some("9:16")),
            Some("512x512")
        );
        assert_eq!(
            normalized_dall_e_size("dall-e-3", Some("1536x1024"), Some("9:16")),
            Some("1024x1792")
        );
        assert_eq!(
            normalized_dall_e_size("dall-e-3", Some("1792x1024"), Some("9:16")),
            Some("1792x1024")
        );
    }

    #[tokio::test]
    async fn generation_removes_explicitly_rejected_optional_fields_in_order() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let rejected = [
                ("negative_prompt", "unknown parameter negative_prompt"),
                ("quality", "quality is unsupported"),
                ("output_format", "invalid output_format"),
                ("response_format", "response_format is an extra field"),
            ];
            for attempt in 0..=rejected.len() {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = read_http_request(&mut socket).await;
                let body = String::from_utf8_lossy(&request)
                    .split_once("\r\n\r\n")
                    .map(|(_, body)| body.to_string())
                    .unwrap();
                let payload: Value = serde_json::from_str(&body).unwrap();
                for (index, (field, _)) in rejected.iter().enumerate() {
                    assert_eq!(
                        payload.get(*field).is_some(),
                        index >= attempt,
                        "field {field} on attempt {attempt}: {payload}"
                    );
                }
                let (status, response) = if attempt < rejected.len() {
                    ("422 Unprocessable Entity", rejected[attempt].1)
                } else {
                    ("200 OK", r#"{"data":[{"b64_json":"aGVsbG8="}]}"#)
                };
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{response}",
                            response.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            }
        });

        let entry = image_test_entry(address);
        let params = image_test_params();
        let images = generate_images(&entry, "compatible-image-model", &params)
            .await
            .unwrap();
        server.await.unwrap();
        assert_eq!(images[0].ext, "png");
    }

    #[tokio::test]
    async fn multipart_edit_removes_rejected_output_format_and_rebuilds_form() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for attempt in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = read_http_request(&mut socket).await;
                let request = String::from_utf8_lossy(&request).into_owned();
                assert_eq!(request.contains("name=\"output_format\""), attempt == 0);
                assert!(!request.contains("name=\"response_format\""));
                assert!(request.contains("name=\"image\""));
                let (status, response) = if attempt == 0 {
                    ("400 Bad Request", "output_format is not supported")
                } else {
                    ("200 OK", r#"{"data":[{"b64_json":"aGVsbG8="}]}"#)
                };
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{response}",
                            response.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            }
        });

        let entry = image_test_entry(address);
        let mut params = image_test_params();
        params.negative_prompt = None;
        params.quality = Some("auto");
        params.input_image_b64 = Some("aGVsbG8=");
        let images = generate_images(&entry, "compatible-image-model", &params)
            .await
            .unwrap();
        server.await.unwrap();
        assert_eq!(images[0].ext, "png");
    }

    fn image_test_entry(address: std::net::SocketAddr) -> ProviderEntry {
        ProviderEntry {
            id: "image".into(),
            name: "Image".into(),
            base_url: format!("http://{address}"),
            api_key: "test-key".into(),
            api_protocol: "openai".into(),
            models: vec![],
            active_model: "image-model".into(),
            temperature: None,
            enable_thinking: false,
            image_generation: true,
        }
    }

    fn image_test_params() -> ImageParams<'static> {
        ImageParams {
            prompt: "draw a cat",
            negative_prompt: Some("text"),
            aspect: Some("1:1"),
            size: None,
            resolution: Some("1K"),
            quality: Some("high"),
            format: Some("webp"),
            n: 1,
            input_image_b64: None,
            input_images_b64: vec![],
            input_image_mimes: vec![],
        }
    }

    #[tokio::test]
    async fn ark_image_edit_uses_generation_endpoint_with_data_url() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            let request = String::from_utf8_lossy(&request).into_owned();
            assert!(request.starts_with("POST /images/generations HTTP/1.1"));
            let body = request
                .split_once("\r\n\r\n")
                .map(|(_, body)| body)
                .unwrap_or_default();
            let payload: Value = serde_json::from_str(body).unwrap();
            assert_eq!(payload["model"], "doubao-seedream-5.0-lite");
            assert_eq!(payload["image"], "data:image/png;base64,aGVsbG8=");
            assert_eq!(payload["response_format"], "url");
            let response = r#"{"data":[{"url":"http://127.0.0.1:9/hello.png"}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                response.len(),
                response
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });

        let entry = ProviderEntry {
            id: "image".into(),
            name: "Image".into(),
            base_url: format!("http://{address}"),
            api_key: "test-key".into(),
            api_protocol: "openai".into(),
            models: vec![],
            active_model: "doubao-seedream-5.0-lite".into(),
            temperature: None,
            enable_thinking: false,
            image_generation: true,
        };
        let params = ImageParams {
            prompt: "add a yellow border",
            negative_prompt: None,
            aspect: Some("1:1"),
            size: None,
            resolution: Some("1K"),
            quality: Some("auto"),
            format: Some("png"),
            n: 1,
            input_image_b64: Some("aGVsbG8="),
            input_images_b64: vec![],
            input_image_mimes: vec![],
        };
        let result = generate_images(&entry, "doubao-seedream-5.0-lite", &params).await;
        assert!(
            result.is_err(),
            "the local test URL is not fetchable; this test only validates the upstream request"
        );
        server.await.unwrap();
    }

    #[test]
    fn aspect_mapping() {
        assert_eq!(size_for(Some("16:9"), None), "1536x1024");
        assert_eq!(size_for(None, None), "1024x1024");
    }
}
