/**
 * SSH 钩子注入回显治理（方案 A）：`stty -echo` 舞步时序 + 残渣常驻吞除。
 *
 * ## 背景
 *
 * 钩子注入（`useTerminalOsc`）是「往活 shell 里打字」，PTY 行规程 ECHO=on 会把
 * 注入内容回显到屏幕上——探针一行、400+ 字符钩子源码一行。根治要动后端建连方式
 * （exec 包装 / rcfile，见 docs/SSH钩子注入回显治理方案.md 方案 B/C），代价大且
 * 违背「不写远端文件」的产品承诺。本文件给出纯前端两段式治理：
 *
 * 1. **舞步时序**：t0 发**合并探针**（`stty -echo` + 报 shell 名，一条命令一个回执），
 *    拿到回执才发钩子，最后 `stty echo` 恢复。回显发生在行规程层（比 shell 读输入
 *    还早），与提示符时机无关——所以「掐时机注入」治不了本，只有开关 ECHO 治得了。
 * 2. **残渣常驻吞除**：关掉回显后，唯一会回显的只剩合并探针那一行。内容完全已知，
 *    用 `createEchoStripper` 在前端 write 路径上识别它：命中时输出**等宽空格覆盖**
 *    （token 字节从未渲染，光标与 ConPTY 保持一致），其余字节原样透传（fail-open）。
 *
 * ## 2026-10-28 第三次修复：时序不能靠猜
 *
 * 用户报「终端偶尔自己输入 echo，新建会话时尤其明显」。根因是**旧时序在猜**：
 * `ssh_connect` 是 spawn 即返回，而 t0 固定 900ms 就盲发 `stty -echo`、250ms 后盲发
 * 探针、回执后发 649 字符钩子——远端 ready 往往要 1~3s，于是这些字节全在 ECHO 仍是
 * on 时到达 tty 被整行回显。短命令能被剥除（有 token），钩子折成 7~9 行后**无 token
 * 可匹配**，明文整屏露出。同时 `claimInjection` 失败分支提前 return + cleanup 撤包装，
 * 让剥除器在 effect 重跑后永久丢失，残渣便在 resize 时「又自己输入一遍」。
 *
 * 两条修法都落在本文件：① 合并探针（`PROBE_ECHO_OFF_CMD`）用**回执**证明「shell 已
 * ready 且 ECHO 已关」，长命令永远排在它之后；② 剥除器改为**随终端实例常驻且幂等**
 * （`attachEchoStripWhenReady` 不再提供 end），与注入 effect 的生死彻底解耦。
 *
 * ## 为什么剥离器必须「常驻」整个会话（2026-10-13 二次修复）
 *
 * Windows 上 ssh 跑在 ConPTY（portable_pty）里：远端输出先被 ConPTY 渲染进
 * **它自己的屏幕缓冲区**再流给前端。前端剥离器擦掉的只是 xterm 的显示，
 * ConPTY 缓冲区里的残渣还在——之后任何整屏重绘（resize / 字号 / CC fullscreen
 * 进出）都会把缓冲区原样重发，残渣「时不时自己再输入一遍」（用户实测）。
 * 曾试过「restore 时趁 ECHO 还关着让远端 printf 清屏」把两边缓冲区一起清掉，
 * 用户不要清屏动作（连接后屏幕跳变），改为剥离器**常驻**：重发多少次就吞
 * 多少次，屏幕其余内容分毫不动。
 *
 * 误剥代价（可接受）：输出流里恰好出现字面 `stty -echo` / 探针 printf 原文的
 * 那一行会被整行擦掉（只碰输出路径，命令执行不受影响）。正常工作内容几乎
 * 不含这两条字面量；确有顾虑时在设置里关掉注入开关。
 *
 * ## 红线：restore 绝不能发两次
 *
 * `stty echo` 是在 **echo 已关** 的情况下发的（所以它自身不被回显）；
 * 若 ECHO 已恢复又发第二句，那句就会被回显成一行可见残渣。恢复必须
 * 单次消费（`echoOffRef` 闸门，见 useTerminalOsc），四条异常路径共用同一个 restore。
 */

import type { Terminal } from "@xterm/xterm";

/** 舞步动作：先关回显再干活，干完恢复。 */
export const ECHO_OFF_CMD = "stty -echo";
export const ECHO_ON_CMD = "stty echo";

/**
 * **合并探针**：关回显 + 报 shell 名，一条命令一个回执（2026-10-28）。
 *
 * WHY 合并：旧时序在 t0 盲发 `stty -echo`、250ms 后盲发探针，全靠固定延时假设
 * 「远端 shell 已经在读了」。可 `ssh_connect` 是 spawn 即返回（`ssh_cmds.rs`），
 * 远端 TCP+认证+profile+MOTD 往往 1~3s ⇒ 两条命令都在 ECHO 仍是 on 时到达 tty 被
 * 整行回显；649 字符的钩子更惨——折成 7~9 行后没有任何 token 能匹配，明文整屏露出。
 * （回显发生在**字节进 tty 的那一刻**，由当时的 ECHO 状态决定，与 shell 何时执行无关。）
 *
 * 合并后语义变成：**回执到达 = shell 已 ready 且 ECHO 已关**，两个前提一次拿到；
 * 钩子必须等这个回执（`useTerminalOsc` 的 probeGoRef）——命令在 tty 队列里排多久都安全。
 *
 * ⚠️ 这一行自身必然被回显（ECHO 在它执行前仍是 on），必须进 STRIP_TOKENS；
 * 且因为它以 `stty -echo` 开头，剥除表里必须排在短命令之前。
 */
export const PROBE_ECHO_OFF_CMD = `stty -echo 2>/dev/null; printf '\\033]1337;Shell=%s\\007' "$0"`;

/**
 * **正常收尾**用的恢复命令：先把光标所在行擦掉，再恢复回显（2026-10-20 修「连接后两个 $」）。
 *
 * WHY 要擦这一行：`stty echo` 是最后一条注入命令，它执行完 bash 必然重画一次提示符。
 * 回显关闭期间 readline 不写换行，整场注入只攒下「登录提示符」那一行；一旦 ECHO 恢复，
 * 这个新提示符就落到下一行 ⇒ 用户看到「每次连接有两个提示符」。
 * 清行必须赶在 ECHO 仍关闭时发出（这行命令自己不被回显），并且**只擦当前行、不回退**：
 * 新提示符随后原地重画在同一行，屏幕只剩一个。
 *
 * 🔴 只用于正常收尾（kick 已发出、shell 正停在提示符上）。异常路径（探针超时 / 发送失败）
 * 屏幕状态未知，退回 ECHO_ON_CMD 不擦行。
 * 🔴 序列走**远端输出流**（不是本地 xterm 注入），ConPTY 处理的是同一份字节、两边不错位——
 * 与文件头注里「别用 `\r\x1b[2K` 去擦本地已渲染内容」的教训不冲突。
 */
export const ECHO_ON_CLEAN_CMD = "printf '\\r\\033[2K'; stty echo";

/**
 * 剥除器的 token 表（常驻整个会话）。
 *
 * 顺序即串行链顺序：**长 token 必须排前**——`PROBE_ECHO_OFF_CMD` 以 `stty -echo`
 * 开头、`ECHO_ON_CLEAN_CMD` 以 `stty echo` 结尾，短串先跑会把长命令的中段吞掉、
 * 把前后半截留在屏上。
 *
 * 不再收 `ECHO_OFF_CMD`：关回显已并入合并探针，单独留这一条反而会在折行时
 * 只吞掉开头 11 字符、把 `2>/dev/null; printf …` 的尾巴留在屏上。
 *
 * 钩子命令**刻意不收**：它 649 字符，必然被 PTY 按列宽折行，跨行无法匹配；
 * 正确做法是让它永远在 ECHO 关闭后才发（见 `PROBE_ECHO_OFF_CMD`），而不是事后擦。
 */
export const STRIP_TOKENS: readonly string[] = [
  PROBE_ECHO_OFF_CMD,
  ECHO_ON_CLEAN_CMD,
  ECHO_ON_CMD,
];

/** 舞步时序（毫秒）。t0 = 会话接线完成（等 banner / MOTD 走完再起舞）。 */
export const DANCE = {
  /** t0：发合并探针。不能再早——还要躲开首连的密码提示自动填充。 */
  PROBE_DELAY: 900,
  /** 探针回执 → 钩子。 */
  HOOK_DELAY: 60,
  /** 钩子 → kick 空回车（逼 shell 重绘一次提示符，触发 133;A）。 */
  KICK_DELAY: 150,
  /** kick → `stty echo`：舞步收尾，ECHO 恢复。 */
  RESTORE_DELAY: 250,
  /**
   * 探针发出后多久没回执就判「不是 bash/zsh，或 shell 迟迟不就绪」。
   * 命令可能在 tty 队列里等 ready，故给足 8s（旧值 1200ms 是按「固定延时后必已执行」
   * 的错误前提定的）；等待期间用户一敲键就走 onData 立刻 abort + 恢复 ECHO。
   */
  PROBE_TIMEOUT: 8000,
  /** 钩子发出后多久没等到 133;A 就降级（ECHO 此时已被 restore 恢复，这里只判死）。 */
  HOOK_TIMEOUT: 2000,
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
 * 剥除目标由调用方给定（stty 舞步 = `stty -echo`；慢 shell 下探针行也会被
 * 回显，所以探针命令原文同样是一个 token），本模块不硬编码。
 *
 * **不要求换行结尾**——Windows 上本地 ssh 跑在 ConPTY 里（portable_pty），
 * ConPTY 会把输出流重新渲染：换行可能被改写成光标定位序列（`\x1b[3;1H`），
 * 转义序列也可能穿插在文本中间。字节级精确匹配在这个管道上必然漏网
 * （2026-10-13 实测）。
 */

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
  /** 喂入一段输出，返回应当真正交给 xterm 渲染的部分。 */
  feed(chunk: string): string;
  /** 失效并交还扣留的尾部（调用方负责把它 write 出去，不丢数据）。 */
  flush(): string;
  /** flush 之前恒为 true：常驻语义，命中不再自动失效。 */
  readonly active: boolean;
}

/**
 * 残渣剥除器（常驻）：在 `term.write` 外面滚一个滑动窗口，识别 token 的
 * 回显行并整行擦除；命中后复位继续扫——ConPTY 整屏重发多少次就吞多少次。
 *
 * ConPTY 容忍策略（fail-open 三原则不变）：
 * 1. 只识别内容完全已知的 token，其余字节原样透传；
 * 2. token 内部允许穿插 VT 序列（跳过、不进输出；失配时**如数归还**）；
 * 3. 候选区间之外的 VT 序列（颜色、光标定位……）原样透传——常驻模式下若
 *    吞掉它们，整场会话的渲染都会坏掉（一次性窗口时代无所谓，常驻后是红线）；
 * 4. 命中时用**等宽空格覆盖** token 所占的列（光标与 ConPTY 保持同步，提示符
 *    与同行其余内容完好，视觉上只是一段空白）；token 内穿插过 VT 序列时列数
 *    不可信，退回 `\r\x1b[2K` 整行擦除。命中后的所有字节照常透传。
 *    失配的内容全部原样吐回，绝不扣留数据；扣留只发生在「疑似部分匹配」时，
 *    且由下个 chunk 立即见分晓。
 *
 * 误剥风险：输出流里恰好出现字面 token——正常工作内容几乎不含，见文件头注。
 */
export function createEchoStripper(token: string): EchoStripper {
  let active = true;
  let pending = ""; // 疑似部分匹配的扣留（候选起点起的整段）
  let k = 0; // 已匹配 token 的前缀长度
  let matchStart = 0; // 当前候选匹配在 buf 中的起点（k>0 时有效）
  let vtInside = false; // 当前候选内是否跳过过 VT 序列（决定命中时的擦除策略）
  return {
    get active() {
      return active;
    },
    feed(chunk: string): string {
      if (!active) return chunk;
      const buf = pending + chunk;
      pending = "";
      if (k > 0) matchStart = 0; // 上个 chunk 扣留的前缀拼到 buf 头部，候选从 0 重新起算
      let out = "";
      let i = 0;
      while (i < buf.length) {
        const ch = buf[i]!;
        if (k > 0 && ch === token[k]) {
          i++;
          k++;
          if (k === token.length) {
            // 命中 + 复位继续扫（常驻：ConPTY 重发多少次吞多少次）。
            // 擦除策略：token 连续（无 VT 穿插）时用**等宽空格覆盖**——token 字节
            // 从未渲染，xterm 光标正停在 token 起点；写 L 个空格后光标停在 token
            // 终点，与 ConPTY 的光标完全同步（ConPTY 认为自己写了这 L 列）。
            // 旧方案 `\r\x1b[2K` 把 xterm 光标搬回行首而 ConPTY 不动——两边从此
            // 错位：①已渲染的提示符被整行抹掉后，ConPTY 的增量更新不会补发；
            // ②readline 之后的退格/重绘增量全部画歪（2026-10-13 实测：按 ↑ 翻
            // 历史时提示符消失、残渣正文反而露出来）。空格覆盖则两边列数一致，
            // 视觉上只是一段空白，提示符完好。
            // token 内穿插过 VT 序列时列数不可信，退回整行擦除（罕见路径）。
            out += vtInside ? "\r\x1b[2K" : " ".repeat(token.length);
            k = 0;
          }
          continue;
        }
        if (ch === "\x1b") {
          const vt = vtSeqLen(buf, i);
          if (vt) {
            if (!vt.complete) {
              // 序列被 chunk 边界切断：从候选起点（或序列起点）扣住等下一段
              pending = buf.slice(k > 0 ? matchStart : i);
              if (k > 0) matchStart = 0;
              break;
            }
            if (k > 0) {
              vtInside = true; // token 内部的 VT 噪声：跳过（失配时由 slice 归还）
              i += vt.len;
              continue;
            }
            // 候选之外的转义序列：原样透传（常驻红线，见函数 doc 第 3 条）
            out += buf.slice(i, i + vt.len);
            i += vt.len;
            continue;
          }
        }
        // 失配：候选区间（前缀 + 中间跳过的 VT 序列）原样吐回
        if (k > 0) {
          out += buf.slice(matchStart, i);
          k = 0;
        }
        if (ch === token[0]) {
          matchStart = i;
          k = 1;
          vtInside = false;
          i++;
          continue;
        }
        out += ch;
        i++;
      }
      if (k > 0) pending = buf.slice(matchStart);
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
 * 把 `term.write` 包一层**常驻**剥除链：tokens 里每个 token 一个剥除器串行
 * 过滤，命中行整行擦除，其余字节原样透传。会话期间不撤包装（ConPTY 重发
 * 残渣的时刻不可预知——resize / 字号 / CC fullscreen 进出都可能触发），
 * 由调用方在会话销毁/重连时 `end()`。
 *
 * - 非字符串数据（Uint8Array，本项目当前不会出现，防御性保留）原样透传；
 * - 串行链保持输出顺序：前级扣留的尾部会在后续 chunk 到达时流经后级；
 * - end() 按链序 flush，扣留尾部不丢。
 */
export function attachEchoStrip(term: Terminal, tokens: readonly string[]): EchoStripHandle {
  const strippers = tokens.map(createEchoStripper);
  const real = term.write.bind(term);
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    term.write = real; // 撤包装（先撤再补写，扣留尾部走原始路径）
    let tail = "";
    for (const s of strippers) {
      tail = s.feed(tail) + s.flush(); // feed 出已定部分，flush 交还扣留的尾部
    }
    if (tail) real(tail);
  };
  term.write = (data, cb) => {
    if (typeof data !== "string") {
      real(data, cb);
      return;
    }
    let out = data;
    for (const s of strippers) out = s.feed(out);
    real(out, cb);
  };
  return { end };
}

/* ============================== 注入前置条件 ============================== */

/**
 * 注入的前提是「往一个停在提示符上的干净 shell 里打字」。屏幕已经是备用屏（全屏 TUI，
 * 如 Claude Code）时**绝不能注入**：那串字节会被 TUI 的输入行吃进去、原样显示出来
 * （2026-10-16 用户报障：「终端会在输入栏自己输入 `printf '\033]1337;…' "$0" stty -echo`」）。
 * 触发它的都不是新会话，而是注入 effect 重跑——那时 shell 里可能正跑着 TUI。
 */
export function tuiOnScreen(term: Terminal | null): boolean {
  return term?.buffer?.active?.type === "alternate";
}

/**
 * 注入台账。挂在 `globalThis` 上（**故意**不用模块级变量）：HMR 会重新求值本模块，
 * 模块级 Set 会被清掉，于是热更新一次就往活会话里重打一遍命令。
 *
 * 键是 sessionId——它按**连接**生成，重连自然拿到新键（那时确实该重新注入）。
 */
function ledger(): Set<string> {
  const g = globalThis as Record<string, unknown>;
  return (g.__ccbOscInjected ??= new Set<string>()) as Set<string>;
}

/** 认领本次会话的注入权：false = 本会话注入过（effect 重跑），调用方必须直接跳过。 */
export function claimInjection(sessionId: string): boolean {
  const set = ledger();
  if (set.has(sessionId)) return false;
  set.add(sessionId);
  return true;
}

export interface EchoStripCancel {
  /** 只取消「还没拿到 term」时的 rAF 重试；**不撤包装**（剥除器随终端实例常驻）。 */
  cancel(): void;
}

/**
 * 终端实例 → 是否已挂过剥除器。挂 `globalThis`（与 `claimInjection` 同理）：
 * HMR 会重新求值本模块，模块级 WeakSet 会被清掉，于是热更新一次就再包一层。
 */
function attachedLedger(): WeakSet<Terminal> {
  const g = globalThis as Record<string, unknown>;
  return (g.__ccbStripAttached ??= new WeakSet<Terminal>()) as WeakSet<Terminal>;
}

/**
 * 尽早挂上残渣剥除器，**幂等**，生命周期跟着**终端实例**而不是 effect。
 *
 * 终端的创建 effect 与注入的会话 effect 谁先跑不由本模块决定，而**漏挂的代价是整场
 * 会话残渣可见**——老写法 `term ? attachEchoStrip(term) : null` 在拿不到 term 时静默
 * 降级成一个空 handle，屏幕上的命令原文再没人擦。这里用 rAF 重试：termRef 一就绪就挂。
 *
 * 🔴 2026-10-28 起**不再提供 end()**：ConPTY 整屏重绘随时可能重发残渣，而 `useTerminalOsc`
 * 的会话 effect 会在 HMR / 重挂 / 换开关时重跑——旧实现在它的 cleanup 里撤包装，重跑后
 * 又因 `claimInjection` 返回 false 提前 return，于是**整场会话再没有剥除器**，残渣就在
 * resize / 字号 / TUI 进出时「又自己输入一遍」。挂在实例上并去重，这条路径彻底关死。
 */
export function attachEchoStripWhenReady(
  termRef: { current: Terminal | null },
  tokens: readonly string[] = STRIP_TOKENS,
): EchoStripCancel {
  let raf = 0;
  let cancelled = false;
  const tryAttach = () => {
    if (cancelled) return;
    const term = termRef.current;
    if (!term) {
      raf = requestAnimationFrame(tryAttach);
      return;
    }
    const seen = attachedLedger();
    if (seen.has(term)) return;
    seen.add(term);
    attachEchoStrip(term, tokens);
  };
  tryAttach();
  return {
    cancel() {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
