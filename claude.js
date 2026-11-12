import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const CLAUDE_BIN = resolveClaudeBin();
export const TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS ?? 5 * 60 * 1000);

// "clean" (default): a chat assistant working in the repo's workspace/ folder — its
//   CLAUDE.md, read-only access to its files, web search; none of your own settings.
// "project": full Claude Code in the directory the server was started from.
export const MODE = process.env.CLAUDE_MODE ?? 'clean';
if (MODE !== 'clean' && MODE !== 'project') {
  console.error(`Invalid CLAUDE_MODE "${MODE}" — use "clean" or "project"`);
  process.exit(1);
}
const SYSTEM_PROMPT = process.env.CLAUDE_SYSTEM_PROMPT ?? 'You are a helpful assistant.';
// Clean mode's tools. Reading is limited to the working directory (reads elsewhere
// need approval, which nobody can give in -p mode); the web tools are pre-approved.
const CLEAN_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
const CLEAN_ALLOWED_TOOLS = ['WebSearch', 'WebFetch'];
// The path must stay stable: sessions can only be resumed from the same cwd.
export const CLAUDE_CWD =
  process.env.CLAUDE_CWD ?? (MODE === 'clean' ? fileURLToPath(new URL('./workspace', import.meta.url)) : process.cwd());
if (MODE === 'clean') mkdirSync(CLAUDE_CWD, { recursive: true });

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

/**
 * Starts `claude -p`. The prompt goes in on stdin rather than as an argument, so it
 * is never parsed as a flag, never touches a shell, and has no argv length limit.
 *
 * @param {object} o
 * @param {string} o.prompt
 * @param {boolean} [o.stream]        stream-json output with partial messages
 * @param {string} [o.systemPrompt]   replaces the default one (appended in project mode)
 * @param {string} [o.model]          passed to --model
 * @param {string} [o.sessionId]      passed to --resume
 * @param {boolean} [o.persist]       false = don't save the session to disk
 * @param {AbortSignal} [o.signal]    kills the process when aborted
 */
function spawnClaude({ prompt, stream = false, systemPrompt, model, sessionId, persist = true, signal }) {
  const args = ['-p', '--output-format', stream ? 'stream-json' : 'json'];
  if (stream) args.push('--verbose', '--include-partial-messages');
  if (MODE === 'clean') {
    args.push(
      '--system-prompt', systemPrompt ?? SYSTEM_PROMPT, // replaces Claude Code's own prompt
      '--tools', CLEAN_TOOLS.join(','), // no shell, no editing
      '--allowedTools', CLEAN_ALLOWED_TOOLS.join(','),
      '--setting-sources', 'project', // the workspace's CLAUDE.md and .claude/ only, not your user settings
      '--strict-mcp-config', // no MCP servers
      '--disable-slash-commands', // no skills or commands
    );
  } else if (systemPrompt) {
    args.push('--append-system-prompt', systemPrompt);
  }
  if (model) args.push('--model', model);
  if (sessionId) args.push('--resume', sessionId);
  if (!persist) args.push('--no-session-persistence');

  const child = spawn(CLAUDE_BIN, args, {
    cwd: CLAUDE_CWD,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: TIMEOUT_MS,
    signal,
  });
  child.stdin.on('error', () => {}); // EPIPE if claude dies before reading the prompt
  child.stdin.end(prompt);

  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));

  // Resolves once the process is gone; never rejects.
  const exited = new Promise((resolve) => {
    child.on('error', (error) => resolve({ error }));
    child.on('close', (code, sig) => resolve({ code, sig }));
  });

  return { child, exited, stderr: () => stderr.slice(0, 2000) };
}

/** Turns a failed exit into an HttpError, or returns undefined if the exit was clean. */
function exitError({ error, code, sig }) {
  if (error?.code === 'ENOENT') {
    return new HttpError(500, `Could not find the "${CLAUDE_BIN}" binary — set CLAUDE_BIN or fix PATH`);
  }
  if (error?.name === 'AbortError') return new HttpError(499, 'Client closed the request');
  if (error) return new HttpError(500, error.message);
  if (sig) return new HttpError(504, `claude was killed by ${sig} (timeout of ${TIMEOUT_MS} ms?)`);
  return undefined;
}

/** Why a result object is an error: its text, or the CLI's `errors` list (e.g. unknown session). */
function failureReason(result) {
  if (typeof result?.result === 'string' && result.result) return result.result;
  if (Array.isArray(result?.errors) && result.errors.length) return result.errors.join('; ');
  return '';
}

/** Runs claude to completion and returns its parsed JSON result object. */
export async function runClaude(options) {
  const { child, exited, stderr } = spawnClaude({ ...options, stream: false });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));

  const end = await exited;
  const failure = exitError(end);
  if (failure) throw failure;

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new HttpError(502, 'claude did not return valid JSON', {
      exitCode: end.code,
      stdout: stdout.slice(0, 2000),
      stderr: stderr(),
    });
  }
  if (end.code !== 0 || parsed.is_error) {
    const reason = failureReason(parsed);
    throw new HttpError(502, `claude exited with code ${end.code}${reason ? `: ${reason}` : ''}`, { claude: parsed, stderr: stderr() });
  }
  return parsed;
}

/**
 * Runs claude and yields its output as it is generated:
 *   { type: 'delta', text }     a piece of the answer
 *   { type: 'limits', limits }  subscription usage limits (rate_limit_info), when claude reports them
 *   { type: 'result', result }  the final result object (always last)
 * Throws HttpError if claude fails.
 */
export async function* streamClaude(options) {
  const { child, exited, stderr } = spawnClaude({ ...options, stream: true });
  let result;
  let sentText = false;
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === 'stream_event' && event.event?.type === 'message_start' && sentText) {
        // A new model turn after a tool call: keep its text apart from what came before.
        sentText = false;
        yield { type: 'delta', text: '\n\n' };
      } else if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') {
        sentText = true;
        yield { type: 'delta', text: event.event.delta.text };
      } else if (event.type === 'rate_limit_event' && event.rate_limit_info) {
        yield { type: 'limits', limits: event.rate_limit_info };
      } else if (event.type === 'result') {
        result = event;
      }
    }

    const end = await exited;
    const failure = exitError(end);
    if (failure) throw failure;
    if (!result) {
      throw new HttpError(502, 'claude ended without a result', { exitCode: end.code, stderr: stderr() });
    }
    if (result.is_error || end.code !== 0) {
      throw new HttpError(502, failureReason(result) || `claude exited with code ${end.code}`, {
        claude: result,
        stderr: stderr(),
      });
    }
    yield { type: 'result', result };
  } finally {
    // The consumer stopped early (client went away) — don't leave claude running.
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}
