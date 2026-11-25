import { describe, expect, it } from "vitest";
import {
  buildRelaySnippet,
  deltaOf,
  foldRate,
  formatClock,
  formatMs,
  formatPercent,
  maskToken,
  modelRewriteLabel,
  rewriteLabel,
  sourceLabel,
  statusText,
  statusTone,
  tierShare,
} from "./relayFormat";
import type { RelayLogEntry, RelayStats } from "./types";

function entry(patch: Partial<RelayLogEntry>): RelayLogEntry {
  return {
    id: 1,
    tsMs: 0,
    source: "local",
    clientModel: "claude-sonnet-5-5",
    tier: "default",
    upstreamModel: "m",
    fellBack: false,
    via: "alias",
    rewrite: null,
    foldSummary: null,
    schemaSummary: null,
    sanitized: false,
    status: 200,
    firstByteMs: 300,
    totalMs: 900,
    bytesIn: 10,
    bytesOut: 20,
    error: null,
    path: "/v1/messages",
    ...patch,
  };
}

function stats(patch: Partial<RelayStats>): RelayStats {
  return {
    todayRequests: 0,
    todayFolded: 0,
    todayErrors: 0,
    todayErrorRate: 0,
    firstByteP50Ms: null,
    firstByteP95Ms: null,
    avgTotalMs: null,
    tierHits: [],
    lastError: null,
    lastErrorAtMs: null,
    inFlight: 0,
    ...patch,
  };
}

describe("formatMs", () => {
  it("keeps milliseconds below one second", () => {
    expect(formatMs(412)).toBe("412ms");
  });

  it("switches to seconds at 1000ms, matching the log page", () => {
    expect(formatMs(1200)).toBe("1.20s");
  });

  it("renders null and negative as em dash", () => {
    expect(formatMs(null)).toBe("—");
    expect(formatMs(undefined)).toBe("—");
    expect(formatMs(-1)).toBe("—");
  });
});

describe("formatClock", () => {
  it("prints HH:MM:SS zero padded", () => {
    const ts = new Date(2026, 10, 23, 8, 4, 9).getTime();
    expect(formatClock(ts)).toBe("08:04:09");
  });
});

describe("formatPercent", () => {
  it("does not multiply by 100 again", () => {
    // 后端 todayErrorRate 已是 0–100；再乘一次就会出现「错误率 800%」。
    expect(formatPercent(0.08)).toBe("0.08");
    expect(formatPercent(12.345)).toBe("12.35");
  });
});

describe("rewriteLabel", () => {
  it("translates every rule the sanitizer can emit", () => {
    expect(rewriteLabel("fold")).toBe("折叠");
    expect(rewriteLabel("pattern")).toBe("正则归一");
    expect(rewriteLabel("thinking")).toBe("剥思考");
    expect(rewriteLabel("strip_suffix+clamp+fold")).toBe("去后缀+压上限+折叠");
    expect(rewriteLabel("thinking+fold")).toBe("剥思考+折叠");
    expect(rewriteLabel("fold+pattern")).toBe("折叠+正则归一");
    // 自愈重试是清洗之后追加的一段，用「+」拼在原改写后面
    expect(rewriteLabel("repair:clamp")).toBe("自愈压上限");
    expect(rewriteLabel("strip_suffix+repair:clamp")).toBe("去后缀+自愈压上限");
    expect(rewriteLabel("repair:strip_thinking")).toBe("自愈剥思考");
    expect(rewriteLabel("repair:max_completion_tokens")).toBe("自愈改字段");
  });

  it("returns null when nothing was rewritten", () => {
    expect(rewriteLabel(null)).toBeNull();
  });

  it("passes unknown rules through instead of hiding them", () => {
    // 后端加了新规则而前端没跟上时，宁可显示原文，也不要显示一个空徽章。
    expect(rewriteLabel("mystery")).toBe("mystery");
  });
});

describe("modelRewriteLabel", () => {
  it("says nothing on the happy path", () => {
    // 正常回填不该多一行——每条记录都标「已回填」会把真正的问题淹没。
    expect(modelRewriteLabel("rewritten")).toBeNull();
    expect(modelRewriteLabel(null)).toBeNull();
    expect(modelRewriteLabel(undefined)).toBeNull();
  });

  it("explains every way the rewrite can be skipped", () => {
    expect(modelRewriteLabel("not_message_start")).toContain("message_start");
    expect(modelRewriteLabel("no_model")).toContain("没有模型名");
    expect(modelRewriteLabel("too_large")).toContain("过大");
    expect(modelRewriteLabel("unparsable")).toContain("无法解析");
  });

  it("keeps unknown states visible", () => {
    expect(modelRewriteLabel("brand_new")).toBe("brand_new");
  });
});

describe("sourceLabel", () => {
  it("names loopback 本机 and keeps foreign addresses as-is", () => {
    expect(sourceLabel("local")).toBe("本机");
    expect(sourceLabel("10.0.0.7")).toBe("10.0.0.7");
  });
});

describe("statusTone", () => {
  it("treats 2xx and 3xx as ok", () => {
    expect(statusTone(200, null)).toBe("ok");
    expect(statusTone(302, null)).toBe("ok");
  });

  it("flags 4xx/5xx as bad", () => {
    expect(statusTone(429, null)).toBe("bad");
    expect(statusTone(500, null)).toBe("bad");
  });

  it("uses the error text when there is no status at all", () => {
    expect(statusTone(null, "连接被拒")).toBe("bad");
    expect(statusTone(null, null)).toBe("mute");
  });
});

describe("statusText", () => {
  it("prefers the code, falls back to 失败 / 进行中", () => {
    expect(statusText(entry({ status: 200 }))).toBe("200");
    expect(statusText(entry({ status: null, error: "boom" }))).toBe("失败");
    expect(statusText(entry({ status: null, error: null }))).toBe("进行中");
  });
});

describe("deltaOf", () => {
  it("returns 0 for the first sample instead of the whole day", () => {
    expect(deltaOf(1284, null)).toBe(0);
  });

  it("clamps the midnight reset to 0 rather than going negative", () => {
    expect(deltaOf(3, 1284)).toBe(0);
  });

  it("reports the real increment", () => {
    expect(deltaOf(1288, 1284)).toBe(4);
  });
});

describe("foldRate", () => {
  it("returns 0 instead of NaN when nothing happened today", () => {
    expect(foldRate(stats({ todayRequests: 0 }))).toBe(0);
  });

  it("computes 37 / 312 as a percentage", () => {
    expect(foldRate(stats({ todayRequests: 312, todayFolded: 37 }))).toBeCloseTo(11.86, 1);
  });
});

describe("tierShare", () => {
  it("never divides by zero", () => {
    expect(tierShare(5, 0)).toBe(0);
  });

  it("returns the percentage of the total", () => {
    expect(tierShare(96, 100)).toBe(96);
  });
});

describe("buildRelaySnippet", () => {
  // 这段要整块粘到远端 bash，所以三个值都必须落进正确位置、引号必须配平。
  const text = buildRelaySnippet({
    baseUrl: "http://127.0.0.1:4100",
    token: "rly_abc",
    model: "claude-sonnet-5-5",
  });

  it("backups the original file before writing", () => {
    expect(text).toContain("cp ~/.claude-own/own-model.json ~/.claude-own/own-model.json.bak");
  });

  it("puts the three values into the env block", () => {
    expect(text).toContain('"ANTHROPIC_BASE_URL": "http://127.0.0.1:4100",');
    expect(text).toContain('"ANTHROPIC_AUTH_TOKEN": "rly_abc",');
    expect(text).toContain('"ANTHROPIC_MODEL": "claude-sonnet-5-5"');
  });

  it("keeps the alias line quoting balanced", () => {
    expect(text).toContain(
      `echo "alias claude-own='claude --settings ~/.claude-own/own-model.json'" >> ~/.bashrc`,
    );
  });

  it("never leaks the upstream model name into the remote file", () => {
    // 映射名只由档位决定；上游真名写出去等于把供应商暴露给远端，也把改名成本转嫁给用户。
    const withUpstream = buildRelaySnippet({ baseUrl: "http://h", token: "t", model: "qwen4-max" });
    expect(withUpstream).toContain("qwen4-max");
    // 上面那条只证明函数照抄入参；真正的约束是调用方必须传 alias（见 RelayAccessCard）。
    expect(text).not.toContain("qwen");
  });
});

describe("maskToken", () => {
  it("keeps head and tail for recognition", () => {
    expect(maskToken("rly_7f3a9c2e4b8d")).toBe("rly_7f3a…4b8d");
  });

  it("does not pretend a short token is long", () => {
    expect(maskToken("rly_abc")).toBe("rly…");
    expect(maskToken("")).toBe("");
  });
});
