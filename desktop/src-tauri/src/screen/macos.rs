//! macOS: ScreenCaptureKit into the hardware H.264 encoder (VideoToolbox), and
//! the system's sound through ScreenCaptureKit minus the muted apps.

use std::collections::HashMap;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use base64::Engine;
use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchRetained};
use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::{AnyClass, AnyObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, sel, AnyThread, DefinedClass};
use objc2_app_kit::{NSApplicationActivationPolicy, NSBitmapImageFileType, NSBitmapImageRep, NSImageCompressionFactor, NSRunningApplication};
use objc2_core_audio_types::{kAudioFormatFlagIsFloat, kAudioFormatLinearPCM, AudioBuffer, AudioBufferList};
use objc2_core_foundation::{CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{CGDisplayCopyDisplayMode, CGDisplayMode, CGImage, CGMainDisplayID, CGWindowListCopyWindowInfo, CGWindowListOption};
use objc2_core_media::{
    kCMSampleAttachmentKey_NotSync, kCMTimeInvalid, kCMVideoCodecType_H264, CMAudioFormatDescriptionGetStreamBasicDescription, CMBlockBuffer,
    CMFormatDescription, CMSampleBuffer, CMTime, CMVideoFormatDescriptionGetH264ParameterSetAtIndex,
};
use objc2_core_video::{kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, CVImageBuffer};
use objc2_foundation::{NSArray, NSDictionary, NSError, NSNumber, NSPoint, NSRect, NSSize};
use objc2_screen_capture_kit::{
    SCContentFilter, SCDisplay, SCRunningApplication, SCScreenshotManager, SCShareableContent, SCStream, SCStreamConfiguration, SCStreamDelegate,
    SCStreamOutput, SCStreamOutputType, SCWindow,
};
use objc2_video_toolbox::{
    kVTCompressionPropertyKey_AllowFrameReordering, kVTCompressionPropertyKey_AverageBitRate, kVTCompressionPropertyKey_ExpectedFrameRate,
    kVTCompressionPropertyKey_MaxKeyFrameInterval, kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, kVTCompressionPropertyKey_ProfileLevel,
    kVTCompressionPropertyKey_RealTime, kVTEncodeFrameOptionKey_ForceKeyFrame, kVTProfileLevel_H264_High_AutoLevel,
    kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder, VTCompressionSession, VTEncodeInfoFlags, VTSession, VTSessionSetProperty,
};
use parking_lot::Mutex;

use super::{
    app_id, frame, ours, AudioApp, Display, Muted, Proc, Quality, Sink, Sources, Started, Target, TargetKind, Window, BLOCK_FRAMES, ENDED, KEYFRAME,
    SAMPLE_RATE,
};

const CHANNELS: usize = 2;
const BLOCK: usize = BLOCK_FRAMES * CHANNELS;
/// Keyframe at least this often, so a late viewer waits little.
const KEYFRAME_EVERY: Duration = Duration::from_secs(2);
const RESCAN: Duration = Duration::from_secs(2);
/// How often a shared window is looked up to see that it still exists.
const WINDOW_CHECK: Duration = Duration::from_millis(500);
/// A forced keyframe that has not come out by then is asked for again.
const KEYFRAME_WAIT: Duration = Duration::from_millis(500);
const ICON_SIZE: u32 = 64;

pub fn sources() -> Result<Sources, String> {
    autoreleasepool(|_| list_sources())
}

fn list_sources() -> Result<Sources, String> {
    let content = shareable(true)?;
    let main = CGMainDisplayID();
    let mut displays = unsafe { content.displays() }.to_vec();
    // The main display first: it is the one people mean by "the screen".
    displays.sort_by_key(|d| unsafe { d.displayID() } != main);
    let displays = displays
        .iter()
        .enumerate()
        .map(|(n, d)| {
            let (width, height) = display_pixels(d);
            Display { id: unsafe { d.displayID() }.to_string(), name: format!("Tela {}", n + 1), width, height }
        })
        .collect();
    let me = std::process::id();
    let windows = unsafe { content.windows() }
        .iter()
        .filter_map(|w| unsafe {
            let title = w.title().map(|t| t.to_string()).unwrap_or_default();
            let app = w.owningApplication()?;
            let size = w.frame().size;
            if title.is_empty() || w.windowLayer() != 0 || size.width < 64.0 || size.height < 64.0 {
                return None;
            }
            let pid = app.processID() as u32;
            if pid == me || responsible(pid) == me {
                return None;
            }
            Some(Window { id: w.windowID().to_string(), title, app: app.applicationName().to_string(), icon: icon(pid) })
        })
        .collect();
    Ok(Sources { displays, windows })
}

pub fn thumbnail(target: &Target, width: u32) -> Result<String, String> {
    autoreleasepool(|_| take_thumbnail(target, width))
}

fn take_thumbnail(target: &Target, width: u32) -> Result<String, String> {
    if AnyClass::get(c"SCScreenshotManager").is_none() {
        return Err("unsupported: thumbnails need macOS 14".into());
    }
    let content = shareable(false)?;
    let (filter, source) = content_filter(&content, target)?;
    let height = ((source.1 as f64) * (width as f64) / (source.0.max(1) as f64)).round().max(2.0) as usize;
    let (tx, rx) = mpsc::channel::<Result<Owned<CFRetained<CGImage>>, String>>();
    let done = RcBlock::new(move |image: *mut CGImage, error: *mut NSError| {
        let _ = tx.send(match unsafe { image.as_ref() } {
            Some(image) => Ok(Owned(unsafe { CFRetained::retain(NonNull::from(image)) })),
            None => Err(error_text(error)),
        });
    });
    unsafe {
        let config = SCStreamConfiguration::new();
        config.setWidth(width as usize);
        config.setHeight(height);
        config.setShowsCursor(false);
        SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(&filter, &config, Some(&done));
    }
    let image = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "capture_failed: thumbnail timed out".to_string())?
        .map_err(|e| format!("capture_failed: {e}"))?;
    let bitmap = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &image.0);
    let quality = NSNumber::new_f64(0.72);
    let properties = NSDictionary::from_slices(&[unsafe { NSImageCompressionFactor }], &[&*quality as &AnyObject]);
    let jpeg = unsafe { bitmap.representationUsingType_properties(NSBitmapImageFileType::JPEG, &properties) }.ok_or("capture_failed: thumbnail")?;
    Ok(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpeg.to_vec())))
}

pub fn audio_apps() -> Result<Vec<AudioApp>, String> {
    autoreleasepool(|_| list_audio_apps())
}

fn list_audio_apps() -> Result<Vec<AudioApp>, String> {
    let content = shareable(false)?;
    let procs: Vec<Proc> = unsafe { content.applications() }.iter().map(|app| proc_of(unsafe { app.processID() } as u32)).collect();
    // Apps with a Dock icon of their own; a helper's sound is its app's.
    let sessions: Vec<Proc> = procs
        .iter()
        .filter(|p| p.parent == 0)
        .filter(|p| running(p.pid).is_some_and(|app| app.activationPolicy() == NSApplicationActivationPolicy::Regular))
        .cloned()
        .collect();
    let pids: HashMap<&str, u32> = sessions.iter().map(|p| (p.id.as_str(), p.pid)).collect();
    Ok(super::audible(&sessions, &procs)
        .into_iter()
        .map(|app| {
            let pid = pids[app.id.as_str()];
            let name = running(pid).and_then(|a| a.localizedName()).map(|n| n.to_string()).unwrap_or(app.name);
            AudioApp { name, icon: icon(pid), id: app.id }
        })
        .collect())
}

extern "C" {
    // libSystem: the app a helper (an Electron renderer, a WebKit process)
    // works for, the same one the privacy prompts name.
    fn responsibility_get_pid_responsible_for_pid(pid: libc::pid_t) -> libc::pid_t;
}

fn responsible(pid: u32) -> u32 {
    let owner = unsafe { responsibility_get_pid_responsible_for_pid(pid as libc::pid_t) };
    if owner > 0 {
        owner as u32
    } else {
        pid
    }
}

fn exe_path(pid: u32) -> Option<String> {
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let len = unsafe { libc::proc_pidpath(pid as i32, buf.as_mut_ptr() as *mut c_void, buf.len() as u32) };
    (len > 0).then(|| String::from_utf8_lossy(&buf[..len as usize]).into_owned())
}

/// A process under the id of the app responsible for it, so a helper reads
/// as its app. The sound filter can only leave out apps ScreenCaptureKit
/// lists, and leans on it to count a helper's sound as its app's.
fn proc_of(pid: u32) -> Proc {
    let owner = responsible(pid);
    let exe = exe_path(owner).unwrap_or_default();
    let name = exe.rsplit('/').next().unwrap_or_default().to_string();
    Proc { pid, parent: if owner != pid { owner } else { 0 }, id: app_id(&exe), name }
}

pub(super) fn running(pid: u32) -> Option<Retained<NSRunningApplication>> {
    NSRunningApplication::runningApplicationWithProcessIdentifier(pid as libc::pid_t)
}

/// The app's icon at 64 px, as a PNG data URL.
fn icon(pid: u32) -> Option<String> {
    static ICONS: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    let key = exe_path(responsible(pid))?;
    let icons = ICONS.get_or_init(Default::default);
    if let Some(icon) = icons.lock().get(&key) {
        return icon.clone();
    }
    let icon = autoreleasepool(|_| draw_icon(pid));
    icons.lock().insert(key, icon.clone());
    icon
}

fn draw_icon(pid: u32) -> Option<String> {
    let image = running(responsible(pid))?.icon()?;
    let mut rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(ICON_SIZE as f64, ICON_SIZE as f64));
    let cg = unsafe { image.CGImageForProposedRect_context_hints(&mut rect, None, None) }?;
    let bitmap = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &cg);
    let png = unsafe { bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }?;
    // A Retina rep comes back at 128 px or more.
    let pixels = image::load_from_memory(&png.to_vec()).ok()?.to_rgba8();
    let small = if pixels.width() > ICON_SIZE || pixels.height() > ICON_SIZE {
        image::imageops::resize(&pixels, ICON_SIZE, ICON_SIZE, image::imageops::FilterType::Lanczos3)
    } else {
        pixels
    };
    let mut out = std::io::Cursor::new(Vec::new());
    small.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(out.into_inner())))
}

fn display_pixels(display: &SCDisplay) -> (u32, u32) {
    let id = unsafe { display.displayID() };
    let mode = CGDisplayCopyDisplayMode(id);
    let (w, h) = (CGDisplayMode::pixel_width(mode.as_deref()), CGDisplayMode::pixel_height(mode.as_deref()));
    if w > 0 && h > 0 {
        (w as u32, h as u32)
    } else {
        unsafe { (display.width() as u32, display.height() as u32) }
    }
}

/// An object made on one thread and handed to another; these are immutable
/// once made.
struct Owned<T>(T);
unsafe impl<T> Send for Owned<T> {}

fn error_text(error: *mut NSError) -> String {
    unsafe { error.as_ref() }.map(|e| e.localizedDescription().to_string()).unwrap_or_else(|| "unknown error".into())
}

fn shareable(on_screen_only: bool) -> Result<Retained<SCShareableContent>, String> {
    if AnyClass::get(c"SCShareableContent").is_none() {
        return Err("unsupported: screen capture needs macOS 12.3".into());
    }
    let (tx, rx) = mpsc::channel::<Result<Owned<Retained<SCShareableContent>>, String>>();
    let done = RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
        let _ = tx.send(match unsafe { Retained::retain(content) } {
            Some(content) => Ok(Owned(content)),
            None => Err(error_text(error)),
        });
    });
    unsafe {
        if on_screen_only {
            SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(true, true, &done);
        } else {
            SCShareableContent::getShareableContentWithCompletionHandler(&done);
        }
    }
    let content = rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "capture_failed: listing what can be shared timed out".to_string())?;
    content.map(|c| c.0).map_err(|e| format!("permission: {e}"))
}

/// The filter for a target, and the source's size for its shape.
fn content_filter(content: &SCShareableContent, target: &Target) -> Result<(Retained<SCContentFilter>, (u32, u32)), String> {
    let id: u32 = target.id.parse().map_err(|_| "not_found: bad id")?;
    unsafe {
        match target.kind {
            TargetKind::Display => {
                let display = content.displays().iter().find(|d| d.displayID() == id).ok_or("not_found: display")?;
                let filter = SCContentFilter::initWithDisplay_excludingWindows(SCContentFilter::alloc(), &display, &NSArray::<SCWindow>::new());
                Ok((filter, display_pixels(&display)))
            }
            TargetKind::Window => {
                let window = content.windows().iter().find(|w| w.windowID() == id).ok_or("not_found: window")?;
                let size = window.frame().size;
                let filter = SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &window);
                Ok((filter, (size.width.max(1.0) as u32, size.height.max(1.0) as u32)))
            }
        }
    }
}

fn start_stream(stream: &SCStream) -> Result<(), String> {
    let (tx, rx) = mpsc::channel::<Option<String>>();
    let done = RcBlock::new(move |error: *mut NSError| {
        let _ = tx.send((!error.is_null()).then(|| error_text(error)));
    });
    unsafe { stream.startCaptureWithCompletionHandler(Some(&done)) };
    match rx.recv_timeout(Duration::from_secs(10)) {
        Ok(None) => Ok(()),
        Ok(Some(e)) => Err(format!("permission: {e}")),
        Err(_) => Err("capture_failed: the capture did not start".into()),
    }
}

fn stop_stream(stream: &SCStream) {
    let (tx, rx) = mpsc::channel::<()>();
    let done = RcBlock::new(move |_: *mut NSError| {
        let _ = tx.send(());
    });
    unsafe { stream.stopCaptureWithCompletionHandler(Some(&done)) };
    let _ = rx.recv_timeout(Duration::from_secs(2));
}

struct Picture(CFRetained<CVImageBuffer>);
// A finished picture nobody writes to again.
unsafe impl Send for Picture {}

define_class!(
    #[unsafe(super(objc2::runtime::NSObject))]
    #[name = "JuntosScreenVideoOutput"]
    #[ivars = Arc<Mutex<Option<Picture>>>]
    struct VideoOutput;

    unsafe impl NSObjectProtocol for VideoOutput {}

    unsafe impl SCStreamOutput for VideoOutput {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        unsafe fn stream_did_output(&self, _stream: &SCStream, sample: &CMSampleBuffer, kind: SCStreamOutputType) {
            // A still screen comes as frames without a picture: the last one stays.
            if kind == SCStreamOutputType::Screen {
                if let Some(image) = unsafe { sample.image_buffer() } {
                    *self.ivars().lock() = Some(Picture(image));
                }
            }
        }
    }
);

define_class!(
    #[unsafe(super(objc2::runtime::NSObject))]
    #[name = "JuntosScreenWatch"]
    #[ivars = Arc<AtomicBool>]
    struct Watch;

    unsafe impl NSObjectProtocol for Watch {}

    unsafe impl SCStreamDelegate for Watch {
        #[unsafe(method(stream:didStopWithError:))]
        unsafe fn stream_did_stop(&self, _stream: &SCStream, error: &NSError) {
            tracing::info!(error = %error.localizedDescription(), "screen capture stopped");
            self.ivars().store(true, Ordering::Release);
        }
    }
);

define_class!(
    #[unsafe(super(objc2::runtime::NSObject))]
    #[name = "JuntosScreenAudioOutput"]
    #[ivars = Arc<Mutex<Vec<i16>>>]
    struct AudioOutput;

    unsafe impl NSObjectProtocol for AudioOutput {}

    unsafe impl SCStreamOutput for AudioOutput {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        unsafe fn stream_did_output(&self, _stream: &SCStream, sample: &CMSampleBuffer, kind: SCStreamOutputType) {
            if kind != SCStreamOutputType::Audio {
                return;
            }
            if let Some(samples) = unsafe { decode(sample) } {
                let mut pending = self.ivars().lock();
                pending.extend_from_slice(&samples);
                // Nobody draining for a second: the oldest goes, not the newest.
                let over = pending.len().saturating_sub(SAMPLE_RATE as usize * CHANNELS);
                pending.drain(..over);
            }
        }
    }
);

impl VideoOutput {
    fn new(latest: Arc<Mutex<Option<Picture>>>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(latest);
        unsafe { msg_send![super(this), init] }
    }
}

impl Watch {
    fn new(closed: Arc<AtomicBool>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(closed);
        unsafe { msg_send![super(this), init] }
    }
}

impl AudioOutput {
    fn new(pending: Arc<Mutex<Vec<i16>>>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(pending);
        unsafe { msg_send![super(this), init] }
    }
}


struct Capture {
    stream: Retained<SCStream>,
    _output: Retained<VideoOutput>,
    _watch: Retained<Watch>,
    _queue: DispatchRetained<DispatchQueue>,
    latest: Arc<Mutex<Option<Picture>>>,
    closed: Arc<AtomicBool>,
    window: Option<u32>,
    checked: Instant,
}

impl Drop for Capture {
    fn drop(&mut self) {
        stop_stream(&self.stream);
    }
}

impl Capture {
    fn open(target: &Target, output: (u32, u32), fps: u32) -> Result<Capture, String> {
        let content = shareable(false)?;
        let (filter, source) = content_filter(&content, target)?;
        let (x, y, w, h) = letterbox(source, output);
        let latest = Arc::new(Mutex::new(None));
        let closed = Arc::new(AtomicBool::new(false));
        let video = VideoOutput::new(latest.clone());
        let watch = Watch::new(closed.clone());
        let queue = DispatchQueue::new("lol.juntos.screen.video", None);
        unsafe {
            let config = SCStreamConfiguration::new();
            // Always the quality's size: a source of another shape gets bars.
            config.setWidth(output.0 as usize);
            config.setHeight(output.1 as usize);
            config.setScalesToFit(true);
            config.setDestinationRect(CGRect::new(CGPoint::new(x as f64, y as f64), CGSize::new(w as f64, h as f64)));
            if config.respondsToSelector(sel!(setPreservesAspectRatio:)) {
                config.setPreservesAspectRatio(true);
            }
            config.setMinimumFrameInterval(CMTime::new(1, fps as i32));
            config.setPixelFormat(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange);
            config.setShowsCursor(true);
            config.setQueueDepth(5);
            let stream = SCStream::initWithFilter_configuration_delegate(SCStream::alloc(), &filter, &config, Some(ProtocolObject::from_ref(&*watch)));
            stream
                .addStreamOutput_type_sampleHandlerQueue_error(ProtocolObject::from_ref(&*video), SCStreamOutputType::Screen, Some(&queue))
                .map_err(|e| format!("capture_failed: {}", e.localizedDescription()))?;
            start_stream(&stream)?;
            let window = matches!(target.kind, TargetKind::Window).then(|| target.id.parse().ok()).flatten();
            Ok(Capture { stream, _output: video, _watch: watch, _queue: queue, latest, closed, window, checked: Instant::now() })
        }
    }

    /// A closed window often just stops sending pictures, without the delegate hearing of it, so it is also looked up.
    fn ended(&mut self) -> bool {
        if self.closed.load(Ordering::Acquire) {
            return true;
        }
        let Some(id) = self.window else { return false };
        if self.checked.elapsed() < WINDOW_CHECK {
            return false;
        }
        self.checked = Instant::now();
        CGWindowListCopyWindowInfo(CGWindowListOption::OptionIncludingWindow, id).is_none_or(|list| list.count() == 0)
    }
}

type Handler = RcBlock<dyn Fn(i32, VTEncodeInfoFlags, *mut CMSampleBuffer)>;

struct Encoder {
    session: CFRetained<VTCompressionSession>,
    handler: Handler,
    /// Pictures the encoder failed or dropped after taking them, in a row.
    failed: Arc<AtomicU32>,
    keyframe_out: Arc<AtomicBool>,
    width: u32,
    height: u32,
    fps: u32,
}

impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe {
            self.session.complete_frames(kCMTimeInvalid);
            self.session.invalidate();
        }
    }
}

fn set(session: &VTSession, key: &CFString, value: &CFType) -> Result<(), String> {
    match unsafe { VTSessionSetProperty(session, key, Some(value)) } {
        0 => Ok(()),
        status => Err(format!("capture_failed: encoder refused {key} ({status})")),
    }
}

impl Encoder {
    fn new(width: u32, height: u32, fps: u32, bitrate: u32, sink: Sink) -> Result<Encoder, String> {
        // Hardware when the Mac has it, else Apple's software encoder.
        let spec = CFDictionary::<CFString, CFType>::from_slices(
            &[unsafe { kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder }],
            &[CFBoolean::new(true).as_ref()],
        );
        let mut raw: *mut VTCompressionSession = std::ptr::null_mut();
        let status = unsafe {
            VTCompressionSession::create(
                None,
                width as i32,
                height as i32,
                kCMVideoCodecType_H264,
                Some(spec.as_opaque()),
                None,
                None,
                None,
                std::ptr::null_mut(),
                NonNull::from(&mut raw),
            )
        };
        let session = NonNull::new(raw).filter(|_| status == 0).ok_or(format!("capture_failed: no H.264 encoder ({status})"))?;
        let session = unsafe { CFRetained::from_raw(session) };
        let s: &VTSession = &session;
        unsafe {
            set(s, kVTCompressionPropertyKey_RealTime, CFBoolean::new(true).as_ref())?;
            set(s, kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel.as_ref())?;
            set(s, kVTCompressionPropertyKey_AllowFrameReordering, CFBoolean::new(false).as_ref())?;
            set(s, kVTCompressionPropertyKey_ExpectedFrameRate, CFNumber::new_i32(fps as i32).as_ref())?;
            set(s, kVTCompressionPropertyKey_AverageBitRate, CFNumber::new_i32(bitrate as i32).as_ref())?;
            set(s, kVTCompressionPropertyKey_MaxKeyFrameInterval, CFNumber::new_i32((fps * 2) as i32).as_ref())?;
            set(s, kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, CFNumber::new_f64(KEYFRAME_EVERY.as_secs_f64()).as_ref())?;
            let status = session.prepare_to_encode_frames();
            if status != 0 {
                return Err(format!("capture_failed: encoder not ready ({status})"));
            }
        }
        let failed = Arc::new(AtomicU32::new(0));
        let keyframe_out = Arc::new(AtomicBool::new(false));
        let (failed_in, keyframe_in) = (failed.clone(), keyframe_out.clone());
        let handler: Handler = RcBlock::new(move |status: i32, flags: VTEncodeInfoFlags, sample: *mut CMSampleBuffer| {
            let out = (status == 0 && !flags.contains(VTEncodeInfoFlags::FrameDropped))
                .then(|| unsafe { sample.as_ref().and_then(|s| access_unit(s)) })
                .flatten();
            let Some((pts, keyframe, data)) = out else {
                failed_in.fetch_add(1, Ordering::AcqRel);
                return;
            };
            failed_in.store(0, Ordering::Release);
            if keyframe {
                keyframe_in.store(true, Ordering::Release);
            }
            sink(frame(pts, if keyframe { KEYFRAME } else { 0 }, &data));
        });
        Ok(Encoder { session, handler, failed, keyframe_out, width, height, fps })
    }

    fn encode(&self, picture: &CVImageBuffer, pts_us: u64, keyframe: bool) -> i32 {
        let force = keyframe.then(|| {
            CFDictionary::<CFString, CFType>::from_slices(&[unsafe { kVTEncodeFrameOptionKey_ForceKeyFrame }], &[CFBoolean::new(true).as_ref()])
        });
        unsafe {
            self.session.encode_frame_with_output_handler(
                picture,
                CMTime::new(pts_us as i64, 1_000_000),
                CMTime::new(1, self.fps as i32),
                force.as_deref().map(|d| d.as_opaque()),
                std::ptr::null_mut(),
                RcBlock::as_ptr(&self.handler),
            )
        }
    }
}

/// One encoded sample as pts in µs, whether it is a keyframe, and Annex-B
/// with SPS and PPS in front of every keyframe.
unsafe fn access_unit(sample: &CMSampleBuffer) -> Option<(u64, bool, Vec<u8>)> {
    // A sample without NotSync is a sync sample.
    let keyframe = match sample.sample_attachments_array(false) {
        Some(list) if list.count() > 0 => {
            let first = list.value_at_index(0) as *const CFDictionary<CFString, CFType>;
            first
                .as_ref()
                .and_then(|d| d.get(kCMSampleAttachmentKey_NotSync))
                .is_none_or(|v| !v.downcast_ref::<CFBoolean>().is_some_and(|b| b.as_bool()))
        }
        _ => true,
    };
    let pts = sample.presentation_time_stamp();
    let pts_us = if pts.timescale > 0 { (pts.value as i128 * 1_000_000 / pts.timescale as i128).max(0) as u64 } else { 0 };
    let data = sample.data_buffer()?;
    let len = data.data_length();
    let mut avcc = vec![0u8; len];
    if len == 0 || data.copy_data_bytes(0, len, NonNull::new(avcc.as_mut_ptr() as *mut c_void)?) != 0 {
        return None;
    }
    let mut header_len = 4;
    let sets = if keyframe { sample.format_description().map(|d| parameter_sets(&d, &mut header_len)).unwrap_or_default() } else { Vec::new() };
    let refs: Vec<&[u8]> = sets.iter().map(Vec::as_slice).collect();
    Some((pts_us, keyframe, annex_b(&avcc, header_len, &refs)))
}

unsafe fn parameter_sets(desc: &CMFormatDescription, header_len: &mut usize) -> Vec<Vec<u8>> {
    let (mut count, mut nal_len) = (0usize, 4i32);
    let (mut ptr, mut size): (*const u8, usize) = (std::ptr::null(), 0);
    if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(desc, 0, &mut ptr, &mut size, &mut count, &mut nal_len) != 0 {
        return Vec::new();
    }
    *header_len = nal_len.max(1) as usize;
    (0..count)
        .filter_map(|index| {
            let (mut ptr, mut size): (*const u8, usize) = (std::ptr::null(), 0);
            let status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(desc, index, &mut ptr, &mut size, std::ptr::null_mut(), std::ptr::null_mut());
            (status == 0 && !ptr.is_null()).then(|| std::slice::from_raw_parts(ptr, size).to_vec())
        })
        .collect()
}

struct Pipeline {
    capture: Capture,
    encoder: Encoder,
    failures: u32,
}

impl Pipeline {
    fn open(target: &Target, quality: Quality, sink: &Sink) -> Result<Pipeline, String> {
        let (width, height) = (quality.width.max(2) & !1, quality.height.max(2) & !1);
        let fps = quality.fps.max(1);
        let encoder = Encoder::new(width, height, fps, quality.bitrate, sink.clone())?;
        let capture = Capture::open(target, (width, height), fps)?;
        tracing::info!(width, height, fps, bitrate = quality.bitrate, "screen capture started");
        Ok(Pipeline { capture, encoder, failures: 0 })
    }

    fn started(&self) -> Started {
        Started { width: self.encoder.width, height: self.encoder.height, fps: self.encoder.fps }
    }

    /// One tick: the newest picture again, changed or not. Returns whether
    /// a picture went in.
    fn step(&mut self, pts: u64, keyframe: bool) -> Result<bool, String> {
        let Some(picture) = self.capture.latest.lock().as_ref().map(|p| p.0.clone()) else { return Ok(false) };
        if self.encoder.failed.load(Ordering::Acquire) > self.encoder.fps {
            return Err("the encoder lost a second of pictures".into());
        }
        match self.encoder.encode(&picture, pts, keyframe) {
            0 => {
                self.failures = 0;
                Ok(true)
            }
            status => {
                self.failures += 1;
                if self.failures > self.encoder.fps {
                    return Err(format!("the encoder refused a second of pictures ({status})"));
                }
                Ok(false)
            }
        }
    }
}

enum Cmd {
    Switch(Target, mpsc::Sender<Result<Started, String>>),
    Quality(Quality, mpsc::Sender<Result<Started, String>>),
    Stop,
}

pub struct Video {
    tx: mpsc::Sender<Cmd>,
    thread: Option<JoinHandle<()>>,
}

impl Video {
    pub fn start(target: &Target, quality: Quality, sink: Sink) -> Result<(Video, Started), String> {
        let (tx, rx) = mpsc::channel();
        let (ready, started) = mpsc::channel();
        let target = target.clone();
        let thread = std::thread::Builder::new()
            .name("screen-video".into())
            .spawn(move || autoreleasepool(|_| run_video(target, quality, sink, rx, ready)))
            .map_err(|e| format!("capture_failed: {e}"))?;
        match started.recv().map_err(|_| "capture_failed: the capture thread ended".to_string())? {
            Ok(started) => Ok((Video { tx, thread: Some(thread) }, started)),
            Err(e) => {
                let _ = thread.join();
                Err(e)
            }
        }
    }

    pub fn switch(&self, target: &Target) -> Result<Started, String> {
        self.ask(|reply| Cmd::Switch(target.clone(), reply))
    }

    pub fn quality(&self, quality: Quality) -> Result<Started, String> {
        self.ask(|reply| Cmd::Quality(quality, reply))
    }

    fn ask(&self, cmd: impl FnOnce(mpsc::Sender<Result<Started, String>>) -> Cmd) -> Result<Started, String> {
        let (reply, answer) = mpsc::channel();
        self.tx.send(cmd(reply)).map_err(|_| "source_closed: the capture ended".to_string())?;
        answer.recv().map_err(|_| "source_closed: the capture ended".to_string())?
    }

    pub fn stop(mut self) {
        self.halt();
    }

    fn halt(&mut self) {
        let _ = self.tx.send(Cmd::Stop);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Video {
    fn drop(&mut self) {
        self.halt();
    }
}

fn run_video(mut target: Target, mut quality: Quality, sink: Sink, rx: mpsc::Receiver<Cmd>, ready: mpsc::Sender<Result<Started, String>>) {
    let mut pipeline = match Pipeline::open(&target, quality, &sink) {
        Ok(p) => {
            let _ = ready.send(Ok(p.started()));
            p
        }
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let clock = Instant::now();
    let mut tick = 0u64;
    let mut force_key = true;
    let mut last_key = clock;
    let mut asked_key: Option<Instant> = None;
    loop {
        let (next_target, next_quality, reply) = match rx.try_recv() {
            Ok(Cmd::Stop) | Err(mpsc::TryRecvError::Disconnected) => break,
            Ok(Cmd::Switch(next, reply)) => (next, quality, Some(reply)),
            Ok(Cmd::Quality(next, reply)) => (target.clone(), next, Some(reply)),
            Err(mpsc::TryRecvError::Empty) => (target.clone(), quality, None),
        };
        // A refused change leaves the old source going.
        if let Some(reply) = reply {
            let result = autoreleasepool(|_| Pipeline::open(&next_target, next_quality, &sink)).map(|next| {
                pipeline = next;
                (target, quality, force_key) = (next_target, next_quality, true);
                pipeline.started()
            });
            let _ = reply.send(result);
        }
        let pts = clock.elapsed().as_micros() as u64;
        if pipeline.capture.ended() {
            tracing::info!("shared source closed");
            sink(frame(pts, ENDED, &[]));
            break;
        }
        if last_key.elapsed() >= KEYFRAME_EVERY {
            force_key = true;
        }
        // The encoder may drop the very picture a keyframe was asked on.
        if pipeline.encoder.keyframe_out.swap(false, Ordering::AcqRel) {
            asked_key = None;
        } else if asked_key.is_some_and(|at| at.elapsed() >= KEYFRAME_WAIT) {
            force_key = true;
        }
        match autoreleasepool(|_| pipeline.step(pts, force_key)) {
            Ok(true) => {
                if force_key {
                    last_key = Instant::now();
                    asked_key = Some(last_key);
                }
                force_key = false;
            }
            Ok(false) => {}
            Err(e) => {
                tracing::warn!(error = %e, "screen encode failed");
                sink(frame(pts, ENDED, &[]));
                break;
            }
        }
        tick += 1;
        let fps = pipeline.encoder.fps as u64;
        let due = clock + Duration::from_micros(tick * 1_000_000 / fps);
        let now = Instant::now();
        if due > now {
            std::thread::sleep(due - now);
        } else if now - due > Duration::from_millis(250) {
            tick = (now - clock).as_micros() as u64 * fps / 1_000_000;
        }
    }
}

/// One sample buffer from ScreenCaptureKit as s16 stereo, whatever the
/// layout; anything but the 48 kHz float that was asked for is dropped.
unsafe fn decode(sample: &CMSampleBuffer) -> Option<Vec<i16>> {
    let format = sample.format_description()?;
    let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(&format).as_ref()?;
    if asbd.mFormatID != kAudioFormatLinearPCM
        || asbd.mFormatFlags & kAudioFormatFlagIsFloat == 0
        || asbd.mBitsPerChannel != 32
        || asbd.mSampleRate as u32 != SAMPLE_RATE
    {
        return None;
    }
    #[repr(C)]
    struct TwoBuffers {
        count: u32,
        buffers: [AudioBuffer; 2],
    }
    let empty = AudioBuffer { mNumberChannels: 0, mDataByteSize: 0, mData: std::ptr::null_mut() };
    let mut list = TwoBuffers { count: 0, buffers: [empty, empty] };
    let mut block: *mut CMBlockBuffer = std::ptr::null_mut();
    const ASSURE_16_BYTE_ALIGNMENT: u32 = 1;
    let status = sample.audio_buffer_list_with_retained_block_buffer(
        std::ptr::null_mut(),
        &mut list as *mut TwoBuffers as *mut AudioBufferList,
        std::mem::size_of::<TwoBuffers>(),
        None,
        None,
        ASSURE_16_BYTE_ALIGNMENT,
        &mut block,
    );
    // Holds the memory the buffers point into until the end of this call.
    let _block = NonNull::new(block).map(|b| CFRetained::from_raw(b));
    if status != 0 || list.count == 0 {
        return None;
    }
    let plane = |b: &AudioBuffer| -> &[f32] {
        if b.mData.is_null() {
            &[]
        } else {
            std::slice::from_raw_parts(b.mData as *const f32, b.mDataByteSize as usize / 4)
        }
    };
    let first = plane(&list.buffers[0]);
    Some(match (list.count, list.buffers[0].mNumberChannels) {
        (1, 2) => {
            let (left, right): (Vec<f32>, Vec<f32>) = first.as_chunks::<2>().0.iter().map(|[l, r]| (*l, *r)).unzip();
            interleave(&left, &right)
        }
        (1, _) => interleave(first, first),
        _ => interleave(first, plane(&list.buffers[1])),
    })
}

/// The apps to leave out of the sound, and their pids to tell a change: the
/// muted ones (helpers under their app) and this app with its webviews.
fn excluded(content: &SCShareableContent, muted: &Muted) -> (Vec<Retained<SCRunningApplication>>, Vec<u32>) {
    let apps = unsafe { content.applications() }.to_vec();
    let procs: Vec<Proc> = apps.iter().map(|a| proc_of(unsafe { a.processID() } as u32)).collect();
    let mut out: Vec<(Retained<SCRunningApplication>, u32)> = apps
        .into_iter()
        .zip(&procs)
        .filter(|(_, p)| ours(p.pid, &procs) || muted.blocks(&p.id))
        .map(|(app, p)| (app, p.pid))
        .collect();
    out.sort_by_key(|(_, pid)| *pid);
    out.into_iter().unzip()
}

fn sound_filter(content: &SCShareableContent, muted: &Muted) -> Result<(Retained<SCContentFilter>, Vec<u32>), String> {
    let display = unsafe { content.displays() }.firstObject().ok_or("audio_failed: no display to take the sound from")?;
    let (apps, pids) = excluded(content, muted);
    let filter = unsafe {
        SCContentFilter::initWithDisplay_excludingApplications_exceptingWindows(
            SCContentFilter::alloc(),
            &display,
            &NSArray::from_retained_slice(&apps),
            &NSArray::<SCWindow>::new(),
        )
    };
    Ok((filter, pids))
}

pub struct Audio {
    muted: Arc<Mutex<Muted>>,
    dirty: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Audio {
    pub fn start(muted: Muted, sink: Sink) -> Result<Audio, String> {
        let muted = Arc::new(Mutex::new(muted));
        let dirty = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let (ready, started) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("screen-audio".into())
            .spawn({
                let (muted, dirty, stop) = (muted.clone(), dirty.clone(), stop.clone());
                move || autoreleasepool(|_| run_audio(muted, dirty, stop, sink, ready))
            })
            .map_err(|e| format!("audio_failed: {e}"))?;
        match started.recv().map_err(|_| "audio_failed: the sound thread ended".to_string())? {
            Ok(()) => Ok(Audio { muted, dirty, stop, thread: Some(thread) }),
            Err(e) => {
                let _ = thread.join();
                Err(e)
            }
        }
    }

    pub fn set_muted(&self, muted: Muted) {
        *self.muted.lock() = muted;
        self.dirty.store(true, Ordering::Release);
    }

    pub fn stop(mut self) {
        self.halt();
    }

    fn halt(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Audio {
    fn drop(&mut self) {
        self.halt();
    }
}

struct Sound {
    stream: Retained<SCStream>,
    _output: Retained<AudioOutput>,
    _watch: Retained<Watch>,
    closed: Arc<AtomicBool>,
    _queue: DispatchRetained<DispatchQueue>,
    pids: Vec<u32>,
}

impl Drop for Sound {
    fn drop(&mut self) {
        stop_stream(&self.stream);
    }
}

impl Sound {
    fn open(muted: &Muted, pending: Arc<Mutex<Vec<i16>>>) -> Result<Sound, String> {
        let content = shareable(false)?;
        let (filter, pids) = sound_filter(&content, muted)?;
        let output = AudioOutput::new(pending);
        let closed = Arc::new(AtomicBool::new(false));
        let watch = Watch::new(closed.clone());
        let queue = DispatchQueue::new("lol.juntos.screen.audio", None);
        unsafe {
            let config = SCStreamConfiguration::new();
            config.setCapturesAudio(true);
            config.setSampleRate(SAMPLE_RATE as _);
            config.setChannelCount(CHANNELS as _);
            config.setExcludesCurrentProcessAudio(true);
            // Only the sound is read; the picture it still makes stays tiny and rare.
            config.setWidth(2);
            config.setHeight(2);
            config.setMinimumFrameInterval(CMTime::new(1, 1));
            let stream = SCStream::initWithFilter_configuration_delegate(SCStream::alloc(), &filter, &config, Some(ProtocolObject::from_ref(&*watch)));
            stream
                .addStreamOutput_type_sampleHandlerQueue_error(ProtocolObject::from_ref(&*output), SCStreamOutputType::Audio, Some(&queue))
                .map_err(|e| format!("audio_failed: {}", e.localizedDescription()))?;
            start_stream(&stream)?;
            Ok(Sound { stream, _output: output, _watch: watch, closed, _queue: queue, pids })
        }
    }

    /// Leaves out what is muted now, without stopping the stream.
    fn refilter(&mut self, muted: &Muted) -> Result<(), String> {
        let content = shareable(false)?;
        let (filter, pids) = sound_filter(&content, muted)?;
        if pids != self.pids {
            self.pids = pids;
            let done = RcBlock::new(|error: *mut NSError| {
                if !error.is_null() {
                    tracing::warn!(error = %error_text(error), "sound filter refused");
                }
            });
            unsafe { self.stream.updateContentFilter_completionHandler(&filter, Some(&done)) };
        }
        Ok(())
    }
}

fn run_audio(muted: Arc<Mutex<Muted>>, dirty: Arc<AtomicBool>, stop: Arc<AtomicBool>, sink: Sink, ready: mpsc::Sender<Result<(), String>>) {
    let pending = Arc::new(Mutex::new(Vec::new()));
    let opened = Sound::open(&muted.lock(), pending.clone());
    let _ = ready.send(opened.as_ref().map(|_| ()).map_err(|e| e.clone()));
    let Ok(mut sound) = opened else { return };
    // The 10 ms blocks have a thread of their own, so a slow lookup of the
    // running apps below never holds the sound back.
    let pump = {
        let (pending, stop) = (pending.clone(), stop.clone());
        std::thread::spawn(move || pump_audio(pending, stop, sink))
    };
    let mut last_scan = Instant::now();
    while !stop.load(Ordering::Acquire) {
        // The menu bar's Stop, or the display going away, ends the stream; silence covers until it is back.
        if sound.closed.load(Ordering::Acquire) && last_scan.elapsed() >= RESCAN {
            last_scan = Instant::now();
            match autoreleasepool(|_| Sound::open(&muted.lock().clone(), pending.clone())) {
                Ok(next) => sound = next,
                Err(e) => tracing::debug!(error = %e, "sound reopen failed"),
            }
        // An app opened later, or a restarted Discord, is a process the
        // filter has not seen yet.
        } else if dirty.swap(false, Ordering::AcqRel) || last_scan.elapsed() >= RESCAN {
            last_scan = Instant::now();
            let muted = muted.lock().clone();
            if let Err(e) = autoreleasepool(|_| sound.refilter(&muted)) {
                tracing::debug!(error = %e, "sound rescan failed");
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = pump.join();
}

fn pump_audio(pending: Arc<Mutex<Vec<i16>>>, stop: Arc<AtomicBool>, sink: Sink) {
    let mut pcm = Pcm::default();
    let period = Duration::from_millis(10);
    let mut next = Instant::now();
    while !stop.load(Ordering::Acquire) {
        let incoming = std::mem::take(&mut *pending.lock());
        for block in pcm.tick(&incoming) {
            sink(block);
        }
        next += period;
        let now = Instant::now();
        if next > now {
            std::thread::sleep(next - now);
        } else if now - next > period * 5 {
            next = now;
        }
    }
}

/// Where the source lands inside the output, as x, y, width, height: as
/// large as fits, centered, even-sized.
fn letterbox(input: (u32, u32), output: (u32, u32)) -> (u32, u32, u32, u32) {
    let scale = (output.0 as f64 / input.0.max(1) as f64).min(output.1 as f64 / input.1.max(1) as f64);
    let even = |v: f64| ((v / 2.0).round() as u32 * 2).max(2);
    let (w, h) = (even(input.0 as f64 * scale).min(output.0), even(input.1 as f64 * scale).min(output.1));
    ((output.0 - w) / 2, (output.1 - h) / 2, w, h)
}

/// A length-prefixed (AVCC) access unit as Annex-B, after the given
/// parameter sets.
fn annex_b(avcc: &[u8], header_len: usize, parameter_sets: &[&[u8]]) -> Vec<u8> {
    const START: [u8; 4] = [0, 0, 0, 1];
    let mut out = Vec::with_capacity(avcc.len() + 64);
    for set in parameter_sets {
        out.extend_from_slice(&START);
        out.extend_from_slice(set);
    }
    let mut at = 0;
    while at + header_len <= avcc.len() {
        let len = avcc[at..at + header_len].iter().fold(0usize, |len, b| (len << 8) | *b as usize);
        at += header_len;
        if len == 0 || at + len > avcc.len() {
            break;
        }
        out.extend_from_slice(&START);
        out.extend_from_slice(&avcc[at..at + len]);
        at += len;
    }
    out
}

fn interleave(left: &[f32], right: &[f32]) -> Vec<i16> {
    let s16 = |v: f32| (v * 32768.0).round().clamp(i16::MIN as f32, i16::MAX as f32) as i16;
    left.iter().zip(right).flat_map(|(l, r)| [s16(*l), s16(*r)]).collect()
}

/// Ticks without sound before silence goes out in its place.
const QUIET_TICKS: u32 = 4;

/// Cuts what ScreenCaptureKit hands over (about 21 ms at a time) into 10 ms
/// blocks as it comes, so there is no second clock to drift against; when
/// nothing comes at all, silence keeps the page's stream going.
#[derive(Default)]
struct Pcm {
    pending: Vec<i16>,
    quiet: u32,
}

impl Pcm {
    fn tick(&mut self, incoming: &[i16]) -> Vec<Vec<u8>> {
        self.pending.extend_from_slice(incoming);
        let whole = self.pending.len() / BLOCK * BLOCK;
        let blocks: Vec<Vec<u8>> =
            self.pending.drain(..whole).collect::<Vec<_>>().chunks(BLOCK).map(|b| b.iter().flat_map(|s| s.to_le_bytes()).collect()).collect();
        if !incoming.is_empty() {
            self.quiet = 0;
        } else {
            self.quiet += 1;
        }
        if blocks.is_empty() && self.quiet > QUIET_TICKS {
            return vec![vec![0; BLOCK * 2]];
        }
        blocks
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_narrower_picture_is_centered_with_bars() {
        assert_eq!(letterbox((1000, 1000), (1920, 1080)), (420, 0, 1080, 1080));
        assert_eq!(letterbox((3024, 1964), (1920, 1080)), (129, 0, 1662, 1080));
    }

    #[test]
    fn avcc_becomes_annex_b_after_the_parameter_sets() {
        let avcc = [0, 0, 0, 2, 0x65, 0xAA, 0, 0, 0, 1, 0x41];
        let out = annex_b(&avcc, 4, &[&[0x67, 0x64], &[0x68, 0xEE]]);
        assert_eq!(out, [0, 0, 0, 1, 0x67, 0x64, 0, 0, 0, 1, 0x68, 0xEE, 0, 0, 0, 1, 0x65, 0xAA, 0, 0, 0, 1, 0x41]);
        assert!(annex_b(&[0, 0, 0, 9, 0x65], 4, &[]).is_empty());
    }

    #[test]
    fn float_planes_become_clamped_interleaved_s16() {
        assert_eq!(interleave(&[0.0, 1.0, -2.0], &[0.5, -1.0, 2.0]), [0, 16384, 32767, -32768, -32768, 32767]);
    }

    #[test]
    fn sound_in_bursts_leaves_in_whole_10ms_blocks() {
        let mut pcm = Pcm::default();
        // ScreenCaptureKit hands 1024 frames at a time.
        let burst = vec![1i16; 1024 * CHANNELS];
        let first = pcm.tick(&burst);
        assert_eq!(first.len(), 2);
        assert!(first.iter().all(|b| b.len() == BLOCK * 2));
        assert_eq!(pcm.tick(&burst).len(), 2);
        assert_eq!(pcm.tick(&burst).len(), 2);
        assert_eq!(pcm.tick(&[]).len(), 0, "a leftover under 10 ms waits for more");
    }

    #[test]
    fn silence_keeps_the_stream_going_only_when_no_sound_comes() {
        let mut pcm = Pcm::default();
        let ticks: Vec<usize> = (0..8).map(|_| pcm.tick(&[]).len()).collect();
        assert_eq!(ticks, [0, 0, 0, 0, 1, 1, 1, 1]);
        assert_eq!(pcm.tick(&vec![0; BLOCK]), vec![vec![0u8; BLOCK * 2]]);
        assert_eq!(pcm.tick(&[]).len(), 0);
    }
}
