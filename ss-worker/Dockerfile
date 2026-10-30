# Built from the repository root (the Cargo workspace lives there):
#   docker build -f ss-worker/Dockerfile .
FROM rust:1-bookworm AS build

WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates crates
COPY ss-worker ss-worker
# aws-lc-rs (behind the MoQ client's TLS) builds its C library with cmake.
RUN apt-get update && apt-get install -y --no-install-recommends cmake && rm -rf /var/lib/apt/lists/*
RUN cargo build --release -p ss-worker

# FFmpeg pinned by build and checksum instead of the distro's: the same 8.1
# everywhere the remux runs, with libx264 for the 480p rendition. BtbN's
# static GPL build needs nothing from the image but libc.
FROM debian:trixie-slim AS ffmpeg
ARG TARGETARCH
ARG FFMPEG_BUILD=autobuild-2026-10-28-19-47
ARG FFMPEG_VERSION=n8.1.3-25-g611cec792a
ARG FFMPEG_SHA256_AMD64=8d02a412b0f72051bf30201a9f2c117fe557a4dc44b03c5c99fda2fbd7b00b5d
ARG FFMPEG_SHA256_ARM64=7257ee9e82ef1e387902ba50ad98bfd2116f2de069f31221988623f56955ad6a
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
	&& rm -rf /var/lib/apt/lists/*
RUN case "${TARGETARCH:-amd64}" in \
		amd64) platform=linux64; sum="${FFMPEG_SHA256_AMD64}" ;; \
		arm64) platform=linuxarm64; sum="${FFMPEG_SHA256_ARM64}" ;; \
		*) echo "no FFmpeg build for ${TARGETARCH}" >&2; exit 1 ;; \
	esac \
	&& name="ffmpeg-${FFMPEG_VERSION}-${platform}-gpl-8.1" \
	&& curl -fsSL -o /tmp/ffmpeg.tar.xz \
		"https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_BUILD}/${name}.tar.xz" \
	&& echo "${sum}  /tmp/ffmpeg.tar.xz" | sha256sum -c - \
	&& tar -xJf /tmp/ffmpeg.tar.xz -C /tmp \
	&& install -m 0755 "/tmp/${name}/bin/ffmpeg" "/tmp/${name}/bin/ffprobe" /usr/local/bin/

FROM debian:trixie-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=ffmpeg /usr/local/bin/ffmpeg /usr/local/bin/ffprobe /usr/local/bin/
RUN ffmpeg -hide_banner -version | head -1

# yt-dlp resolves YouTube links into streams the remux reads. The standalone
# build carries its own Python, so the image stays without one; the binary
# updates itself in place when an extractor goes stale.
ARG YTDLP_VERSION=2026.08.19
RUN curl -fsSL -o /usr/local/bin/yt-dlp \
	"https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux" \
	&& chmod 0755 /usr/local/bin/yt-dlp \
	&& /usr/local/bin/yt-dlp --version

COPY --from=build /src/target/release/ss-worker /usr/local/bin/ss-worker
COPY --from=build /src/target/release/ss-moq-bridge /usr/local/bin/ss-moq-bridge
WORKDIR /var/lib/ss-worker
ENTRYPOINT ["ss-worker"]
