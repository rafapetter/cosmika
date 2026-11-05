# realtime

Go WebSocket gateway. Authenticates clients (web inbox), subscribes to the
account-scoped Redis pub/sub channels they care about, and fans events out.

Separated from `apps/api` because Node WS fanout at scale gets expensive in
event loop time; Go goroutines per connection are cheap.

## Run

```bash
export PORT=3120
export REDIS_URL=redis://localhost:6379
go run ./...
```
