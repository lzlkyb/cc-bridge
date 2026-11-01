import type { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachEchoStrip,
  attachEchoStripWhenReady,
  claimInjection,
  createEchoStripper,
  danceNext,
  ECHO_OFF_CMD,
  ECHO_ON_CMD,
  ECHO_ON_CLEAN_CMD,
  echoRestoreCommand,
  PROBE_ECHO_OFF_CMD,
  STRIP_TOKENS,
  tuiOnScreen,
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
    // 🔴 2026-10-28 不变量：回执没到（连探针都没发）时钩子绝不能发——649 字符会在
    // ECHO 仍是 on 时到达 tty 被整行回显，且折行后无 token 可匹配。
    expect(danceNext("idle", "hookSent")).toEqual({ phase: "idle", restore: false });
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

/**
 * 极简屏幕：只实现 `\r` / `\n` / `\x1b[2K` / 可见字符，足够回答「屏幕上剩几个提示符」。
 *
 * 为什么需要它：剥除器输出的是**字节流**，前缀在命中之前就已经写进 out 了，靠
 * `\r\x1b[2K` 在渲染层擦掉。只断言字符串会得出「前缀还在」的错误结论——用户看到的是
 * 渲染结果，断言就该落在渲染结果上。
 */
function screenOf(text: string, cols = 200): string[] {
  const rows: string[][] = [[]];
  let y = 0;
  let x = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\x1b") {
      // CSI：ESC [ 参数 final。手写扫而不是正则 —— 正则字面量里的 \x1b 会触发 no-control-regex。
      let j = i + 2;
      while (j < text.length && !/[A-Za-z]/.test(text[j]!)) j++;
      if (text.slice(i, j + 1) === "\x1b[2K") rows[y] = []; // 擦整行，光标列不动
      i = j + 1;
      continue;
    }
    if (ch === "\r") {
      x = 0;
      i++;
      continue;
    }
    if (ch === "\n") {
      y++;
      rows[y] = [];
      x = 0;
      i++;
      continue;
    }
    if (x >= cols) {
      y++;
      rows[y] = [];
      x = 0;
    }
    rows[y]![x] = ch;
    x++;
    i++;
  }
  return rows.map((r) => (r ?? []).join("").replace(/\s+$/, ""));
}

describe("createEchoStripper", () => {
  const T = "stty -echo";
  const GAP = " ".repeat(T.length);
  // 命中语义（2026-10-28 方案 A）：先看 token 后面跟什么再决定擦法。
  //   直接换行 ⇒ 一整行命令回显，整行擦 `\r\x1b[2K`（连行首提示符一起，否则屏幕上
  //             会多一个「提示符 + 一串空格」的假 prompt）；列差被随后的换行归零。
  //   可见字符 ⇒ 只是行中一段，用**等长空格**覆盖 token 所占的列，与 ConPTY 保持
  //             列同步（无条件整行擦会搬走光标，按 ↑ 翻历史时提示符就消失了）。

  it("🔴 整行回显：连行首提示符一起从屏幕上消失（本次报障的「假 prompt」）", () => {
    const s = createEchoStripper(T);
    const out = s.feed("lizuliang@code7:~$ stty -echo\r\n");
    // 前缀在命中前已经写进字节流，靠 \r\x1b[2K 在渲染层擦：屏幕上这一行必须是空的
    expect(screenOf(out)).toEqual(["", ""]);
  });

  it("常驻：命中后不失效，同 token 再次出现（ConPTY 重发）照样命中", () => {
    const s = createEchoStripper(T);
    s.feed(`$ stty -echo\r\n`);
    expect(screenOf(s.feed(`$ stty -echo\r\n`))).toEqual(["", ""]);
    expect(s.active).toBe(true);
  });

  it("同一 chunk 两处残渣（整屏重发形态，后面跟定位序列不是换行）：都按行中 token 覆盖", () => {
    const s = createEchoStripper(T);
    expect(s.feed(`$ stty -echo\x1b[2;1H$ stty -echo\x1b[3;1Hok`)).toBe(
      `$ ${GAP}\x1b[2;1H$ ${GAP}\x1b[3;1Hok`,
    );
  });

  it("分片切割：目标行跨三个 chunk 到达，最终拼齐命中", () => {
    const s = createEchoStripper(T);
    expect(s.feed("$ st")).toBe("$ "); // "st" 是前缀，扣住
    expect(s.feed("ty -ec")).toBe(""); // 仍是前缀，继续扣
    expect(s.feed("ho\r\nnext")).toBe(`\r\x1b[2K\r\nnext`); // 拼齐命中 → 整行回显
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

  it("ONLCR 关闭时回显为 \\n 变体，同样判为整行回显", () => {
    const s = createEchoStripper(T);
    expect(screenOf(s.feed(`$ stty -echo\nrestX`))).toEqual(["", "restX"]);
  });

  it("与 banner 交错：只命中目标 token，其余原样透传", () => {
    const s = createEchoStripper(T);
    const out = s.feed("Welcome to Ubuntu 22.04\r\n$ stty -echo\r\nlast login: today\r\n");
    expect(screenOf(out)).toEqual(["Welcome to Ubuntu 22.04", "", "last login: today", ""]);
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

  // ── 2026-10-29 报障：敲 `s` / `p` 屏幕上不出现 ───────────────────────
  // 生产 token 的首字母恰好是 s（`stty -echo …` / `stty echo`）与 p（`printf …`），
  // 用户敲这两个字母的回显被当成探针开头扣住，无限期不显示。扣留必须有时间上界。

  it("🔴 敲单个 `s`：feed 先扣住，idle 必须立刻吐回", () => {
    const s = createEchoStripper(ECHO_ON_CMD);
    expect(s.feed("s")).toBe(""); // 头一个字符就命中 token[0]，被扣
    expect(s.idle()).toBe("s"); // 没有续接字节 ⇒ 它只是用户输入
  });

  it("🔴 敲单个 `p`（printf 首字母）同理", () => {
    const s = createEchoStripper(ECHO_ON_CLEAN_CMD);
    expect(s.feed("p")).toBe("");
    expect(s.idle()).toBe("p");
  });

  it("敲以 s / p 开头的普通命令：idle 吐出后整串可见", () => {
    const s = createEchoStripper(PROBE_ECHO_OFF_CMD);
    // `pwd` / `ps` / `ssh` / `sudo` 这类高频命令的头一个字母都在剥除表里
    expect(s.feed("p") + s.feed("wd") + s.idle()).toBe("pwd");
  });

  it("idle 不失效、不干扰后续命中：吐回前缀后 token 照样被剥掉", () => {
    const s = createEchoStripper(ECHO_ON_CMD);
    expect(s.feed("s")).toBe("");
    expect(s.idle()).toBe("s");
    expect(s.active).toBe(true);
    expect(screenOf(s.feed(`$ ${ECHO_ON_CMD}\r\n`))).toEqual(["", ""]);
  });

  it("idle 对无扣留的输出是空操作（不要凭空产出字节）", () => {
    const s = createEchoStripper(ECHO_ON_CMD);
    expect(s.feed("hello\r\n")).toBe("hello\r\n");
    expect(s.idle()).toBe("");
  });

  it("🔴 穷举：任何可打印字符喂进整条剥除链，idle 后都必须原样出现", () => {
    // 守卫 2026-10-29 那类缺陷（扣留无时间上界）。串行链语义与 attachEchoStrip 一致，
    // 三个 token 一起上，才能证明「不只有 s/p，而是没有任何字符会被吞」。
    const lost: string[] = [];
    for (let code = 0x20; code <= 0x7e; code++) {
      const ch = String.fromCharCode(code);
      const chain = STRIP_TOKENS.map((t) => createEchoStripper(t));
      let visible = "";
      for (const s of chain) {
        s.feed(ch);
        visible = ch;
      }
      let tail = "";
      for (const s of chain) tail = s.feed(tail) + s.idle();
      if (!(visible + tail).includes(ch)) lost.push(JSON.stringify(ch));
    }
    expect(lost).toEqual([]);
  });

  it("🔴 逐字符到达的普通命令：idle 后整串完整（含 s/p 开头的高频命令）", () => {
    for (const cmd of ["ssh", "sudo", "stty", "stty -a", "ps", "pwd", "python", "printf", "ls -l"]) {
      const chain = STRIP_TOKENS.map((t) => createEchoStripper(t));
      let out = "";
      for (const ch of cmd) {
        let tail = ch;
        for (const s of chain) tail = s.feed(tail);
        out += tail;
      }
      let tail = "";
      for (const s of chain) tail = s.feed(tail) + s.idle();
      expect(out + tail).toBe(cmd);
    }
  });

  it("flush 交还扣留的尾部（会话销毁兜底，不丢数据）", () => {
    const s = createEchoStripper(T);
    expect(s.feed("$ stty -ech")).toBe("$ ");
    expect(s.flush()).toBe("stty -ech");
    expect(s.active).toBe(false);
  });

  // ── 2026-10-29 第六次修复：手打 `stty echo` 不能被擦 ─────────────────
  // 剥离是纯内容匹配，注入残渣与用户手打的那一行字节完全相同 ⇒ 只能用时间关联区分。

  it("🔴 刚有按键时命中 token：判为用户自己的输入，原样透传", () => {
    const s = createEchoStripper(ECHO_ON_CMD, { userTypedRecently: () => true });
    expect(s.feed(`$ ${ECHO_ON_CMD}\r\n`)).toBe(`$ ${ECHO_ON_CMD}\r\n`);
  });

  it("同样一串在没有近期按键时仍然整行擦（残渣路径不受影响）", () => {
    const s = createEchoStripper(ECHO_ON_CMD, { userTypedRecently: () => false });
    expect(screenOf(s.feed(`$ ${ECHO_ON_CMD}\r\n`))).toEqual(["", ""]);
  });

  it("跨 chunk 的手打 token：命中时把整个候选区间原样归还", () => {
    const s = createEchoStripper(ECHO_ON_CMD, { userTypedRecently: () => true });
    expect(s.feed("$ stty ec") + s.feed("ho\r\n")).toBe("$ stty echo\r\n");
  });

  it("🔴 不终止的 VT 序列不能把后续输出一起扣死（pending 有长度上界）", () => {
    const s = createEchoStripper(ECHO_ON_CMD);
    const out1 = s.feed("\x1b]" + "x".repeat(2000)); // OSC 无 BEL / ST
    expect(out1.length).toBeGreaterThan(0); // 超界即 fail-open，不能一字不出
    expect(out1 + s.feed("hello\r\n")).toContain("hello");
  });

  it("短的不终止序列仍会扣留等续接（上界不破坏跨 chunk 拼接）", () => {
    const s = createEchoStripper(ECHO_ON_CMD);
    expect(s.feed("\x1b[3")).toBe(""); // CSI 未到 final，等下一个 chunk
    expect(s.feed("2mhi")).toBe("\x1b[32mhi");
  });

  it("探针行（慢 shell 下 ECHO 生效前被回显）也是剥除目标", () => {
    const p = "printf '\\033]1337;Shell=%s\\007' \"$0\"";
    const s = createEchoStripper(p);
    expect(screenOf(s.feed(`$ ${p}\r\n`))).toEqual(["", ""]);
    // 同样常驻：重发照样吞
    expect(screenOf(s.feed(`$ ${p}\r\n`))).toEqual(["", ""]);
  });

  it("前导空格的注入命令回显（history 抑制形态）照样命中", () => {
    const s = createEchoStripper(T);
    // 回显 = 提示符 + 注入命令的前导空格 + token，整行连前缀一起擦
    expect(screenOf(s.feed(`$  stty -echo\r\n`))).toEqual(["", ""]);
  });

  it("光标移动序列穿插 token 内：退回整行擦除（列数不可信）", () => {
    const s = createEchoStripper("AB");
    // 'A' 是候选前缀，命中后随 token 一起抑制，不进输出
    expect(s.feed("x A\x1b[3;1HB y")).toBe("x \r\x1b[2K y");
  });

  /* ══ 行尾判定（2026-10-28 方案 A：假提示符）══ */

  it("🔴 判定跨 chunk：命中落在 chunk 末尾时先按住，下一段见换行再整行擦", () => {
    const s = createEchoStripper(T);
    expect(s.feed("$ stty -echo")).toBe("$ "); // 命中但后续未到：不出结论
    expect(s.feed("\r")).toBe(""); // 只来了 \r，继续等
    expect(s.feed("\nprompt")).toBe("\r\x1b[2K\r\nprompt");
  });

  it("命中后跟可见字符 ⇒ 行中 token，退回空格覆盖保列同步", () => {
    const s = createEchoStripper(T);
    expect(s.feed("$ stty -echoX")).toBe(`$ ${GAP}X`);
  });

  it("flush 兜底：判定未定就销毁会话，退回空格覆盖（不丢字节）", () => {
    const s = createEchoStripper(T);
    expect(s.feed("$ stty -echo")).toBe("$ ");
    expect(s.flush()).toBe(GAP);
  });

  it("判定期暂存超上限 ⇒ 立即按行中 token 收尾，不让数据无限滞留", () => {
    const s = createEchoStripper(T);
    const longVt = "\x1b[" + "0;".repeat(12) + "1m"; // 28 字符，超过上限
    expect(s.feed(`$ stty -echo${longVt}`)).toBe(`$ ${GAP}${longVt}`);
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
    expect(writes[0]).toBe("\r\x1b[2K\r\nkeep me\r\n");
    expect(writes[1]).toBe("\r\x1b[2K\r\n");
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

  it("🔴 `stty echo` 也必须是 token：异常路径下它会在 ECHO 已恢复后发出并自我回显", () => {
    const { term, writes } = fakeTerm();
    const h = attachEchoStrip(term, [ECHO_OFF_CMD, ECHO_ON_CMD]);
    term.write(`$ ${ECHO_ON_CMD}\r\n`);
    h.end();
    expect(screenOf(writes[0]!)).toEqual(["", ""]);
  });

  it("🔴 刚敲过键 ⇒ 默认闸（来自 term.onData）判为用户输入，整行保留", () => {
    const writes: string[] = [];
    let fire: (() => void) | null = null;
    const term = {
      write: (d: string) => void writes.push(d),
      onData: (cb: () => void) => {
        fire = cb;
        return { dispose: () => {} };
      },
    } as unknown as Terminal;
    const h = attachEchoStrip(term, [ECHO_ON_CMD]);
    // 没敲过键：照旧剥（注入残渣路径不能退化）
    term.write(`$ ${ECHO_ON_CMD}\r\n`);
    expect(screenOf(writes[0]!)).toEqual(["", ""]);
    // 敲一下键后：同一个字面量必须原样留下（自己手打的命令不能被擦）
    fire!();
    term.write(`$ ${ECHO_ON_CMD}\r\n`);
    expect(writes[1]).toContain(ECHO_ON_CMD);
    h.end();
  });

  // ── 空闲冲刷：扣留的时间上界（2026-10-29 报障：敲 s/p 不显示）────────────
  // 真实场景不是「下一 chunk 马上到」，而是用户敲完一个字母就停在那儿等回显。

  afterEach(() => {
    vi.useRealTimers();
  });

  it("🔴 敲完 `s` 就停手：空闲到期后字符必须出现（否则这就是吞字）", () => {
    vi.useFakeTimers();
    const { term, writes } = fakeTerm();
    const h = attachEchoStrip(term, [ECHO_ON_CMD]);
    term.write("s"); // 用户敲 s，回显被当成 `stty echo` 的开头扣住
    expect(writes).toEqual([""]);
    vi.advanceTimersByTime(40);
    expect(writes).toEqual(["", "s"]);
    h.end();
  });

  it("拆包间隔小于空闲窗口：token 仍能拼齐并剥掉（不能因为加了超时就漏剥）", () => {
    vi.useFakeTimers();
    const { term, writes } = fakeTerm();
    const h = attachEchoStrip(term, [ECHO_ON_CMD]);
    term.write("$ st");
    vi.advanceTimersByTime(20); // 不足空闲窗口，不冲刷
    term.write("ty echo\r\n"); // 拼齐 → 命中
    h.end();
    expect(screenOf(writes.join(""))).toEqual(["", ""]);
  });

  it("end 会清掉空闲定时器：之后不能再有迟到的写入", () => {
    vi.useFakeTimers();
    const { term, writes } = fakeTerm();
    const h = attachEchoStrip(term, [ECHO_ON_CMD]);
    term.write("s");
    h.end();
    const before = writes.length;
    vi.advanceTimersByTime(200);
    expect(writes.length).toBe(before);
  });
});

/* ============================== 注入前置条件 ============================== */

describe("claimInjection —— 同一会话只注入一次", () => {
  it("首次认领成功，第二次（effect 重跑 / HMR）拒绝", () => {
    expect(claimInjection("sess-A")).toBe(true);
    expect(claimInjection("sess-A")).toBe(false);
  });

  it("不同会话各自独立认领（重连拿到新 sessionId → 该重新注入）", () => {
    expect(claimInjection("sess-B")).toBe(true);
    expect(claimInjection("sess-C")).toBe(true);
    expect(claimInjection("sess-B")).toBe(false);
  });
});

describe("tuiOnScreen —— 全屏 TUI 在屏时禁止注入", () => {
  it("备用屏 = TUI 在跑", () => {
    expect(tuiOnScreen({ buffer: { active: { type: "alternate" } } } as unknown as Terminal)).toBe(true);
  });
  it("主屏（干净提示符）/ 无终端 → 允许", () => {
    expect(tuiOnScreen({ buffer: { active: { type: "normal" } } } as unknown as Terminal)).toBe(false);
    expect(tuiOnScreen(null)).toBe(false);
  });
});

describe("正常收尾命令（ECHO_ON_CLEAN_CMD，修「连接后两个提示符」）", () => {
  it("先清当前行、后恢复回显——顺序反了这行命令自己就会被回显成残渣", () => {
    const clearAt = ECHO_ON_CLEAN_CMD.indexOf("\\r\\033[2K");
    expect(clearAt).toBeGreaterThan(-1);
    expect(ECHO_ON_CLEAN_CMD.indexOf(ECHO_ON_CMD)).toBeGreaterThan(clearAt);
  });

  it("原样入剥除表：异常路径下它被回显时整条吞掉，不留 printf 残渣", () => {
    const out = createEchoStripper(ECHO_ON_CLEAN_CMD).feed(`$ ${ECHO_ON_CLEAN_CMD}\r\nNEXT`);
    expect(out).not.toContain("printf");
    expect(out).toContain("NEXT");
  });
});

/* ==================== 合并探针（2026-10-28：时序不再靠猜） ==================== */

describe("PROBE_ECHO_OFF_CMD —— 关回显 + 报 shell，一条命令一个回执", () => {
  it("形态：先 stty -echo，再 printf 回执（回执到达 = ECHO 已关 + shell 已 ready）", () => {
    const off = PROBE_ECHO_OFF_CMD.indexOf(ECHO_OFF_CMD);
    const probe = PROBE_ECHO_OFF_CMD.indexOf("1337;Shell=");
    expect(off).toBe(0); // 必须是命令第一个动作，否则关不干净
    expect(probe).toBeGreaterThan(off);
  });

  it("短到能整行放下（长命令才会被 PTY 折行，这是它必须短的原因）", () => {
    expect(PROBE_ECHO_OFF_CMD.length).toBeLessThan(80);
  });

  it("带前导空格的整行回显照样被吞（history 抑制形态）", () => {
    const s = createEchoStripper(PROBE_ECHO_OFF_CMD);
    const out = s.feed(`$  ${PROBE_ECHO_OFF_CMD}\r\n`);
    // 整行擦：行首那截提示符也不留 —— 否则它看起来就是个干净 prompt（本次报障）
    expect(screenOf(out)).toEqual(["", ""]);
  });

  it("🔴 一旦被折成两行就命中不了 —— 这正是注入前必须有 cols 安全阀的理由", () => {
    const s = createEchoStripper(PROBE_ECHO_OFF_CMD);
    const cut = 40;
    const folded = `${PROBE_ECHO_OFF_CMD.slice(0, cut)}\r\n${PROBE_ECHO_OFF_CMD.slice(cut)}`;
    expect(s.feed(`$ ${folded}\r\n`)).toContain("stty -echo");
  });

  it("🔴 完整注入场景：屏幕上只剩 1 个提示符（上面那行是被擦掉的回显行）", () => {
    const s = createEchoStripper(PROBE_ECHO_OFF_CMD);
    const p1 = "lizuliang@code7:~$ ";
    const out = s.feed(`${p1} ${PROBE_ECHO_OFF_CMD}\r\n${p1}`);
    expect(screenOf(out)).toEqual(["", "lizuliang@code7:~$"]);
  });

  it("STRIP_TOKENS：长 token 排前，且不再收单条 ECHO_OFF_CMD（否则折行只吞半截）", () => {
    expect(STRIP_TOKENS[0]).toBe(PROBE_ECHO_OFF_CMD);
    expect(STRIP_TOKENS).not.toContain(ECHO_OFF_CMD);
    // ECHO_ON_CLEAN_CMD 必须排在 ECHO_ON_CMD 之前：它是后者的超串，反了会留 printf 残尾。
    expect(STRIP_TOKENS.indexOf(ECHO_ON_CLEAN_CMD)).toBeLessThan(STRIP_TOKENS.indexOf(ECHO_ON_CMD));
  });
});

describe("attachEchoStripWhenReady —— 随终端实例常驻、幂等", () => {
  function fakeTerm(): { term: Terminal; writes: string[] } {
    const writes: string[] = [];
    const term = { write: (d: string) => void writes.push(d) } as unknown as Terminal;
    return { term, writes };
  }

  it("cancel 只取消 rAF 重试，**不撤包装**（effect 重跑后残渣仍归它擦）", () => {
    const { term, writes } = fakeTerm();
    const h = attachEchoStripWhenReady({ current: term });
    h.cancel();
    // 尾字别用 s/t（会被当成 token 前缀扣住，见上面「以首字母结尾」那条）
    term.write(`$ ${ECHO_ON_CMD}\r\nrest!`);
    expect(screenOf(writes[0]!)).toEqual(["", "rest!"]);
  });

  it("同一终端实例重复调用不叠加包装（HMR / effect 重跑安全）", () => {
    const { term } = fakeTerm();
    const ref = { current: term };
    const pristine = term.write;
    attachEchoStripWhenReady(ref);
    const wrapped = term.write;
    // 🔴 只能靠引用身份判定幂等：双层包装在**行为上无法观测**（第二层看到的已是被
    // 第一层抹成空格的文本，不会再吞一次），旧断言「写入次数为 1」双层也照样通过。
    attachEchoStripWhenReady(ref);
    attachEchoStripWhenReady(ref).cancel();
    expect(wrapped).not.toBe(pristine);
    expect(term.write).toBe(wrapped);
  });
});

/* ============================== 恢复命令的字节 ============================== */

describe("echoRestoreCommand", () => {
  it("没敲键：干净的一行，不带任何控制字符", () => {
    expect(echoRestoreCommand(false, false)).toBe(` ${ECHO_ON_CMD}\n`);
    expect(echoRestoreCommand(true, false)).toBe(` ${ECHO_ON_CLEAN_CMD}\n`);
  });

  it("🔴 敲过键：前面必须补 ^U 清行，否则 stty echo 被拼进用户命令", () => {
    // `cd /tmp` 已敲下时直接发 ` stty echo\n` ⇒ 远端执行 `cd /tmp stty echo`（报错）。
    // ^U（0x15）先杀行，恢复命令才是独立一条。
    expect(echoRestoreCommand(false, true)).toBe(`\x15 ${ECHO_ON_CMD}\n`);
    expect(echoRestoreCommand(true, true).startsWith("\x15")).toBe(true);
  });
});
