//! Tool registry: the single source of truth for MCP tool routing + input schema.
//!
//! Replaces the hand-written `match` in `http.rs::dispatch_tool` and the hand-written
//! `json!` blocks in `http.rs::get_tool_definitions` (折中半程重构, see
//! `proposals/handwritten_dispatch_refactor_rfc.md`). Each tool self-describes via
//! `#[derive(ToolSchema)]` on its `XxxArgs` (schema auto-derived) plus one
//! `register_tool!` line here (name + description + write-flag). Adding a tool = write the
//! handler + one `register_tool!` line — no duplicated `match` arm or `json!` block.
//!
//! SECURITY: this module only routes. All gates (Bearer, rate-limit, read-only `WRITE_TOOLS`,
//! path whitelist) live OUTSIDE the registry — see `http.rs` and each handler. No gate is
//! weakened here.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;

use crate::state::AppState;

/// Boxed future alias used by tool runners.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Dispatch entry signature (identical to the old `dispatch_tool`, so `batch`'s internal
/// call is unaffected). Higher-ranked over the state reference lifetime.
pub type ToolRunner = for<'a> fn(Value, &'a Arc<AppState>) -> BoxFuture<'a, Result<Value, String>>;

/// A registered MCP tool: how to dispatch it + what schema to advertise.
pub struct ToolSpec {
    pub name: &'static str,
    pub desc: &'static str,
    /// Declared write-flag. This is the single source of truth for the read-only-mode gate:
    /// `http.rs::dispatch_tool` derives its write-tool set from `all_tools()` at runtime
    /// (cached via `OnceLock`), so adding a write tool here automatically enforces
    /// read-only mode — there is no parallel `WRITE_TOOLS` constant to keep in sync.
    pub is_write: bool,
    pub schema: Value,
    /// Dispatch entry. Signature is intentionally identical to the old `dispatch_tool`
    /// so `batch` (which calls `dispatch_tool` internally) is unaffected.
    pub run: ToolRunner,
}

/// Register one tool. Expands to a `ToolSpec` whose runner deserializes `args` into the
/// tool's `XxxArgs` and calls its `handle`. Schema comes from the derived `ToolSchema`.
macro_rules! register_tool {
    ($module:ident, $args:ident, $desc:expr, $is_write:expr $(,)?) => {{
        fn __run(
            args: ::serde_json::Value,
            state: &::std::sync::Arc<crate::state::AppState>,
        ) -> BoxFuture<'_, ::std::result::Result<::serde_json::Value, String>> {
            Box::pin(async move {
                let parsed: crate::mcp::tools::$module::$args =
                    ::serde_json::from_value(args).map_err(|e| e.to_string())?;
                crate::mcp::tools::$module::handle(parsed, state).await
            })
        }
        ToolSpec {
            name: stringify!($module),
            desc: $desc,
            is_write: $is_write,
            schema: crate::mcp::tools::$module::$args::schema(),
            run: __run,
        }
    }};
}

/// All registered tools. The ONLY place that lists tools — one line per tool.
/// Returns an owned `Vec` because `schema` is derived at runtime (not a `&'static`).
pub fn all_tools() -> Vec<ToolSpec> {
    vec![
        register_tool!(
            list_allowed_roots,
            ListAllowedRootsArgs,
            r#"List the server's access whitelist (allowed root directories, allowed file extensions, max file size). If an allowed root has a top-level CLAUDE.md, its content is inlined under projectInstructions (or a path pointer if it exceeds the size cap). Call this FIRST to discover accessible directories and pick up project rules before attempting any file operation."#,
            false
        ),
        register_tool!(
            list_directory,
            ListDirectoryArgs,
            r#"List directory contents with optional recursion and depth limit"#,
            false
        ),
        register_tool!(
            read_files,
            ReadFilesArgs,
            r#"Read one or more files, optionally by line range (1-based, inclusive). Returns UTF-8 text plus the detected encoding and newline style. Encoding auto-detection (GBK/GB18030 heuristic) is a server-side toggle, OFF by default (reads as UTF-8); pass `encoding` (e.g. "gbk") to force a specific decoding regardless of the toggle."#,
            false
        ),
        register_tool!(
            write_files,
            WriteFilesArgs,
            r#"Write or create files. Automatically creates parent directories and backs up before overwriting. Encoding: omit `encoding` and — when overwriting an EXISTING file with server-side encoding auto-detection ON — the file's original encoding is detected and preserved (a GBK file stays GBK instead of being silently converted to UTF-8); otherwise defaults to utf8. Pass `encoding` (e.g. "gbk", "gb18030", "utf-16le") to force a specific on-disk encoding, or "base64" to write raw binary from a base64 string."#,
            true
        ),
        register_tool!(
            edit_files,
            EditFilesArgs,
            r#"Edit files in place by exact string replacement (like native Edit). For each file, `oldString` must match EXACTLY ONCE unless `replaceAll` is true — include enough surrounding context to be unique. Preserves the file's original encoding (a GBK file stays GBK). Backs up before writing. Far cheaper than rewriting whole files with write_files."#,
            true
        ),
        register_tool!(
            create_directory,
            CreateDirectoryArgs,
            r#"Create a directory (and any missing parents). Idempotent: succeeds if it already exists."#,
            true
        ),
        register_tool!(
            remove_directory,
            RemoveDirectoryArgs,
            r#"Remove a directory. By default only removes an EMPTY directory (fails if non-empty). Set recursive=true to delete the entire tree — DANGEROUS, this permanently removes all contents and is not backed up."#,
            true
        ),
        register_tool!(
            delete_files,
            DeleteFilesArgs,
            r#"Delete files (not directories). Backs up before deletion."#,
            true
        ),
        register_tool!(
            move_files,
            MoveFilesArgs,
            r#"Move/rename files with cross-device fallback"#,
            true
        ),
        register_tool!(
            copy_files,
            CopyFilesArgs,
            r#"Copy files, backing up destination if it exists"#,
            true
        ),
        register_tool!(
            search_files,
            SearchFilesArgs,
            r#"Search files by name glob and/or content regex with context lines"#,
            false
        ),
        register_tool!(
            batch,
            BatchArgs,
            r#"Run multiple cc-bridge tool calls in ONE round trip. Prefer this whenever you need several file operations together (e.g. read many files then edit several, or search then read matches) — it collapses N network round trips into 1, the single biggest latency win over a remote link. Each operation reuses the same security checks as calling the tool directly (read-only mode, path whitelist). Nested batch is not allowed. Non-transactional: when stopOnError is true (default), execution halts on the first failing operation but operations that already completed (including any writes) are NOT rolled back."#,
            false
        ),
        register_tool!(
            notebook_edit,
            NotebookEditArgs,
            r#"Edit a Jupyter notebook (.ipynb): replace/insert/delete a cell by index. Writes the modified notebook back, preserving other metadata."#,
            true
        ),
        register_tool!(
            analyze_file,
            AnalyzeFileArgs,
            r#"Analyze a file: encoding, language, line/function/class counts (heuristic)"#,
            false
        ),
        register_tool!(
            run_command,
            RunCommandArgs,
            r#"Execute a shell command in a whitelisted cwd. The shell is `cmd` by default; if the operator set `shell_type=bash` in config, commands run in Git Bash — use POSIX `/c/...` paths and bash syntax (jq/find/pipes work natively). DANGEROUS: equivalent to granting the caller arbitrary code execution — disabled by default via the `shell_enabled` config toggle, and blocked entirely in read-only mode. Foreground mode (background=false, default) waits up to timeoutMs and returns stdout/stderr/exitCode. Background mode (background=true) returns immediately with a handle; poll it via get_command_output and end it via stop_command. If session cwd persistence is enabled (operator must turn it on), pass `cwd` on the first call to receive a `sessionId`; on later calls pass that `sessionId` instead of `cwd` to keep working in the same directory — `cd` inside a command now carries over to the next call (re-validated against the whitelist each time). If persistence is disabled (default), you must pass an absolute `cwd` every call."#,
            true
        ),
        register_tool!(
            get_command_output,
            GetCommandOutputArgs,
            r#"Incrementally fetch stdout/stderr of a background command started by run_command(background=true). Pass stdoutOffset/stderrOffset (bytes already consumed) to get only new output since the last call."#,
            false
        ),
        register_tool!(
            stop_command,
            StopCommandArgs,
            r#"Forcefully terminate a background command's entire process tree (taskkill /T) and remove it from the registry."#,
            false
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Single traversal over the registry: guards schema auto-derivation via pure
    /// invariants (no hardcoded tool count — adding/removing a tool needs no assertion
    /// bump here, only a `register_tool!` line in `all_tools()`; see G4 in
    /// 功能优化清单.md and proposals/handwritten_dispatch_refactor_rfc.md).
    #[test]
    fn registry_has_expected_count_and_schemas() {
        let tools = all_tools();

        // 1) Registry is non-empty (catches an accidentally-emptied all_tools()).
        assert!(!tools.is_empty(), "tool registry must not be empty");

        // 2) Every tool: non-empty name + description + an object schema with a
        //    `properties` object (may legitimately be empty — e.g. list_allowed_roots
        //    takes no args). Type must always be "object".
        for t in &tools {
            assert!(!t.name.is_empty(), "tool name must not be empty");
            assert!(
                !t.desc.is_empty(),
                "tool {name} description must not be empty",
                name = t.name
            );
            t.schema
                .get("properties")
                .and_then(|p| p.as_object())
                .unwrap_or_else(|| panic!("tool {} schema missing 'properties'", t.name));
            // Type must be object (the derive always emits type:"object" for structs).
            assert_eq!(
                t.schema.get("type").and_then(|v| v.as_str()),
                Some("object"),
                "tool {} schema type must be 'object'",
                t.name
            );
        }
        // 3) Names must be unique — a duplicate register_tool! line (copy-paste error)
        //    would silently shadow one tool via `.find(|t| t.name == name)` in dispatch_tool.
        let mut names: Vec<&str> = tools.iter().map(|t| t.name).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(
            names.len(),
            tools.len(),
            "duplicate tool name registered (register_tool! copy-paste error)"
        );

        // 4) serde(rename) derivation: the schema key must follow the rename, not the
        //    Rust field name. This catches a broken derive (the #1 regression risk).
        let run_cmd = tools
            .iter()
            .find(|t| t.name == "run_command")
            .expect("run_command must be registered");
        let run_props = run_cmd
            .schema
            .get("properties")
            .unwrap()
            .as_object()
            .unwrap();
        assert!(
            run_props.contains_key("sessionId"),
            "run_command schema must expose serde-rename 'sessionId' (got: {:?})",
            run_props.keys().collect::<Vec<_>>()
        );
        // sessionId is `Option<String>` (and #[serde(default)]) -> must NOT be required.
        let run_required = run_cmd
            .schema
            .get("required")
            .and_then(|r| r.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>())
            .unwrap_or_default();
        assert!(
            !run_required.contains(&"sessionId"),
            "sessionId is Option -> must NOT be in 'required'"
        );

        let list_dir = tools
            .iter()
            .find(|t| t.name == "list_directory")
            .expect("list_directory must be registered");
        let list_props = list_dir
            .schema
            .get("properties")
            .unwrap()
            .as_object()
            .unwrap();
        assert!(
            list_props.contains_key("maxDepth"),
            "list_directory schema must expose serde-rename 'maxDepth' (got: {:?})",
            list_props.keys().collect::<Vec<_>>()
        );
        // maxDepth is #[serde(default=...)] -> must NOT be required.
        let list_required = list_dir
            .schema
            .get("required")
            .and_then(|r| r.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>())
            .unwrap_or_default();
        assert!(
            !list_required.contains(&"maxDepth"),
            "maxDepth has serde(default) -> must NOT be in 'required'"
        );
    }
}
