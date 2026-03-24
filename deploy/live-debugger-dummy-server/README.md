# Live Debugger Dummy Server

This fixture starts a small Node.js HTTP server inside Docker and intentionally emits runtime failures on a timer so the live debugger has realistic logs to analyze.

## Start server + debugger with one script

```bash
bash deploy/live-debugger-dummy-server/start.sh
```

This single script will:

1. Build and start the Docker dummy server
2. Wait for `/health` to respond
3. Launch `ai-agent debug --docker fusion-live-debugger-dummy --batch 5 --log-level ERROR`

Optional: start only the container (no debugger launch):

```bash
bash deploy/live-debugger-dummy-server/start.sh start-only
```

Optional: pass extra debugger flags (for example provider/model):

```bash
bash deploy/live-debugger-dummy-server/start.sh debug --provider openai --model gpt-4o
```

Optional: configure Teams notifications in the dummy server YAML config:

Edit [`deploy/live-debugger-dummy-server/docker-compose.yml`](docker-compose.yml) and set:

```yaml
environment:
	TEAMS_WEBHOOK_URL: "https://outlook.office.com/webhook/YOUR/WEBHOOK/URL"
```

Then run the same start script. It will read `TEAMS_WEBHOOK_URL` from the running container config and pass it to the live debugger automatically.

```bash
bash deploy/live-debugger-dummy-server/start.sh debug --provider openai --model gpt-4o
```

Manual container-only start:

```bash
docker compose -f deploy/live-debugger-dummy-server/docker-compose.yml up --build -d
```

The container name is fixed to `fusion-live-debugger-dummy`.

## Generate extra failures on demand

```bash
curl http://localhost:8080/crash
curl http://localhost:8080/db-check
```

## Attach fusion-agent live debugger

```bash
ai-agent debug --docker fusion-live-debugger-dummy --batch 5 --log-level ERROR
```

You can also watch the raw logs directly:

```bash
docker logs -f fusion-live-debugger-dummy
```

## Stop the container

```bash
docker compose -f deploy/live-debugger-dummy-server/docker-compose.yml down
```
