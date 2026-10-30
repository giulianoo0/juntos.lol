//! Windows: each app's sound on its own (WASAPI process loopback), summed.
//!
//! One loopback client per process that holds an audio session, unless its
//! app is muted or it is this app or one of its webviews. Every 10 ms each
//! client's samples are drained into its ring and one block is mixed out; the
//! session list is read again every 2 s, so an app that starts playing later
//! joins and a restarted Discord stays muted.

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use windows::core::{implement, Interface, Ref, Result as WinResult, HRESULT, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Media::Audio::{
    eRender, ActivateAudioInterfaceAsync, AudioSessionStateExpired, IActivateAudioInterfaceAsyncOperation, IActivateAudioInterfaceCompletionHandler,
    IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient, IAudioSessionControl2, IAudioSessionManager2,
    IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, AUDIOCLIENT_ACTIVATION_PARAMS,
    AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, DEVICE_STATE_ACTIVE,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX, WAVE_FORMAT_PCM,
};
use windows::Win32::Media::{timeBeginPeriod, timeEndPeriod};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, IAgileObject, IAgileObject_Impl, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows::Win32::System::Threading::CreateEventW;

use super::mix::{mix, Ring};
use super::{app_id, ours, Muted, Proc, Sink, BLOCK_FRAMES, SAMPLE_RATE};

const CHANNELS: usize = 2;
const BLOCK: usize = BLOCK_FRAMES * CHANNELS;
/// How much of an app's sound may wait for the mixer before the oldest goes.
const RING: usize = BLOCK * 20;
const RESCAN: Duration = Duration::from_secs(2);

/// Every process on the machine, for walking parents.
pub fn processes() -> Vec<Proc> {
    let mut out = Vec::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
        while more {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            let exe = String::from_utf16_lossy(&entry.szExeFile[..len]);
            out.push(Proc { pid: entry.th32ProcessID, parent: entry.th32ParentProcessID, id: app_id(&exe), name: exe });
            more = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
    }
    out
}

/// The processes holding an audio session on any active output, system
/// sounds aside.
pub fn sessions() -> WinResult<Vec<Proc>> {
    let _com = Com::init();
    let procs = processes();
    let mut out: Vec<Proc> = Vec::new();
    unsafe {
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let devices = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
        for d in 0..devices.GetCount()? {
            let device = devices.Item(d)?;
            let manager = match device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) {
                Ok(manager) => manager,
                Err(e) => {
                    tracing::debug!(device = d, error = %e, "no session manager");
                    continue;
                }
            };
            let list = manager.GetSessionEnumerator()?;
            for s in 0..list.GetCount()? {
                let control: IAudioSessionControl2 = list.GetSession(s)?.cast()?;
                if control.IsSystemSoundsSession() == HRESULT(0) || control.GetState()? == AudioSessionStateExpired {
                    continue;
                }
                let pid = control.GetProcessId().unwrap_or(0);
                tracing::debug!(device = d, pid, state = ?control.GetState(), "audio session");
                if pid == 0 || out.iter().any(|p| p.pid == pid) {
                    continue;
                }
                if let Some(p) = procs.iter().find(|p| p.pid == pid) {
                    out.push(p.clone());
                }
            }
        }
    }
    Ok(out)
}

struct Com(bool);

impl Com {
    fn init() -> Com {
        Com(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok())
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
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
        let dirty = Arc::new(AtomicBool::new(true));
        let stop = Arc::new(AtomicBool::new(false));
        let thread = std::thread::Builder::new()
            .name("screen-audio".into())
            .spawn({
                let (muted, dirty, stop) = (muted.clone(), dirty.clone(), stop.clone());
                move || run(muted, dirty, stop, sink)
            })
            .map_err(|e| format!("audio_failed: {e}"))?;
        Ok(Audio { muted, dirty, stop, thread: Some(thread) })
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

struct Client {
    id: String,
    audio: IAudioClient,
    capture: IAudioCaptureClient,
    event: HANDLE,
    ring: Ring,
}

impl Drop for Client {
    fn drop(&mut self) {
        unsafe {
            let _ = self.audio.Stop();
            let _ = CloseHandle(self.event);
        }
    }
}

impl Client {
    fn drain(&mut self) -> WinResult<()> {
        unsafe {
            while self.capture.GetNextPacketSize()? > 0 {
                let mut data: *mut u8 = std::ptr::null_mut();
                let mut frames = 0u32;
                let mut flags = 0u32;
                self.capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
                let samples = frames as usize * CHANNELS;
                if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                    self.ring.push(&vec![0; samples]);
                } else {
                    self.ring.push(std::slice::from_raw_parts(data as *const i16, samples));
                }
                self.capture.ReleaseBuffer(frames)?;
            }
        }
        Ok(())
    }
}

fn run(muted: Arc<Mutex<Muted>>, dirty: Arc<AtomicBool>, stop: Arc<AtomicBool>, sink: Sink) {
    let _com = Com::init();
    unsafe { timeBeginPeriod(1) };
    let mut clients: HashMap<u32, Client> = HashMap::new();
    let mut last_scan = Instant::now() - RESCAN;
    let period = Duration::from_millis(10);
    let mut next = Instant::now();
    while !stop.load(Ordering::Acquire) {
        if dirty.swap(false, Ordering::AcqRel) || last_scan.elapsed() >= RESCAN {
            last_scan = Instant::now();
            rescan(&mut clients, &muted.lock());
        }
        clients.retain(|pid, client| match client.drain() {
            Ok(()) => true,
            Err(e) => {
                tracing::info!(pid, id = %client.id, error = %e, "app sound ended");
                false
            }
        });
        let blocks: Vec<Vec<i16>> = clients.values_mut().map(|c| c.ring.take(BLOCK)).collect();
        let refs: Vec<&[i16]> = blocks.iter().map(Vec::as_slice).collect();
        let mut out = if refs.is_empty() { vec![0; BLOCK] } else { mix(&refs) };
        out.resize(BLOCK, 0);
        sink(out.iter().flat_map(|s| s.to_le_bytes()).collect());
        next += period;
        let now = Instant::now();
        if next > now {
            std::thread::sleep(next - now);
        } else if now - next > period * 5 {
            next = now;
        }
    }
    clients.clear();
    unsafe { timeEndPeriod(1) };
}

fn rescan(clients: &mut HashMap<u32, Client>, muted: &Muted) {
    let Ok(sessions) = sessions() else { return };
    let procs = processes();
    let wanted: Vec<&Proc> = sessions.iter().filter(|p| !muted.blocks(&p.id) && !ours(p.pid, &procs)).collect();
    clients.retain(|pid, _| wanted.iter().any(|p| p.pid == *pid));
    for p in wanted {
        if clients.contains_key(&p.pid) {
            continue;
        }
        match open(p.pid) {
            Ok((audio, capture, event)) => {
                tracing::info!(pid = p.pid, id = %p.id, "app sound joined");
                clients.insert(p.pid, Client { id: p.id.clone(), audio, capture, event, ring: Ring::new(RING) });
            }
            Err(e) => tracing::warn!(pid = p.pid, id = %p.id, error = %e, "app sound refused"),
        }
    }
}

#[implement(IActivateAudioInterfaceCompletionHandler, IAgileObject)]
struct Activated(Mutex<Option<mpsc::Sender<()>>>);

impl IActivateAudioInterfaceCompletionHandler_Impl for Activated_Impl {
    fn ActivateCompleted(&self, _operation: Ref<'_, IActivateAudioInterfaceAsyncOperation>) -> WinResult<()> {
        if let Some(done) = self.0.lock().take() {
            let _ = done.send(());
        }
        Ok(())
    }
}

impl IAgileObject_Impl for Activated_Impl {}

/// PROPVARIANT holding a VT_BLOB, laid out as the system reads it.
#[repr(C)]
struct BlobVariant {
    vt: u16,
    reserved: [u16; 3],
    size: u32,
    data: *const c_void,
}

const VT_BLOB: u16 = 65;

fn open(pid: u32) -> WinResult<(IAudioClient, IAudioCaptureClient, HANDLE)> {
    unsafe {
        let params = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: pid,
                    ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
                },
            },
        };
        let blob = BlobVariant {
            vt: VT_BLOB,
            reserved: [0; 3],
            size: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
            data: &params as *const _ as *const c_void,
        };
        let (done, wait) = mpsc::channel();
        let handler: IActivateAudioInterfaceCompletionHandler = Activated(Mutex::new(Some(done))).into();
        let operation = ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&blob as *const BlobVariant as *const _),
            &handler,
        )?;
        wait.recv_timeout(Duration::from_secs(3)).map_err(|_| windows::core::Error::from(HRESULT(0x8000_000Au32 as i32)))?;
        let mut result = HRESULT(0);
        let mut unknown = None;
        operation.GetActivateResult(&mut result, &mut unknown)?;
        result.ok()?;
        let audio: IAudioClient = unknown.ok_or_else(|| windows::core::Error::from(HRESULT(0x8000_4005u32 as i32)))?.cast()?;
        let format = WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_PCM as u16,
            nChannels: CHANNELS as u16,
            nSamplesPerSec: SAMPLE_RATE,
            nAvgBytesPerSec: SAMPLE_RATE * 4,
            nBlockAlign: 4,
            wBitsPerSample: 16,
            cbSize: 0,
        };
        audio.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            2_000_000,
            0,
            &format,
            None,
        )?;
        let event = CreateEventW(None, false, false, PCWSTR::null())?;
        audio.SetEventHandle(event)?;
        let capture: IAudioCaptureClient = audio.GetService()?;
        audio.Start()?;
        Ok((audio, capture, event))
    }
}
