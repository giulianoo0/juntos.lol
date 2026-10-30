pub mod site;

pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("tauri");
}
