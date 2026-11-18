import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import * as activity from './activity.js';

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
// need approval, which nobody can give in -p mode); the web tools and skills are pre-approved.
const CLEAN_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Skill'];
const CLEAN_ALLOWED_TOOLS = ['WebSearch', 'WebFetch', 'Skill'];
// Only the workspace's own skills (.claude/skills/), not the ones built into the CLI.
const CLEAN_ENV = { CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1', CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL: '1' };
// The API client's own tools reach claude through tools-mcp.js, an MCP server named
// "client", so claude sees them as mcp__client__<name>.
export const CLIENT_TOOL_PREFIX = 'mcp__client__';
const TOOLS_MCP = fileURLToPath(new URL('./tools-mcp.js', import.meta.url));
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
 * @param {string} [o.systemPrompt]   replaces the default one (appended in project mode)
 * @param {string} [o.model]          passed to --model
 * @param {string} [o.sessionId]      passed to --resume
 * @param {boolean} [o.persist]       false = don't save the session to disk
 * @param {AbortSignal} [o.signal]    kills the process when aborted
 * @param {string} [o.source]         the endpoint asking, for the activity log
 * @param {object[]} [o.tools]        the client's tools: { name, description, inputSchema }
 * @param {string} [o.toolInstruction] added to the system prompt when there are tools
 */
function spawnClaude({ prompt, systemPrompt, model, sessionId, persist = true, signal, tools, toolInstruction }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  const clientTools = tools?.length ? tools : undefined;
  const allowed = clientTools ? clientTools.map((t) => CLIENT_TOOL_PREFIX + t.name) : [];
  const extra = clientTools && toolInstruction ? toolInstruction : undefined;
  if (MODE === 'clean') {
    const system = [systemPrompt ?? SYSTEM_PROMPT, extra].filter(Boolean).join('\n\n');
    args.push(
      '--system-prompt', system, // replaces Claude Code's own prompt
      '--tools', CLEAN_TOOLS.join(','), // no shell, no editing
      '--allowedTools', [...CLEAN_ALLOWED_TOOLS, ...allowed].join(','),
      '--setting-sources', 'project', // the workspace's CLAUDE.md and .claude/ (skills), not your user settings
      '--strict-mcp-config', // no MCP servers other than the client's tools
    );
  } else {
    const system = [systemPrompt, extra].filter(Boolean).join('\n\n');
    if (system) args.push('--append-system-prompt', system);
    if (allowed.length) args.push('--allowedTools', allowed.join(','));
  }
  // The client's tools: a list file and an MCP config pointing at it, removed on exit.
  let toolsDir;
  if (clientTools) {
    toolsDir = mkdtempSync(join(tmpdir(), 'jeanclaude-tools-'));
    const listFile = join(toolsDir, 'tools.json');
    const configFile = join(toolsDir, 'mcp.json');
    writeFileSync(listFile, JSON.stringify(clientTools));
    writeFileSync(configFile, JSON.stringify({ mcpServers: { client: { command: process.execPath, args: [TOOLS_MCP, listFile] } } }));
    args.push('--mcp-config', configFile);
  }
  if (model) args.push('--model', model);
  if (sessionId) args.push('--resume', sessionId);
  if (!persist) args.push('--no-session-persistence');

  const child = spawn(CLAUDE_BIN, args, {
    cwd: CLAUDE_CWD,
    env: MODE === 'clean' ? { ...process.env, ...CLEAN_ENV } : process.env,
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
  if (toolsDir) exited.then(() => rmSync(toolsDir, { recursive: true, force: true }));

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

/**
 * Runs claude to completion and returns its result object. It reads the same
 * stream-json output as streamClaude, which (unlike plain json) carries the
 * subscription's usage limits and the reason a run failed.
 */
export async function runClaude(options) {
  let result;
  for await (const event of streamClaude({ ...options, stream: false })) {
    if (event.type === 'result') result = event.result;
  }
  return result;
}

/**
 * Runs claude and yields its output as it is generated:
 *   { type: 'delta', text }     a piece of the answer
 *   { type: 'limits', limits }  subscription usage limits (rate_limit_info), when claude reports them
 *   { type: 'result', result }  the final result object (always last)
 * Throws HttpError if claude fails.
 */
export async function* streamClaude(options) {
  const run = activity.begin({ stream: true, ...options }); // runClaude passes stream: false
  try {
    for await (const event of streamClaudeOnce(options)) {
      if (event.type === 'limits') activity.setLimits(event.limits);
      if (event.type === 'result') run.finish(event.result);
      yield event;
    }
  } catch (err) {
    run.fail(err);
    throw err;
  } finally {
    run.cancel(); // no-op if the run already ended
  }
}

/** Adds a message's token counts (from message_delta) to a running total. */
function addUsage(total, u) {
  for (const key of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']) {
    total[key] = (total[key] ?? 0) + (typeof u?.[key] === 'number' ? u[key] : 0);
  }
}

async function* streamClaudeOnce(options) {
  const { child, exited, stderr } = spawnClaude(options);
  let result;
  let sentText = false;
  // Client tool calls of the current model turn, and what is needed to answer
  // without claude's own result event when the turn ends with them.
  let toolCalls = [];
  let stopping = false;
  let text = '';
  let sessionId;
  const models = new Set();
  const usage = {};
  let turns = 0;
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const se = event.type === 'stream_event' ? event.event : undefined;
      if (stopping) {
        // The tool calls are complete. claude reports the usage limits right after;
        // anything else means it has moved on to running the tools.
        if (event.type === 'rate_limit_event' && event.rate_limit_info) yield { type: 'limits', limits: event.rate_limit_info };
        if (event.type !== 'system') break;
        continue;
      }
      if (event.type === 'system' && event.subtype === 'init') {
        sessionId = event.session_id;
      } else if (se?.type === 'message_start') {
        turns++;
        toolCalls = [];
        if (se.message?.model) models.add(se.message.model);
        if (sentText) {
          // A new model turn after a tool call: keep its text apart from what came before.
          sentText = false;
          text += '\n\n';
          yield { type: 'delta', text: '\n\n' };
        }
      } else if (se?.delta?.type === 'text_delta') {
        sentText = true;
        text += se.delta.text;
        yield { type: 'delta', text: se.delta.text };
      } else if (se?.type === 'message_delta') {
        addUsage(usage, se.usage);
      } else if (event.type === 'assistant') {
        // Each assistant event carries finished content blocks, tool calls with their whole input.
        for (const block of event.message?.content ?? []) {
          if (block?.type === 'tool_use' && block.name?.startsWith(CLIENT_TOOL_PREFIX)) {
            toolCalls.push({ id: block.id, name: block.name.slice(CLIENT_TOOL_PREFIX.length), arguments: JSON.stringify(block.input ?? {}) });
          }
        }
      } else if (se?.type === 'message_stop' && toolCalls.length) {
        // The model wants the client's tools: hand the calls over instead of letting
        // claude wait for an answer. Give it a moment to report the usage limits.
        stopping = true;
        setTimeout(() => child.kill(), 1000).unref();
      } else if (event.type === 'rate_limit_event' && event.rate_limit_info) {
        yield { type: 'limits', limits: event.rate_limit_info };
      } else if (event.type === 'result') {
        result = event;
      }
    }

    if (stopping) {
      const calls = options.singleToolCall ? toolCalls.slice(0, 1) : toolCalls;
      yield {
        type: 'result',
        result: {
          type: 'result',
          subtype: 'tool_calls',
          is_error: false,
          result: text,
          tool_calls: calls,
          session_id: sessionId,
          num_turns: turns,
          total_cost_usd: 0, // claude only reports it in its own result event
          usage,
          modelUsage: Object.fromEntries([...models].map((m) => [m, {}])),
        },
      };
      return;
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
