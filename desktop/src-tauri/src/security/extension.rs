use std::path::Path;

pub fn assert_extension_allowed(
    file_path: &Path,
    allowed_extensions: &[String],
) -> Result<(), String> {
    if allowed_extensions.is_empty() {
        return Ok(());
    }

    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e.to_lowercase()));

    match ext {
        Some(ext) if allowed_extensions.iter().any(|a| a.to_lowercase() == ext) => Ok(()),
        Some(ext) => Err(format!("Extension '{ext}' is not in the allowed list")),
        None => Err("File has no extension".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_allowed_extension() {
        let allowed = vec![".js".into(), ".ts".into()];
        assert!(assert_extension_allowed(&PathBuf::from("test.js"), &allowed).is_ok());
        assert!(assert_extension_allowed(&PathBuf::from("test.exe"), &allowed).is_err());
    }

    #[test]
    fn test_empty_whitelist_allows_all() {
        assert!(assert_extension_allowed(&PathBuf::from("test.exe"), &[]).is_ok());
    }
}
