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
      assert.equal(flag('--output-format'), 'json');
      assert.equal(flag('--resume'), 'abc');
      assert.equal(flag('--model'), 'haiku');
      assert.equal(flag('--system-prompt'), 'Be brief.');
      assert.equal(flag('--tools'), 'Read,Glob,Grep,WebSearch,WebFetch');
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

  it('leaves the chat page and /health open', async () => {
    assert.equal((await fetch(`${server.url}/`)).status, 200);
    assert.equal((await fetch(`${server.url}/health`)).status, 200);
  });
});
