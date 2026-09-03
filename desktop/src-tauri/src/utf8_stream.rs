//! PTY 字节流的增量 UTF-8 解码。
//!
//! # 为什么需要它
//!
//! PTY 读出来的是**裸字节流**，`read()` 的返回长度与字符边界毫无关系。
//! 以前各处直接 `String::from_utf8_lossy(&buf[..n])`，一个 3 字节的中文字符
//! 只要跨了 4096 字节的读取边界，就会被拆成两半、各自变成 `U+FFFD`。
//!
//! 这不是理论风险。用纯中文文本按 4096 字节分块解码实测：
//!
//! ```text
//! 12000 个中文字符 → 拼回来 12009 个字符，其中 15 个是 U+FFFD
//! ```
//!
//! 也就是**每 ~4KB 中文输出就烂掉一个字**。终端里刷中文日志、SFTP 列中文文件名
//! 都会撞上；更隐蔽的是它会让「密码：」这类中文提示的匹配偶发失效，
//! 于是自动填密码就静默不工作了。
//!
//! # 做法
//!
//! 把**尾部不完整**的字节留到下一块再拼；真正非法的字节仍旧替换成 `U+FFFD`
//! 并继续往后扫（否则遇到二进制输出会永远卡住）。因此 `pending` 最多存 3 个字节。

/// 增量 UTF-8 解码器：喂裸字节，吐完整字符。
///
/// 用法：每次 `read` 后 `push()`，EOF 后 `flush()` 收尾。
#[derive(Debug, Default)]
pub struct Utf8Stream {
    /// 上一块尾部那段「不完整但可能合法」的字节，最多 3 个。
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub fn new() -> Self {
        Self::default()
    }

    /// 喂一块裸字节，返回其中**能确定成型**的那部分文本。
    ///
    /// 尾部不完整的序列被留下，等下一次 `push`；调用方不需要关心。
    pub fn push(&mut self, chunk: &[u8]) -> String {
        // 快路径：没有历史残留、且整块本身就是合法 UTF-8（绝大多数情况），省一次 4KB 拷贝。
        if self.pending.is_empty() {
            if let Ok(s) = std::str::from_utf8(chunk) {
                return s.to_string();
            }
        }
        self.pending.extend_from_slice(chunk);

        let mut out = String::new();
        let mut consumed = 0usize;
        loop {
            let rest = &self.pending[consumed..];
            match std::str::from_utf8(rest) {
                Ok(s) => {
                    out.push_str(s);
                    consumed = self.pending.len();
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    // valid_up_to() 之前的部分保证合法，这次 from_utf8 不会失败。
                    if let Ok(s) = std::str::from_utf8(&rest[..valid]) {
                        out.push_str(s);
                    }
                    match e.error_len() {
                        // Some(n)：确凿的非法字节，替换掉继续扫后面。
                        // 不能留着等下一块——二进制输出会让它永远攒下去。
                        Some(n) => {
                            out.push('\u{FFFD}');
                            consumed += valid + n;
                        }
                        // None：尾部是不完整但**可能合法**的序列，留到下一块。
                        None => {
                            consumed += valid;
                            break;
                        }
                    }
                }
            }
        }
        self.pending.drain(..consumed);
        out
    }

    /// EOF 收尾：把最后剩下的残字节按 lossy 吐出来。
    ///
    /// 走到这里说明流已经结束，残字节再也等不到后续了，此时才该替换成 `U+FFFD`。
    pub fn flush(&mut self) -> String {
        if self.pending.is_empty() {
            return String::new();
        }
        let s = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归本体：一个中文字符被读取边界劈开，必须原样拼回，不能出 U+FFFD。
    #[test]
    fn split_multibyte_char_is_rejoined() {
        let bytes = "中".as_bytes(); // 3 字节
        let mut s = Utf8Stream::new();
        assert_eq!(s.push(&bytes[..1]), "", "只有首字节时不该吐任何东西");
        assert_eq!(s.push(&bytes[1..2]), "", "还差一个字节，仍不成型");
        assert_eq!(s.push(&bytes[2..]), "中");
        assert_eq!(s.flush(), "", "补齐后不应有残留");
    }

    /// 这条直接对着实测数据：纯中文按 4096 字节分块，一个 U+FFFD 都不许有。
    /// 修复前同样的输入会产出 15 个 U+FFFD（12000 字 → 12009 字）。
    #[test]
    fn chunked_chinese_stream_has_no_replacement_chars() {
        let text = "中文日志输出".repeat(2000);
        let bytes = text.as_bytes();
        let mut s = Utf8Stream::new();
        let mut out = String::new();
        for c in bytes.chunks(4096) {
            out.push_str(&s.push(c));
        }
        out.push_str(&s.flush());
        assert_eq!(out, text);
        assert_eq!(out.chars().count(), 12000);
        assert_eq!(out.matches('\u{FFFD}').count(), 0);
    }

    /// 真正非法的字节不能被无限期挂起，否则后面的合法文本永远出不来。
    #[test]
    fn genuine_garbage_is_replaced_not_buffered() {
        let mut s = Utf8Stream::new();
        let out = s.push(&[b'a', 0xff, 0xfe, b'b']);
        assert!(
            out.starts_with('a') && out.ends_with('b'),
            "两侧合法字符必须留下：{out:?}"
        );
        assert_eq!(out.matches('\u{FFFD}').count(), 2);
        assert_eq!(s.flush(), "", "非法字节不该被留到下一轮");
    }

    /// 残字节最多 3 个：反复喂「疑似不完整」的首字节也不能让缓冲无限增长。
    #[test]
    fn pending_never_grows_unbounded() {
        let mut s = Utf8Stream::new();
        for _ in 0..1000 {
            s.push(&[0xe4]); // 3 字节序列的首字节
        }
        assert!(s.pending.len() <= 3, "残字节缓冲失控：{}", s.pending.len());
    }

    /// ASCII 快路径不能改变行为（这是 99% 的输入）。
    #[test]
    fn ascii_passes_through_unchanged() {
        let mut s = Utf8Stream::new();
        assert_eq!(s.push(b"total 20\r\n"), "total 20\r\n");
        assert_eq!(s.flush(), "");
    }

    /// EOF 时仍挂着半个字符：只能在这一刻替换掉，不能吞掉。
    #[test]
    fn flush_emits_dangling_bytes_at_eof() {
        let mut s = Utf8Stream::new();
        assert_eq!(s.push(&"中".as_bytes()[..2]), "");
        assert_eq!(s.flush(), "\u{FFFD}");
        assert_eq!(s.flush(), "", "flush 后必须清空");
    }
}
