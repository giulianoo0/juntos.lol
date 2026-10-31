//! `lol.juntos.producer.NativeProducer`: init once, then every call is a method name and JSON.
use jni::objects::{JClass, JString};
use jni::sys::jstring;
use jni::JNIEnv;

use crate::Tools;

fn read(env: &mut JNIEnv, value: &JString) -> String {
    env.get_string(value).map(Into::into).unwrap_or_default()
}

#[no_mangle]
pub extern "system" fn Java_lol_juntos_producer_NativeProducer_init(
    mut env: JNIEnv,
    _class: JClass,
    data_dir: JString,
    site: JString,
    ffmpeg: JString,
    ffprobe: JString,
    ytdlp: JString,
    ytdlp_args: JString,
    ca_file: JString,
) {
    #[cfg(target_os = "android")]
    android_logger::init_once(android_logger::Config::default().with_tag("juntos-producer").with_max_level(log::LevelFilter::Info));
    let ca_file = read(&mut env, &ca_file);
    let tools = Tools {
        ffmpeg: read(&mut env, &ffmpeg),
        ffprobe: read(&mut env, &ffprobe),
        ytdlp: ss_remux::youtube::Config {
            ytdlp_path: read(&mut env, &ytdlp),
            ytdlp_args: serde_json::from_str(&read(&mut env, &ytdlp_args)).unwrap_or_default(),
            proxy: None,
            cookies_file: None,
            ca_file: (!ca_file.is_empty()).then(|| ca_file.into()),
        },
    };
    crate::init(read(&mut env, &data_dir).into(), read(&mut env, &site), tools);
}

#[no_mangle]
pub extern "system" fn Java_lol_juntos_producer_NativeProducer_call(
    mut env: JNIEnv,
    _class: JClass,
    method: JString,
    args: JString,
) -> jstring {
    let method = read(&mut env, &method);
    let args = read(&mut env, &args);
    let answer = crate::call(&method, &args);
    env.new_string(answer).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
}
