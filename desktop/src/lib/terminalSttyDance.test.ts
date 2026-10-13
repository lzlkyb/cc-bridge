import type { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import {
  attachEchoStrip,
  createEchoStripper,
  danceNext,
  ECHO_OFF_CMD,
  type DanceEvent,
  type DancePhase,
} from "./terminalSttyDance";

/* ============================== 舞步状态机 ============================== */

describe("danceNext 正常时序", () => {
  it("五步全部走通，中途不触发 restore", () => {
    let p: DancePhase = "idle";
    const seq: DanceEvent[] = ["echoOffSent", "probeSent", "hookSent", "kickSent", "restoreSent"];
    for (const ev of seq) {
      const n = danceNext(p, ev);
      expect(n.restore).toBe(false);
      p = n.phase;
    }
    expect(p).toBe("done");
  });

  it("乱序/超前事件一律原地不动（幂等）", () => {
    // 还没关 echo 就想发探针 → 不动
    expect(danceNext("idle", "probeSent")).toEqual({ phase: "idle", restore: false });
    // 探针未回执就想发钩子 → 不动
    expect(danceNext("echoOffSent", "hookSent")).toEqual({ phase: "echoOffSent", restore: false });
    // 重复事件 → 不动
    expect(danceNext("probeSent", "probeSent")).toEqual({ phase: "probeSent", restore: false });
    // 已结束再收 restoreSent → 不动
    expect(danceNext("done", "restoreSent")).toEqual({ phase: "done", restore: false });
  });
});

describe("danceNext 异常退出（四条路径共用 abort）", () => {
  it("从每个活跃阶段退出都要求 restore 并进入 aborted", () => {
    for (const p of ["echoOffSent", "probeSent", "hookSent", "kickSent"] as DancePhase[]) {
      const n = danceNext(p, "abort");
      expect(n).toEqual({ phase: "aborted", restore: true });
    }
  });

  it("从非活跃阶段退出不需要 restore（ECHO 从未关闭或已恢复）", () => {
    expect(danceNext("idle", "abort")).toEqual({ phase: "idle", restore: false });
    expect(danceNext("done", "abort")).toEqual({ phase: "done", restore: false });
    expect(danceNext("aborted", "abort")).toEqual({ phase: "aborted", restore: false });
  });
});

/* ============================== 残渣剥除器（常驻 + 空格覆盖） ============================== */

describe("createEchoStripper", () => {
  const T = "stty -echo";
  const GAP = " ".repeat(T.length);
  // 命中语义：token 字节永不进输出，命中点输出**等长空格**覆盖 token 所占的列——
  // xterm 光标与 ConPTY 光标保持同步（旧方案 \r\x1b[2K 会搬走光标 + 抹掉已渲染
  // 的提示符，ConPTY 的增量更新不会补发，按 ↑ 翻历史时提示符就消失了）。

  it("整行一次性到达：命中输出等长空格覆盖，换行照常透传", () => {
    const s = createEchoStripper(T);
    expect(s.feed("lizuliang@code7:~$ stty -echo\r\n")).toBe(
      `lizuliang@code7:~$ ${GAP}\r\n`,
    );
  });

  it("常驻：命中后不失效，同 token 再次出现（ConPTY 重发）照样命中", () => {
    const s = createEchoStripper(T);
    s.feed(`$ stty -echo\r\n`);
    expect(s.feed(`$ stty -echo\r\n`)).toBe(`$ ${GAP}\r\n`);
    expect(s.active).toBe(true);
  });

  it("同一 chunk 两处残渣（整屏重发形态）：两处都覆盖", () => {
    const s = createEchoStripper(T);
    expect(s.feed(`$ stty -echo\x1b[2;1H$ stty -echo\x1b[3;1Hok`)).toBe(
      `$ ${GAP}\x1b[2;1H$ ${GAP}\x1b[3;1Hok`,
    );
  });

  it("分片切割：目标行跨三个 chunk 到达，最终拼齐命中", () => {
    const s = createEchoStripper(T);
    expect(s.feed("$ st")).toBe("$ "); // "st" 是前缀，扣住
    expect(s.feed("ty -ec")).toBe(""); // 仍是前缀，继续扣
    expect(s.feed("ho\r\nnext")).toBe(`${GAP}\r\nnext`); // 拼齐命中
  });

  it("ConPTY 变体：换行被改写成光标定位序列（无 \\r\\n），照样命中且定位序列透传", () => {
    const s = createEchoStripper(T);
    expect(s.feed(`$ stty -echo\x1b[3;1Huser@x:~$ `)).toBe(
      `$ ${GAP}\x1b[3;1Huser@x:~$ `,
    );
  });

  it("token 内穿插 VT 序列：列数不可信，退回整行擦除", () => {
    const s = createEchoStripper(T);
    expect(s.feed("st\x1b[0mty -echo\r\nrestX")).toBe("\r\x1b[2K\r\nrestX");
  });

  it("token 内转义序列跨 chunk 切断：扣住等下一段拼齐，命中走整行擦除", () => {
    const s = createEchoStripper(T);
    expect(s.feed("st\x1b[2")).toBe(""); // CSI 不完整，连前缀一起扣
    expect(s.feed(";1Hty -echo\r\nok")).toBe("\r\x1b[2K\r\nok");
  });

  it("候选之外的转义序列原样透传（常驻模式不能吃掉整场会话的颜色/定位）", () => {
    const s = createEchoStripper(T);
    expect(s.feed("\x1b[31mred\x1b[0m rest\r\n")).toBe("\x1b[31mred\x1b[0m rest\r\n");
  });

  it("失配归还时不吞候选中间跳过的转义序列", () => {
    const s = createEchoStripper(T);
    expect(s.feed("st\x1b[3;1Hxy")).toBe("st\x1b[3;1Hxy");
  });

  it("ONLCR 关闭时回显为 \\n 变体，同样命中", () => {
    const s = createEchoStripper(T);
    expect(s.feed(`$ stty -echo\nrestX`)).toBe(`$ ${GAP}\nrestX`);
  });

  it("与 banner 交错：只命中目标 token，其余原样透传", () => {
    const s = createEchoStripper(T);
    expect(s.feed("Welcome to Ubuntu 22.04\r\n$ stty -echo\r\nlast login: today\r\n")).toBe(
      `Welcome to Ubuntu 22.04\r\n$ ${GAP}\r\nlast login: today\r\n`,
    );
  });

  it("回显完全缺席：透传所有内容，flush 无残留", () => {
    const s = createEchoStripper(T);
    expect(s.feed("motd line one\r\n")).toBe("motd line one\r\n");
    expect(s.feed("$ ")).toBe("$ ");
    expect(s.flush()).toBe("");
  });

  it("token 命中即剥（容忍任意后缀），后缀透传", () => {
    const s = createEchoStripper(T);
    expect(s.feed("echo stty -ec")).toBe("echo ");
    expect(s.feed("hoX")).toBe(`${GAP}X`);
  });

  it("失配但不构成 token：整段透传，不误剥", () => {
    const s = createEchoStripper(T);
    expect(s.feed("echo stty -ecX")).toBe("echo stty -ecX");
    expect(s.active).toBe(true);
  });

  it("普通输出以目标首字母结尾：只扣到下一 chunk 见分晓，不丢字", () => {
    const s = createEchoStripper(T);
    expect(s.feed("status")).toBe("statu"); // 末尾 "s" 是前缀，扣 1 字符
    expect(s.feed(" ok")).toBe("s ok");
  });

  it("flush 交还扣留的尾部（会话销毁兜底，不丢数据）", () => {
    const s = createEchoStripper(T);
    expect(s.feed("$ stty -ech")).toBe("$ ");
    expect(s.flush()).toBe("stty -ech");
    expect(s.active).toBe(false);
  });

  it("探针行（慢 shell 下 ECHO 生效前被回显）也是剥除目标", () => {
    const p = "printf '\\033]1337;Shell=%s\\007' \"$0\"";
    const s = createEchoStripper(p);
    expect(s.feed(`$ ${p}\r\n`)).toBe(`$ ${" ".repeat(p.length)}\r\n`);
    // 同样常驻：重发照样吞
    expect(s.feed(`$ ${p}\r\n`)).toBe(`$ ${" ".repeat(p.length)}\r\n`);
  });

  it("前导空格的注入命令回显（history 抑制形态）照样命中", () => {
    const s = createEchoStripper(T);
    // 回显 = 提示符尾部空格 + 注入命令的前导空格（原样渲染）+ token（覆盖为空格）
    expect(s.feed(`$  stty -echo\r\n`)).toBe(`$  ${GAP}\r\n`);
  });

  it("光标移动序列穿插 token 内：退回整行擦除（列数不可信）", () => {
    const s = createEchoStripper("AB");
    // 'A' 是候选前缀，命中后随 token 一起抑制，不进输出
    expect(s.feed("x A\x1b[3;1HB y")).toBe("x \r\x1b[2K y");
  });
});

describe("attachEchoStrip（write 包装 + 多 token 串行链）", () => {
  function fakeTerm(): { term: Terminal; writes: string[] } {
    const writes: string[] = [];
    const term = { write: (d: string) => void writes.push(d) } as unknown as Terminal;
    return { term, writes };
  }

  it("两个 token 各自命中剥除，其余字节透传", () => {
    const { term, writes } = fakeTerm();
    const p = "printf '\\033]1337;Shell=%s\\007' \"$0\"";
    const h = attachEchoStrip(term, [ECHO_OFF_CMD, p]);
    term.write("stty -echo\r\nkeep me\r\n");
    term.write(`${p}\r\n`);
    h.end();
    expect(writes[0]).toBe(`${" ".repeat(ECHO_OFF_CMD.length)}\r\nkeep me\r\n`);
    expect(writes[1]).toBe(`${" ".repeat(p.length)}\r\n`);
  });

  it("end 后一切数据原样透传（幂等）", () => {
    const { term, writes } = fakeTerm();
    const h = attachEchoStrip(term, [ECHO_OFF_CMD]);
    h.end();
    h.end(); // 幂等
    term.write("stty -echo\r\n");
    expect(writes).toEqual(["stty -echo\r\n"]);
  });

  it("end 归还扣留的尾部，不丢数据", () => {
    const { term, writes } = fakeTerm();
    const h = attachEchoStrip(term, [ECHO_OFF_CMD]);
    term.write("$ stty -ech"); // 部分匹配，扣住
    h.end();
    expect(writes).toEqual(["$ ", "stty -ech"]);
  });
});
