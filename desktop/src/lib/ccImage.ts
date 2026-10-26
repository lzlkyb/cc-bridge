/**
 * 对话页图片附件：格式白名单、尺寸边界、等比缩放口径、缩略图尺寸。
 *
 * 这里只放**纯计算**（R11）：读文件、画 canvas、编 base64 全在
 * `hooks/useCcImageAttach.ts` 里。分开的理由很实际 —— 边界判定是要被单测钉死的
 * （5 MB 卡边、8000 单边、动图不能压），而 canvas 在测试环境里根本不存在。
 *
 * ## 与 Rust 侧的关系
 *
 * `session.rs` 的 `check_images` 是**兜底**（fail-closed，前端被绕过也拦得住），
 * 这里这一层是为了「粘贴的瞬间就告诉用户」，而不是等一整轮问答跑完才发现图没进去。
 * 两边的常量必须一致：改这里要同时改 `MAX_IMAGE_BYTES`。
 */

/** API 侧接受的格式。与 Rust `IMAGE_MEDIA_TYPES` 同一份清单。 */
export const IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

/** 单图上限（二进制 5 MB）：Anthropic 的硬限制，超了 API 直接 400。 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 单边上限（像素）。超了 API 同样拒，但**可以靠缩放救**。 */
export const MAX_IMAGE_EDGE = 8000;

/**
 * 超过 5 MB 时缩到长边 1568px 再重编码。
 *
 * 1568 是 Anthropic 文档给「约 1.15 兆像素」的那一档，也是视觉细节与体积的折中点：
 * 再大对模型没有额外信息量，再小截图里的字就看不清了。
 */
export const SHRINK_EDGE = 1568;

/** 回显缩略图长边。原图不落盘，历史里只能看到这个尺寸。 */
export const THUMB_EDGE = 256;

/** 一张待发/已发的图。 */
export type CcImage = {
  /** 裸 base64（**不带** `data:` 前缀）。CLI 不剥前缀，带了就把它当图片数据转发。 */
  data: string;
  /** 白名单内的 MIME。 */
  mediaType: string;
  /** 回显缩略图 data URL。落盘，历史恢复靠它。 */
  thumb: string;
  /** 实际要发出去的字节数（缩放/重编码之后）。 */
  bytes: number;
  width: number;
  height: number;
};

/** 判定结果。被拒时 `reason` 已经是能直接给用户看的中文。 */
export type ImageVerdict =
  { ok: true; shrink: boolean } | { ok: false; reason: string };

/** MIME 归一 + 白名单。返回 `null` 表示不收。 */
export function pickMediaType(raw: string): string | null {
  const mt = raw.trim().toLowerCase();
  return (IMAGE_TYPES as readonly string[]).includes(mt) ? mt : null;
}

/**
 * 等比缩到长边不超过 `max`。已经够小就原样返回。
 *
 * 用 `Math.round` 而不是向下取整：向下会让本来 1:1 的方图变成 255.9→255 的轻微
 * 变形累积（多轮缩放时）。单边最小 1px —— canvas 不接受 0。
 */
export function fitWithin(
  width: number,
  height: number,
  max: number,
): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= max) return { width, height };
  const k = max / long;
  return {
    width: Math.max(1, Math.round(width * k)),
    height: Math.max(1, Math.round(height * k)),
  };
}

/**
 * 这张图能不能发、要不要缩。
 *
 * 🔴 **GIF 一律不缩放**：canvas 重编码只会留下第一帧，用户发的动图会静默变成静图。
 *    所以动图超限直接拒，把选择权还给用户（换一张 / 自己压）。
 */
export function judgeImage(
  bytes: number,
  width: number,
  height: number,
  mediaType: string,
): ImageVerdict {
  if (width <= 0 || height <= 0) {
    return { ok: false, reason: "这张图读不出尺寸，可能已经损坏" };
  }
  const oversized = bytes > MAX_IMAGE_BYTES;
  const tooBigEdge = Math.max(width, height) > MAX_IMAGE_EDGE;
  if (!oversized && !tooBigEdge) return { ok: true, shrink: false };
  if (mediaType === "image/gif") {
    return {
      ok: false,
      reason: oversized
        ? `动图不能压缩（${formatBytes(bytes)} 超过 5 MB），换一张或先转成 PNG`
        : `动图不能压缩（${width}×${height} 单边超过 8000px），换一张或先转成 PNG`,
    };
  }
  return { ok: true, shrink: true };
}

/** `data:image/png;base64,AAAA` → `AAAA`。没有前缀就原样返回。 */
export function stripDataUrl(dataUrl: string): string {
  const i = dataUrl.indexOf("base64,");
  return i >= 0 ? dataUrl.slice(i + 7) : dataUrl;
}

/**
 * 给人看的体积。**保留一位小数**只在 ≥1 MB 时：`820 KB` 比 `0.8 MB` 精确，
 * 而 `4.94 MB` 比 `5058 KB` 好判断是不是快超限了。
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
