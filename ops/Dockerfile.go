# syntax=docker/dockerfile:1

FROM golang:1.22.12-bookworm AS build
WORKDIR /src

COPY apps/settlement/go.mod apps/settlement/go.sum ./apps/settlement/
WORKDIR /src/apps/settlement
RUN --mount=type=cache,target=/go/pkg/mod go mod download

COPY apps/settlement/ .
ARG TARGETARCH
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH:-amd64} \
    go build -trimpath -ldflags="-s -w" -o /out/settlement ./cmd/settlement

FROM alpine:3.21.3 AS runtime
RUN addgroup -S -g 10001 settlement \
    && adduser -S -D -H -u 10001 -G settlement settlement
WORKDIR /app
COPY --from=build --chown=10001:10001 /out/settlement ./settlement

USER 10001:10001
EXPOSE 8091
ENTRYPOINT ["./settlement"]
CMD ["daemon"]
