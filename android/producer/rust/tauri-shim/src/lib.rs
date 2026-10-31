//! The one piece of Tauri the desktop's producer modules use: spawning onto the app's runtime.
pub mod async_runtime {
    use std::future::Future;
    use std::sync::OnceLock;

    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

    pub fn runtime() -> &'static tokio::runtime::Runtime {
        RUNTIME.get_or_init(|| tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime"))
    }

    pub fn spawn<F>(future: F) -> tokio::task::JoinHandle<F::Output>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        runtime().spawn(future)
    }
}
