// realtime: a thin WebSocket gateway in front of the Nest api.
//
// On /ws?token=<session>:
//   1. Validate the session token by calling Nest's GET /auth/me.
//   2. Subscribe to Redis Pub/Sub channel `account:<id>` for the user's account.
//   3. Forward every published event to the WebSocket client until disconnect.
//
// Events are JSON blobs published by Nest (see RealtimeService). The gateway is
// stateless: it does no auth itself beyond delegating to Nest, and stores
// nothing — drop the process, restart, clients reconnect.

package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/getsentry/sentry-go"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/redis/go-redis/v9"
)

const (
	pingInterval = 25 * time.Second
	writeTimeout = 5 * time.Second
)

type gateway struct {
	apiBase    string
	httpClient *http.Client
	redis      *redis.Client
	corsOrigin string
	logger     *slog.Logger
}

type meResponse struct {
	User    struct {
		ID string `json:"id"`
	} `json:"user"`
	Account struct {
		ID string `json:"id"`
	} `json:"account"`
}

// config holds the resolved environment for the realtime gateway. Extracted
// so newGateway / newRouter / runServer can be tested in isolation.
type config struct {
	port              string
	apiBase           string
	redisURL          string
	corsOrigin        string
	env               string
	sentryDSN         string
	sentryEnvironment string
	sentryRelease     string
}

func loadConfig() config {
	env := envDefault("NODE_ENV", "development")
	return config{
		port:              envDefault("PORT", "3120"),
		apiBase:           envDefault("API_BASE", "http://localhost:3110"),
		redisURL:          envDefault("REDIS_URL", "redis://localhost:6379"),
		corsOrigin:        envDefault("CORS_ORIGIN", "http://localhost:3100"),
		env:               env,
		sentryDSN:         os.Getenv("SENTRY_DSN"),
		sentryEnvironment: envDefault("SENTRY_ENVIRONMENT", env),
		sentryRelease:     os.Getenv("SENTRY_RELEASE"),
	}
}

// newLogger returns a text handler in development and a JSON handler
// everywhere else. Always writes to stdout.
func newLogger(env string) *slog.Logger {
	if env == "development" {
		return slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
}

// initSentry is a no-op when dsn is empty. Returns the underlying init
// error, if any, so tests can verify both success and failure paths.
func initSentry(dsn, environment, release string) error {
	if dsn == "" {
		return nil
	}
	return sentry.Init(sentry.ClientOptions{
		Dsn:              dsn,
		Environment:      environment,
		Release:          release,
		TracesSampleRate: 0.1,
	})
}

// newRedisClient parses the URL and constructs the redis client. Surfaces
// the parse error rather than fatal-exiting so callers (and tests) can decide.
func newRedisClient(redisURL string) (*redis.Client, error) {
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, err
	}
	return redis.NewClient(opt), nil
}

// newGateway builds the gateway from its dependencies. Pure constructor.
func newGateway(cfg config, rdb *redis.Client, logger *slog.Logger) *gateway {
	return &gateway{
		apiBase:    cfg.apiBase,
		httpClient: &http.Client{Timeout: 5 * time.Second},
		redis:      rdb,
		corsOrigin: cfg.corsOrigin,
		logger:     logger,
	}
}

// newRouter wires the chi router with the standard middleware stack and
// the gateway's HTTP routes. Pure factory — no side effects.
func newRouter(gw *gateway, logger *slog.Logger) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(structuredLogger(logger))
	r.Use(middleware.Recoverer)
	r.Get("/health", healthHandler)
	r.Get("/ready", gw.readyHandler)
	r.Get("/ws", gw.wsHandler)
	return r
}

// runServer starts the HTTP server in a goroutine, waits for stopCh, then
// drains with a 10-second timeout. Returns the shutdown error (or nil).
// Callers in tests can pre-close stopCh to exit immediately.
func runServer(srv *http.Server, stopCh <-chan os.Signal, logf func(string, ...any)) error {
	listenErrCh := make(chan error, 1)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			listenErrCh <- err
			return
		}
		listenErrCh <- nil
	}()

	select {
	case err := <-listenErrCh:
		if err != nil {
			return err
		}
	case <-stopCh:
		// graceful shutdown
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		logf("shutdown error: %v", err)
		return err
	}
	return nil
}

// run is the main entry point factored out of main() so tests can drive it
// with a pre-closed stop channel. Returns the first fatal error or nil.
func run(cfg config, stopCh <-chan os.Signal) error {
	if err := initSentry(cfg.sentryDSN, cfg.sentryEnvironment, cfg.sentryRelease); err != nil {
		log.Printf("sentry init failed: %v", err)
	}
	if cfg.sentryDSN != "" {
		defer sentry.Flush(2 * time.Second)
	}

	logger := newLogger(cfg.env)
	slog.SetDefault(logger)

	rdb, err := newRedisClient(cfg.redisURL)
	if err != nil {
		return err
	}
	defer rdb.Close()

	gw := newGateway(cfg, rdb, logger)
	srv := &http.Server{
		Addr:              ":" + cfg.port,
		Handler:           newRouter(gw, logger),
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("[realtime] listening on :%s (api=%s, redis=%s)", cfg.port, cfg.apiBase, cfg.redisURL)
	return runServer(srv, stopCh, log.Printf)
}

func main() {
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	if err := run(loadConfig(), stop); err != nil {
		log.Fatalf("realtime: %v", err)
	}
}

func envDefault(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func healthHandler(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"status":"ok","service":"realtime"}`))
}

// readyHandler returns 503 when Redis is unreachable. Used by deploys / LBs.
func (g *gateway) readyHandler(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	w.Header().Set("Content-Type", "application/json")
	if err := g.redis.Ping(ctx).Err(); err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"status":"not_ready","service":"realtime","redis":"unreachable"}`))
		return
	}
	_, _ = w.Write([]byte(`{"status":"ready","service":"realtime"}`))
}

// structuredLogger replaces chi's default text logger with a one-line JSON
// entry per HTTP response. Keeps log volume the same; gains structure.
func structuredLogger(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			defer func() {
				logger.Info("http",
					slog.String("method", r.Method),
					slog.String("path", r.URL.Path),
					slog.Int("status", ww.Status()),
					slog.Int("bytes", ww.BytesWritten()),
					slog.Duration("duration", time.Since(start)),
					slog.String("request_id", middleware.GetReqID(r.Context())),
				)
			}()
			next.ServeHTTP(ww, r)
		})
	}
}

// authenticate calls Nest's GET /auth/me with the provided bearer token and
// returns the resolved accountId. The gateway never inspects the token itself.
func (g *gateway) authenticate(ctx context.Context, token string) (accountID, userID string, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, g.apiBase+"/auth/me", nil)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("authorization", "Bearer "+token)
	resp, err := g.httpClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", "", errors.New("auth failed: " + resp.Status + " " + string(body))
	}
	var me meResponse
	if err := json.NewDecoder(resp.Body).Decode(&me); err != nil {
		return "", "", err
	}
	if me.Account.ID == "" {
		return "", "", errors.New("auth response missing account")
	}
	return me.Account.ID, me.User.ID, nil
}

func (g *gateway) wsHandler(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if rec := recover(); rec != nil {
			sentry.CurrentHub().Recover(rec)
			sentry.Flush(2 * time.Second)
			log.Printf("[realtime] panic recovered: %v", rec)
		}
	}()

	token := r.URL.Query().Get("token")
	if token == "" {
		http.Error(w, "missing token", http.StatusUnauthorized)
		return
	}

	accountID, _, err := g.authenticate(r.Context(), token)
	if err != nil {
		log.Printf("[realtime] auth failed: %v", err)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns:     parseOrigins(g.corsOrigin),
		// If env says wildcard, fall back to InsecureSkipVerify so any browser
		// can connect — convenient for dev, override in prod via CORS_ORIGIN.
		InsecureSkipVerify: g.corsOrigin == "*",
	})
	if err != nil {
		log.Printf("[realtime] ws accept error: %v", err)
		return
	}
	defer c.CloseNow()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	channel := "account:" + accountID
	sub := g.redis.Subscribe(ctx, channel)
	defer sub.Close()

	// Send a hello so clients know we're authenticated + subscribed.
	hello := map[string]any{"type": "Connected", "accountId": accountID}
	if err := writeJSON(ctx, c, hello); err != nil {
		log.Printf("[realtime] hello write error: %v", err)
		return
	}

	// Reader goroutine: drains client → server frames + control frames.
	// Any read error cancels the context and terminates the writer.
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer cancel()
		for {
			if _, _, err := c.Read(ctx); err != nil {
				return
			}
		}
	}()

	// Writer loop: pipes Redis messages to the WebSocket + periodic pings.
	pingTicker := time.NewTicker(pingInterval)
	defer pingTicker.Stop()
	ch := sub.Channel()
	for {
		select {
		case <-ctx.Done():
			wg.Wait()
			return
		case msg, ok := <-ch:
			if !ok {
				return
			}
			payload := json.RawMessage(msg.Payload)
			writeCtx, c2 := context.WithTimeout(ctx, writeTimeout)
			err := c.Write(writeCtx, websocket.MessageText, []byte(payload))
			c2()
			if err != nil {
				log.Printf("[realtime] write error: %v", err)
				return
			}
		case <-pingTicker.C:
			writeCtx, c2 := context.WithTimeout(ctx, writeTimeout)
			err := c.Ping(writeCtx)
			c2()
			if err != nil {
				return
			}
		}
	}
}

func writeJSON(ctx context.Context, c *websocket.Conn, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	writeCtx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return c.Write(writeCtx, websocket.MessageText, data)
}

// parseOrigins turns a comma-separated CORS_ORIGIN into a list of host-only
// origin patterns suitable for websocket.AcceptOptions.OriginPatterns. Returns
// nil if CORS_ORIGIN is "*", letting the caller decide whether to skip verify.
func parseOrigins(s string) []string {
	if s == "" || s == "*" {
		return nil
	}
	out := make([]string, 0, 2)
	for _, raw := range strings.Split(s, ",") {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		// Strip scheme — websocket.AcceptOptions wants host:port patterns.
		host := raw
		if i := strings.Index(host, "://"); i >= 0 {
			host = host[i+3:]
		}
		out = append(out, host)
	}
	return out
}
