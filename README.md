# JeanClaude

A tiny HTTP API in front of the [Claude](https://claude.com/claude-code) CLI. It gives you:

- an **OpenAI-compatible** `POST /v1/chat/completions` (with streaming), so chat apps that accept a custom OpenAI base URL can use Claude as their provider;
- a simple `POST /message` that returns the CLI's raw JSON result, optionally streamed;
- a small **chat page** in the browser at `/`, built on `/message`.

Under the hood each request runs `claude -p` and feeds it the prompt on stdin. By default it runs in **clean mode**: a plain chat with no project context, no tools and no user settings (see [Modes](#modes)).

Built with [Hono](https://hono.dev).

## Requirements

- Node.js 20 or newer
- The `claude` CLI, logged in (`claude auth login`), or a `CLAUDE_CODE_OAUTH_TOKEN` in the environment (see [Run in a container](#run-in-a-container))

## Run

```bash
npm install
```

```bash
npm start
```

The server listens on `http://127.0.0.1:3000`. `npm run dev` restarts it when a `.js` file changes. The chat page (`public/index.html`) is read once at startup, so restart the server after editing it.

## Chat in the browser

Open `http://localhost:3000/`. The page streams replies, renders Markdown, lets you pick the model, and shows how long each reply took and what it cost. The cost is `total_cost_usd` from `claude`: what the reply would cost at API prices. On a subscription you are not billed for it; it counts towards the usage limits instead.

- The conversation is a Claude session kept on the server; the page sends only your new message plus the session id. If the server no longer has the session (for example the container was recreated without a volume), the page replays the chat as text and carries on in a new session.
- Past chats are listed in the sidebar (a drawer on small screens). Chats and settings are saved in the browser's local storage, so they stay on that browser and device only. Deleting a chat removes it from the browser; its session file stays on the server.
- The header shows how much of the subscription's 5-hour and weekly limits is used, as reported by `claude` with the last reply (hover for the reset time). It updates after each message.
- If the server uses `JEANCLAUDE_API_KEY`, enter the key in Settings (the gear icon). The page itself loads without it.
- The system prompt in Settings applies to chats started after you save; a running chat keeps the one it started with.

## Run in a container

Every push to `main` builds an image (linux/amd64 and linux/arm64) and publishes it to `ghcr.io/spiska/jeanclaude` as `latest` and `sha-<short commit sha>`; a `v*` git tag is published under its own name. The image contains JeanClaude and the Claude Code CLI, pinned to the version JeanClaude was tested with (`CLAUDE_CODE_VERSION` in the `Containerfile`).

A server has no browser to log in with, so create a long-lived token on a machine where you are logged in:

```bash
claude setup-token
```

1. It prints a sign-in URL and tries to open it in your browser. If no browser opens (for example over SSH), copy the URL into a browser yourself.
2. Sign in with your Claude account and authorize the request.
3. The browser then shows a code. Copy it, paste it back into the terminal where `setup-token` is waiting, and press Enter.
4. The terminal prints the token, a long string starting with `sk-ant-oat01-`. Copy all of it. It is shown only once and is valid for a year.

Treat the token like a password: whoever has it can use your subscription. It works only with the `claude` CLI, not as a key for the Claude API.

Then pass it to the container. Put the secrets in a file readable only by you, e.g. `jeanclaude.env`:

```bash
CLAUDE_CODE_OAUTH_TOKEN=<token from setup-token>
JEANCLAUDE_API_KEY=<a long random string>
```

```bash
podman run -d --name jeanclaude --env-file jeanclaude.env -p 127.0.0.1:3000:3000 ghcr.io/spiska/jeanclaude:latest
```

Notes:

- Inside the container the server listens on `0.0.0.0`; what is reachable from outside is decided by `-p`. The example publishes it on the host's loopback only — put a reverse proxy with HTTPS in front if other machines need it, and always set `JEANCLAUDE_API_KEY`.
- `claude` runs in `/workspace`, an empty directory in the image.
- Sessions (used by the chat page and by `/message` with `sessionId`) are saved in `/home/node/.claude` and are lost when the container is removed. To keep them, add a volume: `-v jeanclaude-data:/home/node/.claude`. Without it the chat page still works — it replays old chats as text when their session is gone.
- To build locally: `podman build -t jeanclaude .`

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

If the server uses `JEANCLAUDE_API_KEY`, add `-H "authorization: Bearer $JEANCLAUDE_API_KEY"` to these and the other `curl` examples.

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

| Field       | Type    | Required | Description                                        |
| ----------- | ------- | -------- | -------------------------------------------------- |
| `message`   | string  | yes      | The prompt.                                        |
| `sessionId` | string  | no       | Continue an earlier conversation (`--resume <id>`). |
| `model`     | string  | no       | Same values as for the OpenAI endpoint.            |
| `system`    | string  | no       | System prompt for a new conversation. A resumed session keeps the one it started with. |
| `stream`    | boolean | no       | Reply as server-sent events instead of one JSON.   |

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

With `"stream": true` the reply is a series of `data:` events, each a JSON object:

| `type`   | Fields   | Meaning                                              |
| -------- | -------- | ---------------------------------------------------- |
| `delta`  | `text`   | The next piece of the answer.                        |
| `limits` | `limits` | Subscription usage limits (`rate_limit_info` from the CLI), if reported. |
| `result` | `result` | Last event: the same result object as shown above.   |
| `error`  | `error`  | Last event if claude failed after the stream started. |

## Other endpoints

- `GET /` — the chat page. Never requires an API key.
- `GET /health` — returns `{"ok": true}`. Never requires an API key.

## Errors

`/message` returns `{"error": "..."}`, plus `claude`'s result object and stderr when it failed; the `/v1/*` endpoints use the OpenAI shape, `{"error": {"message": "...", "type": "..."}}`.

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
| `HOST`                 | `127.0.0.1` (`0.0.0.0` in the container) | Interface to bind to.                |
| `JEANCLAUDE_API_KEY`   | not set                        | If set, requests must send `Authorization: Bearer <key>`. |
| `CLAUDE_BIN`           | auto-detected                  | Path to the `claude` binary.                   |
| `CLAUDE_TIMEOUT_MS`    | `300000`                       | Maximum time for one `claude` run (5 minutes). |
| `CLAUDE_MODE`          | `clean`                        | `clean` or `project` — see [Modes](#modes).    |
| `CLAUDE_SYSTEM_PROMPT` | `You are a helpful assistant.` | Default system prompt in clean mode.           |
| `CLAUDE_CWD`           | see Modes (`/workspace` in the container) | Directory `claude` runs in.         |

`CLAUDE_CODE_OAUTH_TOKEN` is not read by JeanClaude itself; `claude` inherits it and uses it to log in.

When `CLAUDE_BIN` is not set, the server looks for `claude` in `PATH`, then falls back to the binary bundled with the Claude desktop app on macOS. The path it picked is printed at startup.

## Modes

### `clean` (default)

Claude behaves like a plain chat model. It gets no project context (no git status, no `CLAUDE.md`, no memory), no tools (it cannot read files, run commands or browse), no MCP servers, no skills, and none of your Claude Code settings. Each request adds these flags:

```bash
--system-prompt "<system prompt>" --tools "" --setting-sources "" --strict-mcp-config --disable-slash-commands
```

The system prompt comes from the request (`system` messages on `/v1/chat/completions`, the `system` field on `/message`), or `CLAUDE_SYSTEM_PROMPT` if it has none.

`claude` still adds some context of its own: the path of its working directory, the OS, and that it runs on the Claude Agent SDK. So it runs in an empty folder, `chat-workspace` inside the system temp directory, and JeanClaude appends a short note to every system prompt telling the model it is a plain chat assistant without tools and should not mention that context. Without it, the model tends to introduce itself as a coding agent working in that folder. Sessions can only be resumed from the directory they were started in, so keep `CLAUDE_CWD` stable if you rely on `sessionId`.

### `project`

Full Claude Code, running in the directory the server was started from (or `CLAUDE_CWD`). It loads that project's context (`CLAUDE.md`, settings, MCP servers) and can read and search the files there, so API callers can ask about them. Nobody is around to approve permission prompts, so tools that need approval — editing files, running commands — are refused unless that project's or your user settings allow them. A request's system prompt is appended to Claude Code's own.

```bash
CLAUDE_MODE=project npm start
```

## Security

By default there is **no authentication**. Anyone who can reach the port can run Claude on your machine, under your account and at your cost — and in `project` mode, have it read the files in its working directory. The server binds to `127.0.0.1` for that reason. Before exposing it to a network, set `JEANCLAUDE_API_KEY` and put it behind HTTPS.

The prompt is passed to `claude` on stdin, never through a shell or as a command-line flag, so it cannot inject commands or options.

JeanClaude uses whatever account the `claude` CLI is logged in to. A Claude subscription is meant for your own use; check Anthropic's terms before putting this behind an app that other people use.
