// In-memory record of what the server has been doing, for the /dashboard page.
// Nothing is written to disk: a restart starts from zero. No prompt or answer
// text is kept, only sizes, timings, token counts and errors.

const MAX_RECENT = 200;
const HOUR = 60 * 60 * 1000;
const HOURS_KEPT = 24;

const startedAt = Date.now();
let nextId = 1;
const running = new Map();
const recent = []; // newest first
const totals = { requests: 0, errors: 0, rejected: 0, cancelled: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0 };
const hourly = new Map(); // hour start (ms) -> { requests, errors, outputTokens }
let limits = null;
const recorded = new WeakSet(); // errors already logged as a failed run

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function bucket(at) {
  const hour = Math.floor(at / HOUR) * HOUR;
  if (!hourly.has(hour)) {
    hourly.set(hour, { requests: 0, errors: 0, outputTokens: 0 });
    for (const key of hourly.keys()) if (key <= hour - HOURS_KEPT * HOUR) hourly.delete(key);
  }
  return hourly.get(hour);
}

/**
 * Records the start of a claude run. Returns callbacks for its end; only the first
 * one called counts, so a run is never finished twice.
 *
 * @param {object} o
 * @param {string} [o.source]     the endpoint that started it
 * @param {string} [o.model]      the requested model
 * @param {boolean} [o.stream]
 * @param {string} [o.sessionId]  set when an earlier conversation is resumed
 * @param {string} [o.prompt]     only its length is kept
 */
export function begin({ source, model, stream, sessionId, prompt }) {
  const run = {
    id: nextId++,
    source: source ?? 'unknown',
    model: model ?? 'default',
    stream: Boolean(stream),
    resumed: Boolean(sessionId),
    promptChars: typeof prompt === 'string' ? prompt.length : 0,
    startedAt: Date.now(),
  };
  running.set(run.id, run);

  let ended = false;
  const end = (status, fields) => {
    if (ended) return;
    ended = true;
    running.delete(run.id);
    const { id, ...rest } = run;
    record({ ...rest, durationMs: Date.now() - run.startedAt, status, ...fields });
  };

  return {
    /** claude finished; `result` is its result object. */
    finish(result) {
      end('ok', resultFields(result));
    },
    /** claude failed or was stopped. */
    fail(err) {
      if (err?.status === 499) return end('cancelled', {});
      if (err && typeof err === 'object') recorded.add(err);
      const fields = { error: String(err?.message ?? err).slice(0, 300), httpStatus: err?.status ?? 500 };
      const result = err?.extra?.claude; // a failed run can still report usage
      end('error', result ? { ...resultFields(result), ...fields } : fields);
    },
    /** The run went away without a result or an error (the client stopped reading). */
    cancel() {
      end('cancelled', {});
    },
  };
}

function record(entry) {
  recent.unshift(entry);
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;

  const hour = bucket(entry.startedAt);
  hour.requests++;
  totals.requests++;
  if (entry.status === 'error' || entry.status === 'rejected') {
    hour.errors++;
    totals.errors++;
  }
  if (entry.status === 'rejected') totals.rejected++;
  if (entry.status === 'cancelled') totals.cancelled++;
  if (entry.usage) {
    totals.inputTokens += entry.usage.input;
    totals.cacheReadTokens += entry.usage.cacheRead;
    totals.cacheWriteTokens += entry.usage.cacheWrite;
    totals.outputTokens += entry.usage.output;
    hour.outputTokens += entry.usage.output;
  }
  totals.costUsd += num(entry.costUsd);
}

/**
 * Records a request the server answered with an HTTP error before (or without)
 * running claude: bad API key, invalid body, unknown path. Errors from a claude
 * run are already in the log and are skipped.
 */
export function rejected({ method, path, status, message, err }) {
  if (err && recorded.has(err)) return;
  if (status === 499) return; // the client went away; nothing to see
  record({
    source: path,
    method,
    startedAt: Date.now(),
    durationMs: 0,
    status: 'rejected',
    httpStatus: status,
    error: String(message ?? '').slice(0, 300),
  });
}

function resultFields(result) {
  const u = result?.usage ?? {};
  return {
    models: result?.modelUsage && typeof result.modelUsage === 'object' ? Object.keys(result.modelUsage) : [],
    turns: num(result?.num_turns),
    costUsd: num(result?.total_cost_usd),
    usage: {
      input: num(u.input_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      cacheWrite: num(u.cache_creation_input_tokens),
      output: num(u.output_tokens),
    },
  };
}

/** The subscription's usage windows, as claude last reported them. */
export function setLimits(info) {
  limits = { info, at: Date.now() };
}

export function snapshot() {
  const now = Date.now();
  const thisHour = Math.floor(now / HOUR) * HOUR;
  const hours = [];
  for (let i = HOURS_KEPT - 1; i >= 0; i--) {
    const hour = thisHour - i * HOUR;
    hours.push({ hour, ...(hourly.get(hour) ?? { requests: 0, errors: 0, outputTokens: 0 }) });
  }
  return {
    now,
    startedAt,
    running: [...running.values()].map(({ id, ...run }) => run).sort((a, b) => a.startedAt - b.startedAt),
    totals: { ...totals, costUsd: Math.round(totals.costUsd * 1e6) / 1e6 },
    hourly: hours,
    recent,
    limits,
  };
}
