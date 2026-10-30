# Compartilhar tela pelo app — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a pessoa compartilha tela ou janela pelo app desktop, com H.264 por hardware e som escolhido app a app, e troca tudo ao vivo.

**Architecture:** o app captura e codifica no Rust (Windows: Windows.Graphics.Capture + encoder H.264 do Media Foundation; Mac: o caminho ScreenCaptureKit → VideoToolbox do jlocal) e entrega à página por Tauri `Channel`. Os quadros usam o mesmo formato do jlocal (u32 tamanho BE, u64 pts µs, 1 byte de flags, Annex-B), e o áudio é PCM s16le 48 kHz estéreo. A página reaproveita `FrameParser`, `publishEncodedScreen` e a máquina de `useScreenShare`, trocando só a origem (o app em vez do jlocal) e o seletor (opção A).

**Tech Stack:** Tauri v2 (Rust), crate `windows` (WGC, D3D11, Media Foundation, WASAPI process loopback), `objc2-screen-capture-kit` no Mac; React + `@tauri-apps/api/core` (`Channel`) no site.

**Spec:** `docs/superpowers/specs/2026-10-30-app-screenshare-design.md`

## Global Constraints

- Hello feature `screenCapture` só no Windows e no Mac (`site.rs`); no Linux o recurso não aparece.
- O processo do próprio app (e seus filhos WebView2/WebKit) nunca entra no áudio.
- `discord` começa desligado no seletor de som.
- Ids de app = nome do executável em minúsculas, sem `.exe` (`discord`, `valorant`, `chrome`). Isso sobrevive a reinícios do app.
- Cópia sem subdescrição (CLAUDE.md): rótulos sozinhos e dica no ícone. Menus e popovers com o spring popover (`--ease-spring-pop`, 600 ms / `--ease-spring-settle`, 360 ms).
- Commits só com a linha de assunto, direto na main.
- Testes manuais agora só no Windows: `ssh giuli@windows-machine` (PowerShell; usuário `giuli` logado no console, sessão 1). O Mac só precisa compilar (`cargo check --target aarch64-apple-darwin`).

## Review Focus

1. Discord fechado e reaberto durante a transmissão → continua mudo (casa pelo id, não pelo PID); um app que começa a tocar depois → aparece na lista em até 2 s.
2. A voz da sala tocando no próprio app → nunca sai no áudio transmitido.
3. A janela compartilhada é minimizada → mantém o último quadro; a janela é fechada → a transmissão para com o erro `source_closed`, sem travar a sala.
4. A resolução ou o tamanho da janela muda → o encoder se reconfigura e manda um keyframe; quem assiste não fica com a tela verde ou congelada.
5. Alguém entra tarde → recebe um keyframe em até 2 s (GOP ≤ 2 s).

---

### Task 1: Captura nativa no app (Rust)

**Files:**
- Create: `desktop/src-tauri/src/screen/mod.rs` (comandos, estado, framing), `screen/windows.rs` (WGC + MF H.264), `screen/win_audio.rs` (WASAPI por processo + mixer), `screen/macos.rs` (porte de `~/projects/jlocal/src/h264.rs` e `audio_engine.rs`), `screen/mix.rs` (mixer s16 puro, testável)
- Modify: `desktop/src-tauri/src/lib.rs` (registrar comandos, permissão na capability "site"), `site.rs` (feature `screenCapture`), `Cargo.toml` (features do crate `windows`: `Graphics_Capture`, `Win32_Graphics_Direct3D11`, `Win32_Media_MediaFoundation`, `Win32_Media_Audio`, `Win32_System_ProcessStatus`, `Win32_UI_Shell`; no Mac, `objc2-screen-capture-kit`, `objc2-core-media`, `objc2-video-toolbox`)
- Test: `#[cfg(test)]` em `screen/mod.rs` e `screen/mix.rs`

**Interfaces:**
- Produces (comandos Tauri, todos `async`, erros como `String` com código antes de `:`):
  - `screen_sources() -> Sources` = `{ displays: [{id, name, width, height}], windows: [{id, title, app, icon}] }`; `icon` é PNG em data URL (64 px), tirado do executável no Windows e do `NSRunningApplication` no Mac.
  - `screen_thumbnail(kind: "display"|"window", id: String, width: u32) -> String` (data URL JPEG).
  - `audio_apps() -> [{id, name, icon}]`: apps com sessão de áudio agora, sem o próprio app, mais `{id:"system", name:"Sons do sistema"}`.
  - `screen_start(target: {kind, id}, quality: {width, height, fps, bitrate}, frames: Channel) -> {width, height, fps}`, `screen_switch(target)`, `screen_quality(quality)`, `screen_stop()`. Cada mensagem no `frames` é `InvokeResponseBody::Raw` com um quadro no formato do jlocal; o primeiro após start, switch ou quality é keyframe.
  - `audio_start(muted: Vec<String>, pcm: Channel)`, `audio_set(muted: Vec<String>)`, `audio_stop()`: blocos de 10 ms em PCM s16le 48 kHz estéreo, `Raw`.
  - Erro `source_closed` chega como o quadro de flag `0x2` (fim) no `frames`.

- [ ] **Step 1: Testes que falham**

```rust
#[test] fn a_frame_is_framed_like_jlocal() {
    let f = frame(1_500, true, &[0, 0, 0, 1, 0x65]);
    assert_eq!(&f[..4], &5u32.to_be_bytes()); assert_eq!(&f[4..12], &1_500u64.to_be_bytes()); assert_eq!(f[12], 1); assert_eq!(&f[13..], &[0, 0, 0, 1, 0x65]);
}
#[test] fn the_mix_clamps_instead_of_wrapping() { assert_eq!(mix(&[&[30_000i16], &[30_000]]), vec![i16::MAX]); }
#[test] fn a_muted_app_stays_out_by_name_not_pid() {
    assert_eq!(app_id(Path::new(r"C:\Users\x\AppData\Local\Discord\app-1.0\Discord.exe")), "discord");
    let muted = Muted::from(vec!["discord".to_string()]);
    assert!(muted.blocks("discord")); assert!(!muted.blocks("valorant"));
}
#[test] fn the_app_itself_is_never_in_the_list() {
    assert!(audible(&[proc(std::process::id(), "juntos"), proc(4242, "chrome")]).iter().all(|a| a.id != "juntos"));
}
#[test] fn screen_capture_is_offered_on_windows_and_mac() {
    assert_eq!(site::features().contains(&"screenCapture"), cfg!(any(windows, target_os = "macos")));
}
```

`app_id(exe: &Path) -> String` usa o nome do produto do recurso de versão do executável, em minúsculas e sem espaços (`VALORANT-Win64-Shipping.exe` → `valorant`); sem recurso, o nome do arquivo sem extensão. `audible(procs: &[Proc]) -> Vec<AudioApp>` tira o próprio PID e os descendentes dele.

- [ ] **Step 2: Rodar e ver falhar:** `cargo test -p juntos screen` → erros de símbolo não definido.
- [ ] **Step 3: Implementar `frame`, `mix`, `Muted`, `app_id`, `audible` e a feature `screenCapture`; rodar os testes até passar.**
- [ ] **Step 4: Windows, vídeo.** Em `windows.rs`: `GraphicsCaptureItem` de monitor (`CreateForMonitor`) ou janela (`CreateForWindow`) por `IGraphicsCaptureItemInterop`, com o frame pool em `B8G8R8A8` e `IsCursorCaptureEnabled = true`. O `ID3D11VideoProcessor` converte para NV12 na GPU e escala para a qualidade. O encoder é o MFT de hardware (`MFTEnumEx` com `MFT_ENUM_FLAG_HARDWARE`, async; na falta dele, o software): `CODECAPI_AVLowLatencyMode`, `eAVEncCommonRateControlMode_CBR`, GOP = 2×fps, sem B-frames, perfil High. Keyframe forçado com `CODECAPI_AVEncVideoForceKeyFrame` em start, switch, mudança de tamanho e a cada 2 s. O switch troca o item sem recriar o encoder quando o tamanho de saída é o mesmo.
- [ ] **Step 5: Windows, áudio.** Em `win_audio.rs`: `IAudioSessionManager2` lista as sessões ativas a cada 2 s. Para cada processo audível, sem mute e diferente do próprio app (nem descendente dele), abre um cliente de loopback com `ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE)`. `system` é o loopback do dispositivo padrão, filtrado só para a sessão de sons do sistema. Tudo é convertido para 48 kHz s16 e somado por `mix` em blocos de 10 ms. `audio_set` só liga e desliga clientes, sem cortar o stream.
- [ ] **Step 6: Mac (só compilar).** Portar `jlocal/src/h264.rs` (SCK → VT) e o áudio do `audio_engine.rs` com o `SCContentFilter` excluindo os apps mudos e o próprio app. Conferir com `cargo check --target aarch64-apple-darwin` sem warnings novos.
- [ ] **Step 7: Toolchain no Windows.** `ssh giuli@windows-machine`: se `cargo` não existir, `winget install Rustlang.Rustup` e os Build Tools do VS 2022 (workload C++). Clonar a main em `C:\src\juntos` e rodar `cargo test -p juntos screen` lá → PASS.
- [ ] **Step 8: Prova no Windows.** Um exemplo `desktop/src-tauri/examples/screen_probe.rs` captura a tela principal por 5 s a 1080p60 e grava `probe.h264` e `probe.pcm`. Rodar na sessão do console (`schtasks /create /sc once /it /tn probe ...` + `schtasks /run`, porque um processo GUI iniciado pelo ssh roda na sessão 0, sem tela). Copiar para o Mac e conferir com `ffprobe -count_frames probe.h264`: ≥ 290 quadros e keyframe a cada ≤ 120. No áudio, com o Chrome tocando e `discord` mudo, `probe.pcm` tem sinal e um tom tocado no Discord não aparece (`ffmpeg -f s16le -ar 48000 -ac 2 -i probe.pcm -af astats`).
- [ ] **Step 9: Commit** `feat: app captura tela e janela com H.264 por hardware e som por app (Windows; Mac compila)`

### Task 2: Seletor A e transmissão pelo app (site)

**Files:**
- Create: `web/src/desktop/screen.ts` (fonte do app: `startAppFeed`, `appAudioTrack`, `appSources`, `appAudioApps`), `web/src/screen/AppScreenPicker.tsx` + `.module.css`, `web/src/desktop/screen.test.ts`, `web/src/screen/AppScreenPicker.test.tsx`
- Modify: `web/src/screen/useScreenShare.ts` (a origem `jlocalRef` vira uma `EncodedOrigin` que pode ser o jlocal ou o app; `startWithJlocal`/`switchJlocal` passam a valer para os dois; o app tem prioridade quando `desktop().features` contém `screenCapture`), `web/src/screen/ScreenStage.tsx` e `SoundMenu.tsx` (barra ao vivo: Trocar fonte, Som com os interruptores por app, Qualidade e Parar), `web/src/jlocal/soundChoice.ts` (`muted` passa a começar com `["discord"]`; a escolha vale para os dois caminhos), `web/src/pages/Room.tsx` (abre o `AppScreenPicker` no lugar do `JlocalPicker` quando o app oferece `screenCapture`), i18n `pt-BR.ts`/`en.ts`, `web/package.json` (`@tauri-apps/api` no mesmo minor do Tauri do app)

**Interfaces:**
- Consumes: os comandos da Task 1, exatamente como no bloco Produces dela.
- Produces:
  - `startAppFeed(options: H264FeedOptions): Promise<H264Feed>`: mesma interface do jlocal, com `open(onFrame, onEnd)` lendo um `Channel<ArrayBuffer>` pelo `FrameParser`.
  - `appAudioTrack(muted: string[]): SystemAudio & { setMuted(muted: string[]): void }`.
  - `AppScreenPicker({ onPick, onExit, busy, error, mode, t })`, com as mesmas props do `JlocalPicker`; `onPick(pick: JlocalPick & { muted: string[] })`.

- [ ] **Step 1: Testes que falham**

```ts
it('turns the app channel into the same frames as jlocal', async () => {
  // invoke falso: screen_start recebe o Channel e envia um quadro keyframe pts 1500
  const feed = await startAppFeed({ target: { kind: 'display', id: '1' }, width: 1920, height: 1080, fps: 60 })
  const frames: EncodedFrame[] = []; feed.open((f) => frames.push(f), () => {})
  expect(frames[0]).toMatchObject({ keyframe: true, timestamp: 1500 })
})
it('ends the feed when the app says the source closed', ...) // flag 0x2 → onEnd chamado uma vez
it('sends the new mute list live without restarting audio', ...) // setMuted(['discord','spotify']) → invoke('audio_set', {muted:[...]}), nenhum audio_stop
it('starts with Discord muted', ...) // getSoundChoice().muted contém 'discord' num localStorage vazio
it('shows windows with the real app icon and the sound panel beside them', ...) // AppScreenPicker: abas "Telas"/"Janelas", img com src = icon, interruptor "Discord" desligado, botão "Silenciar tudo"
it('picks the app over jlocal when the app can capture', ...) // useScreenShare com desktop features ['screenCapture'] chama startAppFeed, não startH264Feed
```

- [ ] **Step 2: Rodar e ver falhar:** `npx vitest run src/desktop/screen.test.ts src/screen/AppScreenPicker.test.tsx` → FAIL.
- [ ] **Step 3: Implementar** `screen.ts` com o `Channel` de `@tauri-apps/api/core` (import dinâmico, para não pesar no navegador) e o PCM pelo mesmo agendamento de `systemAudioTrack` (extrair um `pcmTrack(onChunk)` comum em `h264Feed.ts` em vez de copiar). O `AppScreenPicker` segue o artboard A: miniaturas de `screen_thumbnail` atualizadas a cada 2 s enquanto aberto, lista de `audio_apps` a cada 2 s, e qualidade num `MorphingMenu` com os presets de `screenshare.ts`. Na barra ao vivo, "Som" abre um popover com os mesmos interruptores, que chama `setMuted` na hora; "Trocar fonte" reabre o seletor em `mode="switch"`.
- [ ] **Step 4: Rodar** `npx vitest run src/desktop src/screen src/jlocal` e `npm run build` → PASS, sem erro de tipo.
- [ ] **Step 5: E2E no Windows.** No Mac, subir o servidor local com os `MOQ_*` do `.env` local (stack em `memory/e2e-local.md`) escutando no IP da tailnet. Buildar o app no Windows (`npx tauri build --debug --bundles nsis` em `C:\src\juntos\desktop`) e abri-lo na sessão do console com `JUNTOS_URL=http://<ip-do-mac>:8090` via `schtasks /it`. Num Chrome do Mac (Playwright, `web/dev/e2e-screen.mjs` como viewer), entrar na sala. Pelo ssh, acionar a página do app pelos nomes acessíveis dos botões (UIAutomation do .NET sobre o WebView2, num script PowerShell rodado na sessão do console) e conferir a tela com capturas `CopyFromScreen` copiadas para o Mac. Compartilhar a janela do Chrome com um vídeo tocando e o Discord tocando um tom. Esperado: o viewer mede luminância > 0 no canvas e ≥ 55 fps no `getVideoPlaybackQuality`/contador do decoder; o áudio recebido tem o vídeo e não o tom; desligar "Google Chrome" ao vivo zera o áudio em ≤ 1 s; "Trocar fonte" para a tela inteira chega sem tela verde.
- [ ] **Step 6: Commit** `feat: compartilhar tela pelo app com seletor de janelas e som por app`
- [ ] **Step 7: Release.** Versão nova do app (tauri.conf.json + Cargo.toml, `NOTAS.md`: "Novidade: compartilhe uma tela ou janela pelo app e escolha o som de cada app."), deploy do site com o `/api/live` vazio, e só depois a tag `desktop-v<versão>` (o site precisa estar no ar antes do app que anuncia `screenCapture`).
