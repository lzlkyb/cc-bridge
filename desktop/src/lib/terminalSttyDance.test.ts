import { describe, expect, it } from "vitest";
import {
  createEchoStripper,
  danceNext,
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

/* ============================== 残渣剥除器 ============================== */

describe("createEchoStripper", () => {
  // 命中语义：token 字节永不进输出，命中点输出 \r\x1b[2K 整行擦除
  // （把已上屏的旧提示符一起抹掉，新提示符随透传的换行落到下一行）。

  it("整行一次性到达：命中输出整行擦除，换行照常透传", () => {
    const s = createEchoStripper();
    expect(s.feed("lizuliang@code7:~$ stty -echo\r\n")).toBe(
      "lizuliang@code7:~$ \r\x1b[2K\r\n",
    );
    expect(s.active).toBe(false);
    expect(s.feed("next")).toBe("next"); // 失效后原样透传
  });

  it("分片切割：目标行跨三个 chunk 到达，最终拼齐命中", () => {
    const s = createEchoStripper();
    expect(s.feed("$ st")).toBe("$ "); // "st" 是前缀，扣住
    expect(s.feed("ty -ec")).toBe(""); // 仍是前缀，继续扣
    expect(s.feed("ho\r\nnext")).toBe("\r\x1b[2K\r\nnext"); // 拼齐命中
    expect(s.active).toBe(false);
  });

  it("ConPTY 变体：换行被改写成光标定位序列（无 \\r\\n），照样命中且定位序列透传", () => {
    const s = createEchoStripper();
    expect(s.feed("$ stty -echo\x1b[3;1Huser@x:~$ ")).toBe(
      "$ \r\x1b[2K\x1b[3;1Huser@x:~$ ",
    );
  });

  it("ConPTY 变体：转义序列穿插在 token 中间，照样命中", () => {
    const s = createEchoStripper();
    expect(s.feed("st\x1b[0mty -echo\r\nrest")).toBe("\r\x1b[2K\r\nrest");
  });

  it("token 内转义序列跨 chunk 切断：扣住等下一段拼齐", () => {
    const s = createEchoStripper();
    expect(s.feed("st\x1b[2")).toBe(""); // CSI 不完整，连前缀一起扣
    expect(s.feed(";1Hty -echo\r\nok")).toBe("\r\x1b[2K\r\nok");
  });

  it("ONLCR 关闭时回显为 \\n 变体，同样命中", () => {
    const s = createEchoStripper();
    expect(s.feed("$ stty -echo\nrest")).toBe("$ \r\x1b[2K\nrest");
  });

  it("与 banner 交错：只命中目标 token，其余原样透传", () => {
    const s = createEchoStripper();
    expect(s.feed("Welcome to Ubuntu 22.04\r\n$ stty -echo\r\nlast login: today\r\n")).toBe(
      "Welcome to Ubuntu 22.04\r\n$ \r\x1b[2K\r\nlast login: today\r\n",
    );
  });

  it("回显完全缺席：透传所有内容，flush 无残留", () => {
    const s = createEchoStripper();
    expect(s.feed("motd line one\r\n")).toBe("motd line one\r\n");
    expect(s.feed("$ ")).toBe("$ ");
    expect(s.flush()).toBe("");
  });

  it("token 命中即剥（容忍任意后缀），后缀透传", () => {
    const s = createEchoStripper();
    expect(s.feed("echo stty -ec")).toBe("echo ");
    expect(s.feed("hoX")).toBe("\r\x1b[2KX");
    expect(s.active).toBe(false);
  });

  it("失配但不构成 token：整段透传，不误剥", () => {
    const s = createEchoStripper();
    expect(s.feed("echo stty -ecX")).toBe("echo stty -ecX");
    expect(s.active).toBe(true);
  });

  it("普通输出以目标首字母结尾：只扣到下一 chunk 见分晓，不丢字", () => {
    const s = createEchoStripper();
    expect(s.feed("status")).toBe("statu"); // 末尾 "s" 是前缀，扣 1 字符
    expect(s.feed(" ok")).toBe("s ok");
  });

  it("命中后自动失效：后续数据原样透传", () => {
    const s = createEchoStripper();
    s.feed("stty -echo\r\n");
    expect(s.feed("stty -echo\r\n")).toBe("stty -echo\r\n");
  });

  it("flush 交还扣留的尾部（超时兜底，不丢数据）", () => {
    const s = createEchoStripper();
    expect(s.feed("$ stty -ech")).toBe("$ ");
    expect(s.flush()).toBe("stty -ech");
    expect(s.active).toBe(false);
  });
});
