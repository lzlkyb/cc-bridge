//! 把图片**当图片**交给模型，而不是 base64 文本。
//!
//! 为什么值得单开一个工具：MCP 结果里的 `{"type":"image"}` 内容块由客户端按图片计费
//! （一张图约一两千 token），而同一张图当 base64 文本塞进 `content[0].text` 要十几万
//! 字符。裸写 `read_files` + `encoding:"base64"` 就是后者。
//!
//! 顺带省掉「手写 Edge 无头截图 / Python 转 base64 打印到 stdout」这类一次性脚本。

use std::io::Cursor;
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use image::{ImageFormat, ImageReader};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::security;
use crate::state::AppState;

/// 可读的图片扩展名。
///
/// 🔴 这份清单**独立于** `config.allowed_extensions`，不是笔误。配置里那份白名单管的是
/// 「AI 能读写哪些内容文件」，默认值全是文本/源码；若 view_image 也走它，默认配置下
/// 对着 `.png` 截图直接报错，工具等于默认不可用。而图片只读不写，路径仍受
/// `allowed_roots` / `exclude_patterns` 约束，安全面没有放宽。
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp"];

/// 解码后像素上限。20MB 的文件上限挡不住「8000×8000 的扁平 PNG」——
/// 解出来是 256MB RGBA，安静地把内存吃穿。超了让调用方先裁。
const MAX_PIXELS: u64 = 60_000_000;

fn default_max_width() -> u32 {
    1600
}

fn default_jpeg_quality() -> u8 {
    80
}

#[derive(Debug, Deserialize, cc_bridge_macros::ToolSchema)]
pub struct ViewImageArgs {
    pub path: String,
    /// `[x, y, w, h]`：按**原图**像素裁剪。越界直接报错（不静默裁剪）。
    pub crop: Option<Vec<u32>>,
    /// 输出宽度上限（等比缩放）。默认 1600，传 0 表示不缩放。
    #[serde(default = "default_max_width", rename = "maxWidth")]
    pub max_width: u32,
    /// `"jpeg"`（默认，质量 80）或 `"png"`。截图/线条图用 png 更清晰，
    /// 照片用 jpeg 体积小得多。
    pub format: Option<String>,
}

pub async fn handle(args: ViewImageArgs, state: &Arc<AppState>) -> Result<Value, String> {
    let (resolved, max_bytes) = {
        let config = state.config.read().await;
        let resolved = security::path::resolve_safe_path_cached(
            &args.path,
            &state.cached_roots(),
            &config.exclude_patterns,
            config.whitelist_enabled,
        )?;
        (resolved, config.max_file_size_bytes)
    };

    assert_image_extension(&resolved)?;

    let metadata = tokio::fs::metadata(&resolved)
        .await
        .map_err(|e| format!("Cannot stat: {e}"))?;
    if !metadata.is_file() {
        return Err("path is not a regular file".into());
    }
    if metadata.len() > max_bytes {
        return Err(format!(
            "Image size {} bytes exceeds limit {max_bytes}",
            metadata.len()
        ));
    }

    let raw = tokio::fs::read(&resolved)
        .await
        .map_err(|e| format!("Read error: {e}"))?;

    // 解码/缩放/编码是纯 CPU 活，别占 tokio 工作线程。
    let label = args.path.clone();
    let (bytes, mime, info) = tokio::task::spawn_blocking(move || process(&raw, &args, &label))
        .await
        .map_err(|e| format!("image processing task failed: {e}"))??;

    let data = B64.encode(&bytes);
    Ok(json!({
        "content": [
            { "type": "image", "data": data, "mimeType": mime },
            { "type": "text", "text": serde_json::to_string(&info).unwrap() },
        ]
    }))
}

/// 扩展名必须在 [`IMAGE_EXTENSIONS`] 内（大小写不敏感）。
fn assert_image_extension(path: &std::path::Path) -> Result<(), String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        Ok(())
    } else {
        Err(format!(
            "Unsupported image extension {:?}; supported: {}",
            ext,
            IMAGE_EXTENSIONS.join(", ")
        ))
    }
}

/// 解码 → 裁剪 → 缩放 → 重新编码。返回 `(字节, mime, 说明 JSON)`。
fn process(
    raw: &[u8],
    args: &ViewImageArgs,
    path_label: &str,
) -> Result<(Vec<u8>, &'static str, Value), String> {
    let reader = ImageReader::new(Cursor::new(raw))
        .with_guessed_format()
        .map_err(|e| format!("Cannot read image header: {e}"))?;
    let src_format = reader
        .format()
        .ok_or_else(|| "Unrecognized image format (header sniffing failed)".to_string())?;
    // 只读文件头拿尺寸：先拦过大的图，再决定要不要真解码。
    let (src_w, src_h) = reader
        .into_dimensions()
        .map_err(|e| format!("Cannot read image dimensions: {e}"))?;
    if u64::from(src_w) * u64::from(src_h) > MAX_PIXELS {
        return Err(format!(
            "Image is {src_w}×{src_h} ({} megapixels), above the {}-megapixel decode limit; \
             pass `crop` to read a region instead",
            (u64::from(src_w) * u64::from(src_h)) / 1_000_000,
            MAX_PIXELS / 1_000_000
        ));
    }

    let img = ImageReader::new(Cursor::new(raw))
        .with_guessed_format()
        .map_err(|e| format!("Cannot read image header: {e}"))?
        .decode()
        .map_err(|e| format!("Cannot decode image ({src_format:?}): {e}"))?;

    let mut img = match args.crop.as_deref() {
        None => img,
        Some([x, y, w, h]) => {
            if *w == 0 || *h == 0 {
                return Err("crop width/height must be non-zero".into());
            }
            if *x as u64 + *w as u64 > u64::from(src_w) || *y as u64 + *h as u64 > u64::from(src_h)
            {
                return Err(format!(
                    "crop [{x},{y},{w},{h}] exceeds image bounds {src_w}×{src_h}"
                ));
            }
            image::imageops::crop_imm(&img, *x, *y, *w, *h)
                .to_image()
                .into()
        }
        Some(other) => {
            return Err(format!(
                "crop must be [x, y, w, h] (4 integers), got {} value(s)",
                other.len()
            ))
        }
    };

    let (mut out_w, mut out_h) = (img.width(), img.height());
    let scaled = args.max_width > 0 && out_w > args.max_width;
    if scaled {
        let ratio = f64::from(args.max_width) / f64::from(out_w);
        out_h = ((f64::from(out_h) * ratio).round() as u32).max(1);
        out_w = args.max_width;
        img = img.resize_exact(out_w, out_h, image::imageops::FilterType::Lanczos3);
    }

    let want = args
        .format
        .as_deref()
        .map(|f| f.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "jpeg".to_string());
    let (bytes, mime, format_label, quality) = match want.as_str() {
        "png" => {
            let mut buf = Vec::new();
            img.write_to(&mut Cursor::new(&mut buf), ImageFormat::Png)
                .map_err(|e| format!("PNG encode failed: {e}"))?;
            (buf, "image/png", "png", None)
        }
        "jpeg" | "jpg" => {
            // JPEG 没有 alpha 通道：RGBA 直接编码会失败，必须先丢 alpha。
            let q = default_jpeg_quality();
            let mut buf = Vec::new();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, q)
                .encode_image(&img.to_rgb8())
                .map_err(|e| format!("JPEG encode failed: {e}"))?;
            (buf, "image/jpeg", "jpeg", Some(q))
        }
        other => {
            return Err(format!(
                "Unsupported format {other:?}; use \"png\" or \"jpeg\""
            ))
        }
    };

    let info = json!({
        "path": path_label,
        "source": {
            "width": src_w,
            "height": src_h,
            "format": format!("{src_format:?}").to_ascii_lowercase(),
            "bytes": raw.len(),
        },
        "cropped": args.crop,
        "output": {
            "width": out_w,
            "height": out_h,
            "format": format_label,
            "quality": quality,
            "bytes": bytes.len(),
        },
        "scaled": scaled,
    });
    Ok((bytes, mime, info))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools::testutil::*;

    /// 造一张纯色 PNG 写盘，返回路径。
    fn seed_png(dir: &std::path::Path, name: &str, w: u32, h: u32) -> String {
        let img = image::RgbaImage::from_pixel(w, h, image::Rgba([200, 30, 40, 255]));
        let path = dir.join(name);
        img.save(&path).expect("seed png");
        path.to_string_lossy().into_owned()
    }

    fn blocks(out: &Value) -> &Vec<Value> {
        out["content"].as_array().expect("content 必须是数组")
    }

    fn text_info(out: &Value) -> Value {
        let t = blocks(out)
            .iter()
            .find(|b| b["type"] == json!("text"))
            .and_then(|b| b["text"].as_str())
            .expect("必须有 text 块");
        serde_json::from_str(t).expect("text 块应是 JSON")
    }

    /// 🔴 这条是整个工具的存在意义：结果里必须是 **image 内容块**（客户端按图片计费），
    /// 而不是一段 base64 文本。
    #[tokio::test]
    async fn returns_image_content_block_not_base64_text() {
        let (state, dir) = make_state(|_| {});
        let path = seed_png(&dir, "a.png", 40, 20);

        let out = handle(
            ViewImageArgs {
                path,
                crop: None,
                max_width: 1600,
                format: Some("png".into()),
            },
            &state,
        )
        .await
        .expect("view_image 应成功");

        let b = blocks(&out);
        let img = b
            .iter()
            .find(|x| x["type"] == json!("image"))
            .expect("必须有一个 image 内容块");
        assert_eq!(img["mimeType"], json!("image/png"));
        let data = img["data"].as_str().expect("image 块要带 data");
        assert!(!data.is_empty(), "base64 数据不能为空");
        assert!(
            B64.decode(data).is_ok(),
            "data 必须是合法 base64（客户端会直接解码）"
        );
        let info = text_info(&out);
        assert_eq!(info["source"]["width"], json!(40));
        assert_eq!(info["output"]["width"], json!(40));
        assert_eq!(info["scaled"], json!(false));
    }

    /// 缩放上限生效，且等比——宽被压到 maxWidth、高按比例。
    #[tokio::test]
    async fn max_width_scales_proportionally() {
        let (state, dir) = make_state(|_| {});
        let path = seed_png(&dir, "wide.png", 400, 100);

        let out = handle(
            ViewImageArgs {
                path,
                crop: None,
                max_width: 100,
                format: None,
            },
            &state,
        )
        .await
        .expect("view_image 应成功");

        let info = text_info(&out);
        assert_eq!(info["output"]["width"], json!(100));
        assert_eq!(info["output"]["height"], json!(25));
        assert_eq!(info["scaled"], json!(true));
        assert_eq!(info["output"]["format"], json!("jpeg"), "默认应为 jpeg");
    }

    /// 裁剪越界必须报错，不能静默截到边界——那会让模型以为看到的是它要的那块。
    #[tokio::test]
    async fn crop_out_of_bounds_is_rejected() {
        let (state, dir) = make_state(|_| {});
        let path = seed_png(&dir, "c.png", 40, 20);

        let err = handle(
            ViewImageArgs {
                path,
                crop: Some(vec![30, 10, 20, 20]),
                max_width: 1600,
                format: None,
            },
            &state,
        )
        .await
        .expect_err("越界裁剪必须报错");
        assert!(
            err.contains("exceeds image bounds"),
            "错误要说清越界：{err}"
        );
        assert!(err.contains("40×20"), "错误要给出原图尺寸：{err}");
    }

    /// 非图片扩展名直接拒——比让 `image` 去猜一个 `.txt` 的格式友好得多。
    #[tokio::test]
    async fn non_image_extension_is_rejected() {
        let (state, dir) = make_state(|_| {});
        let path = dir.join("notes.txt");
        std::fs::write(&path, b"not an image").expect("seed");

        let err = handle(
            ViewImageArgs {
                path: path.to_string_lossy().into_owned(),
                crop: None,
                max_width: 1600,
                format: None,
            },
            &state,
        )
        .await
        .expect_err("非图片扩展名必须报错");
        assert!(err.contains("Unsupported image extension"), "{err}");
    }

    /// 扩展名是图标但内容不是图片：报错必须指向「解码失败」，而不是 panic 或空白结果。
    #[tokio::test]
    async fn corrupt_image_reports_decode_failure() {
        let (state, dir) = make_state(|_| {});
        let path = dir.join("fake.png");
        std::fs::write(&path, b"\x89PNG\r\n\x1a\nthis is not really a png").expect("seed");

        let err = handle(
            ViewImageArgs {
                path: path.to_string_lossy().into_owned(),
                crop: None,
                max_width: 1600,
                format: None,
            },
            &state,
        )
        .await
        .expect_err("损坏的图片必须报错");
        assert!(
            err.contains("decode") || err.contains("dimensions"),
            "错误应指明解码阶段：{err}"
        );
    }
}
