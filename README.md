# JeanClaude

A tiny HTTP API in front of the [Claude Code](https://claude.com/claude-code) CLI. Send a message, get Claude's JSON back.

Under the hood each request runs:

```bash
claude -p "<your message>" --output-format json
```

By default it runs in **clean mode**: a plain chat with no project context, no tools and no user settings (see [Modes](#modes)).

No dependencies — just Node.js 18+.

## Requirements

- Node.js 18 or newer
- The `claude` CLI, logged in (`claude auth login`)

## Run

```bash
npm start
```

The server listens on `http://127.0.0.1:3000`. Use `npm run dev` to restart on file changes.

## API

### `POST /message`

| Field       | Type   | Required | Description                                        |
| ----------- | ------ | -------- | -------------------------------------------------- |
| `message`   | string | yes      | The prompt passed to `claude -p`.                  |
| `sessionId` | string | no       | Continue an earlier conversation (`--resume <id>`). |

```bash
curl -s -X POST localhost:3000/message \
  -H 'content-type: application/json' \
  -d '{"message":"hello, how are you?"}'
```

The response is the CLI's JSON output, unchanged (trimmed here):

```json
{
  "type": "result",
  "is_error": false,
  "result": "Hello! I'm doing well — how can I help?",
  "session_id": "a19b0e10-82cc-43d9-964e-dad7c48e2e6a",
  "total_cost_usd": 0.066
}
```

Pass `session_id` back as `sessionId` to keep the conversation going.

### `GET /health`

Returns `{"ok": true}`.

### Errors

Errors come back as `{"error": "..."}` with one of these statuses:

| Status | Meaning                                                             |
| ------ | ------------------------------------------------------------------- |
| 400    | Missing or invalid `message` / `sessionId`, or the body isn't JSON. |
| 404    | Unknown route.                                                      |
| 413    | Body larger than 1 MB.                                              |
| 500    | The `claude` binary could not be found or started.                  |
| 502    | `claude` exited non-zero or printed invalid JSON (details included). |
| 504    | `claude` was killed, usually by the timeout.                        |

## Configuration

All via environment variables:

| Variable            | Default       | Description                                  |
| ------------------- | ------------- | -------------------------------------------- |
| `PORT`              | `3000`        | Port to listen on.                           |
| `HOST`              | `127.0.0.1`   | Interface to bind to.                        |
| `CLAUDE_BIN`        | auto-detected | Path to the `claude` binary.                 |
| `CLAUDE_TIMEOUT_MS` | `300000`      | Maximum time for one `claude` run (5 minutes). |
| `CLAUDE_MODE`       | `clean`       | `clean` or `project` — see [Modes](#modes).  |
| `CLAUDE_SYSTEM_PROMPT` | `You are a helpful assistant.` | System prompt used in clean mode. |
| `CLAUDE_CWD`        | see Modes     | Directory `claude` runs in.                  |

When `CLAUDE_BIN` is not set, the server looks for `claude` in `PATH`, then falls back to the binary bundled with the Claude desktop app on macOS. The path it picked is printed at startup.

## Modes

### `clean` (default)

Claude behaves like a plain chat model. It gets no project context (no git status, no `CLAUDE.md`, no memory), no tools (it cannot read files, run commands or browse), no MCP servers, no skills, and none of your Claude Code settings. Each request adds these flags:

```bash
--system-prompt "<CLAUDE_SYSTEM_PROMPT>" --tools "" --setting-sources "" --strict-mcp-config --disable-slash-commands
```

`claude` still sees the path of its working directory, so it runs in an empty folder, `chat-workspace` inside the system temp directory. Sessions can only be resumed from the directory they were started in, so keep `CLAUDE_CWD` stable if you rely on `sessionId`.

### `project`

Full Claude Code, running in the directory the server was started from (or `CLAUDE_CWD`). It loads that project's context and has its usual tools, so API callers can ask it about the files there.

```bash
CLAUDE_MODE=project npm start
```

## Security

There is **no authentication**. Anyone who can reach the port can run Claude on your machine, under your account and at your cost — and in `project` mode, have it read the files in its working directory. The server binds to `127.0.0.1` by default for that reason — don't expose it to a network without putting your own auth in front of it.

The message is passed to `claude` as a single argument, never through a shell, so it cannot inject shell commands.
