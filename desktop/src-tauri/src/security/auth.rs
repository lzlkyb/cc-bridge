use subtle::ConstantTimeEq;

/// token 长度上限（generate_token 固定产 32 字符，留足冒头）。
/// 超过此长度直接拒绝——这个分支只与固定常量比较，不泄露 expected 的任何信息。
const MAX_TOKEN_LEN: usize = 128;

/// 完全常量时间比较：之前实现在长度不等时提前 return，等长才进 ct_eq，存在长度侧信道（时序能区分"长度错"与"长度对但内容错"）。
/// 现把两侧均填充到固定缓冲区后总是跑完整的 ct_eq，最后再比一下长度整数（对两个小整数的相等比较不构成有意义的侧信道）。
pub fn verify_token(provided: &str, expected: &str) -> bool {
    let p_bytes = provided.as_bytes();
    let e_bytes = expected.as_bytes();
    if p_bytes.len() > MAX_TOKEN_LEN || e_bytes.len() > MAX_TOKEN_LEN {
        return false;
    }
    let mut p_buf = [0u8; MAX_TOKEN_LEN];
    let mut e_buf = [0u8; MAX_TOKEN_LEN];
    p_buf[..p_bytes.len()].copy_from_slice(p_bytes);
    e_buf[..e_bytes.len()].copy_from_slice(e_bytes);
    let bytes_eq: bool = p_buf.ct_eq(&e_buf).into();
    bytes_eq && p_bytes.len() == e_bytes.len()
}

pub fn generate_token() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..32)
        .map(|_| {
            let idx = rng.gen_range(0..36u8);
            if idx < 10 {
                (b'0' + idx) as char
            } else {
                (b'a' + idx - 10) as char
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_token() {
        assert!(verify_token("abc123", "abc123"));
    }

    #[test]
    fn test_invalid_token() {
        assert!(!verify_token("abc123", "xyz789"));
    }

    #[test]
    fn test_different_length() {
        assert!(!verify_token("short", "longer-token"));
    }
}
