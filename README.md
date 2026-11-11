# JeanClaude

A tiny HTTP API in front of the [Claude Code](https://claude.com/claude-code) CLI. It exposes two things:

- an **OpenAI-compatible** `POST /v1/chat/completions` (with streaming), so chat apps that accept a custom OpenAI base URL can use Claude as their provider;
- a simple `POST /message` that returns the CLI's raw JSON result.

Under the hood each request runs `claude -p` and feeds it the prompt on stdin. By default it runs in **clean mode**: a plain chat with no project context, no tools and no user settings (see [Modes](#modes)).

Built with [Hono](https://hono.dev).

## Requirements

- Node.js 18 or newer
- The `claude` CLI, logged in (`claude auth login`)

## Run

```bash
npm install
```

```bash
npm start
```

The server listens on `http://127.0.0.1:3000`. Use `npm run dev` to restart on file changes.

## Use it as an OpenAI-compatible provider

Point the app at JeanClaude:

| Setting  | Value                                                        |
| -------- | ------------------------------------------------------------ |
| Base URL | `http://localhost:3000/v1`                                   |
| API key  | anything, unless you set `JEANCLAUDE_API_KEY`                |
| Model    | `default`, `fable`, `opus`, `sonnet`, `haiku` or a full `claude-…` id |

```bash
curl -s localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"hello, how are you?"}]}'
```

Add `"stream": true` to get the answer as server-sent events while it is being generated:

```bash
curl -sN localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"sonnet","stream":true,"messages":[{"role":"user","content":"count to ten"}]}'
```

### What is and isn't supported

| Feature                              | Status                                                         |
| ------------------------------------ | -------------------------------------------------------------- |
| `messages` with text content         | Supported. `system` / `developer` messages become the system prompt. |
| Multi-turn conversations             | Supported. The CLI takes a single prompt, so the history is sent as a transcript. |
| `stream`, `stream_options.include_usage` | Supported.                                                 |
| `model`                              | Claude aliases and ids are passed on; any other name (e.g. `gpt-4o`) uses Claude's default model. |
| `GET /v1/models`                     | Supported.                                                     |
| Tool / function calling              | Not supported — `tools` is ignored and the model answers in text. |
| Images and other non-text content    | Not supported — rejected with 400.                             |
| `temperature`, `max_tokens`, `n`, …  | Ignored — the CLI has no equivalent.                           |

The endpoint is stateless: the client sends the whole conversation every time and nothing is saved to disk.

## `POST /message`

JeanClaude's own endpoint. One message in, the CLI's result object out — including cost, usage and a session id you can use to continue the conversation.

| Field       | Type   | Required | Description                                        |
| ----------- | ------ | -------- | -------------------------------------------------- |
| `message`   | string | yes      | The prompt.                                        |
| `sessionId` | string | no       | Continue an earlier conversation (`--resume <id>`). |

```bash
curl -s -X POST localhost:3000/message \
  -H 'content-type: application/json' \
  -d '{"message":"hello, how are you?"}'
```

Response (trimmed):

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

## Other endpoints

- `GET /health` — returns `{"ok": true}`. Never requires an API key.

## Errors

`/message` returns `{"error": "..."}`; the `/v1/*` endpoints use the OpenAI shape, `{"error": {"message": "...", "type": "..."}}`.

| Status | Meaning                                                              |
| ------ | -------------------------------------------------------------------- |
| 400    | Invalid request body or fields.                                      |
| 401    | Missing or wrong API key (only when `JEANCLAUDE_API_KEY` is set).    |
| 404    | Unknown route.                                                       |
| 413    | Body larger than 4 MB.                                               |
| 500    | The `claude` binary could not be found or started.                   |
| 502    | `claude` failed (not logged in, unknown model, invalid output, …).   |
| 504    | `claude` was killed, usually by the timeout.                         |

If a streaming request fails after the stream has started, the error is sent as a final `data:` event instead.

## Configuration

All via environment variables:

| Variable               | Default                        | Description                                    |
| ---------------------- | ------------------------------ | ---------------------------------------------- |
| `PORT`                 | `3000`                         | Port to listen on.                             |
| `HOST`                 | `127.0.0.1`                    | Interface to bind to.                          |
| `JEANCLAUDE_API_KEY`   | not set                        | If set, requests must send `Authorization: Bearer <key>`. |
| `CLAUDE_BIN`           | auto-detected                  | Path to the `claude` binary.                   |
| `CLAUDE_TIMEOUT_MS`    | `300000`                       | Maximum time for one `claude` run (5 minutes). |
| `CLAUDE_MODE`          | `clean`                        | `clean` or `project` — see [Modes](#modes).    |
| `CLAUDE_SYSTEM_PROMPT` | `You are a helpful assistant.` | Default system prompt in clean mode.           |
| `CLAUDE_CWD`           | see Modes                      | Directory `claude` runs in.                    |

When `CLAUDE_BIN` is not set, the server looks for `claude` in `PATH`, then falls back to the binary bundled with the Claude desktop app on macOS. The path it picked is printed at startup.

## Modes

### `clean` (default)

Claude behaves like a plain chat model. It gets no project context (no git status, no `CLAUDE.md`, no memory), no tools (it cannot read files, run commands or browse), no MCP servers, no skills, and none of your Claude Code settings. Each request adds these flags:

```bash
--system-prompt "<system prompt>" --tools "" --setting-sources "" --strict-mcp-config --disable-slash-commands
```

The system prompt comes from the request's `system` messages, or `CLAUDE_SYSTEM_PROMPT` if there are none.

`claude` still sees the path of its working directory, so it runs in an empty folder, `chat-workspace` inside the system temp directory. Sessions can only be resumed from the directory they were started in, so keep `CLAUDE_CWD` stable if you rely on `sessionId`.

### `project`

Full Claude Code, running in the directory the server was started from (or `CLAUDE_CWD`). It loads that project's context and has its usual tools, so API callers can ask it about the files there. A request's `system` messages are appended to Claude Code's own system prompt.

```bash
CLAUDE_MODE=project npm start
```

## Security

By default there is **no authentication**. Anyone who can reach the port can run Claude on your machine, under your account and at your cost — and in `project` mode, have it read the files in its working directory. The server binds to `127.0.0.1` for that reason. Before exposing it to a network, set `JEANCLAUDE_API_KEY` and put it behind HTTPS.

The prompt is passed to `claude` on stdin, never through a shell or as a command-line flag, so it cannot inject commands or options.

JeanClaude uses whatever account the `claude` CLI is logged in to. A Claude subscription is meant for your own use; check Anthropic's terms before putting this behind an app that other people use, and use the Claude API with an API key for that instead.
