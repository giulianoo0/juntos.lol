FROM rust:1-bookworm AS build

WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY vendor vendor
COPY ss-remux ss-remux
COPY src src
# aws-lc-rs (behind the MoQ client's TLS) builds its C library with cmake.
RUN apt-get update && apt-get install -y --no-install-recommends cmake && rm -rf /var/lib/apt/lists/*
RUN cargo build --release

FROM debian:trixie-slim

# ffmpeg/ffprobe drive the remote remux. Trixie's 7.x line matters beyond
# freshness: since 6.0 every decoder/filter/encoder runs on its own thread,
# so a run converting two 5.1 audio tracks no longer serializes the whole
# remux onto one core.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates ffmpeg curl \
	&& rm -rf /var/lib/apt/lists/*

# yt-dlp resolves YouTube links into streams the remux reads. The standalone
# build carries its own Python, so the image stays without one; the binary
# updates itself in place when an extractor goes stale.
ARG YTDLP_VERSION=2026.08.19
RUN curl -fsSL -o /usr/local/bin/yt-dlp \
	"https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux" \
	&& chmod 0755 /usr/local/bin/yt-dlp \
	&& /usr/local/bin/yt-dlp --version

COPY --from=build /src/target/release/ss-worker /usr/local/bin/ss-worker
WORKDIR /var/lib/ss-worker
ENTRYPOINT ["ss-worker"]
