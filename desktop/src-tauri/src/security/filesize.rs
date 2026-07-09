use std::path::Path;

pub fn assert_file_size_ok(file_path: &Path, max_bytes: u64) -> Result<(), String> {
    let metadata =
        std::fs::metadata(file_path).map_err(|e| format!("Cannot read file metadata: {e}"))?;

    if metadata.len() > max_bytes {
        return Err(format!(
            "File size {} bytes exceeds limit of {} bytes",
            metadata.len(),
            max_bytes
        ));
    }

    Ok(())
}
