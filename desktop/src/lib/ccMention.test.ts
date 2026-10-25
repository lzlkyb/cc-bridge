import { describe, expect, it } from "vitest";
import {
  filterMentionItems,
  insertMention,
  mentionTokenOf,
  remoteChildPath,
  typedSegments,
  type MentionItem,
} from "./ccMention";

describe("mentionTokenOf", () => {
  it("行首与空白后的 @ 是 token", () => {
    expect(mentionTokenOf("@src", 4)).toEqual({ start: 0, query: "src" });
    expect(mentionTokenOf("看下 @sr", 6)).toEqual({ start: 3, query: "sr" });
  });

  it("a@b 形态（@ 前是非空白）不算引用", () => {
    expect(mentionTokenOf("user@hos", 8)).toBeNull();
  });

  it("token 内出现空白 = 已结束；@ 之前的光标位置之外的内容不影响", () => {
    expect(mentionTokenOf("@a b", 4)).toBeNull();
    // 光标还在 token 内时，token 之后的空白不参与判定
    expect(mentionTokenOf("@a b", 2)).toEqual({ start: 0, query: "a" });
  });

  it("光标在 @ 之前时不算（例如光标移回行首）", () => {
    expect(mentionTokenOf("@src", 0)).toBeNull();
  });
});

describe("insertMention", () => {
  it("目录续打：token 换成 @path/，光标后内容保留", () => {
    expect(insertMention("看下 @sr/ut 好吗", 3, 9, "D:\\proj\\src", "/")).toBe("看下 @D:\\proj\\src/ 好吗");
  });
  it("文件完成：尾随空格，引用结束", () => {
    expect(insertMention("@ccM", 0, 4, "D:\\proj\\ccMention.ts", " ")).toBe("@D:\\proj\\ccMention.ts ");
  });
});

describe("typedSegments / remoteChildPath", () => {
  it("两种分隔符都切，空段过滤", () => {
    expect(typedSegments("a\\b/c")).toEqual(["a", "b", "c"]);
    expect(typedSegments("/etc/")).toEqual(["etc"]);
  });
  it("远端拼接处理根斜杠与软链后缀", () => {
    expect(remoteChildPath("/", "home")).toBe("/home");
    expect(remoteChildPath("/home/u/", "proj")).toBe("/home/u/proj");
    expect(remoteChildPath("/opt", "link -> /etc")).toBe("/opt/link");
  });
});

describe("filterMentionItems", () => {
  /// 顺序契约：**只过滤不排序**——输入按「目录在前、名字序」给（生产端保证），
  /// 根层的置顶（tag）依赖这一点不被打散。
  const items: MentionItem[] = [
    { name: "work", path: "D:\\work", isDir: true, tag: "本会话目录" },
    { name: "proj", path: "D:\\proj", isDir: true },
    { name: "a.ts", path: "/a.ts", isDir: false },
  ];
  it("空过滤器：原样返回（置顶不被排序打散）", () => {
    expect(filterMentionItems(items, "").map((i) => i.name)).toEqual(["work", "proj", "a.ts"]);
  });
  it("子串过滤不区分大小写", () => {
    expect(filterMentionItems(items, "PR").map((i) => i.name)).toEqual(["proj"]);
    expect(filterMentionItems(items, ".ts").map((i) => i.name)).toEqual(["a.ts"]);
  });
});
