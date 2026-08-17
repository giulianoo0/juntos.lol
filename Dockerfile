FROM golang:1.26-bookworm AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY cmd cmd
COPY internal internal
RUN CGO_ENABLED=0 go build -o /bin/server ./cmd/server

FROM debian:bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ffmpeg ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=build /bin/server /bin/server

EXPOSE 8080
ENTRYPOINT ["/bin/server"]
