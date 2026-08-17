# ss.giuli.dev Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an ephemeral watch-together app: upload a video (up to 10 GB, multi audio/sub tracks), share a link, watch in sync with chat and screen share; everything deleted after max 5h.

**Architecture:** Go + Gin backend: embedded tusd upload, ffmpeg remux to HLS fMP4 served as static files over HTTP, WebSocket hub for sync/chat/presence, Redis for room state with TTL + sweeper for disk cleanup, LiveKit SFU for screen share. React + Vite + TS frontend with hls.js and Uppy.

**Tech Stack:** Go 1.23+, Gin, tusd v2, go-redis/v9, gorilla/websocket, miniredis/v2, ffmpeg 7.x, livekit/protocol; React 18, Vite, TypeScript, hls.js, Uppy, livekit-client, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-17-ss-giuli-dev-design.md`

## Global Constraints

- Commit messages and README in English.
- UI copy: pt-BR and en, simple labels, no em dash in interface text.
- Media bytes travel over HTTP/HLS only; WebSocket carries signaling and chat only.
- Nothing persists past the room TTL: files live in `/data/rooms/{id}` and are deleted by the sweeper.
- Limits (env-configurable): 10 GB upload, 20 participants per room, 5h room TTL, 10 min idle expiry, 2 concurrent ffmpeg jobs.
- Redis runs with `maxmemory-policy volatile-ttl` in compose.
- Every video/codec/flag cited targets ffmpeg 7.x.

---

### Task 1: Project scaffold, config, compose, Dockerfile

**Files:**
- Create: `go.mod`, `cmd/server/main.go`, `internal/config/config.go`, `internal/config/config_test.go`
- Create: `docker-compose.yml`, `Dockerfile`, `.dockerignore`

**Interfaces:**
- Produces: `config.Config` struct and `func Load() (Config, error)` reading env with defaults:
  `PORT=8080`, `DATA_DIR=/data`, `REDIS_URL=redis://localhost:6379`, `MAX_UPLOAD_MB=10240`,
  `ROOM_TTL_HOURS=5`, `MAX_PARTICIPANTS=20`, `ROOM_IDLE_MINUTES=10`, `FFMPEG_JOBS=2`,
  `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.

- [ ] **Step 1: Failing test** — `internal/config/config_test.go`:

```go
func TestLoadDefaults(t *testing.T) {
	t.Setenv("REDIS_URL", "")
	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, 8080, cfg.Port)
	require.Equal(t, int64(10240), cfg.MaxUploadMB)
	require.Equal(t, 2, cfg.FFmpegJobs)
}
```

- [ ] **Step 2: Run** — `go test ./internal/config/ -v` → FAIL (package does not exist).
- [ ] **Step 3: Implement** `config.go` with `Load()` using `os.Getenv` + `strconv`, struct fields exactly as in Interfaces. Implement `main.go` calling `Load()` and starting a Gin engine with `GET /healthz` returning `{"ok":true}`.
- [ ] **Step 4: Run** — `go test ./internal/config/ -v` → PASS. `go run ./cmd/server` then `curl localhost:8080/healthz`.
- [ ] **Step 5: Docker** — multi-stage `Dockerfile` (golang:1.23-bookworm build, debian:bookworm-slim runtime + `apt-get install -y ffmpeg`), `docker-compose.yml` with services `app`, `redis` (`redis:7-alpine`, command `redis-server --maxmemory-policy volatile-ttl`), `livekit` (`livekit/livekit-server`, `--dev` behind env flag), volume `ss-data:/data`. `.dockerignore`: `data/`, `web/node_modules`, `.git`.
- [ ] **Step 6: Commit**

```bash
git add go.mod go.sum cmd internal docker-compose.yml Dockerfile .dockerignore
git commit -m "feat: project scaffold with config, health endpoint, docker compose"
```

---

### Task 2: Room store on Redis

**Files:**
- Create: `internal/room/types.go`, `internal/room/store.go`, `internal/room/store_test.go`

**Interfaces:**
- Produces (later tasks consume these exact signatures):

```go
type TrackInfo struct { Index int; Language, Title, Codec string }
type ChatMessage struct { Author, Text string; At time.Time }
type Member struct { ID, Nickname string; JoinedAt time.Time }
type PlayState struct { Playing bool; PositionMs int64; Rate float64; ServerTimeMs int64 }
type Room struct {
	ID, FileName, Status, ControllerID string
	AudioTracks, SubtitleTracks []TrackInfo
	BitmapSubsSkipped int
	CreatedAt, ExpiresAt time.Time
}
func NewStore(rdb *redis.Client, ttl time.Duration) *Store
func (s *Store) Create(ctx context.Context, r *Room) error
func (s *Store) Get(ctx context.Context, id string) (*Room, error)
func (s *Store) SetStatus(ctx context.Context, id, status string) error
func (s *Store) SetTracks(ctx context.Context, id string, audio, subs []TrackInfo, bitmapSkipped int) error
func (s *Store) SetState(ctx context.Context, id string, st PlayState) error
func (s *Store) GetState(ctx context.Context, id string) (PlayState, error)
func (s *Store) AddMember(ctx context.Context, id string, m Member) error
func (s *Store) RemoveMember(ctx context.Context, id, memberID string) error
func (s *Store) Members(ctx context.Context, id string) ([]Member, error)
func (s *Store) AddMessage(ctx context.Context, id string, m ChatMessage) error
func (s *Store) Messages(ctx context.Context, id string) ([]ChatMessage, error)
func (s *Store) Delete(ctx context.Context, id string) error
func (s *Store) ExpiredIDs(ctx context.Context, now time.Time) ([]string, error)
```

- Keys: `room:{id}` (hash, JSON-encoded slices), `room:{id}:state`, `room:{id}:chat` (list, `LTRIM` to 200), `room:{id}:members` (hash), `rooms:by_expiry` (ZSET score=`ExpiresAt.Unix()`). All keys get `EXPIRE` = ttl.

- [ ] **Step 1: Failing test** — `store_test.go` with miniredis:

```go
func TestCreateGetRoundTrip(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	s := NewStore(rdb, 5*time.Hour)
	r := &Room{ID: "abc", FileName: "movie.mkv", Status: "uploading",
		ControllerID: "m1", CreatedAt: time.Now(), ExpiresAt: time.Now().Add(5 * time.Hour)}
	require.NoError(t, s.Create(context.Background(), r))
	got, err := s.Get(context.Background(), "abc")
	require.NoError(t, err)
	require.Equal(t, "movie.mkv", got.FileName)
	require.Equal(t, "uploading", got.Status)
	ttl := mr.TTL("room:abc")
	require.Greater(t, ttl, 4*time.Hour)
}

func TestChatCappedAt200(t *testing.T) { /* add 210 messages, Messages() returns 200, oldest dropped */ }
```

- [ ] **Step 2: Run** — `go test ./internal/room/ -v` → FAIL.
- [ ] **Step 3: Implement** `types.go` + `store.go`. JSON-marshal `AudioTracks`/`SubtitleTracks` into hash fields. `AddMessage`: `RPUSH` + `LTRIM key -200 -1` + `EXPIRE`. `ExpiredIDs`: `ZRANGEBYSCORE rooms:by_expiry -inf <now.Unix()>`.
- [ ] **Step 4: Run** — `go test ./internal/room/ -v` → PASS.
- [ ] **Step 5: Commit**

```bash
git add internal/room
git commit -m "feat: redis room store with TTL, chat cap, members, play state"
```

---

### Task 3: Sweeper (disk + Redis cleanup)

**Files:**
- Create: `internal/room/sweeper.go`, `internal/room/sweeper_test.go`

**Interfaces:**
- Consumes: `Store.ExpiredIDs`, `Store.Delete` (Task 2).
- Produces: `func StartSweeper(ctx context.Context, store *Store, dataDir string, interval time.Duration)` — ticks every `interval`, deletes `/data/rooms/{id}` (`os.RemoveAll`) then `store.Delete` for each expired id, and `ZREM` from `rooms:by_expiry` (done inside `Delete`).

- [ ] **Step 1: Failing test**:

```go
func TestSweeperRemovesExpiredRoom(t *testing.T) {
	mr := miniredis.RunT(t)
	s := NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}), time.Hour)
	dir := t.TempDir()
	r := &Room{ID: "old", Status: "ready", ExpiresAt: time.Now().Add(-time.Minute), CreatedAt: time.Now().Add(-2 * time.Hour)}
	require.NoError(t, s.Create(context.Background(), r))
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "rooms", "old"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "rooms", "old", "f"), []byte("x"), 0o644))
	sweepOnce(context.Background(), s, dir) // extracted tick body, exported for tests as package-private
	_, err := os.Stat(filepath.Join(dir, "rooms", "old"))
	require.True(t, os.IsNotExist(err))
	_, err = s.Get(context.Background(), "old")
	require.Error(t, err)
}
```

Note: `miniredis.FastForward` is not needed since `ExpiresAt` is already past; `ExpiredIDs` compares against `time.Now()`.

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `sweepOnce(ctx, store, dataDir)` + `StartSweeper` wrapping it in a `time.Ticker` loop that stops on `ctx.Done()`. Make `Delete` also `ZREM rooms:by_expiry`.
- [ ] **Step 4: Run** — `go test ./internal/room/ -v` → PASS.
- [ ] **Step 5: Wire into main** — in `cmd/server/main.go`: dial Redis (`redis.ParseURL(cfg.RedisURL)`), `NewStore`, `go StartSweeper(ctx, store, cfg.DataDir, time.Minute)`.
- [ ] **Step 6: Commit**

```bash
git add internal/room cmd/server
git commit -m "feat: sweeper deletes expired rooms from disk and redis"
```

---

### Task 4: tus upload wiring + room creation flow

**Files:**
- Create: `internal/upload/tus.go`, `internal/httpapi/rooms.go`, `internal/httpapi/rooms_test.go`
- Modify: `cmd/server/main.go`

**Interfaces:**
- Consumes: `config.Config`, `room.Store` (Tasks 1-2).
- Produces:
  - `func NewTusHandler(cfg config.Config, store *room.Store, onComplete func(roomID string)) (http.Handler, error)` — tusd handler with file store at `{DataDir}/rooms`, max size `cfg.MaxUploadMB << 20`. Uploads are created with meta `roomID`; on completion the file is moved to `{DataDir}/rooms/{id}/original.{ext}` and `onComplete(roomID)` fires.
  - `POST /api/rooms` → body `{"fileName": "...", "nickname": "..."}` → creates `Room{ID: <8-char nanoid>, Status: "uploading", ControllerID: <member id>}`, registers member, returns `{"id", "uploadEndpoint": "/api/upload/", "expiresAt"}`. Uses `github.com/matoous/go-nanoid/v2`.
  - `GET /api/rooms/:id` → room JSON incl. tracks, status, member count; 404 with `{"error": "room_not_found"}` if missing.

- [ ] **Step 1: Failing test** — `rooms_test.go` with `httptest` + miniredis-backed store:

```go
func TestCreateRoom(t *testing.T) {
	s := newTestStore(t) // helper: miniredis + NewStore
	e := gin.New()
	RegisterRoomRoutes(e.Group("/api"), s, testCfg())
	w := httptest.NewRecorder()
	body := `{"fileName":"movie.mkv","nickname":"giuli"}`
	req := httptest.NewRequest("POST", "/api/rooms", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	e.ServeHTTP(w, req)
	require.Equal(t, 201, w.Code)
	var resp struct{ ID, UploadEndpoint string }
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	require.Len(t, resp.ID, 8)
	got, _ := s.Get(context.Background(), resp.ID)
	require.Equal(t, "uploading", got.Status)
}
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `rooms.go` (`RegisterRoomRoutes(rg *gin.RouterGroup, store *room.Store, cfg config.Config)`) and `tus.go` (tusd `NewHandler` with `Config.BasePath: "/api/upload/"`, `StoreComposer` using `filestore` at `{DataDir}/tus-incoming`; on `CompleteUploads` hook: read meta `roomID`, move file to `rooms/{id}/original.{ext}`, call `onComplete`). Guard: room must exist and be in `uploading`, else reject pre-create with 403.
- [ ] **Step 4: Run** — `go test ./internal/httpapi/ -v` → PASS. Manual: `curl -X POST localhost:8080/api/rooms -d '{"fileName":"a.mkv","nickname":"x"}'`.
- [ ] **Step 5: Commit**

```bash
git add internal/upload internal/httpapi cmd/server
git commit -m "feat: room creation and resumable tus upload"
```

---

### Task 5: ffprobe inventory parser

**Files:**
- Create: `internal/media/probe.go`, `internal/media/probe_test.go`

**Interfaces:**
- Consumes: `room.TrackInfo` (Task 2).
- Produces:

```go
type ProbeResult struct {
	DurationMs int64
	VideoCodec string            // e.g. "h264", "hevc", "vp9"
	VideoCopyable bool           // true if h264/hevc (browser-safe in fMP4)
	Audio []room.TrackInfo       // text-codec audio tracks in file order
	Subtitles []room.TrackInfo   // only text subs (subrip/ass/webvtt/mov_text)
	BitmapSubs int                // count of skipped bitmap subs (hdmv_pgs_subtitle, dvd_subtitle)
}
func Probe(ctx context.Context, path string) (*ProbeResult, error)
```

Runs `ffprobe -v error -print_format json -show_format -show_streams <path>` and parses.

- [ ] **Step 1: Failing test** — parse a checked-in golden JSON fixture `internal/media/testdata/probe-mkv.json` (craft it: one h264 video stream, two aac/ac3 audio streams with `tags.language` "eng"/"jpn", one subrip sub, one hdmv_pgs_subtitle sub, format duration "734.5"):

```go
func TestParseProbe(t *testing.T) {
	data, err := os.ReadFile("testdata/probe-mkv.json")
	require.NoError(t, err)
	p, err := parseProbe(data)
	require.NoError(t, err)
	require.Equal(t, int64(734500), p.DurationMs)
	require.Equal(t, "h264", p.VideoCodec)
	require.True(t, p.VideoCopyable)
	require.Len(t, p.Audio, 2)
	require.Equal(t, "jpn", p.Audio[1].Language)
	require.Len(t, p.Subtitles, 1)
	require.Equal(t, 1, p.BitmapSubs)
}
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `parseProbe([]byte) (*ProbeResult, error)` (pure, table-tested) + `Probe` wrapping `exec.CommandContext`. Map `codec_type`/`codec_name`; `VideoCopyable = codec=="h264" || codec=="hevc"`; `Index` fields are the stream positions within their own type (0-based per `audio`/`subtitle` order), matching ffmpeg's `0:a:N` / `0:s:N` specifiers.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit**

```bash
git add internal/media
git commit -m "feat: ffprobe inventory parser with track classification"
```

---

### Task 6: HLS remux command builder + runner

**Files:**
- Create: `internal/media/remux.go`, `internal/media/remux_test.go`

**Interfaces:**
- Consumes: `ProbeResult` (Task 5).
- Produces:

```go
func BuildRemuxArgs(in, outDir string, p *ProbeResult) []string // pure
func Remux(ctx context.Context, in, outDir string, p *ProbeResult) error // exec ffmpeg, returns stderr tail on error
```

- [ ] **Step 1: Failing test**:

```go
func TestBuildRemuxArgsMultiAudio(t *testing.T) {
	p := &ProbeResult{VideoCodec: "h264", VideoCopyable: true,
		Audio: []room.TrackInfo{{Index: 0, Language: "eng", Codec: "aac"}, {Index: 1, Language: "jpn", Codec: "ac3"}}}
	args := BuildRemuxArgs("/x/original.mkv", "/x/hls", p)
	joined := strings.Join(args, " ")
	require.Contains(t, joined, "-c:v copy")
	require.Contains(t, joined, "-map 0:v:0")
	require.Contains(t, joined, "-map 0:a:0")
	require.Contains(t, joined, "-map 0:a:1")
	require.Contains(t, joined, "a:0,agroup:audio,default:yes")
	require.Contains(t, joined, "a:1,agroup:audio")
	require.Contains(t, joined, "v:0,agroup:audio")
	require.Contains(t, joined, "-master_pl_name master.m3u8")
	require.Contains(t, joined, "-hls_segment_type fmp4")
	require.Contains(t, joined, "aac") // audio transcoded to aac
}
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**. Arg shape (ffmpeg 7.x):

```
ffmpeg -hide_banner -loglevel error -i <in> \
  -map 0:v:0 -c:v copy \
  -map 0:a:0 -c:a aac -b:a 192k \
  [-map 0:a:N -c:a aac -b:a 192k ...] \
  -f hls -hls_time 6 -hls_segment_type fmp4 -hls_playlist_type vod \
  -var_stream_map "a:0,agroup:audio,default:yes a:1,agroup:audio ... v:0,agroup:audio" \
  -master_pl_name master.m3u8 \
  <outDir>/stream_%v.m3u8
```

If `!p.VideoCopyable`: `-c:v libx264 -preset veryfast -crf 23` instead of copy. Segments land as `stream_%v_*.m4s` next to the playlists. `Remux` = `exec.CommandContext("ffmpeg", args...)`, capture stderr, on non-zero exit return error with last 2KB of stderr.

Plan amendment: alternate audio uses ffmpeg `agroup` renditions. The earlier literal `v:0,a:0 a:1` produced an audio-only variant but no `EXT-X-MEDIA`, contradicting the integration requirement for selectable audio tracks.
- [ ] **Step 4: Run** — unit test PASS.
- [ ] **Step 5: Integration test** (build tag `integration` or skip if `ffmpeg` not in PATH):

```go
func TestRemuxIntegration(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil { t.Skip("ffmpeg not installed") }
	dir := t.TempDir()
	src := filepath.Join(dir, "in.mkv")
	// generate 2s fixture: testsrc video + 2 sine audios
	gen := exec.Command("ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=2",
		"-f", "lavfi", "-i", "sine=frequency=880:duration=2",
		"-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "libx264", "-c:a", "aac", "-shortest", src)
	require.NoError(t, gen.Run())
	p, err := Probe(context.Background(), src)
	require.NoError(t, err)
	require.Len(t, p.Audio, 2)
	out := filepath.Join(dir, "hls")
	require.NoError(t, os.MkdirAll(out, 0o755))
	require.NoError(t, Remux(context.Background(), src, out, p))
	master, err := os.ReadFile(filepath.Join(out, "master.m3u8"))
	require.NoError(t, err)
	require.Contains(t, string(master), "EXT-X-MEDIA")
	require.Contains(t, string(master), "TYPE=AUDIO")
}
```

- [ ] **Step 6: Run** — `go test ./internal/media/ -v` → PASS.
- [ ] **Step 7: Commit**

```bash
git add internal/media
git commit -m "feat: ffmpeg remux to hls fmp4 with multi audio master playlist"
```

---

### Task 7: Subtitle extraction to WebVTT

**Files:**
- Create: `internal/media/subs.go`, `internal/media/subs_test.go`

**Interfaces:**
- Consumes: `ProbeResult` (Task 5).
- Produces: `func ExtractSubtitles(ctx context.Context, in, outDir string, p *ProbeResult) ([]string, error)` — for each `p.Subtitles[i]`, runs `ffmpeg -y -i <in> -map 0:s:<track.Index> -c:s webvtt <outDir>/sub_<i>_<lang>.vtt`; returns the written file paths in track order. Tolerates per-track failure (logs, skips) so one bad sub does not kill the pipeline.

- [ ] **Step 1: Failing integration test** — build a fixture mkv with an embedded srt (generate video with lavfi as in Task 6, plus `-i fixture.srt -c:s srt`), run `ExtractSubtitles`, assert the `.vtt` file exists and contains `WEBVTT`:

```go
func TestExtractSubtitles(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil { t.Skip("ffmpeg not installed") }
	// ... generate mkv with srt, Probe, ExtractSubtitles
	content, _ := os.ReadFile(paths[0])
	require.Contains(t, string(content), "WEBVTT")
}
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `subs.go`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit**

```bash
git add internal/media
git commit -m "feat: extract text subtitles to webvtt"
```

---

### Task 8: Media pipeline queue + orchestration

**Files:**
- Create: `internal/media/queue.go`, `internal/media/queue_test.go`
- Modify: `cmd/server/main.go`

**Interfaces:**
- Consumes: `Probe`, `Remux`, `ExtractSubtitles` (Tasks 5-7), `room.Store` (Task 2).
- Produces:

```go
type Queue struct { /* jobs chan string, workers */ }
func NewQueue(workers int, store *room.Store, dataDir string, onReady func(roomID string)) *Queue
func (q *Queue) Start(ctx context.Context)
func (q *Queue) Submit(roomID string)
```

Pipeline per job: status `processing` → `Probe` → `Remux` → `ExtractSubtitles` → `store.SetTracks(...)` → status `ready` → `onReady(roomID)`. Any error → status `error` + `errorMessage` field on room hash (add `SetError(ctx, id, msg string)` to store).

- [ ] **Step 1: Failing test** — end-to-end with a fake pipeline: extract an interface

```go
type Pipeline interface {
	Run(ctx context.Context, roomID, srcPath, outDir string) (audio, subs []room.TrackInfo, bitmapSkipped int, err error)
}
```

so the queue test injects a fake that returns two audio tracks; assert room ends `ready` with tracks persisted and `onReady` fired; second case: fake returns error → status `error`.

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `Queue` (buffered chan, N workers, graceful stop on ctx) with `realPipeline` calling Probe/Remux/ExtractSubtitles; file layout `{dataDir}/rooms/{id}/original.*` → `{dataDir}/rooms/{id}/hls/` and `{dataDir}/rooms/{id}/subs/`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Wire into main** — create queue, `q.Start(ctx)`, pass `q.Submit` as tus `onComplete` (Task 4 hook). `onReady` left as a hook the hub registers later (Task 11).
- [ ] **Step 6: Commit**

```bash
git add internal/media cmd/server
git commit -m "feat: media pipeline queue wiring probe, remux, subs"
```

---

### Task 9: Static HLS/VTT serving

**Files:**
- Create: `internal/httpapi/media.go`, `internal/httpapi/media_test.go`

**Interfaces:**
- Produces: `GET /media/:id/hls/*filepath` and `GET /media/:id/subs/*filepath` → serves from `{DataDir}/rooms/{id}/hls|subs` with `http.ServeContent` (Range support), correct content types (`application/vnd.apple.mpegurl`, `video/mp2t` unused, `video/mp4` for `.m4s`, `text/vtt` for `.vtt`), `Access-Control-Allow-Origin: *` (hls.js fetches cross-origin in dev), path-traversal safe (reject `..`).

- [ ] **Step 1: Failing test**:

```go
func TestServeHLSRange(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "rooms", "r1", "hls"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "rooms", "r1", "hls", "master.m3u8"), []byte("#EXTM3U\n1234567890"), 0o644))
	e := gin.New()
	RegisterMediaRoutes(e, testCfgWithDir(dir), newTestStore(t))
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/media/r1/hls/master.m3u8", nil)
	req.Header.Set("Range", "bytes=0-6")
	e.ServeHTTP(w, req)
	require.Equal(t, 206, w.Code)
	require.Equal(t, "#EXTM3U", w.Body.String())
	require.Equal(t, "application/vnd.apple.mpegurl", w.Header().Get("Content-Type"))
}

func TestServeHLSTraversalRejected(t *testing.T) { /* GET /media/r1/hls/..%2f..%2foriginal.mkv → 400/404 */ }
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `media.go`: resolve room dir, `filepath.Clean`, verify result stays under the room dir, `http.ServeContent(c.Writer, c.Request, name, modtime, file)`; also 404 when room expired/missing (check store first).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit**

```bash
git add internal/httpapi
git commit -m "feat: serve hls playlists, segments and subtitles with range support"
```

---

### Task 10: Sync messages + position math (pure)

**Files:**
- Create: `internal/sync/messages.go`, `internal/sync/position.go`, `internal/sync/position_test.go`

**Interfaces:**
- Consumes: `room.PlayState` (Task 2).
- Produces:

```go
// position.go — pure, no I/O
const DriftThresholdMs = 450
func ExpectedPositionMs(st room.PlayState, nowServerMs int64) int64 // positionMs + (now-serverTime)*rate if Playing, clamped >= 0
func NeedsResync(localMs, expectedMs int64) bool                    // abs(local-expected) > DriftThresholdMs

// messages.go — WS protocol, JSON
type Inbound struct { // client -> server
	Type string `json:"type"` // "hello"|"play"|"pause"|"seek"|"rate"|"chat"|"heartbeat"|"delegate"
	PositionMs int64 `json:"positionMs,omitempty"`
	Rate float64 `json:"rate,omitempty"`
	Text string `json:"text,omitempty"`
	Nickname string `json:"nickname,omitempty"`
	TargetID string `json:"targetId,omitempty"` // delegate
	ClientTimeMs int64 `json:"clientTimeMs,omitempty"`
}
type Outbound struct {
	Type string `json:"type"` // "welcome"|"state"|"members"|"chat"|"chatHistory"|"error"|"roomStatus"|"pong"
	State *room.PlayState `json:"state,omitempty"`
	ControllerID string `json:"controllerId,omitempty"`
	Members []room.Member `json:"members,omitempty"`
	Message *room.ChatMessage `json:"message,omitempty"`
	History []room.ChatMessage `json:"history,omitempty"`
	Status string `json:"status,omitempty"`
	ServerTimeMs int64 `json:"serverTimeMs,omitempty"`
	ClientTimeMs int64 `json:"clientTimeMs,omitempty"`
	ErrCode string `json:"error,omitempty"`
}
```

- [ ] **Step 1: Failing test** — `position_test.go`:

```go
func TestExpectedPositionWhilePlaying(t *testing.T) {
	st := room.PlayState{Playing: true, PositionMs: 10_000, Rate: 1, ServerTimeMs: 1_000_000}
	require.Equal(t, int64(12_000), ExpectedPositionMs(st, 1_002_000))
}
func TestExpectedPositionPaused(t *testing.T) {
	st := room.PlayState{Playing: false, PositionMs: 10_000, Rate: 1, ServerTimeMs: 1_000_000}
	require.Equal(t, int64(10_000), ExpectedPositionMs(st, 1_999_999))
}
func TestNeedsResync(t *testing.T) {
	require.False(t, NeedsResync(10_000, 10_400))
	require.True(t, NeedsResync(10_000, 10_451))
}
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit**

```bash
git add internal/sync
git commit -m "feat: sync protocol messages and pure position math"
```

---

### Task 11: WebSocket hub (sync, chat, presence, delegation)

**Files:**
- Create: `internal/sync/hub.go`, `internal/sync/client.go`, `internal/sync/hub_test.go`
- Modify: `cmd/server/main.go`, `internal/httpapi/server.go`

**Interfaces:**
- Consumes: Tasks 2, 10. Produces:

```go
type Hub struct { /* rooms map[string]*roomConn guarded by mutex; store */ }
func NewHub(store *room.Store, cfg config.Config) *Hub
func (h *Hub) HandleWS(c *gin.Context)               // GET /ws/rooms/:id?nickname=
func (h *Hub) NotifyStatus(roomID, status string)    // called by queue onReady
```

Behavior:
- Upgrade with gorilla/websocket. First inbound must be `hello` (+nickname). Server replies `welcome` (member id, snapshot state, controllerID, chat history, members) + `pong` carrying `ServerTimeMs` and echoed `ClientTimeMs` for offset estimation.
- `play/pause/seek/rate` accepted only from `controllerID`; server stamps `ServerTimeMs`, persists via `SetState`, broadcasts `state` to all (including sender, for convergence).
- `delegate` (from controller) → new `controllerID` persisted + broadcast.
- `chat` → `AddMessage` + broadcast `chat`.
- `heartbeat` → `pong` with times.
- Controller disconnects → oldest member (by `JoinedAt`) becomes controller, broadcast. Room with 0 members starts idle timer (`RoomIdleMinutes`) → `store.Delete` + `os.RemoveAll`.
- Room full (`MaxParticipants`) → `error` `room_full` and close.

- [ ] **Step 1: Failing test** — real WS over `httptest.Server` with miniredis store:

```go
func TestSyncFlow(t *testing.T) {
	// setup: store with room "r1" (controller "m1"), hub, gin route
	c1 := dialWS(t, srv, "/ws/rooms/r1?nickname=host")
	c1.WriteJSON(Inbound{Type: "hello", Nickname: "host"})
	var w Outbound
	require.NoError(t, c1.ReadJSON(&w)) // welcome
	require.NotNil(t, w.State)
	// controller plays at 30s
	c1.WriteJSON(Inbound{Type: "play", PositionMs: 30_000, Rate: 1})
	var ev Outbound
	require.NoError(t, c1.ReadJSON(&ev))
	require.Equal(t, "state", ev.Type)
	require.True(t, ev.State.Playing)
	require.Equal(t, int64(30_000), ev.State.PositionMs)
	require.Greater(t, ev.State.ServerTimeMs, int64(0))

	c2 := dialWS(t, srv, "/ws/rooms/r1?nickname=guest")
	c2.WriteJSON(Inbound{Type: "hello", Nickname: "guest"})
	require.NoError(t, c2.ReadJSON(&w))
	require.Equal(t, "m1", w.ControllerID)
	// guest tries to pause: rejected
	c2.WriteJSON(Inbound{Type: "pause", PositionMs: 31_000})
	c2.WriteJSON(Inbound{Type: "heartbeat", ClientTimeMs: 1}) // flush: next read must be pong, not state
	var got Outbound
	require.NoError(t, c2.ReadJSON(&got))
	require.Equal(t, "pong", got.Type)
}
```

Plus tests: chat broadcast to both clients; delegation then guest can pause; controller disconnect promotes oldest member.

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `hub.go`/`client.go` (per-room goroutine owns the broadcast channel; per-conn read/write pumps with `SetReadLimit`, ping/pong keepalive at 30s).
- [ ] **Step 4: Run** — `go test ./internal/sync/ -v` → PASS.
- [ ] **Step 5: Wire** — register `GET /ws/rooms/:id` in the engine; pass `hub.NotifyStatus` as queue `onReady`; register `POST /api/rooms` `onComplete` → `q.Submit`.
- [ ] **Step 6: Commit**

```bash
git add internal/sync internal/httpapi cmd/server
git commit -m "feat: websocket hub with host delegation sync, chat, presence"
```

---

### Task 12: LiveKit screen share token

**Files:**
- Create: `internal/httpapi/screenshare.go`, `internal/httpapi/screenshare_test.go`

**Interfaces:**
- Produces: `POST /api/rooms/:id/screenshare/token` body `{"nickname": "..."}` → `{"token": "<jwt>", "url": "<LIVEKIT_URL>"}`. Token built with `github.com/livekit/protocol/auth`: `NewAccessToken(key, secret)`, `VideoGrant{RoomJoin: true, Room: roomID, CanPublish: true, CanSubscribe: true}`, identity = member id, TTL 2h. 404 if room missing. Requires LiveKit env set; if unset → 503 `screenshare_disabled`.

- [ ] **Step 1: Failing test**:

```go
func TestScreenshareToken(t *testing.T) {
	e := gin.New()
	RegisterScreenshareRoute(e.Group("/api"), newTestStore(t), testCfgWithLiveKit())
	// create room first, then:
	w := doJSON(e, "POST", "/api/rooms/<id>/screenshare/token", `{"nickname":"giuli"}`)
	require.Equal(t, 200, w.Code)
	var resp struct{ Token, URL string }
	json.Unmarshal(w.Body.Bytes(), &resp)
	require.NotEmpty(t, resp.Token)
	// parse JWT and check video grant room == id
}
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit**

```bash
git add internal/httpapi
git commit -m "feat: livekit token endpoint for screen share"
```

---

### Task 13: Frontend scaffold, Skrivo dark tokens, i18n

**Files:**
- Create: `web/` via `npm create vite@latest web -- --template react-ts`
- Create: `web/src/theme.css`, `web/src/i18n/en.ts`, `web/src/i18n/pt-BR.ts`, `web/src/i18n/useT.ts`, `web/src/i18n/useT.test.ts`

**Interfaces:**
- Produces:
  - `useT(): (key: string) => string` — reads `navigator.language`, falls back to en, allows manual switch persisted in localStorage. Plain nested-object dictionaries, no i18n lib.
  - CSS tokens in `:root`: `--canvas` (#101014 near-black), `--card` (#17171c), `--well` (#0b0b0e), `--border` (rgba(255,255,255,.08)), `--primary` (indigo #6366f1), `--text`, `--text-dim`; radii `--r-control:8px --r-field:12px --r-surface:18px`; motion `--ease:cubic-bezier(0.22,1,0.36,1) --t-open:250ms --t-close:150ms`; utility classes `.raised` (inset 0 1px 0 rgba(255,255,255,.1), 0 1px 2px rgba(0,0,0,.4)) and `.sunken` (darker fill + inset 0 1px 2px rgba(0,0,0,.5) + hairline border turning `--primary` on focus).
- Copy rules: short labels ("Create room", "Copy link", "Audio", "Subtitles", "Off"), no em dash anywhere.

- [ ] **Step 1: Failing test** — `useT.test.ts`:

```ts
it("translates and falls back to english", () => {
	expect(translate("en", "home.create")).toBe("Create room");
	expect(translate("pt-BR", "home.create")).toBe("Criar sala");
	expect(translate("fr", "home.create")).toBe("Create room");
});
it("has no em dash in any string", () => {
	for (const dict of [en, ptBR]) for (const v of Object.values(dict)) expect(v).not.toContain("—");
});
```

- [ ] **Step 2: Run** — `cd web && npx vitest run` → FAIL.
- [ ] **Step 3: Implement** dictionaries (keys: home.*, room.*, chat.*, status.*, error.*), `translate(lang, key)`, `useT` hook, `theme.css` imported in `main.tsx`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit**

```bash
git add web
git commit -m "feat: frontend scaffold with skrivo dark tokens and i18n"
```

---

### Task 14: Home page + Uppy upload + create room

**Files:**
- Create: `web/src/pages/Home.tsx`, `web/src/upload.ts`, `web/src/pages/Home.test.tsx`

**Interfaces:**
- Consumes: `POST /api/rooms` (Task 4), tus endpoint `/api/upload/` (Task 4), `useT` (Task 13).
- Produces: drop zone (native drag events + Uppy DashboardModal optional; keep it simple: hidden input + drag/drop area) → on file select: `POST /api/rooms` then Uppy `Tus` plugin with `endpoint: uploadEndpoint`, `meta: {roomID}`; progress bar (tabular numbers); on `complete` → `navigate(/room/:id?nick=...)`. Reject files over limit client-side with a designed error card.

- [ ] **Step 1: Failing test** — `Home.test.tsx` with MSW or fetch mock: renders headline + drop zone; selecting a file calls create-room and starts upload; over-limit file shows error card, no network call.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**. Styled per tokens: dashed hairline drop zone turning `--primary` when `dragover`, one-line headline, one-line guidance, primary raised button.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit**

```bash
git add web
git commit -m "feat: home page with resumable upload"
```

---

### Task 15: Room page — Player (hls.js) + useSync hook + track selectors

**Files:**
- Create: `web/src/pages/Room.tsx`, `web/src/player/Player.tsx`, `web/src/player/useSync.ts`, `web/src/player/position.ts`, `web/src/player/position.test.ts`, `web/src/player/useSync.test.ts`

**Interfaces:**
- Consumes: WS protocol (Task 10), `GET /api/rooms/:id` (Task 4), `/media/:id/hls/master.m3u8`, `/media/:id/subs/*.vtt` (Task 9).
- Produces:
  - `position.ts` (mirror of backend math):

```ts
export interface PlayState { playing: boolean; positionMs: number; rate: number; serverTimeMs: number }
export const DRIFT_THRESHOLD_MS = 450;
export function expectedPositionMs(st: PlayState, nowServerMs: number): number
export function needsResync(localMs: number, expectedMs: number): boolean
```

  - `useSync(roomId, nickname, videoRef)` → `{ state, controllerId, members, isController, send(type, payload), serverOffsetMs }`. On `welcome`/`pong`: `offset = serverTimeMs - (clientSent + rtt/2)`. On `state`: if not playing locally and `state.playing` → seek+play; every 5s heartbeat → if `needsResync(video.currentTime*1000, expected)` → hard seek. While `waiting` (buffering) event fires, skip resync and catch up on `canplay`.
  - `Player.tsx`: hls.js attach (`new Hls()`, `loadSource`, `attachMedia`; Safari fallback to `video.src` when `canPlayType('application/vnd.apple.mpegurl')`); audio track selector from `hls.audioTracks` (`hls.audioTrack = i`); subtitle selector from room's `subtitleTracks` rendered as native `<track kind="subtitles" src={...} srclang={lang}>`; toggle via `track.mode = "showing"|"hidden"`; bitmap-skipped notice chip when `bitmapSubsSkipped > 0`. Controls: floating capsule, tabular time, play/pause/seek enabled only for `isController` (viewers see disabled state with a quiet label).

- [ ] **Step 1: Failing test** — `position.test.ts` mirrors Task 10 cases; `useSync.test.ts` with a fake WebSocket (mock class): receives `state` playing at 30s with serverTime, video mocked at 30.1s → no seek; video at 29s → seek called to expected.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit**

```bash
git add web
git commit -m "feat: room player with hls multitrack and drift-corrected sync"
```

---

### Task 16: Chat, presence, screen share, room status handling

**Files:**
- Create: `web/src/chat/Chat.tsx`, `web/src/chat/Chat.test.tsx`, `web/src/screenshare.ts`, `web/src/components/StatusPill.tsx`
- Modify: `web/src/pages/Room.tsx`

**Interfaces:**
- Consumes: `useSync` send/receive (Task 15), screenshare token endpoint (Task 12).
- Produces:
  - `Chat.tsx`: docked right column on desktop (`width: 320px`, `--r-surface` top-left), drawer over the player on `<768px`. Enter animation `transform: translateX(8px) → 0 + opacity, var(--t-open) var(--ease)`; messages stagger ≤300ms total; close 150ms; `@media (prefers-reduced-motion: reduce)` strips transforms. Sunken composer with indigo focus border; user messages as white-8% cards.
  - `StatusPill`: dot + label (`--status-color` per state: connecting yellow, live green, buffering orange, processing indigo), never color alone.
  - `screenshare.ts`: `startScreenShare(roomId, nickname)` → fetch token → `new Room()` from livekit-client → `connect(url, token)` → `localParticipant.setScreenShareEnabled(true)`; remote screen tracks render in a tile over the player via `room.on(RoomEvent.TrackSubscribed, ...)`.
  - Room page handles `roomStatus` events: `processing` → designed waiting card with indigo dot; `error` → error card with reason; expired/404 → empty state with create-new action.

- [ ] **Step 1: Failing test** — `Chat.test.tsx`: renders messages, sends on Enter via provided `send`, drawer classes toggle at mobile width (matchMedia mock), reduced-motion class applied when `prefers-reduced-motion`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** all four files.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Manual smoke** — `docker compose up --build`, create a room with a real MKV, open two browser tabs, verify sync, chat, audio/sub switching, screen share (LiveKit `--dev` mode).
- [ ] **Step 6: Commit**

```bash
git add web
git commit -m "feat: animated chat, presence, status pill, screen share"
```

---

## Self-review notes

- Spec coverage: upload tus (T4/T14), remux HLS multi-audio (T6), subs VTT + bitmap skip (T7/T15), TTL + sweeper (T2/T3), host+delegation + drift 0.45s + heartbeat 5s (T10/T11/T15), chat 200 cap (T2/T11/T16), LiveKit (T12/T16), Skrivo dark + motion tokens (T13/T16), i18n pt-BR/en + no em dash (T13), limits via env (T1), error/empty states (T14/T16), compose (T1). Playlist-progressive playback is explicitly out of scope (spec, fase 2).
- Type consistency: `TrackInfo`, `PlayState`, `Inbound`/`Outbound`, `Pipeline.Run`, `useSync` return shape are declared once and reused verbatim across tasks.
- Deliberate choices not in the spec (flagged for the user): gorilla/websocket over coder/websocket (most common, fine at this scale); go-nanoid for ids; subtitles served as static VTT + native `<track>` instead of HLS `EXT-X-MEDIA` subtitles (simpler, per research); LiveKit runs with `--dev` flag for local compose, real keys via env in production.
