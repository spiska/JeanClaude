import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { CLAUDE_BIN, CLAUDE_CWD, HttpError, MODE, runClaude, streamClaude } from './claude.js';
import {
  MODELS,
  chunk,
  completion,
  errorBody,
  newCompletionId,
  newResponseIds,
  resolveModel,
  response,
  responseMessage,
  responsesToMessages,
  toPrompt,
} from './openai.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';
const API_KEY = process.env.JEANCLAUDE_API_KEY;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const CHAT_PAGE = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
// The page is self-contained (inline CSS and JS) and only talks to this server.
const CHAT_PAGE_CSP =
  "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const app = new Hono();

const isOpenAiPath = (c) => c.req.path.startsWith('/v1/');

app.onError((err, c) => {
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) console.error(`[${c.req.method} ${c.req.path}]`, err.message);
  if (isOpenAiPath(c)) return c.json(errorBody(err, status), status);
  return c.json({ error: err.message, ...(err.extra ?? {}) }, status);
});

app.notFound((c) => {
  const err = new HttpError(404, 'Not found');
  return c.json(isOpenAiPath(c) ? errorBody(err, 404) : { error: err.message }, 404);
});

app.get('/health', (c) => c.json({ ok: true }));

// Browser chat client. Served without the API key — it holds no secrets; the key
// is entered in the page and sent with its API calls.
app.get('/', (c) => {
  c.header('Content-Security-Policy', CHAT_PAGE_CSP);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'no-cache');
  return c.html(CHAT_PAGE);
});

// Optional shared secret. OpenAI clients send it as "Authorization: Bearer <key>".
app.use(async (c, next) => {
  if (API_KEY) {
    const given = Buffer.from(c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '');
    const expected = Buffer.from(API_KEY);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new HttpError(401, 'Missing or invalid API key');
    }
  }
  await next();
});

app.use(
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => {
      throw new HttpError(413, 'Request body is too large');
    },
  }),
);

async function jsonBody(c) {
  try {
    const body = await c.req.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {
    // fall through
  }
  throw new HttpError(400, 'Request body must be a JSON object');
}

/**
 * Streams a claude run to the client as server-sent events. `send(data, event?)`
 * writes one, with an optional event name. `format` decides what they look like:
 *   start(send)         optional, before the first event
 *   event(e, send)      for each { type: 'delta' | 'result' } from claude
 *   end(send)           optional, after the last event
 *   error(err)          body of the final event if claude fails mid-stream
 */
async function streamResponse(c, options, format) {
  // Covers both phases: before the response starts (request signal) and while it
  // is streaming (stream.onAbort). Either way claude is killed.
  const abort = new AbortController();
  c.req.raw.signal.addEventListener('abort', () => abort.abort(), { once: true });
  const events = streamClaude({ ...options, signal: abort.signal })[Symbol.asyncIterator]();
  // Wait for the first event before committing to a 200: if claude fails up front
  // (not logged in, bad model, unknown session), the client gets a proper JSON error.
  let next = await events.next();

  return streamSSE(c, async (stream) => {
    stream.onAbort(() => abort.abort());
    const send = (data, event) => stream.writeSSE({ event, data: typeof data === 'string' ? data : JSON.stringify(data) });
    try {
      await format.start?.(send);
      for (; !next.done; next = await events.next()) await format.event(next.value, send);
      await format.end?.(send);
    } catch (err) {
      if (abort.signal.aborted) return;
      console.error(`[${c.req.method} ${c.req.path}] stream failed:`, err.message);
      await format.error(err, send);
    }
  });
}

// JeanClaude's own endpoint: one message in, claude's result JSON out. The
// conversation lives on the server — pass `sessionId` to continue it.
app.post('/message', async (c) => {
  const { message, sessionId, model, system, stream } = await jsonBody(c);
  if (typeof message !== 'string' || !message.trim()) {
    throw new HttpError(400, 'Missing "message" field (non-empty string)');
  }
  for (const [name, value] of Object.entries({ sessionId, model, system })) {
    if (value !== undefined && typeof value !== 'string') throw new HttpError(400, `"${name}" must be a string`);
  }
  const options = {
    prompt: message,
    sessionId: sessionId || undefined,
    model: resolveModel(model),
    systemPrompt: system?.trim() ? system : undefined,
  };

  if (!stream) {
    const result = await runClaude({ ...options, signal: c.req.raw.signal });
    return c.json(result);
  }

  return streamResponse(c, options, {
    event: (e, send) => {
      if (e.type === 'delta') return send({ type: 'delta', text: e.text });
      if (e.type === 'limits') return send({ type: 'limits', limits: e.limits });
      return send({ type: 'result', result: e.result });
    },
    error: (err, send) => send({ type: 'error', error: err.message }),
  });
});

app.get('/v1/models', (c) =>
  c.json({
    object: 'list',
    data: MODELS.map((id) => ({ id, object: 'model', created: 0, owned_by: 'anthropic' })),
  }),
);

// OpenAI-compatible chat completions, with and without streaming. Stateless: the
// client sends the whole conversation each time, so nothing is saved to disk.
app.post('/v1/chat/completions', async (c) => {
  const body = await jsonBody(c);
  const { systemPrompt, prompt } = toPrompt(body.messages);
  const base = {
    id: newCompletionId(),
    created: Math.floor(Date.now() / 1000),
    model: typeof body.model === 'string' ? body.model : 'default',
  };
  const options = { prompt, systemPrompt, model: resolveModel(body.model), persist: false };

  if (!body.stream) {
    const result = await runClaude({ ...options, signal: c.req.raw.signal });
    return c.json(completion({ ...base, result }));
  }

  let sentText = false;
  return streamResponse(c, options, {
    start: (send) => send(chunk({ ...base, delta: { role: 'assistant', content: '' } })),
    event: async (e, send) => {
      if (e.type === 'delta') {
        sentText = true;
        await send(chunk({ ...base, delta: { content: e.text } }));
      } else if (e.type === 'result') {
        if (!sentText && e.result.result) await send(chunk({ ...base, delta: { content: String(e.result.result) } }));
        await send(chunk({ ...base, delta: {}, finishReason: 'stop' }));
        if (body.stream_options?.include_usage) await send(chunk({ ...base, result: e.result }));
      }
    },
    end: (send) => send('[DONE]'),
    error: (err, send) => send(errorBody(err, err instanceof HttpError ? err.status : 500)),
  });
});

// OpenAI Responses API, text only, with and without streaming. Stateless like
// chat completions: the client sends the whole conversation in `input`.
app.post('/v1/responses', async (c) => {
  const body = await jsonBody(c);
  const { systemPrompt, prompt } = toPrompt(responsesToMessages(body));
  const base = {
    ...newResponseIds(),
    created: Math.floor(Date.now() / 1000),
    model: typeof body.model === 'string' ? body.model : 'default',
    instructions: body.instructions,
  };
  const options = { prompt, systemPrompt, model: resolveModel(body.model), persist: false };

  if (!body.stream) {
    const result = await runClaude({ ...options, signal: c.req.raw.signal });
    return c.json(response({ ...base, result }));
  }

  // Each event repeats its type in the data and carries a sequence number.
  let sequence = 0;
  const emit = (send, type, fields) => send({ type, sequence_number: sequence++, ...fields }, type);
  const at = { item_id: base.messageId, output_index: 0, content_index: 0 };
  let text = '';
  return streamResponse(c, options, {
    start: async (send) => {
      await emit(send, 'response.created', { response: response(base) });
      await emit(send, 'response.in_progress', { response: response(base) });
      const item = responseMessage({ messageId: base.messageId, status: 'in_progress' });
      await emit(send, 'response.output_item.added', { output_index: 0, item });
      await emit(send, 'response.content_part.added', { ...at, part: { type: 'output_text', text: '', annotations: [] } });
    },
    event: async (e, send) => {
      if (e.type === 'delta') {
        text += e.text;
        await emit(send, 'response.output_text.delta', { ...at, delta: e.text, logprobs: [] });
      } else if (e.type === 'result') {
        const final = String(e.result.result ?? '');
        if (!text && final) await emit(send, 'response.output_text.delta', { ...at, delta: final, logprobs: [] });
        // The stream's text is what the client has seen; it can differ from the
        // result in the separators between model turns.
        const done = text || final;
        await emit(send, 'response.output_text.done', { ...at, text: done, logprobs: [] });
        await emit(send, 'response.content_part.done', { ...at, part: { type: 'output_text', text: done, annotations: [] } });
        const finished = response({ ...base, result: { ...e.result, result: done } });
        await emit(send, 'response.output_item.done', { output_index: 0, item: finished.output[0] });
        await emit(send, 'response.completed', { response: finished });
      }
    },
    error: (err, send) => emit(send, 'response.failed', { response: response({ ...base, error: err }) }),
  });
});

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => {
  console.log(`JeanClaude is running at http://${HOST}:${PORT}`);
  console.log(`claude: ${CLAUDE_BIN}`);
  console.log(`mode: ${MODE} (cwd: ${CLAUDE_CWD})`);
  console.log(`api key: ${API_KEY ? 'required' : 'not required'}`);
  if (!API_KEY && !['127.0.0.1', '::1', 'localhost'].includes(HOST)) {
    console.warn('WARNING: listening on a non-loopback address without JEANCLAUDE_API_KEY — anyone who can reach this port can use your Claude account.');
  }
});
