fn main() {
    // Android loads the app as a shared library, which Android 15 and later map in 16 KB pages
    // on the phones that have them, and Google Play requires of every new app: the linker aligns
    // the library's segments to 16 KB. NDK 27 still aligns to 4 KB by itself.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-arg-cdylib=-Wl,-z,max-page-size=16384");
    }
    // The app's own commands (src/endpoint.rs) are permissions like a plugin's, which only the
    // capabilities that name them grant (capabilities/start-page.json): without the manifest every
    // window could call every command.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "workspace_address",
            "parse_workspace_address",
            "set_workspace_address",
        ]),
    ))
    .expect("tauri-build failed");
}
