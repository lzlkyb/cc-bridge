//! 文件编码 + 换行探测与无损转码。
//!
//! WHY: `read_files`/`edit_files` 面对的真实文件不一定是 UTF-8（用户的 NC65
//! 项目是 GBK），换行也可能是 CRLF。参考 nc-compile/ccedit.py 的做法：
//! 读取时探测编码/换行/BOM，把文本统一归一化到 LF 供模型匹配与展示；写回时
//! 按**原编码 + 原换行 + 原 BOM** 还原，并做 encode→decode round-trip 校验，
//! 编码有损（如往 GBK 插入不可表示字符）时**拒绝写入**而非静默损坏。
//! 相关问题：anthropics/claude-code#56946（内置工具把 GBK 读成 U+FFFD）。

use encoding_rs::{Encoding, GB18030, GBK, UTF_16BE, UTF_16LE, UTF_8};

const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

/// 解码后的文件文本 + 回写所需的保真信息。`text` 已归一化到 LF、剥掉 BOM。
pub struct FileText {
    pub text: String,
    pub encoding: &'static Encoding,
    /// 原文件使用 CRLF 换行（写回时把 `\n` 还原为 `\r\n`）。
    pub crlf: bool,
    /// 原文件带 UTF-8 BOM（写回时补回）。
    pub had_bom: bool,
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
    // 3. 非 UTF-8：先试 GBK（严格），无替换字符即判定；再退 GB18030（超集）
    let (_, had_errors) = GBK.decode_without_bom_handling(data);
    if !had_errors {
        return GBK;
    }
    let (_, had_errors) = GB18030.decode_without_bom_handling(data);
    if !had_errors {
        return GB18030;
    }
    // 4. 兜底：按 UTF-8 lossy 处理（decode 阶段用替换字符）
    UTF_8
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
    let had_bom = requested == UTF_8 && data.starts_with(&UTF8_BOM);
    // decode 会剥掉匹配的 BOM；若检测到与 requested 不同的 BOM 会改用 BOM 编码。
    let (cow, actual, had_errors) = requested.decode(data);
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
    let text = raw.replace("\r\n", "\n").replace('\r', "\n");
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
    if data.starts_with(&[0xFF, 0xFE])
        || data.starts_with(&[0xFE, 0xFF])
        || data.starts_with(&[0xFF, 0xFE, 0x00])
        || data.starts_with(&[0x00, 0xFE, 0xFF])
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

    let (body, _, _) = enc.encode(&restored);

    // round-trip 守卫：解码回来归一化后必须与输入一致，否则说明该编码无法无损
    // 表示新内容（如 GBK 装不下的字符），拒绝写入。
    let (back, _, _) = enc.decode(&body);
    let back_norm = back.replace("\r\n", "\n").replace('\r', "\n");
    if back_norm != text_lf {
        return Err(format!(
            "encode round-trip mismatch under {} — the new content contains characters not representable in this encoding; aborting write to avoid corruption",
            enc.name()
        ));
    }

    let mut out = Vec::with_capacity(body.len() + if had_bom { 3 } else { 0 });
    if had_bom && enc == UTF_8 {
        out.extend_from_slice(&UTF8_BOM);
    }
    out.extend_from_slice(&body);
    Ok(out)
}

/// 把文本按指定编码编码为字节流（仅测试用，不做守卫）。
#[cfg(test)]
pub fn encode_string(text: &str, enc: &'static Encoding) -> Vec<u8> {
    let (cow, _, _) = enc.encode(text);
    cow.into_owned()
}

/// 把用户提供的编码标签映射到 Encoding。复用 WHATWG 标准别名
/// （"utf8"/"utf-8"、"gbk"/"gb2312"、"gb18030"、"utf-16le" 等）。
pub fn label_to_encoding(label: &str) -> Option<&'static Encoding> {
    Encoding::for_label(label.trim().as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
