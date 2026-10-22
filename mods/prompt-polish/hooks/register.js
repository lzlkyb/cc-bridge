/**
 * prompt-polish —— Claude Code mod：读输入框草稿 → 模型改写 → 回填。
 *
 * 用法（加载后）：
 *   /polish        打开打磨面板（自动取当前输入框里的草稿）
 *   /polish-probe  自省：读草稿走的是哪条路、回填能否往返
 *
 * ## 取草稿为什么要写两条路
 * 文档说 `$.prompt.read()` 能读输入框，但离线用 `claude plugin test` 拿到的
 * `$.prompt` 方法表（submit|fill|edit|change|autocomplete|suggest|section|context|
 * attachment|mention|compose）里**没有 read**。所以不能只押一条：
 *   1) 先试 `$.prompt.read()`；
 *   2) 抛错就退到「订阅 prompt.edit / prompt.change 缓存的最新文本」。
 * 二进制里有一句 `prompt.edit: hooked; the composer relays its edits to the chain`
 * —— 说明这个事件只有在有 mod 订阅时才会被转发，所以订阅本身也是必须的。
 *
 * ## 静态校验（claude plugin validate）的四条硬规矩
 *  1. `$` 只能写成 `$.ns.method`（`typeof $.x.y` / `const ui = $.ui` 都会被判违规）
 *  2. `on()` 的事件名必须是字符串字面量
 *  3. register 作用域里不能再声明名为 `on` 的变量
 *  4. 只能相对导入，或裸导入 'claude-code'
 *
 * ## 权限边界（分发时保持）
 * 只用 $.prompt / $.model / $.ui / $.command。不碰 $.fs / $.http / $.process / $.env / $.mcp。
 */

const PANE = "prompt-polish";

const SYSTEM = [
  "你是提示词改写器。把用户给的草稿改写成一条更清晰、更可执行的编码任务提示词。",
  "要求：",
  "1. 只输出改写后的提示词本身，不要前言、解释、markdown 代码围栏。",
  "2. 保持用户原本的语言（中文草稿出中文），技术名词、路径、变量名逐字不变。",
  "3. 不要凭空添加用户没提过的需求、文件、验收标准；信息不足就保留原样。",
  "4. 补的是结构：目标、约束、验收。通常不超过原文 2.5 倍。",
].join("\n");

/** idle | working | ready | error */
let phase = "idle";
let draft = "";
let result = "";
let errorText = "";

/** prompt.edit / prompt.change 转发过来的最新输入框文本。 */
let liveDraft = "";

function textOf(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const pick = value.text ?? value.content ?? value.output ?? value.value;
    if (typeof pick === "string") return pick;
  }
  return "";
}

/** 事件 / 返回值里取草稿文本。字段名未定，按常见几种兜。 */
function draftOf(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const pick = value.text ?? value.value ?? value.content ?? value.draft ?? value.input;
    if (typeof pick === "string") return pick;
  }
  return "";
}

/**
 * 命令参数里的草稿。
 *
 * 🔴 为什么必须有这条：`/polish` 只有在**输入框内容的第一个字符**才是斜杠命令。
 * 用户先写完草稿再在末尾打 `/polish`，整段会被当成普通提问发给模型——命令根本不会触发。
 * 所以正确用法是「在草稿最前面加 `/polish `」，草稿从命令参数进来，而不是从输入框读。
 * 二进制里也写着：`a slash command's typed line ... its arguments are changed at command.run`。
 */
function argsOf(e) {
  if (!e || typeof e !== "object") return "";
  const raw = e.args ?? e.arguments ?? e.argv ?? e.text ?? "";
  if (Array.isArray(raw)) return raw.join(" ");
  return typeof raw === "string" ? raw : "";
}

/** 去掉行首的 `/polish`（命令回显 / prompt.edit 缓存里都可能带着它）。 */
function stripCmd(s) {
  return String(s || "")
    .replace(/^\s*\/polish\s*/i, "")
    .trim();
}

async function readDraft($, e) {
  const fromArgs = stripCmd(argsOf(e));
  if (fromArgs) return fromArgs;

  try {
    const viaApi = stripCmd(draftOf(await $.prompt.read()));
    if (viaApi) return viaApi;
  } catch (err) {
    // $.prompt.read 在这个版本不存在 / 没有输入框 —— 退到缓存，不把错抛给用户。
  }

  return stripCmd(liveDraft);
}

async function rewrite($) {
  const r = await $.model.complete({
    model: "haiku",
    system: SYSTEM,
    prompt: draft,
    maxTokens: 900,
    timeoutMs: 60000,
  });
  if (r && r.isAnswered === false) throw new Error(r.reason || "模型没有返回结果");
  return textOf(r).trim();
}

export function register(on) {
  // 输入框内容转发：二进制里写明「只有被 hook 时才转发」，所以这两条订阅本身是必须的。
  // 🔴 prompt.edit 有时限（50ms）：这里只做赋值 + next，绝不 await 别的东西。
  on("prompt.edit", async ($, e, next) => {
    const t = draftOf(e);
    if (t) liveDraft = t;
    return next(e);
  });

  on("prompt.change", async ($, e, next) => {
    const t = draftOf(e);
    if (t) liveDraft = t;
    return next(e);
  });

  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "polish",
      description: "打磨输入框里的提示词（读草稿 → 改写 → 回填）",
    });
    await $.command.register({
      name: "polish-probe",
      description: "自省：读草稿走的是哪条路、回填能否往返",
    });
    return next(e);
  });

  on("command.run", { command: "polish" }, async ($, e) => {
    phase = "working";
    result = "";
    errorText = "";
    draft = "";

    try {
      draft = await readDraft($, e);
    } catch (err) {
      errorText = "读不到输入框内容：" + (err && err.message ? err.message : String(err));
    }

    // 🔴 不传 closeOnEscape：Esc 由 CC 直接关面板，走不到下面的 close()，
    // 那条路会吞掉已回填/待恢复的草稿。只留「放弃」按钮，保证所有关闭路径都过我这儿。
    await $.ui.open({ id: PANE, title: "提示词打磨", focus: true, rows: 12 });

    if (!draft.trim()) {
      phase = "error";
      if (!errorText) {
        errorText =
          "没拿到草稿。正确用法是 /polish 后面直接跟草稿（/polish 帮我把登录接口的错误处理改一下）；" +
          "也可以在空输入框里打 /polish，然后从面板回到输入框写。";
      }
      $.ui.invalidate("ui.render");
      return {};
    }

    try {
      result = await rewrite($);
      phase = result ? "ready" : "error";
      if (!result) errorText = "模型返回了空文本，点「重来」再试一次。";
    } catch (err) {
      phase = "error";
      errorText = "改写失败：" + (err && err.message ? err.message : String(err));
    }

    $.ui.invalidate("ui.render");
    return {};
  });

  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e);

    const { Box, Text, Button } = $.ui.resolve(e);
    const redraw = () => $.ui.invalidate("ui.render");
    /** 关面板。放弃时把草稿还回输入框——/polish 已经把输入框清空了，不还就等于丢稿。 */
    const close = async (restore) => {
      if (restore && draft.trim()) {
        try {
          await $.prompt.fill(draft);
        } catch (err) {
          // 还不了也别把面板卡住：用户至少能自己重新打。
        }
      }
      await $.ui.close({ id: PANE });
    };

    const rows = [];
    rows.push(Text({ children: ["原文"], dimColor: true }));
    rows.push(Text({ children: [draft.trim() ? draft : "（空）"], wrap: "wrap" }));
    rows.push(Text({ children: [" "] }));
    rows.push(Text({ children: ["改写"], dimColor: true }));

    if (phase === "working") {
      rows.push(Text({ children: ["改写中…"], dimColor: true }));
    } else if (phase === "error") {
      rows.push(Text({ children: [errorText], color: "red", wrap: "wrap" }));
    } else if (phase === "ready") {
      rows.push(Text({ children: [result], wrap: "wrap" }));
    } else {
      rows.push(Text({ children: ["（待开始）"], dimColor: true }));
    }

    rows.push(Text({ children: [" "] }));

    const actions = [];
    if (phase === "ready") {
      actions.push(
        Button({
          key: "fill",
          label: "回填输入框",
          hotkey: "a",
          onPress: async () => {
            try {
              await $.prompt.fill(result);
            } catch (err) {
              errorText = "回填失败：" + (err && err.message ? err.message : String(err));
              phase = "error";
              redraw();
              return;
            }
            liveDraft = result;
            await close(false);
            $.ui.toast("已回填：在输入框里确认或改，回车才发送");
          },
        }),
        Button({
          key: "copy",
          label: "复制",
          hotkey: "c",
          plain: true,
          onPress: async () => {
            await $.ui.copy(result);
            $.ui.toast("已复制");
          },
        }),
        Button({
          key: "retry",
          label: "重来",
          hotkey: "r",
          plain: true,
          onPress: async () => {
            phase = "working";
            errorText = "";
            redraw();
            try {
              result = await rewrite($);
              phase = result ? "ready" : "error";
              if (!result) errorText = "模型返回了空文本。";
            } catch (err) {
              phase = "error";
              errorText = "改写失败：" + (err && err.message ? err.message : String(err));
            }
            redraw();
          },
        }),
      );
    }

    actions.push(
      Button({ key: "close", label: "放弃", hotkey: "q", plain: true, onPress: () => close(true) }),
    );

    rows.push(Box({ flexDirection: "row", columnGap: 2, children: actions }));
    return Box({ flexDirection: "column", children: rows });
  });

  on("command.run", { command: "polish-probe" }, async ($, e) => {
    const lines = [];
    const step = async (label, fn) => {
      try {
        lines.push(label + " => " + (await fn()));
      } catch (err) {
        lines.push(label + " !! " + (err && err.message ? err.message : String(err)));
      }
    };

    // 0) command.run 的事件长什么样 —— 这一步决定参数该从哪个字段取
    try {
      lines.push("e.keys => " + Object.keys(e || {}).join(","));
      lines.push("e.json => " + JSON.stringify(e).slice(0, 320));
    } catch (err) {
      lines.push("e.dump !! " + (err && err.message ? err.message : String(err)));
    }
    lines.push("argsOf(e) => " + JSON.stringify(argsOf(e).slice(0, 80)));

    // 1) $.prompt.read 到底存不存在
    await step("prompt.read()", async () => {
      const v = await $.prompt.read();
      return typeof v === "string"
        ? "string(" + v.length + ") " + JSON.stringify(v.slice(0, 60))
        : "object " + JSON.stringify(v).slice(0, 120);
    });

    // 2) prompt.edit 缓存有没有收到东西（先打几个字再跑本命令）
    lines.push(
      "liveDraft(缓存) => " + JSON.stringify(liveDraft.slice(0, 60)) + " len=" + liveDraft.length,
    );

    // 3) 回填能否往返：只在拿到草稿时做「原样写回」，不改用户内容
    await step("prompt.fill(原样)", async () => {
      if (!liveDraft) return "skipped (缓存为空)";
      await $.prompt.fill(liveDraft);
      return "ok";
    });

    return { text: "prompt-polish probe:\n  " + lines.join("\n  ") };
  });
}
