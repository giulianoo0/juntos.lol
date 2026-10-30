/// Every command the site may call, one per line of commands.txt; each
/// becomes an `allow-<name>` permission that the runtime capability grants to
/// the site's origin only (see `site_permissions` in src/lib.rs).
const COMMANDS: &str = include_str!("commands.txt");

fn main() {
    println!("cargo:rerun-if-changed=commands.txt");
    let commands: Vec<&'static str> = COMMANDS.lines().filter(|line| !line.is_empty()).collect();
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(commands.leak())))
        .expect("tauri build");
}
