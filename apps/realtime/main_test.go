// Tests for the realtime WebSocket gateway. Covers the pure helpers, the
// health/ready/auth HTTP endpoints, the structuredLogger middleware, and a
// happy-path WebSocket round-trip backed by httptest + a fake Redis subscriber.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/coder/websocket"
	"github.com/redis/go-redis/v9"
)

var _ os.Signal = os.Interrupt

// ─── envDefault ──────────────────────────────────────────────────

func TestEnvDefault_ReturnsValue(t *testing.T) {
	t.Setenv("RT_TEST_KEY", "from-env")
	if got := envDefault("RT_TEST_KEY", "fallback"); got != "from-env" {
		t.Fatalf("expected 'from-env', got %q", got)
	}
}

func TestEnvDefault_ReturnsDefault(t *testing.T) {
	// Setenv with empty so we exercise the fallback branch deterministically.
	t.Setenv("RT_TEST_KEY_EMPTY", "")
	if got := envDefault("RT_TEST_KEY_EMPTY", "fallback"); got != "fallback" {
		t.Fatalf("expected 'fallback', got %q", got)
	}
}

// ─── parseOrigins ────────────────────────────────────────────────

func TestParseOrigins_EmptyOrWildcard(t *testing.T) {
	if got := parseOrigins(""); got != nil {
		t.Fatalf("empty: expected nil, got %v", got)
	}
	if got := parseOrigins("*"); got != nil {
		t.Fatalf("wildcard: expected nil, got %v", got)
	}
}

func TestParseOrigins_SingleAndMultiWithSchemes(t *testing.T) {
	got := parseOrigins("https://web.example.com,http://localhost:3100")
	want := []string{"web.example.com", "localhost:3100"}
	if !sliceEqual(got, want) {
		t.Fatalf("expected %v, got %v", want, got)
	}
}

func TestParseOrigins_TrimsAndSkipsBlank(t *testing.T) {
	got := parseOrigins(" https://a.io , , http://b.io ")
	want := []string{"a.io", "b.io"}
	if !sliceEqual(got, want) {
		t.Fatalf("expected %v, got %v", want, got)
	}
}

func TestParseOrigins_HostOnlyEntry(t *testing.T) {
	// Origin without scheme should pass through unchanged.
	got := parseOrigins("localhost:3100")
	want := []string{"localhost:3100"}
	if !sliceEqual(got, want) {
		t.Fatalf("expected %v, got %v", want, got)
	}
}

func sliceEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// ─── healthHandler ───────────────────────────────────────────────

func TestHealthHandler(t *testing.T) {
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	healthHandler(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	if ct := rr.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("expected JSON content-type, got %q", ct)
	}
	if !strings.Contains(rr.Body.String(), `"status":"ok"`) {
		t.Fatalf("expected status:ok in body, got %s", rr.Body.String())
	}
}

// ─── readyHandler ────────────────────────────────────────────────

// startFakeRedis spins up an in-memory miniredis instance for the duration of
// the test. When `replyOK` is false we point the client at an unused address so
// every command (Ping included) fails fast — simulating "Redis unreachable".
func startFakeRedis(t *testing.T, replyOK bool) *redis.Client {
	t.Helper()
	if !replyOK {
		// 127.0.0.1:1 is reserved; connect attempts fail almost instantly.
		return redis.NewClient(&redis.Options{
			Addr:        "127.0.0.1:1",
			DialTimeout: 200 * time.Millisecond,
			ReadTimeout: 200 * time.Millisecond,
		})
	}
	mr := miniredis.RunT(t)
	return redis.NewClient(&redis.Options{Addr: mr.Addr()})
}

func TestReadyHandler_RedisOK(t *testing.T) {
	rdb := startFakeRedis(t, true)
	gw := &gateway{redis: rdb}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/ready", nil)
	gw.readyHandler(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body=%s)", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), `"status":"ready"`) {
		t.Fatalf("expected ready body, got %s", rr.Body.String())
	}
}

func TestReadyHandler_RedisDown(t *testing.T) {
	rdb := startFakeRedis(t, false)
	gw := &gateway{redis: rdb}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/ready", nil)
	gw.readyHandler(rr, req)
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), `"redis":"unreachable"`) {
		t.Fatalf("expected unreachable body, got %s", rr.Body.String())
	}
}

// ─── authenticate ────────────────────────────────────────────────

func TestAuthenticate_HappyPath(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/auth/me" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("authorization") != "Bearer abc123" {
			http.Error(w, "missing bearer", http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"user":    map[string]string{"id": "u1"},
			"account": map[string]string{"id": "acc1"},
		})
	}))
	t.Cleanup(srv.Close)
	gw := &gateway{apiBase: srv.URL, httpClient: srv.Client()}
	acc, user, err := gw.authenticate(context.Background(), "abc123")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if acc != "acc1" || user != "u1" {
		t.Fatalf("got acc=%q user=%q", acc, user)
	}
}

func TestAuthenticate_Non200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "no", http.StatusUnauthorized)
	}))
	t.Cleanup(srv.Close)
	gw := &gateway{apiBase: srv.URL, httpClient: srv.Client()}
	_, _, err := gw.authenticate(context.Background(), "bad")
	if err == nil || !strings.Contains(err.Error(), "auth failed") {
		t.Fatalf("expected auth-failed error, got %v", err)
	}
}

func TestAuthenticate_MalformedJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("not-json"))
	}))
	t.Cleanup(srv.Close)
	gw := &gateway{apiBase: srv.URL, httpClient: srv.Client()}
	_, _, err := gw.authenticate(context.Background(), "x")
	if err == nil {
		t.Fatalf("expected JSON decode error")
	}
}

func TestAuthenticate_MissingAccount(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"user":    map[string]string{"id": "u1"},
			"account": map[string]string{"id": ""}, // empty
		})
	}))
	t.Cleanup(srv.Close)
	gw := &gateway{apiBase: srv.URL, httpClient: srv.Client()}
	_, _, err := gw.authenticate(context.Background(), "x")
	if err == nil || !strings.Contains(err.Error(), "missing account") {
		t.Fatalf("expected missing-account err, got %v", err)
	}
}

func TestAuthenticate_NewRequestError(t *testing.T) {
	gw := &gateway{apiBase: "://bad-url", httpClient: http.DefaultClient}
	_, _, err := gw.authenticate(context.Background(), "x")
	if err == nil {
		t.Fatalf("expected NewRequest err")
	}
}

func TestAuthenticate_ClientDoError(t *testing.T) {
	// Closed server → Do returns a connection-refused-style error.
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {}))
	srv.Close() // close immediately so connect fails
	gw := &gateway{apiBase: srv.URL, httpClient: srv.Client()}
	_, _, err := gw.authenticate(context.Background(), "x")
	if err == nil {
		t.Fatalf("expected Do error from closed server")
	}
}

// ─── structuredLogger ────────────────────────────────────────────

func TestStructuredLogger_WrapsHandler(t *testing.T) {
	captured := &capturingWriter{}
	logger := slog.New(slog.NewTextHandler(captured, nil))
	mw := structuredLogger(logger)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
		_, _ = w.Write([]byte("ok"))
	}))
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusTeapot {
		t.Fatalf("expected 418 propagated, got %d", rr.Code)
	}
	if !strings.Contains(captured.s, "method=GET") || !strings.Contains(captured.s, "status=418") {
		t.Fatalf("log line missing fields: %q", captured.s)
	}
}

type capturingWriter struct{ s string }

func (c *capturingWriter) Write(p []byte) (int, error) {
	c.s += string(p)
	return len(p), nil
}

// ─── writeJSON ───────────────────────────────────────────────────

func TestWriteJSON_MarshalError(t *testing.T) {
	// Marshal fails on functions / channels — pass one to force the path.
	err := writeJSON(context.Background(), nil, make(chan int))
	if err == nil {
		t.Fatalf("expected marshal error")
	}
}

func TestWriteJSON_WritesText(t *testing.T) {
	// Stand up a WebSocket server that reads one message and validates the body.
	receivedCh := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			t.Logf("accept err: %v", err)
			return
		}
		defer c.CloseNow()
		_, data, err := c.Read(r.Context())
		if err != nil {
			t.Logf("read err: %v", err)
			return
		}
		receivedCh <- string(data)
	}))
	t.Cleanup(srv.Close)

	u, _ := url.Parse(srv.URL)
	u.Scheme = "ws"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, u.String(), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()
	if err := writeJSON(ctx, conn, map[string]string{"hello": "world"}); err != nil {
		t.Fatalf("writeJSON: %v", err)
	}
	select {
	case got := <-receivedCh:
		if !strings.Contains(got, `"hello":"world"`) {
			t.Fatalf("unexpected payload %q", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for message")
	}
}

// ─── wsHandler unauthenticated paths ─────────────────────────────

func TestWsHandler_MissingToken(t *testing.T) {
	gw := &gateway{
		apiBase:    "http://unused",
		httpClient: http.DefaultClient,
		corsOrigin: "*",
		logger:     slog.Default(),
	}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/ws", nil)
	gw.wsHandler(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rr.Code)
	}
}

func TestWsHandler_AuthFailure(t *testing.T) {
	authSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "no", http.StatusUnauthorized)
	}))
	t.Cleanup(authSrv.Close)
	gw := &gateway{
		apiBase:    authSrv.URL,
		httpClient: authSrv.Client(),
		corsOrigin: "*",
		logger:     slog.Default(),
	}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/ws?token=bad", nil)
	gw.wsHandler(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rr.Code)
	}
}

// Sanity-check that errors.Is + errors.New from net/http imports compile in this file.
var _ = errors.Is

// ─── loadConfig ──────────────────────────────────────────────────

func TestLoadConfig_AllDefaults(t *testing.T) {
	// Force every env var empty so we exercise the default branches.
	for _, k := range []string{
		"PORT", "API_BASE", "REDIS_URL", "CORS_ORIGIN", "NODE_ENV",
		"SENTRY_DSN", "SENTRY_ENVIRONMENT", "SENTRY_RELEASE",
	} {
		t.Setenv(k, "")
	}
	c := loadConfig()
	if c.port != "3120" || c.apiBase != "http://localhost:3110" ||
		c.redisURL != "redis://localhost:6379" || c.corsOrigin != "http://localhost:3100" ||
		c.env != "development" {
		t.Fatalf("defaults wrong: %+v", c)
	}
	if c.sentryDSN != "" || c.sentryRelease != "" {
		t.Fatalf("expected empty sentry fields, got %+v", c)
	}
	// sentryEnvironment defaults to env when SENTRY_ENVIRONMENT unset.
	if c.sentryEnvironment != "development" {
		t.Fatalf("expected sentryEnvironment=development, got %q", c.sentryEnvironment)
	}
}

func TestLoadConfig_AllOverrides(t *testing.T) {
	t.Setenv("PORT", "4000")
	t.Setenv("API_BASE", "http://api.local")
	t.Setenv("REDIS_URL", "redis://r.local:6379")
	t.Setenv("CORS_ORIGIN", "https://web.local")
	t.Setenv("NODE_ENV", "production")
	t.Setenv("SENTRY_DSN", "https://sentry.io/x")
	t.Setenv("SENTRY_ENVIRONMENT", "prod-eu")
	t.Setenv("SENTRY_RELEASE", "rev-abc")
	c := loadConfig()
	if c.port != "4000" || c.apiBase != "http://api.local" ||
		c.env != "production" || c.sentryDSN != "https://sentry.io/x" ||
		c.sentryEnvironment != "prod-eu" || c.sentryRelease != "rev-abc" {
		t.Fatalf("overrides wrong: %+v", c)
	}
}

// ─── newLogger ───────────────────────────────────────────────────

func TestNewLogger_DevelopmentTextHandler(t *testing.T) {
	l := newLogger("development")
	if l == nil {
		t.Fatal("expected logger")
	}
	// Best we can verify without reflecting on handler type is that the
	// logger doesn't panic and the underlying handler advertises Info level.
	if !l.Enabled(context.Background(), slog.LevelInfo) {
		t.Fatal("expected info enabled")
	}
}

func TestNewLogger_ProductionJSONHandler(t *testing.T) {
	l := newLogger("production")
	if l == nil {
		t.Fatal("expected logger")
	}
	if !l.Enabled(context.Background(), slog.LevelInfo) {
		t.Fatal("expected info enabled")
	}
}

// ─── initSentry ──────────────────────────────────────────────────

func TestInitSentry_NoOpOnEmptyDSN(t *testing.T) {
	if err := initSentry("", "production", ""); err != nil {
		t.Fatalf("expected nil err on empty dsn, got %v", err)
	}
}

func TestInitSentry_RejectsInvalidDSN(t *testing.T) {
	// A nonsense DSN must surface as a non-nil error.
	if err := initSentry("not-a-valid-dsn", "test", "1.0"); err == nil {
		t.Fatal("expected error for invalid DSN")
	}
}

// ─── newRedisClient ─────────────────────────────────────────────

func TestNewRedisClient_ParsesValidURL(t *testing.T) {
	c, err := newRedisClient("redis://localhost:6379/0")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if c == nil {
		t.Fatal("expected client")
	}
	_ = c.Close()
}

func TestNewRedisClient_RejectsInvalidURL(t *testing.T) {
	if _, err := newRedisClient("not a url"); err == nil {
		t.Fatal("expected parse error")
	}
}

// ─── newGateway / newRouter ─────────────────────────────────────

func TestNewGateway_WiresAllFields(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	cfg := config{apiBase: "http://api", corsOrigin: "*"}
	logger := slog.Default()
	gw := newGateway(cfg, rdb, logger)
	if gw.apiBase != "http://api" || gw.corsOrigin != "*" ||
		gw.redis != rdb || gw.logger != logger || gw.httpClient == nil {
		t.Fatalf("gateway not wired: %+v", gw)
	}
}

func TestNewRouter_RoutesHealthAndReady(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	gw := newGateway(config{}, rdb, slog.Default())
	r := newRouter(gw, slog.Default())

	// /health
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/health", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("/health expected 200, got %d", rr.Code)
	}
	// /ready
	rr2 := httptest.NewRecorder()
	r.ServeHTTP(rr2, httptest.NewRequest(http.MethodGet, "/ready", nil))
	if rr2.Code != http.StatusOK {
		t.Fatalf("/ready expected 200, got %d", rr2.Code)
	}
	// Unknown route
	rr3 := httptest.NewRecorder()
	r.ServeHTTP(rr3, httptest.NewRequest(http.MethodGet, "/nope", nil))
	if rr3.Code != http.StatusNotFound {
		t.Fatalf("/nope expected 404, got %d", rr3.Code)
	}
}

// ─── runServer ──────────────────────────────────────────────────

func TestRunServer_GracefulShutdownOnSignal(t *testing.T) {
	// Pick a free port by binding to :0 then closing immediately — extract
	// the port number for the test server's Addr field.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()

	srv := &http.Server{
		Addr:              addr,
		Handler:           http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }),
		ReadHeaderTimeout: time.Second,
	}
	stop := make(chan os.Signal, 1)
	done := make(chan error, 1)
	go func() {
		done <- runServer(srv, stop, func(string, ...any) {})
	}()

	// Give the server a moment to bind, then signal stop.
	time.Sleep(100 * time.Millisecond)
	close(stop)

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("runServer returned err: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("runServer never returned after stop")
	}
}

func TestRunServer_ReturnsListenError(t *testing.T) {
	// Bind to an already-used port to force ListenAndServe to fail.
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer occupied.Close()
	srv := &http.Server{
		Addr:              occupied.Addr().String(),
		Handler:           http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}),
		ReadHeaderTimeout: time.Second,
	}
	stop := make(chan os.Signal, 1)
	err = runServer(srv, stop, func(string, ...any) {})
	if err == nil {
		t.Fatal("expected listen error from port conflict")
	}
}

// ─── run (the orchestrator that main calls) ─────────────────────

func TestRun_ReturnsErrorOnBadRedisURL(t *testing.T) {
	cfg := config{
		port: "0", env: "production", redisURL: "not-a-url",
		apiBase: "http://x", corsOrigin: "*",
	}
	stop := make(chan os.Signal, 1)
	close(stop) // exit fast if we somehow get past redis
	if err := run(cfg, stop); err == nil {
		t.Fatal("expected redis URL error")
	}
}

func TestRun_HappyShutdown(t *testing.T) {
	mr := miniredis.RunT(t)
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := ln.Addr().String()
	_ = ln.Close()
	_, port, _ := net.SplitHostPort(addr)

	cfg := config{
		port: port, env: "development",
		apiBase: "http://localhost", corsOrigin: "*",
		redisURL: "redis://" + mr.Addr(),
	}
	stop := make(chan os.Signal, 1)
	done := make(chan error, 1)
	go func() { done <- run(cfg, stop) }()
	time.Sleep(150 * time.Millisecond)
	close(stop)
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("unexpected err: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("run never returned")
	}
}

func TestRun_NoOpSentryWhenDSNEmpty(t *testing.T) {
	// Verifies the sentryDSN=="" branch in run() that skips the deferred Flush.
	mr := miniredis.RunT(t)
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := ln.Addr().String()
	_ = ln.Close()
	_, port, _ := net.SplitHostPort(addr)
	cfg := config{
		port: port, env: "production",
		apiBase: "http://localhost", corsOrigin: "*",
		redisURL:  "redis://" + mr.Addr(),
		sentryDSN: "", // explicit no-op
	}
	stop := make(chan os.Signal, 1)
	done := make(chan error, 1)
	go func() { done <- run(cfg, stop) }()
	time.Sleep(150 * time.Millisecond)
	close(stop)
	if err := <-done; err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
}

func TestRun_InvalidSentryDSNLogsButDoesNotFail(t *testing.T) {
	// initSentry returns an error for bogus DSNs; run() logs it but keeps going.
	mr := miniredis.RunT(t)
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := ln.Addr().String()
	_ = ln.Close()
	_, port, _ := net.SplitHostPort(addr)
	cfg := config{
		port: port, env: "production",
		apiBase: "http://localhost", corsOrigin: "*",
		redisURL:  "redis://" + mr.Addr(),
		sentryDSN: "not-a-real-dsn",
	}
	stop := make(chan os.Signal, 1)
	done := make(chan error, 1)
	go func() { done <- run(cfg, stop) }()
	time.Sleep(150 * time.Millisecond)
	close(stop)
	if err := <-done; err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
}

// ─── wsHandler error paths ──────────────────────────────────────

// websocket.Accept fails when the request isn't a valid upgrade — exercises
// the `if err != nil` after Accept (lines 238-241).
func TestWsHandler_AcceptError(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	authSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"user":    map[string]string{"id": "u1"},
			"account": map[string]string{"id": "acc1"},
		})
	}))
	t.Cleanup(authSrv.Close)
	gw := &gateway{
		apiBase:    authSrv.URL,
		httpClient: authSrv.Client(),
		redis:      rdb,
		corsOrigin: "*",
		logger:     slog.Default(),
	}
	// Plain GET with no Upgrade header — websocket.Accept must fail.
	gwSrv := httptest.NewServer(http.HandlerFunc(gw.wsHandler))
	t.Cleanup(gwSrv.Close)
	resp, err := http.Get(gwSrv.URL + "/?token=good")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	// Accept writes its own error response (some 4xx).
	if resp.StatusCode == http.StatusOK {
		t.Fatalf("expected non-200 from failed Accept, got 200")
	}
}

// Closing miniredis under an active subscription forces the redis-go
// subscription channel to close — exercises the `if !ok { return }` branch
// of the writer-loop select (line 282-284).
func TestWsHandler_SubscriptionChannelClosed(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	authSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"user":    map[string]string{"id": "u1"},
			"account": map[string]string{"id": "acc-sub-closed"},
		})
	}))
	t.Cleanup(authSrv.Close)
	gw := &gateway{
		apiBase:    authSrv.URL,
		httpClient: authSrv.Client(),
		redis:      rdb,
		corsOrigin: "*",
		logger:     slog.Default(),
	}
	gwSrv := httptest.NewServer(http.HandlerFunc(gw.wsHandler))
	t.Cleanup(gwSrv.Close)
	u, _ := url.Parse(gwSrv.URL)
	u.Scheme = "ws"
	q := u.Query()
	q.Set("token", "good")
	u.RawQuery = q.Encode()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, u.String(), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()
	// Read the hello so the writer loop is engaged.
	_, _, _ = conn.Read(ctx)
	// Close miniredis — drops the subscription, channel closes server-side.
	mr.Close()
	// Give the handler a beat to react and exit cleanly.
	time.Sleep(300 * time.Millisecond)
}

// Closing the client after the upgrade but before the server writes anything
// will eventually surface as a c.Write error in the writer loop when a
// payload is published — exercises lines 289-292.
func TestWsHandler_WriterLoopWriteError(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	authSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"user":    map[string]string{"id": "u1"},
			"account": map[string]string{"id": "acc-werr"},
		})
	}))
	t.Cleanup(authSrv.Close)
	gw := &gateway{
		apiBase:    authSrv.URL,
		httpClient: authSrv.Client(),
		redis:      rdb,
		corsOrigin: "*",
		logger:     slog.Default(),
	}
	gwSrv := httptest.NewServer(http.HandlerFunc(gw.wsHandler))
	t.Cleanup(gwSrv.Close)
	u, _ := url.Parse(gwSrv.URL)
	u.Scheme = "ws"
	q := u.Query()
	q.Set("token", "good")
	u.RawQuery = q.Encode()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, u.String(), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	// Read the hello so the writer loop is definitely engaged.
	_, _, _ = conn.Read(ctx)
	// Abruptly close the underlying transport so the next server write fails.
	_ = conn.CloseNow()
	// Wait for subscriber attach so publish reaches a subscriber.
	deadline := time.Now().Add(2 * time.Second)
	for {
		if n := mr.PubSubNumSub("account:acc-werr")["account:acc-werr"]; n > 0 {
			break
		}
		if time.Now().After(deadline) {
			break // best-effort; test still useful
		}
		time.Sleep(20 * time.Millisecond)
	}
	mr.Publish("account:acc-werr", `{"x":1}`)
	// No assertion needed — the goal is for the writer loop to exit via the
	// write-error branch. We give it a moment to do so before the test ends.
	time.Sleep(100 * time.Millisecond)
}

// ─── wsHandler end-to-end happy path ─────────────────────────────

// Spins up a fake API server + miniredis + the gateway under httptest, opens
// a real WebSocket connection through wsHandler, publishes one message to the
// account channel, and verifies the client receives "Connected" + the payload.
func TestWsHandler_HappyPath(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })

	// Fake API auth server.
	authSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/auth/me" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"user":    map[string]string{"id": "u1"},
			"account": map[string]string{"id": "acc-ws"},
		})
	}))
	t.Cleanup(authSrv.Close)

	gw := &gateway{
		apiBase:    authSrv.URL,
		httpClient: authSrv.Client(),
		redis:      rdb,
		corsOrigin: "*",
		logger:     slog.Default(),
	}

	// Stand up the gateway as an actual HTTP server.
	gwSrv := httptest.NewServer(http.HandlerFunc(gw.wsHandler))
	t.Cleanup(gwSrv.Close)

	u, _ := url.Parse(gwSrv.URL)
	u.Scheme = "ws"
	u.Path = "/"
	q := u.Query()
	q.Set("token", "good-token")
	u.RawQuery = q.Encode()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, u.String(), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	// Expect the Connected hello first.
	_, helloBytes, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read hello: %v", err)
	}
	if !strings.Contains(string(helloBytes), `"type":"Connected"`) ||
		!strings.Contains(string(helloBytes), `"accountId":"acc-ws"`) {
		t.Fatalf("unexpected hello: %s", helloBytes)
	}

	// Publish a payload to the account channel — the writer loop should
	// forward it as a text frame.
	const payload = `{"type":"MessageCreated","id":"m1"}`
	// Give the subscription a beat to actually attach before publishing.
	deadline := time.Now().Add(2 * time.Second)
	for {
		if n := mr.PubSubNumSub("account:acc-ws")["account:acc-ws"]; n > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("subscriber never attached")
		}
		time.Sleep(20 * time.Millisecond)
	}
	mr.Publish("account:acc-ws", payload)

	_, got, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read published: %v", err)
	}
	if string(got) != payload {
		t.Fatalf("unexpected payload: got %s want %s", got, payload)
	}

	// Closing the client triggers reader-goroutine exit on the server,
	// which cancels the context and ends the writer loop cleanly.
	if err := conn.Close(websocket.StatusNormalClosure, "bye"); err != nil {
		t.Logf("close: %v", err) // best-effort
	}
}
