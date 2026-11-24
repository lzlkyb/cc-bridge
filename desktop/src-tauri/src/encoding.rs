//! 文件编码 + 换行探测与无损转码。
//!
//! WHY: `read_files`/`edit_files` 面对的真实文件不一定是 UTF-8（用户的 NC65
//! 项目是 GBK），换行也可能是 CRLF。参考 nc-compile/ccedit.py 的做法：
//! 读取时探测编码/换行/BOM，把文本统一归一化到 LF 供模型匹配与展示；写回时
//! 按**原编码 + 原换行 + 原 BOM** 还原，并做 encode→decode round-trip 校验，
//! 编码有损（如往 GBK 插入不可表示字符）时**拒绝写入**而非静默损坏。
//! 相关问题：anthropics/claude-code#56946（内置工具把 GBK 读成 U+FFFD）。

use encoding_rs::{DecoderResult, Encoding, GBK, UTF_16BE, UTF_16LE, UTF_8};

const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

/// 解码后的文件文本 + 回写所需的保真信息。`text` 已归一化到 LF、剥掉 BOM。
pub struct FileText {
    pub text: String,
    pub encoding: &'static Encoding,
    /// 原文件使用 CRLF 换行（写回时把 `\n` 还原为 `\r\n`）。
    pub crlf: bool,
    /// 原文件带有与 `encoding` 匹配的 BOM（UTF-8 / UTF-16LE / UTF-16BE，写回时按编码补回）。
    ///
    /// 🔴 曾经只认 UTF-8 BOM：UTF-16LE/BE 的 BOM 被 `decode` 剥掉后**不记录**，
    /// 写回时也不补——文件从此丢掉 BOM。而丢 BOM 的 UTF-16 文本再被
    /// `detect_encoding` 探测时不再是 UTF-16（含 NUL 的字节串会被当成
    /// 「合法 UTF-8 + 垃圾」或直接二进制），`is_binary_content` 随即判它二进制
    /// ⇒ **这个文件连本工具都再也读不了**。所以三种 BOM 都必须 round-trip。
    pub had_bom: bool,
}

/// 该编码对应的 BOM 字节（没有则 `None`）。
fn bom_bytes(enc: &Encoding) -> Option<&'static [u8]> {
    if enc == UTF_8 {
        Some(&UTF8_BOM)
    } else if enc == UTF_16LE {
        Some(&[0xFF, 0xFE])
    } else if enc == UTF_16BE {
        Some(&[0xFE, 0xFF])
    } else {
        None
    }
}

impl FileText {
    /// 供 JSON 返回的换行标签。
    pub fn newline_label(&self) -> &'static str {
        if self.crlf {
            "CRLF"
        } else {
            "LF"
        }
    }
}

/// 探测字节流编码。顺序：BOM → UTF-8 校验 → GBK/GB18030 启发式 → 兜底 UTF-8。
pub fn detect_encoding(data: &[u8]) -> &'static Encoding {
    // 1. BOM 优先（最可靠）
    if data.starts_with(&UTF8_BOM) {
        return UTF_8;
    }
    if data.starts_with(&[0xFF, 0xFE]) {
        return UTF_16LE;
    }
    if data.starts_with(&[0xFE, 0xFF]) {
        return UTF_16BE;
    }
    // 2. 合法 UTF-8 直接判定
    if std::str::from_utf8(data).is_ok() {
        return UTF_8;
    }
    // 3. 非 UTF-8：按 GBK（encoding_rs 中 GBK 与 GB18030 共用同一套解码/编码实现，
    //    实际就是 gb18030 解码器，能覆盖 GB18030 全集）无损解码即判定为中文编码。
    //    注：此前还有一段“GBK 失败后再试 GB18030”的回退，但二者解码行为完全一致（GBK 报错时
    //    GB18030 同样报错），GB18030 分支永远不可达，已删除该死代码。GBK 标签下回写也走同一编码器，可无损。
    let (_, had_errors) = GBK.decode_without_bom_handling(data);
    if !had_errors {
        return GBK;
    }
    // 4. 兜底：按 UTF-8 lossy 处理（decode 阶段用替换字符）
    UTF_8
}

/// 把任意行尾归一到 LF：CRLF 与孤立 CR 都转成 LF。
///
/// 🔴 **单一定义**，不要在别处再抄一遍。全部四个使用点都要走这里：
/// [`read_text`]（读）、[`encode_text`] 的 round-trip 守卫（写）、
/// `edit_files` 归一化 `oldString`（匹配）、`write_files` 归一化 `content`（写）。
/// 任意两边脱钩都会出现“看着一模一样却匹配不上”或“每次写入都被守卫拒掉”
/// 这类谁都查不出来的现象（后者报的还是“字符无法表示”这句假话）。
///
/// ⚠ **契约：纯 CR（经典 Mac）换行的文件会被转成 LF，不会还原。**
/// [`read_text`] 的 `crlf` 标志取自 `contains("\r\n")`，纯 CR 文件为 `false`，
/// 而这里会把每个孤立 `\r` 转成 `\n`——于是改一个词会把**全文行尾**换掉。
/// 这是既有行为（经典 Mac 格式已基本绝迹，不值得为它多开一条还原路径），
/// 写在这里是为了让它从**隐含前提**变成**明写的取舍**。
pub fn normalize_newlines(s: &str) -> String {
    s.replace("\r\n", "\n").replace('\r', "\n")
}

/// 解码一段**可能在尾部被截断**的 UTF-8 字节串。
///
/// 与 `String::from_utf8` 的唯一差别：尾部那个被切坏的多字节字符被退掉，而不是
/// 让整个文件被判成二进制。限流读（`take(N)` / 远端 `f.read(N)`）按**字节数**切，
/// 一个 >2 MB 的中文文件有约 1/4 概率把切点落进某个汉字的第 2/3 字节——文件本身
/// 是合法 UTF-8，严格 decode 却会整体拒绝，用户看到「文件不是 UTF-8 文本」。
///
/// 🔴 只原谅**尾部不完整**：`Utf8Error::error_len() == None` 正是 std 对
/// 「输入在一个合法字符序列中途结束」的判定，此时 `valid_up_to()` 之前必为完整
/// 合法 UTF-8。其余任何非法字节（文件真的是二进制）原样返回 Err——绝不把二进制
/// 静默解码成乱码再让上层写回（那会把 U+FFFD 永久烤进文件）。
pub fn decode_utf8_truncated(bytes: &[u8]) -> Result<String, std::str::Utf8Error> {
    match std::str::from_utf8(bytes) {
        Ok(s) => Ok(s.to_string()),
        Err(e) if e.error_len().is_none() => {
            let s = std::str::from_utf8(&bytes[..e.valid_up_to()])
                .expect("valid_up_to 之前的字节必为合法 UTF-8（std 契约）");
            Ok(s.to_string())
        }
        Err(e) => Err(e),
    }
}

/// SSH 文件面板读路径的文本 + 编码标签。
#[derive(Debug)]
pub struct PanelText {
    /// 已把 CRLF 归一成 LF 的文本（**孤立 CR 原样保留**，与面板既有语义一致；
    /// 不同于 [`read_text`] 会把孤立 CR 也抹掉）。
    pub text: String,
    /// 编码标签："utf-8" | "gbk"。写回时原样带回后端（经 [`label_to_encoding`] 校验）。
    pub encoding: &'static str,
    /// 原文件是 CRLF 换行（写回时还原）。
    pub crlf: bool,
}

/// SSH 文件面板的读路径解码：**UTF-8 优先，GBK 兜底**，两者都拒才报错。
///
/// WHY 需要它：面板原来两条读路径（russh / helper 回退）各抄一份
/// [`decode_utf8_truncated`]，GBK 文件（国内服务器上极常见）一律被
/// `ERR_FILE_BINARY` 拒掉，只能「用本机编辑器打开」。而 MCP 本地工具早有完整的
/// GBK round-trip 支持（[`read_text`]/[`encode_text`]）。迁 GBK 的同时把两份
/// 重复解码收回这一个函数，避免以后再分叉。
///
/// 🔴 顺序不能反（UTF-8 必须在 GBK 之前）：多数 UTF-8 中文恰好也是合法 GBK，
/// 反序会把 UTF-8 文件误标成 GBK。虽然 GBK 编回去字节一致（无损），但状态栏对
/// 用户说谎，且探测规则一旦微调就会真的损坏文件。有单测守着这个顺序。
///
/// 🔴 GBK 路线必须先过 [`is_binary_content`]：GBK/GB18030 几乎能无损解码任何
/// 双字节序列，PNG/EXE 这类二进制不加守卫会被当文本打开，用户编辑保存后把乱码
/// 永久写回远端。UTF-8 路线**不**加这道守卫——保持既有行为（合法 UTF-8 但含
/// NUL 的文件今天就能打开，本批不改这个语义）。
///
/// 截断容忍两条路各自处理：UTF-8 走 [`decode_utf8_truncated`]（尾部残缺退一个
/// 字符）；GBK 走流式 `Decoder` + `last=false`——尾部不完整的多字节序列被
/// decoder 扣住（返回的已读字节数 < 输入长度），**不是** Malformed。限量读按
/// 字节数切，切点落在汉字中间是常态，这条容忍必须成立。
pub fn decode_panel_text(bytes: &[u8]) -> Result<PanelText, String> {
    // 1. UTF-8 优先：完整合法、或仅尾部被限量读切坏的，都按 UTF-8 收下。
    if let Ok(text) = decode_utf8_truncated(bytes) {
        let crlf = text.contains("\r\n");
        return Ok(PanelText {
            text: text.replace("\r\n", "\n"),
            encoding: "utf-8",
            crlf,
        });
    }
    // 2. 非 UTF-8：先拦二进制，再试 GBK 流式解码。
    if is_binary_content(bytes) {
        return Err("文件疑似二进制（含 NUL 或高比例控制字符），请用本机编辑器打开".to_string());
    }
    // 不用带 BOM 处理的构造器：GBK 没有 BOM，且 UTF-8 BOM 的文件在第 1 步就走掉了。
    let mut decoder = GBK.new_decoder_without_bom_handling();
    // 🔴 输出容量必须按 decoder 自报的最坏情况预留：GBK 双字节序列最多产出 3 字节
    // UTF-8（单一 0x80 字节也是 3）。容量不够时 `decode_*` 会提前返回
    // `OutputFull` 并**静默丢掉剩余输入**——表现就是「GBK 文件只解出前半段」，
    // 而返回值又不是 Malformed，上层完全看不出。曾经按 `bytes.len()` 预留容量
    // 踩过：8 字节输入要 12 字节输出，第 3 个汉字起整段消失。
    let cap = decoder
        .max_utf8_buffer_length_without_replacement(bytes.len())
        .unwrap_or_else(|| bytes.len().saturating_mul(3).saturating_add(1));
    let mut text = String::with_capacity(cap);
    let (result, _read) = decoder.decode_to_string_without_replacement(bytes, &mut text, false);
    // OutputFull 与 Malformed 一并拒绝：容量算对时前者不可达，但宁可错杀也不
    // 静默截断（截断的文本会被用户编辑后写回远端，等于数据损坏）。
    if matches!(
        result,
        DecoderResult::Malformed(..) | DecoderResult::OutputFull
    ) {
        return Err("文件不是 UTF-8 或 GBK/GB18030 文本，请用本机编辑器打开".to_string());
    }
    let crlf = text.contains("\r\n");
    Ok(PanelText {
        text: text.replace("\r\n", "\n"),
        encoding: "gbk",
        crlf,
    })
}

/// 读取字节流为归一化文本（LF），并记录编码/换行/BOM 供无损回写。
/// `override_label`（如 "gbk"）优先，否则自动探测。
pub fn read_text(data: &[u8], override_label: Option<&str>) -> Result<FileText, String> {
    let requested = match override_label {
        Some(label) if !label.trim().is_empty() => {
            label_to_encoding(label).ok_or_else(|| format!("Unknown encoding label: {label}"))?
        }
        _ => detect_encoding(data),
    };
    // decode 会剥掉匹配的 BOM；若检测到与 requested 不同的 BOM 会改用 BOM 编码。
    let (cow, actual, had_errors) = requested.decode(data);
    // BOM 判定按**实际用于解码的编码**来：UTF-16LE/BE 的 BOM 同样要记，
    // 否则写回时不补，文件丢 BOM 后被自家探测判二进制（见 `FileText::had_bom`）。
    let had_bom = bom_bytes(actual).is_some_and(|bom| data.starts_with(bom));
    // 修复：之前这里用 `_had_errors` 丢弃了解码错误标志。当 detect_encoding 四种尝试都失败（既不是合法 UTF-8，
    // 也无法被 GBK/GB18030 无损解码）时会落到这里的 UTF-8 兼底分支，`decode()` 会静默用 U+FFFD 替换无法解码的字节。
    // 若不拦截，后续 edit_files/notebook_edit 写回时会把这些 U+FFFD 永久烤进文件，与本模块注释里声明的
    // “编码有损时拒绝写入而非静默损坏”原则自相矛盾（该原则之前只在 encode_text 的回写方向实现），这里补上读方向的同样保护。
    if had_errors {
        let label = match override_label {
            Some(l) if !l.trim().is_empty() => format!("指定编码 '{l}'"),
            _ => "自动探测（已依次尝试 BOM / UTF-8 / GBK / GB18030）".to_string(),
        };
        return Err(format!(
            "无法无损解码文件内容（{label}）：存在无法正确转换的字节。为避免将这些字节静默替换为 U+FFFD 并在后续写回时永久损坏原始内容，已拒绝处理。若确定真实编码，请显式传入 encoding 参数重试。"
        ));
    }
    let raw = cow.as_ref();
    let crlf = raw.contains("\r\n");
    // 归一化到 LF：CRLF 与孤立 CR 都转成 LF，用于匹配/展示。
    let text = normalize_newlines(raw);
    Ok(FileText {
        text,
        encoding: actual,
        crlf,
        had_bom,
    })
}

/// 判断字节流是否为二进制内容（用于 `read_files` 守卫，避免把二进制当文本裸返乱码）。
///
/// WHY: `read_text` 只在编码**有损**时拦截（`encoding.rs:80`），而 GBK/GB18030 几乎能解码
/// 任何双字节序列，导致 PNG/EXE/`".pyc"` 这类二进制被当文本成功解码、返回乱码，污染远程
/// CC 上下文。`is_binary_content` 在 `read_text` 之前先拦一层。
///
/// 判定（采样前 8KB）：
/// - 排除合法 UTF-16/UTF-32 BOM（其 ASCII 区间含 `0x00` 字节，是编码特征不是二进制垃圾）。
/// - 命中 NUL（`0x00`）即判二进制（正常文本文件不含 NUL）。
/// - 非打印控制字符占比 > 10% 判二进制（覆盖「全 NUL 之外的控制字符垃圾」）。
pub fn is_binary_content(data: &[u8]) -> bool {
    // 排除合法 UTF-16/UTF-32 BOM：它们的 0x00 是编码特征，不是二进制垃圾。
    if data.starts_with(&[0xFF, 0xFE])                  // UTF-16LE（同时覆盖 UTF-32LE 的 FF FE 00 00 前缀）
        || data.starts_with(&[0xFE, 0xFF])              // UTF-16BE
        || data.starts_with(&[0x00, 0x00, 0xFE, 0xFF])
    // UTF-32BE（此前误写为 00 FE FF，导致 UTF-32BE 文本被当二进制）
    {
        return false;
    }
    let sample = &data[..data.len().min(8192)];
    if sample.is_empty() {
        return false;
    }
    if sample.contains(&0x00) {
        return true;
    }
    let non_print = sample
        .iter()
        .filter(|&&b| b < 0x09 || (0x0D < b && b < 0x20) || b == 0x7F)
        .count();
    (non_print as f64 / sample.len() as f64) > 0.10
}

/// 把文本按编码编为字节流，**UTF-16 走独立路径**。
///
/// 🔴 为什么必须有这个分发：`encoding_rs` 的 `Encoding::encode` 对
/// **UTF-16LE / UTF-16BE / UTF-32* 目标会静默返回 UTF-8**（返回值里的
/// `&Encoding` 会变成 `UTF_8`，实测 `UTF_16LE.encode("content")` 得到
/// 7 字节 ASCII）。如果像对 GBK 那样直接 `enc.encode(&restored)`，
/// UTF-16 文件写回会吐出 UTF-8 字节：要么被 round-trip 守卫拒掉
/// （报「字符无法表示」这句假话），要么——万一守卫没看出问题——把文件
/// 悄悄换成另一种编码。这是**典型的静默失败**：调用方不检查第二个返回值
/// 就永远发现不了。所以 UTF-16 必须自己用 `str::encode_utf16` 编。
fn encode_bytes(text: &str, enc: &'static Encoding) -> Vec<u8> {
    if enc == UTF_16LE {
        encode_utf16(text, true)
    } else if enc == UTF_16BE {
        encode_utf16(text, false)
    } else {
        enc.encode(text).0.into_owned()
    }
}

/// 文本 → UTF-16 字节流（`str::encode_utf16` 正确处理代理对，不会拆坏 emoji）。
fn encode_utf16(text: &str, little_endian: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 2 + 2);
    for unit in text.encode_utf16() {
        if little_endian {
            out.extend_from_slice(&unit.to_le_bytes());
        } else {
            out.extend_from_slice(&unit.to_be_bytes());
        }
    }
    out
}

/// 把归一化文本（LF）按指定编码/换行/BOM 无损编码为字节流。
/// 编码有损（往 GBK 插入不可表示字符等）时返回错误，绝不静默损坏文件。
pub fn encode_text(
    text_lf: &str,
    enc: &'static Encoding,
    crlf: bool,
    had_bom: bool,
) -> Result<Vec<u8>, String> {
    // 还原原始换行。
    let restored = if crlf {
        text_lf.replace('\n', "\r\n")
    } else {
        text_lf.to_string()
    };

    let body = encode_bytes(&restored, enc);

    // round-trip 守卫：解码回来归一化后必须与输入一致，否则说明该编码无法无损
    // 表示新内容（如 GBK 装不下的字符），拒绝写入。
    let (back, _, _) = enc.decode(&body);
    let back_norm = normalize_newlines(&back);
    if back_norm != text_lf {
        return Err(format!(
            "encode round-trip mismatch under {} — the new content contains characters not representable in this encoding; aborting write to avoid corruption",
            enc.name()
        ));
    }

    let mut out = Vec::with_capacity(body.len() + 4);
    if had_bom {
        // 按**这个**编码的 BOM 补回：UTF-8 补 3 字节、UTF-16LE/BE 补 2 字节。
        // 曾经这里写死 `enc == UTF_8`，UTF-16 文件的 BOM 有去无回。
        if let Some(bom) = bom_bytes(enc) {
            out.extend_from_slice(bom);
        }
    }
    out.extend_from_slice(&body);
    Ok(out)
}

/// SSH 文件面板的写路径编码：把编辑器的 LF 文本按**原编码 + 原换行**还原成字节流。
///
/// WHY: 面板原来把 content 当 UTF-8 字节原样落盘（`normalized.as_bytes()`）。接了
/// GBK 读之后写路径若不改，GBK 文件会被**静默转码成 UTF-8**——远端文件编码被换掉，
/// 用户完全看不出。所以读时带回的 `encoding` 标签必须在这里参与回写。
///
/// 安全性：`encoding_label` 来自前端，但写路径是破坏性的，必须过
/// [`label_to_encoding`] 白名单——未知标签（前端被篡改 / 版本错位）直接拒绝，
/// 绝不静默按 UTF-8 落盘。
///
/// 🔴 为什么不直接复用 [`encode_text`]：它的 round-trip 守卫用
/// [`normalize_newlines`] 比对（孤立 CR 也抹成 LF），而面板读路径**不**归一化
/// 孤立 CR（孤立 CR 原样进出）。拿 `encode_text` 的守卫套面板内容，会把「能打开
/// 却存不回去」的孤立 CR 文件误判成不可编码。所以这里按面板自己的归一化规则
/// （只认 CRLF→LF）做同样的守卫。两处规则差异必须一直保持，改任何一边都要
/// 同步想清楚另一边。
///
/// BOM 不单独处理：面板读路径不剥 BOM，U+FEFF 作为文本内容参与往返；GBK 也没有 BOM。
pub fn encode_panel_text(
    content: &str,
    line_ending: &str,
    encoding_label: &str,
) -> Result<Vec<u8>, String> {
    let enc = label_to_encoding(encoding_label)
        .ok_or_else(|| format!("不支持的编码标签：{encoding_label}"))?;
    // 还原换行：读时把 CRLF 归一成 LF，写回按原文件风格，避免把全文换行改掉。
    let restored = if line_ending == "crlf" {
        content.replace('\n', "\r\n")
    } else {
        content.to_string()
    };
    let body = encode_bytes(&restored, enc);
    // round-trip 守卫（面板版）：编回去再解回来，按面板的归一化规则（只认
    // CRLF→LF，孤立 CR 不动）必须与输入一致，否则说明该编码装不下新内容
    // （如往 GBK 插 emoji），拒绝写入而非把乱码写进远端文件。
    // 🔴 必须用 `decode_without_bom_handling`：面板把 BOM 当文本内容带着走，
    // 而带嗅探的 `decode` 会把 body 开头的 UTF-8 BOM 剥掉，守卫于是永远
    // 对不上（带 BOM 的 UTF-8 文件会被误判成「无法编码」而存不回去）。
    let (back, _) = enc.decode_without_bom_handling(&body);
    if back.replace("\r\n", "\n") != content {
        return Err(format!(
            "无法按 {encoding_label} 编码保存：内容含有该编码无法表示的字符（如 emoji）。请移除这些字符，或用本机编辑器打开"
        ));
    }
    Ok(body)
}

/// 把文本按指定编码编码为字节流（仅测试用，不做守卫）。
///
/// 与 `encode_text` 共用 `encode_bytes`：否则测试会像曾经那样用
/// `enc.encode()` 构造「假 UTF-16」（实际是 UTF-8），测的东西根本不是要测的。
#[cfg(test)]
pub fn encode_string(text: &str, enc: &'static Encoding) -> Vec<u8> {
    encode_bytes(text, enc)
}

/// 把用户提供的编码标签映射到 Encoding。复用 WHATWG 标准别名
/// （"utf8"/"utf-8"、"gbk"/"gb2312"、"gb18030"、"utf-16le" 等）。
pub fn label_to_encoding(label: &str) -> Option<&'static Encoding> {
    Encoding::for_label(label.trim().as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 归一化规则本身。`edit_files` 归一化 `oldString` 用的是同一个函数，
    /// 这条一旦改了，那边的匹配行为也跟着变——所以先把规则钉死。
    #[test]
    fn normalize_newlines_handles_crlf_and_lone_cr() {
        assert_eq!(normalize_newlines("a\r\nb"), "a\nb");
        assert_eq!(normalize_newlines("a\rb"), "a\nb", "孤立 CR 也要转");
        assert_eq!(normalize_newlines("a\nb"), "a\nb", "已是 LF 的不能动");
        assert_eq!(normalize_newlines("a\r\n\r\nb"), "a\n\nb");
    }

    /// 纯 CR（经典 Mac）文件会被转成 LF 且**不还原**——这是取舍，不是意外。
    ///
    /// 钉它的理由：这个行为一直是**隐含**的（`crlf` 标志只看 `\r\n`），
    /// 而它的后果不小：对纯 CR 文件改一个词，全文行尾都会被换掉。
    /// 写成测试之后，日后谁想改成“保真纯 CR”就必须先面对这条断言。
    #[test]
    fn lone_cr_is_converted_to_lf_and_not_restored() {
        let ft = read_text(b"a\rb\rc", None).expect("纯 CR 应能读");
        assert_eq!(ft.text, "a\nb\nc");
        assert!(!ft.crlf, "`crlf` 标志只看 \\r\\n，纯 CR 文件为 false");

        let out = encode_text(&ft.text, ft.encoding, ft.crlf, ft.had_bom).expect("回写");
        assert_eq!(out, b"a\nb\nc", "纯 CR **不会**被还原——行尾已整体变成 LF");
    }

    #[test]
    fn test_detect_utf8() {
        assert_eq!(detect_encoding("hello 世界".as_bytes()), UTF_8);
    }

    #[test]
    fn test_detect_gbk() {
        let gbk_bytes = encode_string("你好，世界", GBK);
        assert!(std::str::from_utf8(&gbk_bytes).is_err());
        assert_eq!(detect_encoding(&gbk_bytes), GBK);
    }

    #[test]
    fn test_gbk_round_trip() {
        let original = "中文注释 abc 123";
        let bytes = encode_string(original, GBK);
        let ft = read_text(&bytes, None).unwrap();
        assert_eq!(ft.text, original);
        assert_eq!(ft.encoding, GBK);
    }

    #[test]
    fn test_utf8_bom_stripped_and_restored() {
        let mut bytes = UTF8_BOM.to_vec();
        bytes.extend_from_slice("content".as_bytes());
        let ft = read_text(&bytes, None).unwrap();
        assert_eq!(ft.text, "content"); // BOM 已剥离
        assert!(ft.had_bom);
        // 回写补回 BOM
        let out = encode_text(&ft.text, ft.encoding, ft.crlf, ft.had_bom).unwrap();
        assert!(out.starts_with(&UTF8_BOM));
    }

    /// 回归：UTF-16LE + BOM 必须**原样 round-trip**。
    ///
    /// 修复前 `had_bom` 只记 UTF-8、回写只补 UTF-8 BOM ⇒ UTF-16 文件保存后
    /// BOM 丢失；而丢 BOM 的 UTF-16 再探测时不再是 UTF-16（含 NUL 的字节串
    /// 会被 `is_binary_content` 判二进制）⇒ 该文件从此连本工具都读不了。
    #[test]
    fn test_utf16le_bom_stripped_and_restored() {
        let mut bytes = vec![0xFF, 0xFE];
        bytes.extend_from_slice(&encode_string("content", UTF_16LE));
        let ft = read_text(&bytes, None).unwrap();
        assert_eq!(ft.text, "content");
        assert_eq!(ft.encoding, UTF_16LE);
        assert!(ft.had_bom, "UTF-16LE 的 BOM 也必须记录");
        let out = encode_text(&ft.text, ft.encoding, ft.crlf, ft.had_bom).unwrap();
        assert_eq!(out, bytes, "读→写必须逐字节一致（含 BOM）");

        // 写回后再读：编码与 BOM 都还在，且不会被误判成二进制。
        let again = read_text(&out, None).unwrap();
        assert_eq!(again.encoding, UTF_16LE);
        assert!(again.had_bom);
        assert!(!is_binary_content(&out), "带 BOM 的 UTF-16 不是二进制");
    }

    /// 同上，BE 方向。两个方向都要守：BOM 字节序不同，写错就是乱码。
    #[test]
    fn test_utf16be_bom_stripped_and_restored() {
        let mut bytes = vec![0xFE, 0xFF];
        bytes.extend_from_slice(&encode_string("内容", UTF_16BE));
        let ft = read_text(&bytes, None).unwrap();
        assert_eq!(ft.text, "内容");
        assert_eq!(ft.encoding, UTF_16BE);
        assert!(ft.had_bom);
        let out = encode_text(&ft.text, ft.encoding, ft.crlf, ft.had_bom).unwrap();
        assert_eq!(out, bytes, "读→写必须逐字节一致（含 BOM）");
    }

    /// UTF-16 文件必须**真的能改**，而不只是读→写原样 round-trip。
    ///
    /// 修复前 `encode_text` 直接 `enc.encode()`，而 encoding_rs 对 UTF-16
    /// 目标静默返回 UTF-8 ⇒ 任何一次 edit_files/write_files 保存都被
    /// round-trip 守卫拒掉，报的还是「字符无法表示」这句假话——
    /// 用户视角是「UTF-16 文件完全不能编辑」。emoji 顺带钉住代理对
    /// （`encode_utf16` 走 `str::encode_utf16`，不会把 🎯 拆成两个独立码元）。
    #[test]
    fn test_utf16le_file_is_editable() {
        let mut bytes = vec![0xFF, 0xFE];
        bytes.extend_from_slice(&encode_string("hello", UTF_16LE));
        let ft = read_text(&bytes, None).unwrap();
        let edited = format!("{}\n世界 🎯", ft.text);
        let out =
            encode_text(&edited, ft.encoding, ft.crlf, ft.had_bom).expect("UTF-16 文件必须可保存");
        let again = read_text(&out, None).unwrap();
        assert_eq!(again.text, edited);
        assert_eq!(again.encoding, UTF_16LE);
        assert!(again.had_bom, "改完再存，BOM 还在");
        assert!(!is_binary_content(&out));
    }

    /// UTF-16 无 BOM（用户显式指定编码时）不能凭编码补一个 BOM 出来。
    #[test]
    fn test_utf16_without_bom_stays_without_bom() {
        let bytes = encode_string("no bom", UTF_16LE);
        let ft = read_text(&bytes, Some("utf-16le")).unwrap();
        assert!(!ft.had_bom);
        let out = encode_text(&ft.text, ft.encoding, ft.crlf, ft.had_bom).unwrap();
        assert_eq!(out, bytes);
    }

    #[test]
    fn test_crlf_detected_and_restored() {
        let bytes = "a\r\nb\r\nc".as_bytes();
        let ft = read_text(bytes, None).unwrap();
        assert_eq!(ft.text, "a\nb\nc"); // 归一化到 LF
        assert!(ft.crlf);
        let out = encode_text(&ft.text, ft.encoding, ft.crlf, ft.had_bom).unwrap();
        assert_eq!(out, "a\r\nb\r\nc".as_bytes()); // 还原 CRLF
    }

    #[test]
    fn test_lf_stays_lf() {
        let ft = read_text("a\nb".as_bytes(), None).unwrap();
        assert!(!ft.crlf);
        let out = encode_text(&ft.text, ft.encoding, ft.crlf, ft.had_bom).unwrap();
        assert_eq!(out, "a\nb".as_bytes());
    }

    #[test]
    fn test_gbk_crlf_edit_round_trip() {
        // 模拟 GBK + CRLF 的 NC65 源码：读→改→写全链路保真。
        let src = encode_string("公用\r\n方法", GBK);
        let ft = read_text(&src, None).unwrap();
        assert_eq!(ft.text, "公用\n方法");
        assert_eq!(ft.encoding, GBK);
        assert!(ft.crlf);
        let edited = ft.text.replace("方法", "工具");
        let out = encode_text(&edited, ft.encoding, ft.crlf, ft.had_bom).unwrap();
        // 写回仍是 GBK + CRLF
        assert_eq!(out, encode_string("公用\r\n工具", GBK));
    }

    #[test]
    fn test_round_trip_guard_rejects_lossy() {
        // 往 GBK 文件插入 GBK 无法表示的字符（emoji），必须报错而非损坏。
        let result = encode_text("hello 🎉", GBK, false, false);
        assert!(result.is_err());
    }

    #[test]
    fn test_override_label() {
        let bytes = encode_string("测试", GBK);
        let ft = read_text(&bytes, Some("gbk")).unwrap();
        assert_eq!(ft.text, "测试");
        assert_eq!(ft.encoding, GBK);
    }

    #[test]
    fn test_read_text_rejects_undecodable_bytes_instead_of_lossy_fffd() {
        // 修复回归：0xFF 既不是合法 UTF-8，也不是合法 GBK/GB18030 首字节（合法范围 0x81-0xFE），
        // detect_encoding 四种尝试都会失败、落到 UTF-8 兼底分支。修复前这里会静默用 U+FFFD
        // 替换并返回 Ok，修复后必须返回 Err，避免写回时永久烤进替换字符。
        let bytes = b"hello \xff world";
        let result = read_text(bytes, None);
        assert!(
            result.is_err(),
            "不可解码的字节应该报错而不是静默 lossy 成功：{:?}",
            result.map(|f| f.text)
        );
    }

    #[test]
    fn test_read_text_override_label_also_rejects_lossy() {
        // 显式指定的编码同样不应该容忍有损解码（之前也是同样的 _had_errors 丢弃问题，
        // 无论走自动探测还是显式 override 都会命中同一行）。
        // 注意：不能用任意 UTF-8 中文字节测试——GBK 解码对"这个字节序列是否对应某个
        // 合法 GBK 字符"宽容很高，很多 UTF-8 中文字节恰好也能被当成合法（碰巧）GBK 解码（这正是
        // GBK 误判风险本身的根源）。用 0xFF 这种超出 GBK 首字节合法范围（0x81-0xFE）的字节才能确保真正报错。
        let bytes: &[u8] = b"abc\xff";
        let result = read_text(bytes, Some("gbk"));
        assert!(result.is_err());
    }

    #[test]
    fn test_unknown_label_errors() {
        assert!(read_text(b"x", Some("no-such-encoding")).is_err());
    }

    #[test]
    fn test_is_binary_content_detects_real_binaries() {
        // NUL 开头的二进制（.pyc 类）
        assert!(is_binary_content(b"\x00world"));
        // PNG 头（0x89 起）——GBK 会误判为可解码，必须被 is_binary_content 拦下
        assert!(is_binary_content(b"\x89PNG\r\n\x1a\n\x00\x01\x02"));
        // EXE 头（MZ + NUL）
        assert!(is_binary_content(b"MZ\x00\x00\x01\x02"));
        // 全控制字符垃圾（非打印占比高）
        assert!(is_binary_content(&[
            0x01u8, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07
        ]));
    }

    #[test]
    fn test_is_binary_content_accepts_text() {
        // 合法 UTF-8 文本
        assert!(!is_binary_content("hello 世界\nfn main()\n".as_bytes()));
        // 合法 GBK 中文（不是二进制）
        assert!(!is_binary_content("你好".as_bytes()));
        // 普通 ASCII + 空格（非打印占比 < 10%）
        assert!(!is_binary_content(b"just some normal text with spaces"));
        // UTF-16LE BOM：排除，不是二进制
        assert!(!is_binary_content(b"\xff\xfeh\x00i\x00"));
    }

    #[test]
    fn test_is_binary_content_empty_is_not_binary() {
        assert!(!is_binary_content(b""));
    }

    #[test]
    fn decode_utf8_truncated_passes_valid_input_through() {
        assert_eq!(
            decode_utf8_truncated("hello 世界\n".as_bytes()).unwrap(),
            "hello 世界\n"
        );
        assert_eq!(decode_utf8_truncated(b"").unwrap(), "");
    }

    /// 限流读按字节切，切点落在多字节字符中间时只能退掉尾部那一个字符，
    /// 前面的完整字符必须保住——这是 >2MB 中文文件不再被误判二进制的原因。
    #[test]
    fn decode_utf8_truncated_drops_only_the_broken_tail_char() {
        // "世界" = E4 B8 96 | E7 95 8C
        assert_eq!(decode_utf8_truncated(b"a\xe4\xb8").unwrap(), "a");
        assert_eq!(
            decode_utf8_truncated(b"\xe4\xb8\x96\xe7\x95").unwrap(),
            "世"
        );
        // 4 字节 emoji 被切成两半：整段尾巴都要退掉
        let emoji = "🎉".as_bytes();
        assert_eq!(decode_utf8_truncated(&emoji[..2]).unwrap(), "");
        assert_eq!(decode_utf8_truncated(&emoji[..4]).unwrap(), "🎉");
    }

    /// 真二进制仍然必须拒绝：`decode_utf8_truncated` 不是「什么都试着解码」。
    /// 中部非法字节、尾巴不完整但前面已有非法字节、合法文本后接非法字节，都要 Err。
    #[test]
    fn decode_utf8_truncated_still_rejects_real_binary() {
        assert!(decode_utf8_truncated(b"abc\xffdef").is_err());
        assert!(decode_utf8_truncated(b"\xff\xe4\xb8").is_err());
        let mut v = "世界".as_bytes().to_vec();
        v.push(0xFF);
        assert!(decode_utf8_truncated(&v).is_err());
    }

    // ---- SSH 面板 GBK 编解码（批次② 2026-11-24）----

    /// UTF-8 优先：合法 UTF-8 必须标 "utf-8"。
    /// 同时守着探测顺序——中文 UTF-8 字节多数也是合法 GBK，顺序一反就被误标 GBK。
    #[test]
    fn decode_panel_text_prefers_utf8_over_gbk() {
        let t = decode_panel_text("hello 世界\n".as_bytes()).unwrap();
        assert_eq!(t.text, "hello 世界\n");
        assert_eq!(t.encoding, "utf-8");
        assert!(!t.crlf);
    }

    #[test]
    fn decode_panel_text_decodes_gbk_with_label() {
        let bytes = encode_string("你好，世界", GBK);
        assert!(
            std::str::from_utf8(&bytes).is_err(),
            "前置条件：确实是 GBK 字节"
        );
        let t = decode_panel_text(&bytes).unwrap();
        assert_eq!(t.text, "你好，世界");
        assert_eq!(t.encoding, "gbk");
    }

    /// 限量读按字节切，切点落在汉字中间：GBK 路线必须容忍（扣住尾部半个字符），
    /// 与 UTF-8 路线的 `decode_utf8_truncated` 语义对齐。
    #[test]
    fn decode_panel_text_gbk_tolerates_truncated_tail() {
        let bytes = encode_string("你好世界", GBK); // 界 = BD E7
        let cut = &bytes[..bytes.len() - 1];
        let t = decode_panel_text(cut).unwrap();
        assert_eq!(t.text, "你好世", "尾部半个字符被扣住，不是错误");
        assert_eq!(t.encoding, "gbk");
    }

    /// 中部真损坏（0xFF 不是合法 GBK 首字节）必须拒绝——截断容忍只原谅尾部。
    #[test]
    fn decode_panel_text_gbk_rejects_mid_file_malformed() {
        let mut bytes = encode_string("你好", GBK); // 你 = C4 E3
        bytes.insert(1, 0xFF);
        assert!(decode_panel_text(&bytes).is_err());
    }

    /// GBK 路线的二进制守卫：PNG 头能被 GBK「解码」，必须被 `is_binary_content` 拦下。
    /// （注意：纯 NUL 垃圾如 `MZ\x00\x00` 是**合法 UTF-8**，会走第 1 步被当成文本
    /// 收下——这是 UTF-8 路线不加守卫的既定取舍，见 `decode_panel_text` 注释。）
    #[test]
    fn decode_panel_text_gbk_rejects_binary() {
        let png = b"\x89PNG\r\n\x1a\n\x00\x01\x02\x03";
        let err = decode_panel_text(png).unwrap_err();
        assert!(err.contains("二进制"), "应报二进制：{err}");
        // GBK 能无损解出的双字节序列里夹带 NUL：没有守卫就会被当文本打开
        let gbk_with_nul = b"\xc4\xe3\x00\xba\xc3";
        assert!(decode_panel_text(gbk_with_nul).is_err());
    }

    #[test]
    fn decode_panel_text_crlf_flag_both_encodings() {
        let u = decode_panel_text("a\r\nb".as_bytes()).unwrap();
        assert!(u.crlf);
        assert_eq!(u.text, "a\nb");
        let g = decode_panel_text(&encode_string("公用\r\n方法", GBK)).unwrap();
        assert!(g.crlf);
        assert_eq!(g.text, "公用\n方法");
    }

    /// 读→写原样 round-trip（GBK + CRLF，逐字节）。
    #[test]
    fn encode_panel_text_gbk_round_trip_byte_identical() {
        let src = encode_string("公用\r\n方法 abc 123", GBK);
        let t = decode_panel_text(&src).unwrap();
        let out =
            encode_panel_text(&t.text, if t.crlf { "crlf" } else { "lf" }, t.encoding).unwrap();
        assert_eq!(out, src);
    }

    /// 改内容后仍按 GBK + CRLF 落盘，且写回的字节再读编码标签不漂移。
    #[test]
    fn encode_panel_text_gbk_edit_round_trip() {
        let src = encode_string("公用\r\n方法", GBK);
        let t = decode_panel_text(&src).unwrap();
        let edited = t.text.replace("方法", "工具");
        let out = encode_panel_text(&edited, "crlf", "gbk").unwrap();
        assert_eq!(out, encode_string("公用\r\n工具", GBK));
        assert_eq!(decode_panel_text(&out).unwrap().encoding, "gbk");
    }

    /// round-trip 守卫：往 GBK 插 emoji 必须拒存，且错误消息点明编码、可读。
    #[test]
    fn encode_panel_text_rejects_unrepresentable_chars() {
        let err = encode_panel_text("hello 🎉", "lf", "gbk").unwrap_err();
        assert!(
            err.contains("无法按 gbk 编码保存"),
            "错误消息应点明编码：{err}"
        );
    }

    /// 未知编码标签拒绝（写路径不信任前端字符串）。
    #[test]
    fn encode_panel_text_rejects_unknown_label() {
        assert!(encode_panel_text("x", "lf", "no-such-encoding").is_err());
    }

    /// UTF-8 + BOM：BOM 作为文本内容参与往返，不能补重也不能丢。
    #[test]
    fn encode_panel_text_utf8_bom_round_trip() {
        let mut src = UTF8_BOM.to_vec();
        src.extend_from_slice("content".as_bytes());
        let t = decode_panel_text(&src).unwrap();
        assert_eq!(t.encoding, "utf-8");
        let out = encode_panel_text(&t.text, "lf", t.encoding).unwrap();
        assert_eq!(out, src, "BOM 必须原样回来（不重不漏）");
    }

    /// 孤立 CR 文件：面板不归一化孤立 CR，读→写必须原样往返。
    /// 守着 `encode_panel_text` 与 `encode_text` 的守卫规则差异——后者会抹掉孤立 CR，
    /// 直接复用会把「能打开却存不回去」的误判带进面板。
    #[test]
    fn encode_panel_text_preserves_lone_cr() {
        let src = b"a\rb\rc".to_vec();
        let t = decode_panel_text(&src).unwrap();
        assert_eq!(t.text, "a\rb\rc", "孤立 CR 不进归一化");
        assert!(!t.crlf);
        let out = encode_panel_text(&t.text, "lf", t.encoding).unwrap();
        assert_eq!(out, src, "孤立 CR 原样写回");
    }
}
