pub mod cache;
pub mod hls;
pub mod local;
pub mod serve;
pub mod site;
pub mod upload_plan;

pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("tauri");
}
