FROM node:24-bookworm AS web-build

# The commit the image was built from, shown in the app's header. The build
# context excludes .git, so it has to be handed in.
ARG GIT_SHA=dev
ENV VITE_GIT_SHA=$GIT_SHA

WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.26-bookworm AS go-build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd cmd
COPY internal internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /bin/server ./cmd/server

FROM debian:trixie-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates \
	&& useradd --system --uid 10001 --create-home app \
	&& mkdir -p /data /web \
	&& chown -R app:app /data /web \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=go-build /bin/server /bin/server
COPY --from=web-build --chown=app:app /src/web/dist /web

ENV WEB_DIR=/web
USER app
# 8080 is the site; 9090 is the Prometheus endpoint, which the Compose file
# keeps on the internal network and never publishes to the host.
EXPOSE 8080 9090
ENTRYPOINT ["/bin/server"]
