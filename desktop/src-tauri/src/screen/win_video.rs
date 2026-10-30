//! Windows: Windows.Graphics.Capture into the GPU's H.264 encoder.
//!
//! The capture keeps the newest picture in a texture of its own. A thread of
//! its own turns that picture into NV12 at the output size on the GPU (video
//! processor, letterboxed when the source's shape changes) and hands it to the
//! hardware encoder at a steady rate: a still screen still makes frames, so a
//! viewer who joins late gets a keyframe within two seconds.

use std::mem::ManuallyDrop;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use windows::core::{Interface, Result as WinResult, GUID, HRESULT};
use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::SizeInt32;
use windows::Win32::Foundation::{HMODULE, RECT};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_RATIONAL, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::Media::{timeBeginPeriod, timeEndPeriod};
use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_MULTITHREADED};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;

use super::{frame, Quality, Sink, Started, Target, TargetKind, ENDED, KEYFRAME};

/// Keyframe at least this often, so a late viewer waits little.
const KEYFRAME_EVERY: Duration = Duration::from_secs(2);
/// NV12 surfaces the encoder may still be reading while the next is drawn.
const SURFACES: usize = 4;

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
            .spawn(move || run(target, quality, sink, rx, ready))
            .map_err(|e| format!("capture_failed: {e}"))?;
        let first = started.recv().map_err(|_| "capture_failed: the capture thread ended".to_string())?;
        match first {
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

fn run(mut target: Target, mut quality: Quality, sink: Sink, rx: mpsc::Receiver<Cmd>, ready: mpsc::Sender<Result<Started, String>>) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let _ = MFStartup(MF_VERSION, MFSTARTUP_FULL);
        timeBeginPeriod(1);
    }
    let mut pipeline = match Gpu::new().and_then(|gpu| Pipeline::open(gpu, &target, quality)) {
        Ok(p) => {
            let _ = ready.send(Ok(p.started()));
            p
        }
        Err(e) => {
            let _ = ready.send(Err(e));
            return finish();
        }
    };
    let clock = Instant::now();
    let mut tick = 0u64;
    let mut force_key = true;
    let mut last_key = clock;
    loop {
        match rx.try_recv() {
            Ok(Cmd::Stop) | Err(mpsc::TryRecvError::Disconnected) => break,
            Ok(Cmd::Switch(next, reply)) => {
                let result = pipeline.reopen(&next, quality);
                if result.is_ok() {
                    target = next;
                    force_key = true;
                }
                let _ = reply.send(result);
            }
            Ok(Cmd::Quality(next, reply)) => {
                let result = pipeline.reopen(&target, next);
                if result.is_ok() {
                    quality = next;
                    force_key = true;
                }
                let _ = reply.send(result);
            }
            Err(mpsc::TryRecvError::Empty) => {}
        }
        if pipeline.capture.closed.load(Ordering::Acquire) {
            tracing::info!("shared source closed");
            sink(frame(clock.elapsed().as_micros() as u64, ENDED, &[]));
            break;
        }
        if last_key.elapsed() >= KEYFRAME_EVERY {
            force_key = true;
        }
        let pts = clock.elapsed().as_micros() as u64;
        match pipeline.step(pts, force_key, &sink) {
            Ok(true) => {
                if force_key {
                    last_key = Instant::now();
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
        let due = clock + Duration::from_micros(tick * 1_000_000 / pipeline.fps as u64);
        let now = Instant::now();
        if due > now {
            std::thread::sleep(due - now);
        } else if now - due > Duration::from_millis(250) {
            tick = (now - clock).as_micros() as u64 * pipeline.fps as u64 / 1_000_000;
        }
    }
    drop(pipeline);
    finish();
}

fn finish() {
    unsafe {
        timeEndPeriod(1);
        let _ = MFShutdown();
        CoUninitialize();
    }
}

fn err(context: &str) -> impl Fn(windows::core::Error) -> String + '_ {
    move |e| format!("capture_failed: {context}: {e}")
}

// ---- the GPU

#[derive(Clone)]
struct Gpu {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    winrt: IDirect3DDevice,
}

// The device is created with multithread protection on, so the capture's
// callback may use it beside this thread.
unsafe impl Send for Gpu {}
unsafe impl Sync for Gpu {}

impl Gpu {
    fn new() -> Result<Gpu, String> {
        unsafe {
            let mut device = None;
            let mut context = None;
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
            .map_err(err("D3D11 device"))?;
            let device: ID3D11Device = device.ok_or("capture_failed: no D3D11 device")?;
            let context = context.ok_or("capture_failed: no D3D11 context")?;
            // The capture's callback, this thread and the encoder all use it.
            let _ = device.cast::<ID3D11Multithread>().map_err(err("multithread"))?.SetMultithreadProtected(true);
            let dxgi: IDXGIDevice = device.cast().map_err(err("DXGI device"))?;
            let winrt: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&dxgi).and_then(|i| i.cast()).map_err(err("WinRT device"))?;
            Ok(Gpu { device, context, winrt })
        }
    }

    fn texture(&self, width: u32, height: u32, format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT, bind: D3D11_BIND_FLAG) -> WinResult<ID3D11Texture2D> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: format,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: bind.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut texture = None;
        unsafe { self.device.CreateTexture2D(&desc, None, Some(&mut texture))? };
        texture.ok_or_else(|| windows::core::Error::from(HRESULT(0x8000_4005u32 as i32)))
    }
}

// ---- the capture

struct Latest {
    texture: ID3D11Texture2D,
    width: u32,
    height: u32,
}

// Only touched under the mutex, on the protected device.
unsafe impl Send for Latest {}

struct Capture {
    _item: GraphicsCaptureItem,
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    latest: Arc<Mutex<Option<Latest>>>,
    closed: Arc<AtomicBool>,
}

impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}

impl Capture {
    fn open(gpu: &Gpu, target: &Target) -> Result<Capture, String> {
        let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().map_err(err("capture interop"))?;
        let item: GraphicsCaptureItem = unsafe {
            match target.kind {
                TargetKind::Display => {
                    let (monitor, _) = super::win::monitor(&target.id).ok_or("not_found: display")?;
                    interop.CreateForMonitor(monitor).map_err(err("capture item"))?
                }
                TargetKind::Window => {
                    let hwnd = super::win::window(&target.id).ok_or("not_found: window")?;
                    interop.CreateForWindow(hwnd).map_err(err("capture item"))?
                }
            }
        };
        let size = item.Size().map_err(err("item size"))?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&gpu.winrt, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size)
            .map_err(err("frame pool"))?;
        let session = pool.CreateCaptureSession(&item).map_err(err("capture session"))?;
        let _ = session.SetIsCursorCaptureEnabled(true);
        // Windows 11 lets the yellow border go; Windows 10 just refuses.
        let _ = session.SetIsBorderRequired(false);
        let latest: Arc<Mutex<Option<Latest>>> = Arc::new(Mutex::new(None));
        let closed = Arc::new(AtomicBool::new(false));
        let pool_size = Arc::new(Mutex::new(size));
        {
            let (gpu, latest, pool_size) = (gpu.clone(), latest.clone(), pool_size.clone());
            pool.FrameArrived(&TypedEventHandler::<Direct3D11CaptureFramePool, windows::core::IInspectable>::new(move |pool, _| {
                let Some(pool) = pool.as_ref() else { return Ok(()) };
                let frame = pool.TryGetNextFrame()?;
                let content = frame.ContentSize()?;
                let surface: ID3D11Texture2D = unsafe { frame.Surface()?.cast::<IDirect3DDxgiInterfaceAccess>()?.GetInterface()? };
                let (w, h) = (content.Width.max(2) as u32 & !1, content.Height.max(2) as u32 & !1);
                {
                    let mut latest = latest.lock();
                    let reuse = latest.as_ref().is_some_and(|l| l.width == w && l.height == h);
                    if !reuse {
                        let texture = gpu.texture(w, h, DXGI_FORMAT_B8G8R8A8_UNORM, D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE)?;
                        *latest = Some(Latest { texture, width: w, height: h });
                    }
                    let target = &latest.as_ref().unwrap().texture;
                    let region = D3D11_BOX { left: 0, top: 0, front: 0, right: w, bottom: h, back: 1 };
                    unsafe { gpu.context.CopySubresourceRegion(target, 0, 0, 0, 0, &surface, 0, Some(&region)) };
                }
                // A window that grew needs a bigger pool, or its picture gets cut.
                let mut known = pool_size.lock();
                if content.Width != known.Width || content.Height != known.Height {
                    *known = content;
                    pool.Recreate(&gpu.winrt, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, SizeInt32 { Width: content.Width, Height: content.Height })?;
                }
                Ok(())
            }))
            .map_err(err("frame handler"))?;
        }
        {
            let closed = closed.clone();
            item.Closed(&TypedEventHandler::new(move |_, _| {
                closed.store(true, Ordering::Release);
                Ok(())
            }))
            .map_err(err("closed handler"))?;
        }
        session.StartCapture().map_err(err("start capture"))?;
        Ok(Capture { _item: item, pool, session, latest, closed })
    }

}

// ---- BGRA to NV12 at the output size

struct Converter {
    video: ID3D11VideoDevice,
    context: ID3D11VideoContext,
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    input: (u32, u32),
    output: (u32, u32),
}

impl Converter {
    fn new(gpu: &Gpu, input: (u32, u32), output: (u32, u32), fps: u32) -> WinResult<Converter> {
        unsafe {
            let video: ID3D11VideoDevice = gpu.device.cast()?;
            let context: ID3D11VideoContext = gpu.context.cast()?;
            let desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                InputFrameRate: DXGI_RATIONAL { Numerator: fps, Denominator: 1 },
                InputWidth: input.0,
                InputHeight: input.1,
                OutputFrameRate: DXGI_RATIONAL { Numerator: fps, Denominator: 1 },
                OutputWidth: output.0,
                OutputHeight: output.1,
                Usage: D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
            };
            let enumerator = video.CreateVideoProcessorEnumerator(&desc)?;
            let processor = video.CreateVideoProcessor(&enumerator, 0)?;
            // Screens are full-range RGB; H.264 wants BT.709 limited range.
            context.VideoProcessorSetStreamColorSpace(&processor, 0, &D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: 0 });
            context.VideoProcessorSetOutputColorSpace(&processor, &D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: 0b1_0100 });
            context.VideoProcessorSetOutputBackgroundColor(
                &processor,
                false,
                &D3D11_VIDEO_COLOR { Anonymous: D3D11_VIDEO_COLOR_0 { RGBA: D3D11_VIDEO_COLOR_RGBA { R: 0.0, G: 0.0, B: 0.0, A: 1.0 } } },
            );
            context.VideoProcessorSetStreamFrameFormat(&processor, 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
            context.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
            let full = RECT { left: 0, top: 0, right: output.0 as i32, bottom: output.1 as i32 };
            context.VideoProcessorSetOutputTargetRect(&processor, true, Some(&full));
            context.VideoProcessorSetStreamSourceRect(&processor, 0, true, Some(&RECT { left: 0, top: 0, right: input.0 as i32, bottom: input.1 as i32 }));
            context.VideoProcessorSetStreamDestRect(&processor, 0, true, Some(&letterbox(input, output)));
            Ok(Converter { video, context, enumerator, processor, input, output })
        }
    }

    fn convert(&self, source: &ID3D11Texture2D, target: &ID3D11Texture2D) -> WinResult<()> {
        unsafe {
            let input_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                FourCC: 0,
                ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: 0 } },
            };
            let mut input = None;
            self.video.CreateVideoProcessorInputView(source, &self.enumerator, &input_desc, Some(&mut input))?;
            let output_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 } },
            };
            let mut output = None;
            self.video.CreateVideoProcessorOutputView(target, &self.enumerator, &output_desc, Some(&mut output))?;
            let output = output.ok_or_else(|| windows::core::Error::from(HRESULT(0x8000_4005u32 as i32)))?;
            let stream = D3D11_VIDEO_PROCESSOR_STREAM { Enable: true.into(), pInputSurface: ManuallyDrop::new(input), ..Default::default() };
            let streams = [stream];
            let result = self.context.VideoProcessorBlt(&self.processor, &output, 0, &streams);
            let [mut stream] = streams;
            ManuallyDrop::drop(&mut stream.pInputSurface);
            result
        }
    }
}

/// Where a picture of `input`'s shape sits inside `output`, centered.
fn letterbox(input: (u32, u32), output: (u32, u32)) -> RECT {
    let scale = (output.0 as f64 / input.0 as f64).min(output.1 as f64 / input.1 as f64);
    let (w, h) = ((input.0 as f64 * scale).round() as i32, (input.1 as f64 * scale).round() as i32);
    let (x, y) = ((output.0 as i32 - w) / 2, (output.1 as i32 - h) / 2);
    RECT { left: x, top: y, right: x + w, bottom: y + h }
}

// ---- the encoder

struct Encoder {
    transform: IMFTransform,
    /// The GPU's encoder runs on its own and says when it wants a picture;
    /// Windows' software one (for cards without an encoder, such as the
    /// RX 6500 XT) takes each picture from memory and answers at once.
    events: Option<IMFMediaEventGenerator>,
    staging: Option<(ID3D11Texture2D, ID3D11DeviceContext)>,
    codec: Option<ICodecAPI>,
    _manager: Option<IMFDXGIDeviceManager>,
    input_id: u32,
    output_id: u32,
    fps: u32,
    width: u32,
    height: u32,
    credits: u32,
    header: Vec<u8>,
}

impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe {
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
            if let Ok(activate) = self.transform.cast::<IMFShutdown>() {
                let _ = activate.Shutdown();
            }
        }
    }
}

fn media_type(subtype: &GUID, width: u32, height: u32, fps: u32) -> WinResult<IMFMediaType> {
    unsafe {
        let t = MFCreateMediaType()?;
        t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        t.SetGUID(&MF_MT_SUBTYPE, subtype)?;
        t.SetUINT64(&MF_MT_FRAME_SIZE, ((width as u64) << 32) | height as u64)?;
        t.SetUINT64(&MF_MT_FRAME_RATE, ((fps as u64) << 32) | 1)?;
        t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1)?;
        t.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        Ok(t)
    }
}

impl Encoder {
    fn new(gpu: &Gpu, width: u32, height: u32, fps: u32, bitrate: u32) -> Result<Encoder, String> {
        unsafe {
            let (transform, hardware) = match hardware_encoder() {
                Ok(t) => (t, true),
                Err(e) => {
                    tracing::warn!(error = %e, "no H.264 encoder on the GPU, encoding on the CPU");
                    let t: IMFTransform = windows::Win32::System::Com::CoCreateInstance(&CLSID_MSH264EncoderMFT, None, windows::Win32::System::Com::CLSCTX_INPROC_SERVER)
                        .map_err(err("software H.264 encoder"))?;
                    (t, false)
                }
            };
            let attributes = transform.GetAttributes().ok();
            let mut manager = None;
            if hardware {
                let attributes = attributes.as_ref().ok_or("capture_failed: encoder attributes")?;
                attributes.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1).map_err(err("async unlock"))?;
                let _ = attributes.SetUINT32(&MF_LOW_LATENCY, 1);
                let mut token = 0u32;
                MFCreateDXGIDeviceManager(&mut token, &mut manager).map_err(err("device manager"))?;
                let m = manager.as_ref().ok_or("capture_failed: no device manager")?;
                m.ResetDevice(&gpu.device, token).map_err(err("device manager"))?;
                transform.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, m.as_raw() as usize).map_err(err("D3D manager"))?;
            }
            let (mut input_id, mut output_id) = (0u32, 0u32);
            let _ = transform.GetStreamIDs(std::slice::from_mut(&mut input_id), std::slice::from_mut(&mut output_id));
            // Some encoders take the GOP only before the media types.
            let codec = transform.cast::<ICodecAPI>().ok();
            if let Some(codec) = &codec {
                let set = |key: &GUID, value: VARIANT| {
                    let _ = codec.SetValue(key, &value);
                };
                set(&CODECAPI_AVEncCommonRateControlMode, VARIANT::from(eAVEncCommonRateControlMode_CBR.0 as u32));
                set(&CODECAPI_AVEncCommonMeanBitRate, VARIANT::from(bitrate));
                set(&CODECAPI_AVLowLatencyMode, VARIANT::from(true));
                // Keyframes come only when asked for, every two seconds and at
                // each switch; the encoder's own would land beside them.
                set(&CODECAPI_AVEncMPVGOPSize, VARIANT::from(fps * 60));
                set(&CODECAPI_AVEncMPVDefaultBPictureCount, VARIANT::from(0u32));
                if !hardware {
                    // Speed over quality: the CPU is also running the game.
                    set(&CODECAPI_AVEncCommonQualityVsSpeed, VARIANT::from(0u32));
                }
            }
            let output = media_type(&MFVideoFormat_H264, width, height, fps).map_err(err("output type"))?;
            output.SetUINT32(&MF_MT_AVG_BITRATE, bitrate).map_err(err("output type"))?;
            output.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32).map_err(err("output type"))?;
            transform.SetOutputType(output_id, &output, 0).map_err(err("output type"))?;
            let input = media_type(&MFVideoFormat_NV12, width, height, fps).map_err(err("input type"))?;
            transform.SetInputType(input_id, &input, 0).map_err(err("input type"))?;
            let events = if hardware { Some(transform.cast::<IMFMediaEventGenerator>().map_err(err("encoder events"))?) } else { None };
            let staging = if hardware {
                None
            } else {
                let desc = D3D11_TEXTURE2D_DESC {
                    Width: width,
                    Height: height,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: DXGI_FORMAT_NV12,
                    SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                    Usage: D3D11_USAGE_STAGING,
                    BindFlags: 0,
                    CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                    MiscFlags: 0,
                };
                let mut texture = None;
                gpu.device.CreateTexture2D(&desc, None, Some(&mut texture)).map_err(err("staging surface"))?;
                Some((texture.ok_or("capture_failed: staging surface")?, gpu.context.clone()))
            };
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0).map_err(err("begin streaming"))?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0).map_err(err("start of stream"))?;
            tracing::info!(hardware, width, height, fps, bitrate, "H.264 encoder ready");
            let credits = if hardware { 0 } else { 1 };
            let mut encoder = Encoder { transform, events, staging, codec, _manager: manager, input_id, output_id, fps, width, height, credits, header: Vec::new() };
            encoder.read_header();
            Ok(encoder)
        }
    }

    fn read_header(&mut self) {
        unsafe {
            if let Ok(current) = self.transform.GetOutputCurrentType(self.output_id) {
                if let Ok(size) = current.GetBlobSize(&MF_MT_MPEG_SEQUENCE_HEADER) {
                    let mut blob = vec![0u8; size as usize];
                    if current.GetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &mut blob, None).is_ok() {
                        self.header = blob;
                    }
                }
            }
        }
    }

    /// Answers the encoder's events; returns whether a frame went out.
    fn pump(&mut self, sink: &Sink) -> WinResult<bool> {
        let mut sent = false;
        let Some(events) = self.events.clone() else {
            // The software encoder: whatever it has is ready now.
            while self.output(sink)? {
                sent = true;
            }
            return Ok(sent);
        };
        loop {
            let event = match unsafe { events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
                Ok(event) => event,
                Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => return Ok(sent),
                Err(e) => return Err(e),
            };
            let kind = unsafe { event.GetType()? };
            if kind == METransformNeedInput.0 as u32 {
                self.credits += 1;
            } else if kind == METransformHaveOutput.0 as u32 {
                sent |= self.output(sink)?;
            }
        }
    }

    fn output(&mut self, sink: &Sink) -> WinResult<bool> {
        unsafe {
            let info = self.transform.GetOutputStreamInfo(self.output_id)?;
            let provides = info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.0 as u32) != 0;
            let sample = if provides {
                None
            } else {
                let sample = MFCreateSample()?;
                sample.AddBuffer(&MFCreateMemoryBuffer(info.cbSize.max(self.width * self.height))?)?;
                Some(sample)
            };
            let mut buffers = [MFT_OUTPUT_DATA_BUFFER { dwStreamID: self.output_id, pSample: ManuallyDrop::new(sample), dwStatus: 0, pEvents: ManuallyDrop::new(None) }];
            let mut status = 0u32;
            let result = self.transform.ProcessOutput(0, &mut buffers, &mut status);
            let [mut buffer] = buffers;
            let sample = ManuallyDrop::take(&mut buffer.pSample);
            ManuallyDrop::drop(&mut buffer.pEvents);
            match result {
                Ok(()) => {}
                Err(e) if e.code() == MF_E_TRANSFORM_STREAM_CHANGE => {
                    let available = self.transform.GetOutputAvailableType(self.output_id, 0)?;
                    self.transform.SetOutputType(self.output_id, &available, 0)?;
                    self.read_header();
                    return Ok(false);
                }
                Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => return Ok(false),
                Err(e) => return Err(e),
            }
            let Some(sample) = sample else { return Ok(false) };
            let keyframe = sample.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(0) != 0;
            let pts = sample.GetSampleTime().unwrap_or(0).max(0) as u64 / 10;
            let buffer = sample.ConvertToContiguousBuffer()?;
            let mut data = std::ptr::null_mut();
            let mut len = 0u32;
            buffer.Lock(&mut data, None, Some(&mut len))?;
            let bytes = std::slice::from_raw_parts(data, len as usize);
            let payload = if keyframe && !has_sps(bytes) && !self.header.is_empty() {
                [self.header.as_slice(), bytes].concat()
            } else {
                bytes.to_vec()
            };
            buffer.Unlock()?;
            sink(frame(pts, if keyframe { KEYFRAME } else { 0 }, &payload));
            Ok(true)
        }
    }

    fn encode(&mut self, surface: &ID3D11Texture2D, pts_us: u64, keyframe: bool) -> WinResult<bool> {
        if self.credits == 0 {
            return Ok(false);
        }
        unsafe {
            if keyframe {
                if let Some(codec) = &self.codec {
                    let _ = codec.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &VARIANT::from(1u32));
                }
            }
            let buffer = match &self.staging {
                None => {
                    let buffer = MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, surface, 0, false)?;
                    if let Ok(two_d) = buffer.cast::<IMF2DBuffer>() {
                        buffer.SetCurrentLength(two_d.GetContiguousLength()?)?;
                    }
                    buffer
                }
                Some((staging, context)) => read_nv12(context, surface, staging, self.width, self.height)?,
            };
            let sample = MFCreateSample()?;
            sample.AddBuffer(&buffer)?;
            sample.SetSampleTime(pts_us as i64 * 10)?;
            sample.SetSampleDuration(10_000_000 / self.fps as i64)?;
            self.transform.ProcessInput(self.input_id, &sample, 0)?;
        }
        if self.events.is_some() {
            self.credits -= 1;
        }
        Ok(true)
    }
}

/// The NV12 picture copied off the GPU into memory, rows packed tight.
fn read_nv12(context: &ID3D11DeviceContext, surface: &ID3D11Texture2D, staging: &ID3D11Texture2D, width: u32, height: u32) -> WinResult<IMFMediaBuffer> {
    unsafe {
        context.CopyResource(staging, surface);
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        context.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
        let size = width * height * 3 / 2;
        let buffer = MFCreateMemoryBuffer(size)?;
        let mut data = std::ptr::null_mut();
        buffer.Lock(&mut data, None, None)?;
        let source = mapped.pData as *const u8;
        let pitch = mapped.RowPitch as usize;
        let (w, h) = (width as usize, height as usize);
        // Y rows, then the interleaved UV rows that follow them at the same pitch.
        for row in 0..h + h / 2 {
            std::ptr::copy_nonoverlapping(source.add(row * pitch), data.add(row * w), w);
        }
        buffer.Unlock()?;
        buffer.SetCurrentLength(size)?;
        context.Unmap(staging, 0);
        Ok(buffer)
    }
}

fn has_sps(annex_b: &[u8]) -> bool {
    annex_b.windows(4).any(|w| w[..3] == [0, 0, 1] && w[3] & 0x1f == 7)
}

fn hardware_encoder() -> WinResult<IMFTransform> {
    unsafe {
        let input = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_NV12 };
        let output = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_H264 };
        let mut list: *mut Option<IMFActivate> = std::ptr::null_mut();
        let mut count = 0u32;
        MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
            Some(&input),
            Some(&output),
            &mut list,
            &mut count,
        )?;
        let activates = std::slice::from_raw_parts_mut(list, count as usize);
        let mut found = Err(windows::core::Error::from(HRESULT(0xC00D_36D5u32 as i32)));
        for activate in activates.iter_mut() {
            if let Some(activate) = activate.take() {
                if found.is_err() {
                    let mut name = windows::core::PWSTR::null();
                    let mut len = 0u32;
                    let named = activate.GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut name, &mut len).is_ok();
                    let label = if named { name.to_string().unwrap_or_default() } else { String::new() };
                    if named {
                        CoTaskMemFree(Some(name.0 as *const _));
                    }
                    found = activate.ActivateObject::<IMFTransform>();
                    match &found {
                        Ok(_) => tracing::info!(encoder = %label, "H.264 encoder"),
                        Err(e) => tracing::warn!(encoder = %label, error = %e, "H.264 encoder refused"),
                    }
                }
            }
        }
        CoTaskMemFree(Some(list as *const _));
        found
    }
}

// ---- the whole chain

struct Pipeline {
    gpu: Gpu,
    capture: Capture,
    converter: Option<Converter>,
    encoder: Encoder,
    surfaces: Vec<ID3D11Texture2D>,
    next_surface: usize,
    fps: u32,
}

impl Pipeline {
    fn open(gpu: Gpu, target: &Target, quality: Quality) -> Result<Pipeline, String> {
        let capture = Capture::open(&gpu, target)?;
        // Always the quality's size: a viewer's picture never changes shape
        // under it, a source of another shape gets bars.
        let (width, height) = (quality.width.max(2) & !1, quality.height.max(2) & !1);
        let encoder = Encoder::new(&gpu, width, height, quality.fps, quality.bitrate)?;
        let surfaces = (0..SURFACES)
            .map(|_| gpu.texture(width, height, DXGI_FORMAT_NV12, D3D11_BIND_RENDER_TARGET))
            .collect::<WinResult<Vec<_>>>()
            .map_err(err("NV12 surfaces"))?;
        tracing::info!(width, height, fps = quality.fps, bitrate = quality.bitrate, "screen capture started");
        Ok(Pipeline { gpu, capture, converter: None, encoder, surfaces, next_surface: 0, fps: quality.fps })
    }

    fn started(&self) -> Started {
        Started { width: self.encoder.width, height: self.encoder.height, fps: self.fps }
    }

    fn reopen(&mut self, target: &Target, quality: Quality) -> Result<Started, String> {
        let next = Pipeline::open(self.gpu.clone(), target, quality)?;
        *self = next;
        Ok(self.started())
    }

    /// One tick: answers the encoder and feeds it the newest picture when it
    /// has room. Returns whether a picture went in.
    fn step(&mut self, pts: u64, keyframe: bool, sink: &Sink) -> WinResult<bool> {
        self.encoder.pump(sink)?;
        if self.encoder.credits == 0 {
            return Ok(false);
        }
        let surface = {
            let latest = self.capture.latest.lock();
            let Some(latest) = latest.as_ref() else { return Ok(false) };
            let output = (self.encoder.width, self.encoder.height);
            let input = (latest.width, latest.height);
            if self.converter.as_ref().is_none_or(|c| c.input != input || c.output != output) {
                self.converter = Some(Converter::new(&self.gpu, input, output, self.fps)?);
            }
            let surface = self.surfaces[self.next_surface].clone();
            self.next_surface = (self.next_surface + 1) % self.surfaces.len();
            self.converter.as_ref().unwrap().convert(&latest.texture, &surface)?;
            surface
        };
        let fed = self.encoder.encode(&surface, pts, keyframe)?;
        self.encoder.pump(sink)?;
        Ok(fed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_narrower_picture_is_centered_with_bars() {
        let r = letterbox((1000, 1000), (1920, 1080));
        assert_eq!((r.left, r.top, r.right, r.bottom), (420, 0, 1500, 1080));
    }

    #[test]
    fn a_keyframe_without_parameters_is_noticed() {
        assert!(has_sps(&[0, 0, 0, 1, 0x67, 1, 0, 0, 1, 0x65]));
        assert!(!has_sps(&[0, 0, 0, 1, 0x65, 9]));
    }
}
