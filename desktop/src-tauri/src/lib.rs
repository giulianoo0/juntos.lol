pub mod cache;
pub mod hls;
pub mod site;

pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("tauri");
}
