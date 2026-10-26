import { useCallback, useMemo, useRef, useState } from "react";
import {
  SHRINK_EDGE,
  THUMB_EDGE,
  fitWithin,
  judgeImage,
  pickMediaType,
  stripDataUrl,
  type CcImage,
} from "../lib/ccImage";

/** 一条待发附件。`pending` 期间只占了位置，图和 base64 都还没有。 */
export type Attachment = {
  id: string;
  /** 正在解码/编码：界面上是虚线骨架，发送按钮要等它。 */
  pending: boolean;
  /** 缩略图 data URL（`pending` 时为空）。 */
  thumb: string;
  /** 编好的图；`pending` 或失败时为 null。 */
  image: CcImage | null;
  /** 来源文件名，只给 tooltip 用。 */
  name: string;
};

/** 一条被拒记录。**不用 toast**：toast 三秒就没了，用户还没看清是哪一张。 */
export type ImageReject = { id: string; text: string };

/** 把 canvas 编成 Blob。返回实际 MIME —— 浏览器可能不支持请求的格式。 */
function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("图片编码失败"))),
      type,
      quality,
    );
  });
}

function drawTo(
  src: CanvasImageSource,
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("图片编码失败：无法创建画布");
  // 缩图时用高质量插值：默认的 low 会让截图里的字糊成一团，而截图正是主场景。
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, width, height);
  return canvas;
}

/**
 * 解码一个 `File` 并拿到可绘制的图元。
 *
 * ## 为什么用 `<img>` + `decode()` 而不是 `createImageBitmap`
 *
 * `createImageBitmap` 更「现代」，但它在某些环境下会**永不 settle**（无 GPU 的
 * headless / 虚拟显示驱动下实测复现：同一个 Blob 主线程解一次成功，经由组件里
 * 的异步链路再解一次就挂住，既不 resolve 也不 reject）。那种挂起没有任何出口：
 * chip 永远转圈、发送按钮永远等不到图。
 *
 * `Image.decode()` 走的是同一条解码器，但没有那条挂起路径，而且失败时会给一个
 * 明确的 rejection —— 对「用户粘了张坏图」这个场景，能报错比快几毫秒重要。
 *
 * 🔴 objectURL 必须等到画完 canvas 才 revoke：提前 revoke 会让 `drawImage`
 *    拿到一张空图（Chrome 上表现为全黑/全透明，不报错）。
 */
async function decodeImage(file: File): Promise<{ img: HTMLImageElement; url: string }> {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("这张图读不出来，可能已经损坏");
  }
  return { img, url };
}

/**
 * 一个 `File` → 一条可发的图。
 *
 * 抛出来的 Error 文案已经是能给用户看的（含体积/尺寸/原因），调用方直接展示。
 *
 * ## 为什么要判断「要不要缩」而不是无脑缩
 *
 * 无脑重编码会让所有截图掉一遍质量、让 JPEG 多一代压缩损失，而且没法保住 GIF
 * 的动画。只在真超限（>5 MB 或单边 >8000px）时才缩 —— 这条路径极少走，走的时候
 * 用户本来也没别的选择。
 */
async function loadFile(file: File): Promise<CcImage> {
  const mediaType = pickMediaType(file.type);
  if (!mediaType) {
    const shown = file.type.trim() || "未知类型";
    throw new Error(`格式不支持（${shown}），只收 PNG / JPEG / GIF / WebP`);
  }
  const { img, url } = await decodeImage(file);
  try {
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    const verdict = judgeImage(file.size, width, height, mediaType);
    if (!verdict.ok) throw new Error(verdict.reason);

    const out = verdict.shrink ? fitWithin(width, height, SHRINK_EDGE) : null;
    // 原样发的时候连字节都不重编码：保住 GIF 的动画、保住 JPEG 的原始质量。
    const main = out ? await encode(drawTo(img, out.width, out.height), mediaType, 0.92) : file;
    const body = stripDataUrl(await blobToDataUrl(main));

    // 缩略图恒重编码：它要落盘，体积比保真重要。GIF 取首帧；透明图转 PNG 保底色
    // （转 JPEG 会把透明区压成黑块，深色主题下看不出，浅色下非常刺眼）。
    const thumbBox = fitWithin(width, height, THUMB_EDGE);
    const thumbType =
      mediaType === "image/jpeg" || mediaType === "image/webp" ? mediaType : "image/png";
    const thumbBlob = await encode(
      drawTo(img, thumbBox.width, thumbBox.height),
      thumbType,
      thumbType === "image/png" ? undefined : 0.8,
    );

    return {
      data: body,
      // 🔴 用**实际输出**的 MIME 而不是请求的：浏览器不支持某种编码时会静默换成
      //    PNG，而 CLI 那边按声明的 media_type 走。声明与实际不符虽然会被 CLI 的
      //    文件头嗅探纠正，但没必要留这个坑。
      mediaType: main.type || mediaType,
      thumb: await blobToDataUrl(thumbBlob),
      bytes: main.size,
      width: out?.width ?? width,
      height: out?.height ?? height,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error("图片读取失败"));
    fr.readAsDataURL(blob);
  });
}

/**
 * 对话页的图片附件区（粘贴 → 校验 → 编码 → 待发列表）。
 *
 * ## 为什么先摆骨架再编码
 *
 * 一张 4 MB 截图解码 + 缩放要几百毫秒。等它编完再显示，用户的感受是「粘贴没反应」，
 * 然后会再粘一次 —— 于是同一张图进了两次。骨架 chip 立刻出现，就把这件事说清了。
 *
 * ## 为什么错误是「列表」而不是「最后一条」
 *
 * 一次粘贴五张、其中两张被拒，用户需要同时看到两条原因。只留最后一条会让第一张的
 * 问题永远看不到。
 */
export function useCcImageAttach() {
  const [items, setItems] = useState<Attachment[]>([]);
  const [rejects, setRejects] = useState<ImageReject[]>([]);
  const seq = useRef(0);

  /** 收下一批文件。串行编码：并行解码几张大图会把主线程堵死，输入框跟着卡。 */
  const addFiles = useCallback(async (files: File[]) => {
    const picked = files.filter((f) => f.type.startsWith("image/"));
    if (picked.length === 0) return;
    const batch = picked.map((f) => ({ file: f, id: `i${++seq.current}` }));
    setItems((prev) => [
      ...prev,
      ...batch.map(({ file, id }) => ({
        id,
        pending: true,
        thumb: "",
        image: null,
        name: file.name || "剪贴板图片",
      })),
    ]);
    for (const { file, id } of batch) {
      try {
        const image = await loadFile(file);
        setItems((prev) =>
          prev.map((it) =>
            it.id === id ? { ...it, pending: false, thumb: image.thumb, image } : it,
          ),
        );
      } catch (e) {
        // 编不出来就把骨架摘掉，同时留一条原因 —— 不然界面上是一个永远转圈的方块。
        setItems((prev) => prev.filter((it) => it.id !== id));
        setRejects((prev) => [...prev, { id, text: String(e instanceof Error ? e.message : e) }]);
      }
    }
  }, []);

  const remove = useCallback((id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }, []);

  const dismissReject = useCallback((id: string) => {
    setRejects((prev) => prev.filter((r) => r.id !== id));
  }, []);

  /**
   * 发送成功后清理。只清图，不碰用户的文字/草稿（那是 Composer 的事）。
   *
   * `sent` = 这次实际发出去的那几张：发送 IPC 在途期间（远端可达数秒）用户可能又粘贴了
   * 新图，全量清空会把这些「没发出去」的图一起删掉。不传 = 全清（旧行为）。
   */
  const clear = useCallback((sent?: CcImage[]) => {
    setItems((prev) =>
      sent === undefined ? [] : prev.filter((it) => it.image === null || !sent.includes(it.image)),
    );
    setRejects([]);
  }, []);

  const ready = useMemo(
    () => items.map((it) => it.image).filter((i): i is CcImage => i !== null),
    [items],
  );
  const busy = items.some((it) => it.pending);

  return { items, rejects, ready, busy, addFiles, remove, dismissReject, clear };
}
