import { describe, it, expect } from "vitest";
import { normalizePaste, preparePaste } from "./terminalPaste";

const START = "\x1b[200~";
const END = "\x1b[201~";

describe("normalizePaste", () => {
  it("LF 换成 CR", () => {
    expect(normalizePaste("a\nb")).toBe("a\rb");
  });

  it("CRLF 折叠成一个 CR，不多出一个空行", () => {
    expect(normalizePaste("a\r\nb")).toBe("a\rb");
  });

  it("已是 CR 的行尾原样保留", () => {
    expect(normalizePaste("a\rb")).toBe("a\rb");
  });

  it("单行不受影响", () => {
    expect(normalizePaste("ls -al")).toBe("ls -al");
  });

  it("空串仍是空串", () => {
    expect(normalizePaste("")).toBe("");
  });
});

describe("preparePaste", () => {
  // 关键行为：远端支持 bracketed paste 时，内容整块插入编辑缓冲区、显示多行、
  // 不执行——"粘贴就是插入"全靠这一条。
  it("远端支持时首尾包上标记", () => {
    expect(preparePaste("a\nb", true)).toBe(`${START}a\rb${END}`);
  });

  it("远端不支持时只做规范化，不加标记", () => {
    expect(preparePaste("a\nb", false)).toBe("a\rb");
    expect(preparePaste("a\r\nb", false)).toBe("a\rb");
  });

  it("单行也走同一套逻辑（不再有单行特例）", () => {
    expect(preparePaste("ls -al", true)).toBe(`${START}ls -al${END}`);
    expect(preparePaste("ls -al", false)).toBe("ls -al");
  });

  // 不剥离的话，内容里的 END 会提前闭合包裹，后面的内容落回裸发、重新变成逐行执行。
  it("剥离内容里自带的标记，防止提前闭合包裹", () => {
    expect(preparePaste(`a${END}b\nc`, true)).toBe(`${START}ab\rc${END}`);
  });

  it("起止标记都被剥掉", () => {
    expect(preparePaste(`x${START}y${END}z`, true)).toBe(`${START}xyz${END}`);
  });

  it("远端不支持时不剥内容（此时标记只是普通字节）", () => {
    expect(preparePaste(`a${END}b`, false)).toBe(`a${END}b`);
  });

  it("空串在支持模式下也成对包裹", () => {
    expect(preparePaste("", true)).toBe(`${START}${END}`);
  });
});
