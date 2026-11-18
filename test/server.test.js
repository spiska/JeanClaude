// Runs the real server against test/fake-claude.js instead of the claude CLI.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('./fake-claude.js', import.meta.url));

async function freePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  return port;
}

/** Starts server.js with the given extra environment; resolves once it is listening. */
async function startServer(env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, CLAUDE_BIN: FAKE_CLAUDE, PORT: String(port), HOST: '127.0.0.1', JEANCLAUDE_API_KEY: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => {
      output += d;
      if (output.includes('is running at')) resolve();
    });
    child.stderr.on('data', (d) => (output += d));
    child.on('exit', (code) => reject(new Error(`server exited with ${code}:\n${output}`)));
  });
  return { url: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

const post = (url, body, headers = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

/** Reads a server-sent events response into `{ event, data }` pairs (data JSON parsed). */
async function namedEvents(res) {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const field = (name) => block.split('\n').find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1).trim();
      return { event: field('event'), data: JSON.parse(field('data')) };
    });
}

/** Reads a server-sent events response into a list of `data:` payloads (JSON parsed where possible). */
async function events(res) {
  const text = await res.text();
  return text
    .split('\n\n')
    .flatMap((block) => block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()))
    .map((data) => (data === '[DONE]' ? data : JSON.parse(data)));
}

describe('server', () => {
  let server;
  before(async () => (server = await startServer()));
  after(() => server.stop());

  it('answers /health', async () => {
    const res = await fetch(`${server.url}/health`);
    assert.deepEqual(await res.json(), { ok: true });
  });

  it('serves the chat page with a content security policy', async () => {
    const res = await fetch(`${server.url}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(await res.text(), /<title>JeanClaude<\/title>/);
  });

  it('returns 404 in the shape of each API', async () => {
    assert.deepEqual(await (await fetch(`${server.url}/nope`)).json(), { error: 'Not found' });
    const res = await fetch(`${server.url}/v1/nope`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.message, 'Not found');
  });

  describe('POST /message', () => {
    it('returns claude\'s result', async () => {
      const res = await post(`${server.url}/message`, { message: 'hello' });
      assert.equal(res.status, 200);
      const result = await res.json();
      assert.equal(result.result, 'echo: hello');
      assert.equal(result.total_cost_usd, 0.0123);
    });

    it('runs claude in clean mode with the request\'s options', async () => {
      const res = await post(`${server.url}/message`, { message: 'hi', sessionId: 'abc', model: 'haiku', system: 'Be brief.' });
      const args = (await res.json()).fake_args;
      const flag = (name) => args[args.indexOf(name) + 1];
      assert.equal(flag('--output-format'), 'stream-json'); // also for non-streamed replies: it carries the usage limits
      assert.equal(flag('--resume'), 'abc');
      assert.equal(flag('--model'), 'haiku');
      assert.equal(flag('--system-prompt'), 'Be brief.');
      assert.equal(flag('--tools'), 'Read,Glob,Grep,WebSearch,WebFetch,Skill');
      assert.equal(flag('--setting-sources'), 'project');
      assert.ok(args.includes('--strict-mcp-config'));
      assert.ok(!args.includes('hi'), 'the prompt goes in on stdin, not as an argument');
    });

    it('drops model names claude does not know', async () => {
      const args = (await (await post(`${server.url}/message`, { message: 'hi', model: 'gpt-4o' })).json()).fake_args;
      assert.ok(!args.includes('--model'));
    });

    it('streams deltas, limits and the result', async () => {
      const res = await post(`${server.url}/message`, { message: 'hello', stream: true });
      assert.match(res.headers.get('content-type'), /text\/event-stream/);
      const list = await events(res);
      const text = list.filter((e) => e.type === 'delta').map((e) => e.text).join('');
      assert.equal(text, 'echo: hello');
      assert.equal(list.find((e) => e.type === 'limits').limits.unifiedWindows.five_hour.utilization, 0.25);
      assert.equal(list.at(-1).type, 'result');
      assert.equal(list.at(-1).result.result, 'echo: hello');
    });

    it('separates text from separate model turns', async () => {
      const list = await events(await post(`${server.url}/message`, { message: 'TOOL', stream: true }));
      const text = list.filter((e) => e.type === 'delta').map((e) => e.text).join('');
      assert.equal(text, 'Let me look.\n\necho: TOOL');
    });

    it('reports a failed run as 502, streaming or not', async () => {
      const res = await post(`${server.url}/message`, { message: 'FAIL' });
      assert.equal(res.status, 502);
      assert.match((await res.json()).error, /something went wrong/);

      const list = await events(await post(`${server.url}/message`, { message: 'FAIL', stream: true }));
      assert.deepEqual(list.at(-1), { type: 'error', error: 'something went wrong' });
    });

    it('validates the body', async () => {
      assert.equal((await post(`${server.url}/message`, {})).status, 400);
      assert.equal((await post(`${server.url}/message`, { message: '   ' })).status, 400);
      assert.equal((await post(`${server.url}/message`, { message: 'hi', sessionId: 5 })).status, 400);
      const res = await fetch(`${server.url}/message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[1' });
      assert.equal(res.status, 400);
    });

    it('rejects bodies over 4 MB', async () => {
      const res = await post(`${server.url}/message`, { message: 'x'.repeat(5 * 1024 * 1024) });
      assert.equal(res.status, 413);
    });
  });

  describe('OpenAI-compatible API', () => {
    it('lists models', async () => {
      const body = await (await fetch(`${server.url}/v1/models`)).json();
      assert.equal(body.object, 'list');
      assert.deepEqual(body.data.map((m) => m.id), ['default', 'fable', 'opus', 'sonnet', 'haiku']);
    });

    it('answers a chat completion', async () => {
      const res = await post(`${server.url}/v1/chat/completions`, {
        model: 'sonnet',
        messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hello' }],
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.model, 'sonnet');
      assert.equal(body.choices[0].message.content, 'echo: hello');
      assert.equal(body.usage.total_tokens, 18);
    });

    it('streams chunks, usage and [DONE]', async () => {
      const list = await events(
        await post(`${server.url}/v1/chat/completions`, {
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: 'user', content: 'hello' }],
        }),
      );
      assert.equal(list.at(-1), '[DONE]');
      const chunks = list.slice(0, -1);
      assert.deepEqual(chunks[0].choices[0].delta, { role: 'assistant', content: '' });
      const text = chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('');
      assert.equal(text, 'echo: hello');
      assert.equal(chunks.filter((c) => c.choices[0]?.finish_reason === 'stop').length, 1);
      assert.equal(chunks.at(-1).usage.total_tokens, 18);
    });

    it('answers a Responses API request', async () => {
      const res = await post(`${server.url}/v1/responses`, { model: 'haiku', instructions: 'Be brief.', input: 'hello' });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.object, 'response');
      assert.equal(body.status, 'completed');
      assert.equal(body.output[0].content[0].text, 'echo: hello');
      assert.equal(body.usage.total_tokens, 18);
      assert.equal(body.instructions, 'Be brief.');
    });

    it('streams Responses API events', async () => {
      const list = await namedEvents(
        await post(`${server.url}/v1/responses`, { stream: true, input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }] }),
      );
      assert.deepEqual(
        list.map((e) => e.event),
        [
          'response.created',
          'response.in_progress',
          'response.output_item.added',
          'response.content_part.added',
          'response.output_text.delta',
          'response.output_text.delta',
          'response.output_text.done',
          'response.content_part.done',
          'response.output_item.done',
          'response.completed',
        ],
      );
      assert.ok(list.every((e, i) => e.data.type === e.event && e.data.sequence_number === i));
      const text = list.filter((e) => e.event === 'response.output_text.delta').map((e) => e.data.delta).join('');
      assert.equal(text, 'echo: hello');
      const done = list.at(-1).data.response;
      assert.equal(done.status, 'completed');
      assert.equal(done.output[0].content[0].text, 'echo: hello');
      assert.equal(done.usage.total_tokens, 18);
    });

    it('reports a failed Responses API stream as response.failed', async () => {
      const list = await namedEvents(await post(`${server.url}/v1/responses`, { stream: true, input: 'FAIL' }));
      assert.equal(list.at(-1).event, 'response.failed');
      assert.equal(list.at(-1).data.response.error.message, 'something went wrong');
      const res = await post(`${server.url}/v1/responses`, { input: 'FAIL' });
      assert.equal(res.status, 502);
      assert.equal((await res.json()).error.type, 'server_error');
    });

    it('rejects previous_response_id', async () => {
      const res = await post(`${server.url}/v1/responses`, { input: 'hi', previous_response_id: 'resp_1' });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error.message, /previous_response_id/);
    });

    it('rejects unsupported content with an OpenAI error', async () => {
      const res = await post(`${server.url}/v1/chat/completions`, {
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }],
      });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error.type, 'invalid_request_error');
    });
  });
});

describe('server with JEANCLAUDE_API_KEY', () => {
  let server;
  before(async () => (server = await startServer({ JEANCLAUDE_API_KEY: 'secret' })));
  after(() => server.stop());

  it('requires the key on the API', async () => {
    assert.equal((await post(`${server.url}/message`, { message: 'hi' })).status, 401);
    assert.equal((await post(`${server.url}/message`, { message: 'hi' }, { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await post(`${server.url}/message`, { message: 'hi' }, { authorization: 'Bearer secret' })).status, 200);
    assert.equal((await fetch(`${server.url}/v1/models`)).status, 401);
  });

  it('leaves the chat page, the dashboard and /health open', async () => {
    assert.equal((await fetch(`${server.url}/`)).status, 200);
    assert.equal((await fetch(`${server.url}/dashboard`)).status, 200);
    assert.equal((await fetch(`${server.url}/health`)).status, 200);
  });

  it('requires the key for the activity data', async () => {
    assert.equal((await fetch(`${server.url}/activity`)).status, 401);
    const res = await fetch(`${server.url}/activity`, { headers: { authorization: 'Bearer secret' } });
    assert.equal(res.status, 200);
    // The 401s from the first test are in the log; the one from /activity is not.
    const recent = (await res.json()).recent.filter((r) => r.httpStatus === 401);
    assert.ok(recent.length >= 2);
    assert.ok(recent.every((r) => r.source !== '/activity'));
  });
});

describe('activity', () => {
  let server;
  before(async () => (server = await startServer()));
  after(() => server.stop());

  const activity = async () => (await fetch(`${server.url}/activity`)).json();

  it('serves the dashboard page', async () => {
    const res = await fetch(`${server.url}/dashboard`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(await res.text(), /<title>JeanClaude Activity<\/title>/);
  });

  it('starts empty', async () => {
    const a = await activity();
    assert.equal(a.mode, 'clean');
    assert.equal(a.totals.requests, 0);
    assert.deepEqual(a.running, []);
    assert.deepEqual(a.recent, []);
    assert.equal(a.hourly.length, 24);
    assert.equal(a.limits, null);
  });

  it('records finished, failed and streamed runs without their text', async () => {
    await post(`${server.url}/message`, { message: 'secret prompt' });
    await post(`${server.url}/v1/chat/completions`, { messages: [{ role: 'user', content: 'FAIL' }] });
    await (await post(`${server.url}/v1/responses`, { input: 'hi', stream: true })).text();

    const a = await activity();
    assert.equal(a.totals.requests, 3);
    assert.equal(a.totals.errors, 1);
    assert.equal(a.totals.outputTokens, 18);
    assert.equal(a.totals.costUsd, 0.0369);
    assert.deepEqual(a.recent.map((r) => [r.source, r.stream, r.status]), [
      ['/v1/responses', true, 'ok'],
      ['/v1/chat/completions', false, 'error'],
      ['/message', false, 'ok'],
    ]);
    assert.match(a.recent[1].error, /something went wrong/);
    assert.deepEqual(a.recent[2].usage, { input: 3, cacheRead: 5, cacheWrite: 4, output: 6 });
    assert.equal(a.recent[2].promptChars, 'secret prompt'.length);
    assert.doesNotMatch(JSON.stringify(a), /secret prompt|echo:/);
    assert.equal(a.limits.info.unifiedWindows.five_hour.utilization, 0.25);
    assert.equal(a.hourly.at(-1).requests, 3);
    assert.equal(a.hourly.at(-1).errors, 1);
  });

  it('records HTTP errors once, but not favicon or its own requests', async () => {
    const before = (await activity()).totals;
    await post(`${server.url}/message`, { message: '' });
    await fetch(`${server.url}/nope`);
    await fetch(`${server.url}/favicon.ico`);
    await post(`${server.url}/message`, { message: 'FAIL' }); // a failed run: logged as a run, not again as HTTP

    const a = await activity();
    assert.equal(a.totals.requests - before.requests, 3);
    assert.equal(a.totals.errors - before.errors, 3);
    assert.equal(a.totals.rejected - before.rejected, 2);
    assert.deepEqual(a.recent.slice(0, 3).map((r) => [r.source, r.status, r.httpStatus]), [
      ['/message', 'error', 502],
      ['/nope', 'rejected', 404],
      ['/message', 'rejected', 400],
    ]);
    assert.equal(a.recent[2].method, 'POST');
    assert.match(a.recent[2].error, /Missing "message"/);
  });
});

describe('tool calling', () => {
  let server;
  before(async () => (server = await startServer()));
  after(() => server.stop());

  const weather = { name: 'get_weather', description: 'Weather in a city', parameters: { type: 'object', properties: { city: { type: 'string' } } } };
  const chatTools = [{ type: 'function', function: weather }, { type: 'function', function: { name: 'get_time' } }];
  const responsesTools = [{ type: 'function', ...weather }];
  const argsOf = (call) => JSON.parse(call.function?.arguments ?? call.arguments);

  it('returns the calls claude makes to the client\'s tools as a chat completion', async () => {
    const started = Date.now();
    const res = await post(`${server.url}/v1/chat/completions`, { tools: chatTools, messages: [{ role: 'user', content: 'CALL' }] });
    assert.equal(res.status, 200);
    const { choices, usage } = await res.json();
    assert.ok(Date.now() - started < 5000, 'claude was stopped instead of waiting for the tool result');
    assert.equal(choices[0].finish_reason, 'tool_calls');
    const { message } = choices[0];
    assert.equal(message.content, 'Let me check.');
    // Only the client's tools, not claude's own (WebSearch).
    assert.deepEqual(message.tool_calls.map((c) => [c.id, c.type, c.function.name]), [
      ['toolu_1', 'function', 'get_weather'],
      ['toolu_2', 'function', 'get_weather'],
    ]);
    const { args, tools } = argsOf(message.tool_calls[0]);
    assert.deepEqual(tools, ['get_weather', 'get_time']);
    const flag = (name) => args[args.indexOf(name) + 1];
    assert.match(flag('--allowedTools'), /mcp__client__get_weather,mcp__client__get_time/);
    assert.match(flag('--system-prompt'), /^You are a helpful assistant\.\n\nTools whose names start with mcp__client__/);
    assert.deepEqual(usage, { prompt_tokens: 7, completion_tokens: 8, total_tokens: 15 });
  });

  it('keeps one call when parallel_tool_calls is false', async () => {
    const body = { tools: chatTools, parallel_tool_calls: false, messages: [{ role: 'user', content: 'CALL' }] };
    const { choices } = await (await post(`${server.url}/v1/chat/completions`, body)).json();
    assert.equal(choices[0].message.tool_calls.length, 1);
  });

  it('streams tool calls as chunks', async () => {
    const res = await post(`${server.url}/v1/chat/completions`, { stream: true, tools: chatTools, messages: [{ role: 'user', content: 'CALL' }] });
    const data = await events(res);
    assert.equal(data.at(-1), '[DONE]');
    const deltas = data.slice(0, -1).map((d) => d.choices[0]);
    const calls = deltas.flatMap((d) => d.delta.tool_calls ?? []);
    assert.deepEqual(calls.map((c) => [c.index, c.id, c.function.name]), [
      [0, 'toolu_1', 'get_weather'],
      [1, 'toolu_2', 'get_weather'],
    ]);
    assert.equal(deltas.at(-1).finish_reason, 'tool_calls');
  });

  it('runs without tools when tool_choice is "none"', async () => {
    const body = { tools: chatTools, tool_choice: 'none', messages: [{ role: 'user', content: 'CALL' }] };
    const { choices } = await (await post(`${server.url}/v1/chat/completions`, body)).json();
    assert.equal(choices[0].finish_reason, 'stop');
    assert.equal(choices[0].message.content, 'echo: CALL');
  });

  it('sends earlier calls and results back to claude as text', async () => {
    const res = await post(`${server.url}/v1/chat/completions`, {
      tools: chatTools,
      messages: [
        { role: 'user', content: 'Weather?' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'sunny' },
      ],
    });
    const { content } = (await res.json()).choices[0].message;
    assert.match(content, /\[Called tool mcp__client__get_weather \(call id c1\) with arguments \{\}\]/);
    assert.match(content, /### Tool result \(call id c1\)\nsunny/);
  });

  it('returns function_call items from the Responses API', async () => {
    const res = await post(`${server.url}/v1/responses`, { tools: responsesTools, input: 'CALL' });
    const body = await res.json();
    assert.equal(body.status, 'completed');
    assert.deepEqual(body.tools, responsesTools);
    assert.deepEqual(body.output.map((o) => [o.type, o.call_id ?? null, o.name ?? null]), [
      ['message', null, null],
      ['function_call', 'toolu_1', 'get_weather'],
      ['function_call', 'toolu_2', 'get_weather'],
    ]);
  });

  it('streams Responses API function calls', async () => {
    const res = await post(`${server.url}/v1/responses`, { stream: true, tools: responsesTools, input: 'CALL' });
    const list = await namedEvents(res);
    assert.deepEqual(list.map((e) => e.data.sequence_number), list.map((_, i) => i));
    const call = (index) => [
      ['response.output_item.added', index],
      ['response.function_call_arguments.delta', index],
      ['response.function_call_arguments.done', index],
      ['response.output_item.done', index],
    ];
    assert.deepEqual(list.map((e) => [e.event, e.data.output_index ?? null]), [
      ['response.created', null],
      ['response.in_progress', null],
      ['response.output_item.added', 0],
      ['response.content_part.added', 0],
      ['response.output_text.delta', 0],
      ['response.output_text.done', 0],
      ['response.content_part.done', 0],
      ['response.output_item.done', 0],
      ...call(1),
      ...call(2),
      ['response.completed', null],
    ]);
    const added = list[8].data.item;
    assert.equal(added.arguments, '');
    assert.equal(added.status, 'in_progress');
    const done = list[11].data.item;
    assert.equal(done.call_id, 'toolu_1');
    assert.deepEqual(argsOf(done).tools, ['get_weather']);
    assert.deepEqual(list.at(-1).data.response.output.map((o) => o.type), ['message', 'function_call', 'function_call']);
  });

  it('records tool calls in the activity log', async () => {
    const { recent, limits } = await (await fetch(`${server.url}/activity`)).json();
    const entry = recent.find((r) => r.source === '/v1/responses');
    assert.equal(entry.status, 'ok');
    assert.equal(entry.toolCalls, 2);
    assert.deepEqual(entry.models, ['claude-fake-1']);
    assert.equal(limits.info.unifiedWindows.five_hour.utilization, 0.5);
  });
});
