import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_EDGE,
  fitWithin,
  formatBytes,
  judgeImage,
  pickMediaType,
  stripDataUrl,
} from "./ccImage";

describe("pickMediaType", () => {
  it("认白名单内的四种格式", () => {
    expect(pickMediaType("image/png")).toBe("image/png");
    expect(pickMediaType("image/jpeg")).toBe("image/jpeg");
    expect(pickMediaType("image/gif")).toBe("image/gif");
    expect(pickMediaType("image/webp")).toBe("image/webp");
  });

  it("大小写与首尾空白归一", () => {
    expect(pickMediaType("  IMAGE/PNG ")).toBe("image/png");
  });

  it("白名单外一律不收（哪怕浏览器认得）", () => {
    expect(pickMediaType("image/bmp")).toBeNull();
    expect(pickMediaType("image/svg+xml")).toBeNull();
    expect(pickMediaType("application/pdf")).toBeNull();
    expect(pickMediaType("")).toBeNull();
  });
});

describe("fitWithin", () => {
  it("本来就够小就原样返回", () => {
    expect(fitWithin(800, 600, 1568)).toEqual({ width: 800, height: 600 });
  });

  it("按长边等比缩，短边跟着变", () => {
    expect(fitWithin(3136, 1568, 1568)).toEqual({ width: 1568, height: 784 });
    expect(fitWithin(1568, 3136, 1568)).toEqual({ width: 784, height: 1568 });
  });

  it("极端长条也不会缩出 0 像素", () => {
    const out = fitWithin(20000, 3, 1568);
    expect(out.width).toBe(1568);
    expect(out.height).toBeGreaterThanOrEqual(1);
  });
});

describe("judgeImage", () => {
  it("常规截图直接放行，不缩", () => {
    expect(judgeImage(820 * 1024, 1200, 800, "image/png")).toEqual({
      ok: true,
      shrink: false,
    });
  });

  it("恰好卡在 5 MB / 8000px 上不算超限", () => {
    expect(
      judgeImage(MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, 100, "image/jpeg"),
    ).toEqual({
      ok: true,
      shrink: false,
    });
  });

  it("超 5 MB 的静图走缩放，不拒", () => {
    expect(judgeImage(MAX_IMAGE_BYTES + 1, 4000, 3000, "image/jpeg")).toEqual({
      ok: true,
      shrink: true,
    });
  });

  it("单边超 8000px 也能靠缩放救", () => {
    expect(
      judgeImage(100 * 1024, MAX_IMAGE_EDGE + 1, 500, "image/png"),
    ).toEqual({
      ok: true,
      shrink: true,
    });
  });

  it("🔴 动图超限直接拒 —— canvas 重编码会把动图变成静图", () => {
    const big = judgeImage(MAX_IMAGE_BYTES + 1, 800, 600, "image/gif");
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.reason).toContain("动图不能压缩");
    const huge = judgeImage(1000, MAX_IMAGE_EDGE + 1, 600, "image/gif");
    expect(huge.ok).toBe(false);
  });

  it("读不出尺寸的坏图拒掉", () => {
    const v = judgeImage(1000, 0, 600, "image/png");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("损坏");
  });
});

describe("stripDataUrl", () => {
  it("剥掉 data URL 前缀", () => {
    expect(stripDataUrl("data:image/png;base64,iVBORw0KGgo=")).toBe(
      "iVBORw0KGgo=",
    );
  });

  it("已经是裸 base64 就原样返回", () => {
    expect(stripDataUrl("iVBORw0KGgo=")).toBe("iVBORw0KGgo=");
  });

  it("别被 base64 里偶然出现的逗号带偏", () => {
    // 没有 `base64,` 标记 ⇒ 整串都是数据，不能按第一个逗号切。
    expect(stripDataUrl("data:image/png,AAAA")).toBe("data:image/png,AAAA");
  });
});

describe("formatBytes", () => {
  it("三档都好读", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(820 * 1024)).toBe("820 KB");
    expect(formatBytes(1.2 * 1048576)).toBe("1.2 MB");
  });
});
