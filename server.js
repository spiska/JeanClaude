import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';
const CLAUDE_BIN = resolveClaudeBin();
const TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS ?? 5 * 60 * 1000);
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Order: CLAUDE_BIN from env → `claude` in PATH → the binary bundled with the Claude
 * desktop app (newest version; its path changes on every update, so we look it up).
 */
function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;

  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, 'claude'))) return join(dir, 'claude');
  }

  const root = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code');
  const list = (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  const versions = list(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    for (const build of list(join(root, version))) {
      const bin = join(root, version, build, 'claude.app', 'Contents', 'MacOS', 'claude');
      if (existsSync(bin)) return bin;
    }
  }

  return 'claude';
}

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON');
  }
}

/**
 * Runs `claude -p <message> --output-format json` and returns the parsed JSON.
 * The message is passed as a single argument (no shell), so it cannot inject commands.
 */
function runClaude(message, { sessionId, signal } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-p', message, '--output-format', 'json'];
    if (sessionId) args.push('--resume', sessionId);

    const child = spawn(CLAUDE_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: TIMEOUT_MS,
      signal,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new HttpError(500, `Could not find the "${CLAUDE_BIN}" binary — set CLAUDE_BIN or fix PATH`));
      } else if (err.name === 'AbortError') {
        reject(new HttpError(499, 'Client closed the request'));
      } else {
        reject(new HttpError(500, err.message));
      }
    });

    child.on('close', (code, sig) => {
      if (sig) {
        return reject(new HttpError(504, `claude was killed by ${sig} (timeout of ${TIMEOUT_MS} ms?)`));
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        return reject(
          new HttpError(502, 'claude did not return valid JSON', {
            exitCode: code,
            stdout: stdout.slice(0, 2000),
            stderr: stderr.slice(0, 2000),
          }),
        );
      }
      if (code !== 0) {
        return reject(new HttpError(502, `claude exited with code ${code}`, { claude: parsed, stderr: stderr.slice(0, 2000) }));
      }
      resolve(parsed);
    });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/message') {
      const body = await readJsonBody(req);
      const { message, sessionId } = body;
      if (typeof message !== 'string' || !message.trim()) {
        throw new HttpError(400, 'Missing "message" field (non-empty string)');
      }
      if (sessionId !== undefined && typeof sessionId !== 'string') {
        throw new HttpError(400, '"sessionId" must be a string');
      }

      // If the client disconnects, kill the claude process too.
      const ac = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) ac.abort();
      });

      const result = await runClaude(message, { sessionId, signal: ac.signal });
      return send(res, 200, result);
    }

    throw new HttpError(404, 'Not found');
  } catch (err) {
    if (res.destroyed) return;
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(`[${req.method} ${url.pathname}]`, err.message);
    send(res, status, { error: err.message, ...(err.extra ?? {}) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`JeanClaude is running at http://${HOST}:${PORT}`);
  console.log(`claude: ${CLAUDE_BIN}`);
});
