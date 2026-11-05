# Multi-stage build for the realtime gateway (Go).
# Produces a small static binary on alpine.

# ─── Stage 1: build ────────────────────────────────────────────────────────
FROM golang:1.25-alpine AS build
WORKDIR /src

# Cache deps before copying source.
COPY apps/realtime/go.mod apps/realtime/go.sum* ./
RUN go mod download

COPY apps/realtime/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/realtime ./

# ─── Stage 2: runtime ──────────────────────────────────────────────────────
FROM alpine:3.20 AS runtime
RUN apk add --no-cache ca-certificates wget
COPY --from=build /out/realtime /usr/local/bin/realtime

EXPOSE 3120
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3120/health || exit 1

ENTRYPOINT ["/usr/local/bin/realtime"]
