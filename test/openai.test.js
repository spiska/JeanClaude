import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpError } from '../claude.js';
import { chunk, completion, errorBody, resolveModel, toPrompt } from '../openai.js';

describe('resolveModel', () => {
  it('passes Claude aliases and ids through', () => {
    assert.equal(resolveModel('sonnet'), 'sonnet');
    assert.equal(resolveModel('claude-haiku-5-5'), 'claude-haiku-5-5');
  });

  it('falls back to the default model for anything else', () => {
    assert.equal(resolveModel('gpt-4o'), undefined);
    assert.equal(resolveModel('default'), undefined);
    assert.equal(resolveModel(undefined), undefined);
    assert.equal(resolveModel(42), undefined);
  });
});

describe('toPrompt', () => {
  it('passes a single user message through as is', () => {
    assert.deepEqual(toPrompt([{ role: 'user', content: 'hello' }]), { systemPrompt: undefined, prompt: 'hello' });
  });

  it('turns system and developer messages into the system prompt', () => {
    const { systemPrompt, prompt } = toPrompt([
      { role: 'system', content: 'Be brief.' },
      { role: 'developer', content: 'Use English.' },
      { role: 'user', content: 'hi' },
    ]);
    assert.equal(systemPrompt, 'Be brief.\n\nUse English.');
    assert.equal(prompt, 'hi');
  });

  it('writes a longer conversation out as a transcript', () => {
    const { prompt } = toPrompt([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'How are you?' },
    ]);
    assert.match(prompt, /### User\nHi\n\n### Assistant\nHello!\n\n### User\nHow are you\?$/);
  });

  it('joins text parts', () => {
    const { prompt } = toPrompt([{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }]);
    assert.equal(prompt, 'ab');
  });

  it('rejects what it cannot handle with a 400', () => {
    const rejects = (messages, pattern) =>
      assert.throws(() => toPrompt(messages), (err) => err instanceof HttpError && err.status === 400 && pattern.test(err.message));
    rejects(undefined, /non-empty array/);
    rejects([], /non-empty array/);
    rejects([{ role: 'system', content: 'only system' }], /non-system message/);
    rejects([{ role: 'robot', content: 'x' }], /unknown role/);
    rejects([{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }], /only text content/);
  });
});

describe('response bodies', () => {
  const result = { result: 'Hi!', usage: { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 } };

  it('builds a chat completion with usage', () => {
    const body = completion({ id: 'chatcmpl-1', created: 1, model: 'sonnet', result });
    assert.equal(body.object, 'chat.completion');
    assert.deepEqual(body.choices[0].message, { role: 'assistant', content: 'Hi!' });
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.deepEqual(body.usage, { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 });
  });

  it('builds stream chunks', () => {
    const delta = chunk({ id: 'c', created: 1, model: 'm', delta: { content: 'x' } });
    assert.equal(delta.object, 'chat.completion.chunk');
    assert.deepEqual(delta.choices, [{ index: 0, delta: { content: 'x' }, finish_reason: null }]);

    const usage = chunk({ id: 'c', created: 1, model: 'm', result });
    assert.deepEqual(usage.choices, []);
    assert.equal(usage.usage.total_tokens, 10);
  });

  it('builds OpenAI-style errors', () => {
    assert.equal(errorBody(new Error('bad'), 400).error.type, 'invalid_request_error');
    assert.equal(errorBody(new Error('boom'), 502).error.type, 'server_error');
  });
});
