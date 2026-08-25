FROM rust:1-bookworm AS build

WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY vendor vendor
COPY src src
RUN cargo build --release

FROM debian:bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=build /src/target/release/ss-worker /usr/local/bin/ss-worker
WORKDIR /var/lib/ss-worker
ENTRYPOINT ["ss-worker"]
