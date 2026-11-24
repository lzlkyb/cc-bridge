fn main() {
    tauri_build::build();
    // tauri-build 只把资源嵌进 bins；lib 单测 exe 没有 Common-Controls v6 manifest，
    // rfd/muda 引用的 TaskDialogIndirect 在 v5 comctl32 里找不到（0xc0000139）。
    // /MANIFESTDEPENDENCY 让链接器给所有目标生成含 comctl v6 的 manifest（bins 已有
    // tauri 内嵌 manifest，优先生效、不受影响）。不能用 /MANIFEST:EMBED 或再链一份
    // resource.lib——会与 bins 的资源 manifest 撞 CVT1100 资源重复。
    #[cfg(windows)]
    println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
}
