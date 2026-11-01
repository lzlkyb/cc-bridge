import { describe, it, expect } from "vitest";
import { cellColumnOf, findPathsInLine } from "./terminalPathLink";

describe("findPathsInLine（终端输出的远端绝对路径识别）", () => {
  it("基础绝对路径", () => {
    expect(findPathsInLine("see /var/log/syslog for details")).toEqual([
      { path: "/var/log/syslog", startCol: 4, length: 15 },
    ]);
  });
  it("多个路径", () => {
    const r = findPathsInLine("diff /etc/a.conf /etc/b.conf");
    expect(r.map((x) => x.path)).toEqual(["/etc/a.conf", "/etc/b.conf"]);
  });
  it("尾部标点剥掉（句尾/括号路径）", () => {
    expect(findPathsInLine("check /tmp/x.txt.")[0].path).toBe("/tmp/x.txt");
    expect(findPathsInLine("(see /opt/app)")[0].path).toBe("/opt/app");
  });
  it("URL 不匹配（: 前缀排除）", () => {
    expect(findPathsInLine("open http://host/var/www")).toEqual([]);
  });
  it("协议相对 //host/path 不匹配", () => {
    expect(findPathsInLine("mount //srv/share")).toEqual([]);
  });
  it("相对路径中段不匹配（/ 前是 \\w）", () => {
    expect(findPathsInLine("run npm run build/thing or dist/js")).toEqual([]);
  });
  it("纯根目录 / 不算路径", () => {
    expect(findPathsInLine("cd / now")).toEqual([]);
  });
  it("单段根下路径 /tmp 算", () => {
    expect(findPathsInLine("ls /tmp")[0].path).toBe("/tmp");
  });
  it("带点扩展与 @+- 字符", () => {
    expect(findPathsInLine("cat /etc/ssl/certs/ca-bundle.trust.crt")[0].path).toBe(
      "/etc/ssl/certs/ca-bundle.trust.crt",
    );
    expect(findPathsInLine("git@host:/srv/git/x.git")[0]?.path).toBe("/srv/git/x.git");
  });
  it("无斜杠的行直接短路", () => {
    expect(findPathsInLine("hello world")).toEqual([]);
  });
});

describe("中文与非 ASCII 路径（旧字符集点不动的主场景）", () => {
  it("路径片段里有中文目录/文件名", () => {
    expect(findPathsInLine("打开 /var/日志/app.log 看看")[0]).toEqual({
      path: "/var/日志/app.log",
      startCol: 3,
      length: "/var/日志/app.log".length,
    });
  });
  it("整段中文路径", () => {
    expect(findPathsInLine("ls /home/张三/文档")[0].path).toBe("/home/张三/文档");
  });
  it("中文紧跟在路径字符后面时不误判（相对路径中段）", () => {
    expect(findPathsInLine("说明见 构建/dist/js")).toEqual([]);
  });
});

describe("含空格的路径（只认引号形式）", () => {
  it("单引号包裹（ls 默认输出形态）", () => {
    const r = findPathsInLine("total: '/srv/my file.txt' 12K");
    expect(r).toHaveLength(1);
    expect(r[0]).toEqual({ path: "/srv/my file.txt", startCol: 8, length: "/srv/my file.txt".length });
  });
  it("双引号包裹 + 中文 + 空格", () => {
    expect(findPathsInLine('"/srv/我的 文件.txt"')[0].path).toBe("/srv/我的 文件.txt");
  });
  it("🔴 裸文本里的空格不打开：句子不被整句吞成一条路径", () => {
    expect(findPathsInLine("see /var/log for details")[0].path).toBe("/var/log");
  });
  it("引号内不是绝对路径就不算（普通引用文本）", () => {
    expect(findPathsInLine('bash: "unexpected token"')).toEqual([]);
  });
  it("引号里的协议相对地址不碰", () => {
    expect(findPathsInLine('"//host/share"')).toEqual([]);
  });
  it("引号形式与裸形式重叠时只留完整的那条", () => {
    const r = findPathsInLine("'/srv/a b/c.txt'");
    expect(r).toHaveLength(1);
    expect(r[0].path).toBe("/srv/a b/c.txt");
  });
});

describe("cellColumnOf（字符下标 → 终端列）", () => {
  /** 假缓冲区行：CJK 按两列展开，宽字符的第二格是零宽占位。 */
  const fakeLine = (text: string) => {
    const cells: { w: number; c: string }[] = [];
    for (const ch of text) {
      const w = /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
      cells.push({ w, c: ch });
      if (w === 2) cells.push({ w: 0, c: "" });
    }
    return { length: cells.length, getCell: (x: number) => cells[x] && { getWidth: () => cells[x].w, getChars: () => cells[x].c } };
  };
  it("纯 ASCII 时字符下标与列一一对应", () => {
    expect(cellColumnOf(fakeLine("/var/x"), 0)).toBe(1);
    expect(cellColumnOf(fakeLine("/var/x"), 6)).toBe(7);
  });
  it("🔴 中文占两列：列号必须是换算后的（否则下划线与可点区域错位）", () => {
    // 字符：/ a 中 b  →  列：1 2 3-4 5；字符下标 2（中）落到第 3 列，下标 3（b）落到第 5 列
    const line = fakeLine("/a中b");
    expect(cellColumnOf(line, 2)).toBe(3);
    expect(cellColumnOf(line, 3)).toBe(5);
    expect(cellColumnOf(line, 4)).toBe(6);
  });
});
