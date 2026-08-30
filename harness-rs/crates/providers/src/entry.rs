//! 供应商条目解析（对齐桌面端 apiProtocol auto 规则）与图像生成。

use super::{ChunkStream, LlmMessage, LlmRole, LlmTool, Provider, StreamChunk};
use crate::{AnthropicProvider, MockProvider, OpenAIProvider};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use worldbase_protocol::types::ProviderEntry;

/// auto 规则：baseUrl 含 anthropic → anthropic 协议，否则 openai（对齐桌面 resolveApiProtocol）。
pub fn resolve_protocol(entry: &ProviderEntry) -> &'static str {
    match entry.api_protocol.as_str() {
        "anthropic" => "anthropic",
        "openai" => "openai",
        _ => {
            if entry.base_url.contains("anthropic") {
                "anthropic"
            } else {
                "openai"
            }
        }
    }
}

/// 由供应商条目构建 chat provider；无 api_key 时回退 mock（保持全链路可演示）。
pub fn create_provider_from_entry(entry: &ProviderEntry) -> Result<std::sync::Arc<dyn Provider>> {
    if entry.api_key.trim().is_empty() {
        return Ok(std::sync::Arc::new(MockProvider::default_script(
            entry.active_model.clone(),
        )));
    }
    match resolve_protocol(entry) {
        "anthropic" => Ok(std::sync::Arc::new(AnthropicProvider::new(
            entry.api_key.clone(),
            entry.active_model.clone(),
            Some(entry.base_url.clone()).filter(|u| !u.trim().is_empty()),
        )?)),
        _ => Ok(std::sync::Arc::new(OpenAIProvider::new(
            entry.api_key.clone(),
            entry.active_model.clone(),
            Some(entry.base_url.clone()).filter(|u| !u.trim().is_empty()),
        ))),
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

/// OpenAI images 接口生图/改图（gpt-image-1 / dall-e-3 等任意 openai 协议端点）。
/// 无 api_key 时生成确定性 SVG 占位图（mock 演示链路）。
pub async fn generate_images(
    entry: &ProviderEntry,
    model: &str,
    params: &ImageParams<'_>,
) -> Result<Vec<GeneratedImage>> {
    let n = params.n.clamp(1, 4);
    let size = params
        .size
        .filter(|size| !size.trim().is_empty())
        .unwrap_or_else(|| size_for(params.aspect, params.resolution));
    if entry.api_key.trim().is_empty() {
        return Ok((0..n)
            .map(|i| mock_placeholder(params.prompt, Some(size), i))
            .collect());
    }

    let base = if entry.base_url.trim().is_empty() {
        "https://api.openai.com/v1".to_string()
    } else {
        entry.base_url.trim().trim_end_matches('/').to_string()
    };
    let client = reqwest::Client::new();
    let ext = ext_of(params.format);

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
        use base64::Engine;
        let mut form = reqwest::multipart::Form::new()
            .text("model", model.to_string())
            .text("prompt", params.prompt.to_string())
            .text("n", n.to_string());
        if !size.trim().is_empty() {
            form = form.text("size", size.to_string());
        }
        if let Some(q) = params.quality {
            if q != "auto" {
                form = form.text("quality", (*q).to_string());
            }
        }
        if let Some(format) = params.format.filter(|format| !format.trim().is_empty()) {
            form = form.text("output_format", format.to_string());
        }
        let multiple = edit_inputs.len() > 1;
        for (index, (b64, mime)) in edit_inputs.iter().enumerate() {
            let image_bytes = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .with_context(|| format!("decode input image {index}"))?;
            let extension = match *mime {
                "image/jpeg" | "image/jpg" => "jpg",
                "image/webp" => "webp",
                "image/gif" => "gif",
                "image/svg+xml" => "svg",
                _ => "png",
            };
            let part = reqwest::multipart::Part::bytes(image_bytes)
                .file_name(format!("image-{index}.{extension}"))
                .mime_str(mime)?;
            form = form.part(if multiple { "image[]" } else { "image" }, part);
        }
        let resp = client
            .post(format!("{base}/images/edits"))
            .bearer_auth(&entry.api_key)
            .multipart(form)
            .timeout(std::time::Duration::from_secs(180))
            .send()
            .await
            .context("image edit request failed")?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            bail!("image api error ({status}): {text}");
        }
        let value: Value = resp.json().await.context("parse image response")?;
        let out = collect_images(value, &client, ext).await?;
        anyhow::ensure!(!out.is_empty(), "image api returned no images");
        return Ok(out);
    }

    // 生成模式：JSON /images/generations
    let mut body = json!({
        "model": model,
        "prompt": params.prompt,
        "n": n,
        "size": size,
    });
    if let Some(q) = params.quality {
        if q != "auto" {
            body["quality"] = json!(q);
        }
    }
    if let Some(negative_prompt) = params
        .negative_prompt
        .filter(|negative_prompt| !negative_prompt.trim().is_empty())
    {
        body["negative_prompt"] = json!(negative_prompt);
    }
    if let Some(format) = params.format.filter(|format| !format.trim().is_empty()) {
        body["output_format"] = json!(format);
    }
    let resp = client
        .post(format!("{base}/images/generations"))
        .bearer_auth(&entry.api_key)
        .json(&body)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .context("image generation request failed")?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        bail!("image api error ({status}): {text}");
    }
    let value: Value = resp.json().await.context("parse image response")?;
    let out = collect_images(value, &client, ext).await?;
    anyhow::ensure!(!out.is_empty(), "image api returned no images");
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
                out.push(GeneratedImage { bytes, ext });
            } else if let Some(url) = item["url"].as_str() {
                let bytes = client.get(url).send().await?.bytes().await?;
                out.push(GeneratedImage {
                    bytes: bytes.to_vec(),
                    ext,
                });
            }
        }
    }
    Ok(out)
}

fn ext_of(format: Option<&str>) -> &'static str {
    match format {
        Some("jpeg") | Some("jpg") => "jpg",
        Some("webp") => "webp",
        _ => "png",
    }
}

/// 宽高比 + 分辨率 → API 尺寸（gpt-image-1 支持 1024x1024 / 1536x1024 / 1024x1536）。
pub fn size_for(aspect: Option<&str>, resolution: Option<&str>) -> &'static str {
    // 分辨率档位影响 mock 绘制尺寸；真实 API 取最近支持档
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
    fn protocol_auto_rules() {
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
            image_generation: false,
        };
        assert_eq!(resolve_protocol(&e), "anthropic");
        e.base_url = "https://api.deepseek.com/v1".into();
        assert_eq!(resolve_protocol(&e), "openai");
        e.api_protocol = "anthropic".into();
        assert_eq!(resolve_protocol(&e), "anthropic");
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
            image_generation: true,
        };
        let params = ImageParams {
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
    }

    #[tokio::test]
    async fn image_edit_forwards_multiple_inputs_and_studio_options() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            let request = String::from_utf8_lossy(&request);
            assert!(request.starts_with("POST /images/edits HTTP/1.1"));
            assert!(request.contains("name=\"size\"\r\n\r\n1536x1024"));
            assert!(request.contains("name=\"quality\"\r\n\r\nhigh"));
            assert!(request.contains("name=\"output_format\"\r\n\r\nwebp"));
            assert_eq!(request.matches("name=\"image[]\"").count(), 2);
            let body = r#"{"data":[{"b64_json":"aGVsbG8="}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
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
            active_model: "gpt-image-1".into(),
            temperature: None,
            image_generation: true,
        };
        let params = ImageParams {
            prompt: "combine the references",
            negative_prompt: None,
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
        let images = generate_images(&entry, "gpt-image-1", &params)
            .await
            .unwrap();
        server.await.unwrap();
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].ext, "webp");
        assert_eq!(images[0].bytes, b"hello");
    }

    #[test]
    fn aspect_mapping() {
        assert_eq!(size_for(Some("16:9"), None), "1536x1024");
        assert_eq!(size_for(None, None), "1024x1024");
    }

    // 抑制未用告警
    #[allow(dead_code)]
    fn _t(_m: LlmMessage, _t2: LlmTool, _s: StreamChunk, _c: ChunkStream) {}
}
