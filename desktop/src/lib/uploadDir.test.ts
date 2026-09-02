import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_UPLOAD_DIR,
  normalizeRemoteDir,
  remoteDirError,
  joinRemoteDir,
  loadUploadDir,
  saveUploadDir,
  humanSize,
} from "./uploadDir";

describe("normalizeRemoteDir", () => {
  it("空值回退到默认目录", () => {
    expect(normalizeRemoteDir("")).toBe(DEFAULT_UPLOAD_DIR);
    expect(normalizeRemoteDir("   ")).toBe(DEFAULT_UPLOAD_DIR);
  });

  it("去末尾斜杠，但根目录保留", () => {
    expect(normalizeRemoteDir("/opt/app/")).toBe("/opt/app");
    expect(normalizeRemoteDir("/opt/app///")).toBe("/opt/app");
    expect(normalizeRemoteDir("/")).toBe("/");
    expect(normalizeRemoteDir("///")).toBe("/");
  });

  it("折叠重复斜杠", () => {
    expect(normalizeRemoteDir("/opt//app///releases")).toBe("/opt/app/releases");
  });

  it("去首尾空白", () => {
    expect(normalizeRemoteDir("  /opt/app  ")).toBe("/opt/app");
  });
});

describe("remoteDirError", () => {
  it("合法绝对路径无错", () => {
    expect(remoteDirError("/opt/app")).toBeNull();
    expect(remoteDirError("/")).toBeNull();
  });

  it("空值报错", () => {
    expect(remoteDirError("  ")).toBeTruthy();
  });

  // 🔴 后端把远程路径包进单引号（防命令注入），`'~'` 在 shell 里不展开；
  // SFTP 协议下路径按字面处理，同样不展开。必须在提交前拦住，
  // 否则会在远端造出一个叫 `~` 的目录，失败方式极难看懂。
  it("拒绝波浪号开头的路径", () => {
    expect(remoteDirError("~")).toMatch(/~/);
    expect(remoteDirError("~/uploads")).toMatch(/~/);
  });

  it("拒绝相对路径", () => {
    expect(remoteDirError("opt/app")).toBeTruthy();
    expect(remoteDirError("./app")).toBeTruthy();
  });
});

describe("joinRemoteDir", () => {
  it("根目录不会出现双斜杠", () => {
    expect(joinRemoteDir("/", "a.txt")).toBe("/a.txt");
  });

  it("普通目录拼接", () => {
    expect(joinRemoteDir("/opt/app", "a.txt")).toBe("/opt/app/a.txt");
    expect(joinRemoteDir("/opt/app/", "a.txt")).toBe("/opt/app/a.txt");
  });
});

// vitest 跑在 node 环境（项目没装 jsdom），没有 localStorage。
// 现有的 terminalFontSize.test.ts 是直接跳过持久化部分的，但这里的
// 「存取来回 + 不同连接互不串」恰恰是功能本身，值得用一个内存桩盖住。
function installMemoryStorage() {
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
    },
  });
}

describe("load / saveUploadDir", () => {
  beforeEach(() => {
    installMemoryStorage();
  });

  it("没存过时给默认值", () => {
    expect(loadUploadDir("conn-1")).toBe(DEFAULT_UPLOAD_DIR);
  });

  it("存取来回并归一化", () => {
    saveUploadDir("conn-1", "/opt/app//");
    expect(loadUploadDir("conn-1")).toBe("/opt/app");
  });

  it("不同连接互不串", () => {
    saveUploadDir("conn-1", "/opt/a");
    saveUploadDir("conn-2", "/opt/b");
    expect(loadUploadDir("conn-1")).toBe("/opt/a");
    expect(loadUploadDir("conn-2")).toBe("/opt/b");
  });
});

describe("humanSize", () => {
  it("分档正确", () => {
    expect(humanSize(0)).toBe("0 B");
    expect(humanSize(999)).toBe("999 B");
    expect(humanSize(1024)).toBe("1.0 KB");
    expect(humanSize(8.4 * 1024 * 1024)).toBe("8.4 MB");
    expect(humanSize(1024 * 1024 * 1024)).toBe("1.0 GB");
  });

  it("大于 10 时不再给小数（一行里字符数固定，不抖）", () => {
    expect(humanSize(45 * 1024 * 1024)).toBe("45 MB");
  });

  it("异常值不报错", () => {
    expect(humanSize(-1)).toBe("—");
    expect(humanSize(NaN)).toBe("—");
  });
});
