/**
 * SSH 钩子注入回显治理（方案 A）：`stty -echo` 舞步时序 + 残渣吞除。
 *
 * ## 背景
 *
 * 钩子注入（`useTerminalOsc`）是「往活 shell 里打字」，PTY 行规程 ECHO=on 会把
 * 注入内容回显到屏幕上——探针一行、400+ 字符钩子源码一行。根治要动后端建连方式
 * （exec 包装 / rcfile，见 docs/SSH钩子注入回显治理方案.md 方案 B/C），代价大且
 * 违背「不写远端文件」的产品承诺。本文件给出纯前端两段式治理：
 *
 * 1. **舞步时序**：t0 先发 `stty -echo` 关回显，探针/钩子/kick 全程静默，
 *    最后 `stty echo` 恢复。回显发生在行规程层（比 shell 读输入还早），
 *    与提示符时机无关——所以「掐时机注入」治不了本，只有开关 ECHO 治得了。
 * 2. **残渣吞除**：关掉回显后，唯一会回显的只剩 t0 那行 `stty -echo`
 *    （它自己执行前必须先被回显）。内容完全已知、每次会话只出现一次，
 *    用 `createEchoStripper` 在前端 write 路径上识别它：命中时不逐字节抠——
 *    前面的旧提示符（带颜色序列）早已渲染上屏、内容不可预知——而是输出
 *    「回车 + 整行擦除」(`\r\x1b[2K`) 把旧提示符连同命令一起从屏幕抹掉，
 *    随后的换行照常放行，新提示符落在下一行（fail-open）。
 *
 * ## 红线：restore 绝不能发两次
 *
 * `stty echo` 是在 **echo 已关** 的情况下发的（所以它自身不被回显）；
 * 若 ECHO 已恢复又发第二句，那句就会被回显成一行可见残渣。恢复必须
 * 单次消费（`echoOffRef` 闸门，见 useTerminalOsc），四条异常路径共用同一个 restore。
 */

import type { Terminal } from "@xterm/xterm";

/** 舞步动作：先关回显再干活，干完恢复。发往远端的两条 stty 命令。 */
export const ECHO_OFF_CMD = "stty -echo";
export const ECHO_ON_CMD = "stty echo";

/** 舞步时序（毫秒）。t0 = 会话接线完成（等 banner / MOTD 走完再起舞）。 */
export const DANCE = {
  /** t0：发 `stty -echo`。太早发会被登录脚本吞掉（沿用原探针延时）。 */
  PROBE_DELAY: 900,
  /** stty -echo → 探针：给行规程生效留余量（跨洋 RTT 也远小于此）。 */
  ECHO_GAP: 250,
  /** 探针回执 → 钩子。 */
  HOOK_DELAY: 60,
  /** 钩子 → kick 空回车（逼 shell 重绘一次提示符，触发 133;A）。 */
  KICK_DELAY: 150,
  /** kick → `stty echo`：舞步收尾，ECHO 恢复。 */
  RESTORE_DELAY: 250,
  /** 探针发出后多久没回执就判「不是 bash/zsh」。 */
  PROBE_TIMEOUT: 1200,
  /** 钩子发出后多久没等到 133;A 就降级（ECHO 此时已被 restore 恢复，这里只判死）。 */
  HOOK_TIMEOUT: 2000,
  /** 残渣吞除窗口：超时把扣留的尾部整体透传（回显缺席时不无限扣留输出）。 */
  STRIP_TIMEOUT: 1500,
} as const;

/* ============================== 时序状态机 ============================== */

/**
 * 舞步阶段。中间四态表示「ECHO 可能处于关闭期」——任何路径从这四态退出
 * 都必须先恢复 ECHO（`danceNext` 用 restore 标志表达，调用方负责真正发送）。
 */
export type DancePhase =
  | "idle" // 尚未开始（还没发 stty -echo）
  | "echoOffSent" // stty -echo 已发出
  | "probeSent" // 探针已发出，等回执
  | "hookSent" // 钩子已发出
  | "kickSent" // kick 已发出，等 restore 收尾
  | "done" // stty echo 已发出，舞步正常结束
  | "aborted"; // 异常退出（ECHO 已恢复 + 判 unsupported）

export type DanceEvent =
  | "echoOffSent"
  | "probeSent"
  | "hookSent"
  | "kickSent"
  | "restoreSent"
  | "abort"; // 用户敲键 / 探针超时 / 钩子超时

/** 合法迁移表：只在「当前阶段精确匹配」时前进，乱序/重复事件一律原地不动（幂等）。 */
const TRANSITIONS: Array<[from: DancePhase, ev: DanceEvent, to: DancePhase]> = [
  ["idle", "echoOffSent", "echoOffSent"],
  ["echoOffSent", "probeSent", "probeSent"],
  ["probeSent", "hookSent", "hookSent"],
  ["hookSent", "kickSent", "kickSent"],
  ["kickSent", "restoreSent", "done"],
];

/**
 * 纯 reducer。返回新阶段 + 是否需要立即恢复 ECHO（restore 只是信号，
 * 真正的「只发一次」由调用方的 echoOffRef 闸门保证）。
 */
export function danceNext(
  phase: DancePhase,
  ev: DanceEvent,
): { phase: DancePhase; restore: boolean } {
  if (ev === "abort") {
    const active = phase !== "idle" && phase !== "done" && phase !== "aborted";
    return active ? { phase: "aborted", restore: true } : { phase, restore: false };
  }
  const hit = TRANSITIONS.find(([from, e]) => from === phase && e === ev);
  return hit ? { phase: hit[2], restore: false } : { phase, restore: false };
}

/* ============================== 残渣吞除 ============================== */

/**
 * 剥除目标：`stty -echo` 这个 token 本身。**不要求换行结尾**——
 * Windows 上本地 ssh 跑在 ConPTY 里（portable_pty），ConPTY 会把输出流
 * 重新渲染：换行可能被改写成光标定位序列（`\x1b[3;1H`），转义序列也可能
 * 穿插在文本中间。字节级精确匹配在这个管道上必然漏网（2026-10-13 实测）。
 */
const TOKEN = "stty -echo";

/**
 * 从 s[i] 起解析一条 VT 转义序列。返回 null = 不是序列起点；
 * complete=false = 序列被 chunk 边界切断（len 是已见的长度）。
 * 只认三类：CSI（ESC [ 参数 final）、OSC（ESC ] … BEL 或 ESC \）、双字符转义。
 */
function vtSeqLen(s: string, i: number): { len: number; complete: boolean } | null {
  if (s[i] !== "\x1b") return null;
  const c = s[i + 1];
  if (c === undefined) return { len: 1, complete: false };
  if (c === "[") {
    let j = i + 2;
    while (j < s.length) {
      const code = s.charCodeAt(j);
      if (code >= 0x40 && code <= 0x7e) return { len: j + 1 - i, complete: true }; // final 字节
      j++;
    }
    return { len: s.length - i, complete: false };
  }
  if (c === "]") {
    // OSC：到 BEL 或 ST（ESC \）结束
    const bel = s.indexOf("\x07", i);
    const st = s.indexOf("\x1b\\", i);
    const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
    if (end === -1) return { len: s.length - i, complete: false };
    return { len: (end === bel ? bel + 1 : st + 2) - i, complete: true };
  }
  return { len: 2, complete: true };
}

export interface EchoStripper {
  /** 喂入一段输出，返回应当真正交给 xterm 渲染的部分。命中剥除后自动失效。 */
  feed(chunk: string): string;
  /** 失效并交还扣留的尾部（调用方负责把它 write 出去，不丢数据）。 */
  flush(): string;
  readonly active: boolean;
}

/**
 * 残渣剥除器：在 `term.write` 外面滚一个滑动窗口，识别唯一一处 `stty -echo` 回显。
 *
 * ConPTY 容忍策略（fail-open 三原则不变）：
 * 1. 只识别内容完全已知的一个 token，其余字节原样透传；
 * 2. token 内部允许穿插 VT 序列（跳过、不进输出）；
 * 3. 命中即输出 `\r\x1b[2K`（回车 + 整行擦除）——旧提示符已经上屏、字节
 *    收不回来，从渲染层整行抹掉才是干净做法；命中后的所有字节（包括
 *    ConPTY 的换行/光标定位）照常透传，新提示符自然落到下一行。
 *    失配的内容全部原样吐回，绝不扣留数据；扣留只发生在「疑似部分匹配」时，
 *    且由下个 chunk 立即见分晓。
 *
 * 误剥风险：登录后 2.4s 窗口内输出流里恰好出现字面 `stty -echo`——MOTD
 * 不可能包含它，可忽略；就算误中，代价也只是擦掉一行 MOTD（纯外观）。
 */
export function createEchoStripper(): EchoStripper {
  let active = true;
  let pending = ""; // 疑似部分匹配的扣留（MATCH 态）
  let k = 0; // 已匹配 TOKEN 的前缀长度；k === TOKEN.length 表示进入尾部吞除
  return {
    get active() {
      return active;
    },
    feed(chunk: string): string {
      if (!active) return chunk;
      const buf = pending + chunk;
      pending = "";
      let out = "";
      let i = 0;
      while (i < buf.length) {
        const ch = buf[i]!;
        if (k === TOKEN.length) {
          // 命中：整行擦除（见上方 doc）。token 前缀从未进 out，本行已上屏的
          // 旧提示符由 \r\x1b[2K 从渲染层抹掉；余下字节（换行/定位序列/新提示符）
          // 全部照常透传。命中即失效，后续输出零开销。
          active = false;
          out += "\r\x1b[2K";
          out += buf.slice(i);
          break;
        }
        if (ch === TOKEN[k]) {
          i++;
          k++;
          continue;
        }
        if (ch === "\x1b") {
          const vt = vtSeqLen(buf, i);
          if (vt) {
            if (!vt.complete) {
              // 序列被 chunk 边界切断：连同等匹配前缀一起扣住等下一段
              pending = buf.slice(i - k);
              break;
            }
            i += vt.len; // token 内部的 VT 噪声：跳过
            continue;
          }
        }
        // 失配：扣住的前缀原样吐回，当前字符按「新起点 or 普通字符」处理
        out += buf.slice(i - k, i);
        k = 0;
        if (ch === TOKEN[0]) {
          k = 1;
          i++;
          continue;
        }
        out += ch;
        i++;
      }
      // chunk 结束仍在匹配中：扣住未决前缀等下一段
      if (active && k > 0 && k < TOKEN.length) pending = buf.slice(i - k);
      return out;
    },
    flush(): string {
      active = false;
      const out = pending;
      pending = "";
      return out;
    },
  };
}

export interface EchoStripHandle {
  /** 撤掉 write 包装并交还扣留的尾部（幂等；end 后一切数据原样透传）。 */
  end(): void;
}

/**
 * 把 `term.write` 临时包一层剥除器。舞步期间的所有输出（banner / 探针回显 /
 * 远端欢迎信息）都走这里，只有 `stty -echo` 回显命中会被整行擦除。
 *
 * - 非字符串数据（Uint8Array，本项目当前不会出现，防御性保留）原样透传；
 * - `timeoutMs` 后自动撤包装（回显缺席时兜底）。调用方应传
 *   `PROBE_DELAY + STRIP_TIMEOUT`：包装从接线时刻就开始（早于 t0），
 *   而回显要到 t0+RTT 才到，只按 STRIP_TIMEOUT 计时会在高延迟链路上提前撤窗；
 * - 提前命中（回显到达）时在**当次调用内**就撤包装，后续输出零开销。
 */
export function attachEchoStrip(term: Terminal, timeoutMs: number): EchoStripHandle {
  const strip = createEchoStripper();
  const real = term.write.bind(term);
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    window.clearTimeout(timer);
    term.write = real; // 撤包装（先撤再补写，扣留尾部走原始路径）
    const tail = strip.flush();
    if (tail) real(tail);
  };
  const timer = window.setTimeout(end, timeoutMs);
  term.write = (data, cb) => {
    if (typeof data !== "string") {
      real(data, cb);
      return;
    }
    const out = strip.feed(data);
    if (!strip.active) end(); // 命中：当次调用内撤包装，本次数据照常写出
    real(out, cb);
  };
  return { end };
}
