use subtle::ConstantTimeEq;

pub fn verify_token(provided: &str, expected: &str) -> bool {
    if provided.len() != expected.len() {
        return false;
    }
    provided.as_bytes().ct_eq(expected.as_bytes()).into()
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
