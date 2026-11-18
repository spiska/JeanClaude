import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { rejected, snapshot } from './activity.js';
import { CLAUDE_BIN, CLAUDE_CWD, HttpError, MODE, runClaude, streamClaude } from './claude.js';
import {
  MODELS,
  chatToolCalls,
  chunk,
  clientTools,
  completion,
  errorBody,
  functionCallItem,
  newCompletionId,
  newResponseIds,
  resolveModel,
  response,
  responseMessage,
  responsesToMessages,
  toPrompt,
  webSearchItem,
} from './openai.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';
const API_KEY = process.env.JEANCLAUDE_API_KEY;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const CHAT_PAGE = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
const DASHBOARD_PAGE = readFileSync(new URL('./public/dashboard.html', import.meta.url), 'utf8');
// The page is self-contained (inline CSS and JS) and only talks to this server.
const CHAT_PAGE_CSP =
  "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const app = new Hono();

const isOpenAiPath = (c) => c.req.path.startsWith('/v1/');
// HTTP errors go to the activity log, except the browser's favicon request and the
// dashboard's own polling (a wrong key there would log a 401 every few seconds).
const UNLOGGED_PATHS = new Set(['/favicon.ico', '/activity']);
const logRejected = (c, status, err) => {
  if (!UNLOGGED_PATHS.has(c.req.path)) rejected({ method: c.req.method, path: c.req.path, status, message: err.message, err });
};

app.onError((err, c) => {
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) console.error(`[${c.req.method} ${c.req.path}]`, err.message);
  logRejected(c, status, err);
  if (isOpenAiPath(c)) return c.json(errorBody(err, status), status);
  return c.json({ error: err.message, ...(err.extra ?? {}) }, status);
});

app.notFound((c) => {
  const err = new HttpError(404, 'Not found');
  logRejected(c, 404, err);
  return c.json(isOpenAiPath(c) ? errorBody(err, 404) : { error: err.message }, 404);
});

app.get('/health', (c) => c.json({ ok: true }));

// The browser pages: the chat client and the activity dashboard. Served without
// the API key — they hold no secrets; the key is entered in the chat's settings
// and sent with their API calls.
const page = (html) => (c) => {
  c.header('Content-Security-Policy', CHAT_PAGE_CSP);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'no-cache');
  return c.html(html);
};
app.get('/', page(CHAT_PAGE));
app.get('/dashboard', page(DASHBOARD_PAGE));

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

// What the server is doing and has done since it started, for /dashboard.
app.get('/activity', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ mode: MODE, ...snapshot() });
});

/** The client's tools for claude, from a Chat Completions or Responses API body. */
function toolOptions(body) {
  return { ...clientTools(body), singleToolCall: body.parallel_tool_calls === false };
}

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
    source: '/message',
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
      if (e.type === 'result') return send({ type: 'result', result: e.result });
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
  const options = { source: '/v1/chat/completions', prompt, systemPrompt, model: resolveModel(body.model), persist: false, ...toolOptions(body) };

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
        const calls = chatToolCalls(e.result);
        for (const call of calls) await send(chunk({ ...base, delta: { tool_calls: [call] } }));
        await send(chunk({ ...base, delta: {}, finishReason: calls.length ? 'tool_calls' : 'stop' }));
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
    tools: Array.isArray(body.tools) ? body.tools : [],
    toolChoice: body.tool_choice,
    parallelToolCalls: body.parallel_tool_calls,
  };
  const options = { source: '/v1/responses', prompt, systemPrompt, model: resolveModel(body.model), persist: false, ...toolOptions(body) };

  if (!body.stream) {
    const result = await runClaude({ ...options, signal: c.req.raw.signal });
    return c.json(response({ ...base, result }));
  }

  // Each event repeats its type in the data and carries a sequence number. Output
  // items get their index in the order they appear: web searches as claude runs
  // them, the message with its first text (so a reply that only calls tools has
  // no empty message in front of them), then the tool calls.
  let sequence = 0;
  const emit = (send, type, fields) => send({ type, sequence_number: sequence++, ...fields }, type);
  const output = []; // the finished items, in index order
  let messageIndex; // set once the message item is opened
  let text = '';
  const at = () => ({ item_id: base.messageId, output_index: messageIndex, content_index: 0 });
  const open = async (send) => {
    messageIndex = output.length;
    output.push(null); // filled in when the message is done
    const item = responseMessage({ messageId: base.messageId, status: 'in_progress' });
    await emit(send, 'response.output_item.added', { output_index: messageIndex, item });
    await emit(send, 'response.content_part.added', { ...at(), part: { type: 'output_text', text: '', annotations: [] } });
  };
  return streamResponse(c, options, {
    start: async (send) => {
      await emit(send, 'response.created', { response: response(base) });
      await emit(send, 'response.in_progress', { response: response(base) });
    },
    event: async (e, send) => {
      if (e.type === 'web_search') {
        // claude runs the search itself; by the time the query is known it is under way.
        const index = output.length;
        const item = webSearchItem(e.search);
        output.push(item);
        const ref = { output_index: index, item_id: item.id };
        await emit(send, 'response.output_item.added', { output_index: index, item: webSearchItem(e.search, 'in_progress') });
        await emit(send, 'response.web_search_call.in_progress', ref);
        await emit(send, 'response.web_search_call.searching', ref);
        await emit(send, 'response.web_search_call.completed', ref);
        await emit(send, 'response.output_item.done', { output_index: index, item });
      } else if (e.type === 'delta') {
        if (messageIndex === undefined) await open(send);
        text += e.text;
        await emit(send, 'response.output_text.delta', { ...at(), delta: e.text, logprobs: [] });
      } else if (e.type === 'result') {
        const final = String(e.result.result ?? '');
        const calls = e.result.tool_calls ?? [];
        if (!text && final) {
          await open(send);
          await emit(send, 'response.output_text.delta', { ...at(), delta: final, logprobs: [] });
        }
        if (messageIndex === undefined && !calls.length) await open(send); // an empty answer still gets its message
        if (messageIndex !== undefined) {
          // The stream's text is what the client has seen; it can differ from the
          // result in the separators between model turns.
          const done = text || final;
          const item = responseMessage({ messageId: base.messageId, text: done });
          output[messageIndex] = item;
          await emit(send, 'response.output_text.done', { ...at(), text: done, logprobs: [] });
          await emit(send, 'response.content_part.done', { ...at(), part: { type: 'output_text', text: done, annotations: [] } });
          await emit(send, 'response.output_item.done', { output_index: messageIndex, item });
        }
        for (const call of calls) {
          const index = output.length;
          const item = functionCallItem(call);
          output.push(item);
          await emit(send, 'response.output_item.added', { output_index: index, item: functionCallItem(call, 'in_progress') });
          await emit(send, 'response.function_call_arguments.delta', { item_id: item.id, output_index: index, delta: call.arguments });
          await emit(send, 'response.function_call_arguments.done', { item_id: item.id, output_index: index, name: call.name, arguments: call.arguments });
          await emit(send, 'response.output_item.done', { output_index: index, item });
        }
        const finished = response({ ...base, result: e.result });
        await emit(send, 'response.completed', { response: { ...finished, output } });
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
