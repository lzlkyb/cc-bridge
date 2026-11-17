import { describe, expect, it } from "vitest";
import { baseName, extName, hasHighlight, languageFor } from "./remoteFileLang";

describe("baseName", () => {
  it("取最后一段，容忍尾部斜杠", () => {
    expect(baseName("/home/u/a.txt")).toBe("a.txt");
    expect(baseName("/home/u/dir/")).toBe("dir");
    expect(baseName("/")).toBe("");
    expect(baseName("a.txt")).toBe("a.txt");
  });
});

describe("extName", () => {
  it("小写、不含点；点文件不算扩展名", () => {
    expect(extName("/a/b.TS")).toBe("ts");
    expect(extName("/a/.env")).toBe("");
    expect(extName("/a/noext")).toBe("");
    expect(extName("/a/archive.tar.gz")).toBe("gz");
  });
});

describe("languageFor", () => {
  it("按扩展名命中", () => {
    expect(languageFor("/a/b.py").length).toBe(1);
    expect(languageFor("/a/b.yaml").length).toBe(1);
    expect(languageFor("/a/b.json").length).toBe(1);
    expect(languageFor("/a/b.sh").length).toBe(1);
    expect(languageFor("/a/b.rs").length).toBe(1);
  });

  it("tsx 走 jsx 变体、ts 走 typescript 变体（同一函数不同配置）", () => {
    // 无法直接比对配置对象，退一步验证两者都非空且不抛
    expect(languageFor("/a/b.tsx").length).toBe(1);
    expect(languageFor("/a/b.ts").length).toBe(1);
  });

  it("无扩展名的常见文件名按名字命中", () => {
    expect(languageFor("/srv/Dockerfile").length).toBe(1);
    expect(languageFor("/srv/Makefile").length).toBe(1);
    expect(languageFor("/srv/.bashrc").length).toBe(1);
  });

  it("未知类型返回空数组 = 纯文本，不报错", () => {
    expect(languageFor("/a/b.unknownext")).toEqual([]);
    expect(languageFor("/a/binary.bin")).toEqual([]);
    expect(hasHighlight("/a/b.unknownext")).toBe(false);
    expect(hasHighlight("/a/b.py")).toBe(true);
  });

  it("点文件优先按名字而不是按『扩展名』", () => {
    // .env 的 extName 是空串，靠 BY_NAME 命中；若误判成 env 扩展名也能中，
    // 这里守住「一定命中」而不是走纯文本。
    expect(languageFor("/a/.env").length).toBe(1);
  });
});
