FROM rust:1-bookworm AS build

WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY vendor vendor
COPY src src
RUN cargo build --release

FROM debian:trixie-slim

# ffmpeg/ffprobe drive the remote remux. Trixie's 7.x line matters beyond
# freshness: since 6.0 every decoder/filter/encoder runs on its own thread,
# so a run converting two 5.1 audio tracks no longer serializes the whole
# remux onto one core.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates ffmpeg \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=build /src/target/release/ss-worker /usr/local/bin/ss-worker
WORKDIR /var/lib/ss-worker
ENTRYPOINT ["ss-worker"]
