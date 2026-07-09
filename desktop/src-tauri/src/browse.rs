use std::path::Path;

use serde::Serialize;

use crate::security::path::display_path;

#[derive(Debug, Serialize)]
pub struct BrowseEntry {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct BrowseResult {
    pub path: Option<String>,
    pub parent: Option<String>,
    pub entries: Vec<BrowseEntry>,
}

pub fn list_browse_roots() -> Vec<BrowseEntry> {
    #[cfg(windows)]
    {
        let mut roots = Vec::new();
        for letter in b'A'..=b'Z' {
            let drive = format!("{}:\\", letter as char);
            if Path::new(&drive).exists() {
                roots.push(BrowseEntry {
                    name: drive.clone(),
                    path: drive,
                });
            }
        }
        roots
    }
    #[cfg(not(windows))]
    {
        vec![BrowseEntry {
            name: "/".into(),
            path: "/".into(),
        }]
    }
}

pub async fn browse_directory(input_path: Option<&str>) -> Result<BrowseResult, String> {
    let path_str = match input_path {
        None | Some("") => {
            return Ok(BrowseResult {
                path: None,
                parent: None,
                entries: list_browse_roots(),
            });
        }
        Some(p) => p,
    };

    let normalized = Path::new(path_str);
    let real =
        std::fs::canonicalize(normalized).map_err(|e| format!("目录不存在或不可访问: {e}"))?;

    let metadata = std::fs::metadata(&real).map_err(|e| format!("Cannot stat: {e}"))?;
    if !metadata.is_dir() {
        return Err("不是一个目录".into());
    }

    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(&real).map_err(|e| format!("无法读取目录: {e}"))?;

    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if !ft.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let full_path = real.join(&name);
        entries.push(BrowseEntry {
            name,
            path: display_path(&full_path),
        });
    }

    entries.sort_by(|a, b| a.name.cmp(&b.name));

    let parent_dir = real.parent();
    let is_root = parent_dir.map(|p| p == real).unwrap_or(true);

    Ok(BrowseResult {
        path: Some(display_path(&real)),
        parent: if is_root {
            None
        } else {
            parent_dir.map(display_path)
        },
        entries,
    })
}
