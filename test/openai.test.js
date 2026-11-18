import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpError } from '../claude.js';
import { chunk, clientTools, completion, errorBody, resolveModel, response, responsesToMessages, toPrompt } from '../openai.js';

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

describe('responsesToMessages', () => {
  it('turns a string input and instructions into messages', () => {
    assert.deepEqual(responsesToMessages({ input: 'hi', instructions: 'Be brief.' }), [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('reads message items with input_text and output_text parts', () => {
    const messages = responsesToMessages({
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'Hi' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello!' }] },
        { type: 'reasoning', summary: [] },
        { role: 'user', content: 'Bye' },
      ],
    });
    const { prompt } = toPrompt(messages);
    assert.match(prompt, /### User\nHi\n\n### Assistant\nHello!\n\n### User\nBye$/);
  });

  it('turns function calls and their outputs into tool messages', () => {
    const messages = responsesToMessages({
      input: [
        { role: 'user', content: 'Weather?' },
        { type: 'function_call', call_id: 'c1', name: 'get_weather', arguments: '{"city":"Prague"}' },
        { type: 'function_call', call_id: 'c2', name: 'get_weather', arguments: '{"city":"Rome"}' },
        { type: 'function_call_output', call_id: 'c1', output: 'sunny' },
        { type: 'function_call_output', call_id: 'c2', output: 'rainy' },
      ],
    });
    const call = (id, city) => ({ id, type: 'function', function: { name: 'get_weather', arguments: `{"city":"${city}"}` } });
    assert.deepEqual(messages.slice(1), [
      { role: 'assistant', content: null, tool_calls: [call('c1', 'Prague'), call('c2', 'Rome')] },
      { role: 'tool', tool_call_id: 'c1', content: 'sunny' },
      { role: 'tool', tool_call_id: 'c2', content: 'rainy' },
    ]);
  });

  it('rejects what it cannot handle with a 400', () => {
    const rejects = (body, pattern) =>
      assert.throws(() => responsesToMessages(body), (err) => err instanceof HttpError && err.status === 400 && pattern.test(err.message));
    rejects({}, /"input"/);
    rejects({ input: [] }, /"input"/);
    rejects({ input: 'hi', previous_response_id: 'resp_1' }, /previous_response_id/);
    rejects({ input: 'hi', instructions: 5 }, /instructions/);
    rejects({ input: [{ type: 'computer_call' }] }, /unsupported item type/);
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

  it('builds a Responses API response', () => {
    const body = response({ id: 'resp_1', messageId: 'msg_1', created: 1, model: 'sonnet', result });
    assert.equal(body.object, 'response');
    assert.equal(body.status, 'completed');
    assert.deepEqual(body.output[0].content, [{ type: 'output_text', text: 'Hi!', annotations: [] }]);
    assert.equal(body.usage.input_tokens, 6);
    assert.equal(body.usage.input_tokens_details.cached_tokens, 3);
    assert.equal(body.usage.total_tokens, 10);

    const failed = response({ id: 'resp_1', messageId: 'msg_1', created: 1, model: 'sonnet', error: new Error('boom') });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error.message, 'boom');
  });

  it('builds OpenAI-style errors', () => {
    assert.equal(errorBody(new Error('bad'), 400).error.type, 'invalid_request_error');
    assert.equal(errorBody(new Error('boom'), 502).error.type, 'server_error');
  });
});

describe('tools', () => {
  const weather = { name: 'get_weather', description: 'Weather in a city', parameters: { type: 'object', properties: { city: { type: 'string' } } } };

  it('reads function tools in both formats', () => {
    const chat = clientTools({ tools: [{ type: 'function', function: weather }] });
    const responses = clientTools({ tools: [{ type: 'function', ...weather }] });
    assert.deepEqual(chat.tools, [{ name: 'get_weather', description: 'Weather in a city', inputSchema: weather.parameters }]);
    assert.deepEqual(responses.tools, chat.tools);
    assert.match(chat.toolInstruction, /mcp__client__/);
  });

  it('follows tool_choice', () => {
    const tools = [{ type: 'function', function: weather }];
    assert.deepEqual(clientTools({ tools, tool_choice: 'none' }), {});
    assert.deepEqual(clientTools({ tools: [] }), {});
    assert.match(clientTools({ tools, tool_choice: 'required' }).toolInstruction, /at least one/);
    assert.match(clientTools({ tools, tool_choice: { type: 'function', function: { name: 'get_weather' } } }).toolInstruction, /call the tool mcp__client__get_weather/);
    assert.match(clientTools({ tools, tool_choice: { type: 'function', name: 'get_weather' } }).toolInstruction, /mcp__client__get_weather/);
  });

  it('rejects tools it cannot offer', () => {
    const rejects = (body, pattern) =>
      assert.throws(() => clientTools(body), (err) => err instanceof HttpError && err.status === 400 && pattern.test(err.message));
    rejects({ tools: {} }, /must be an array/);
    rejects({ tools: [{ type: 'web_search_preview' }] }, /only function tools/);
    rejects({ tools: [{ type: 'function', function: { name: 'bad name' } }] }, /name/);
    rejects({ tools: [{ type: 'function', function: weather }], tool_choice: { type: 'function', function: { name: 'other' } } }, /not in "tools"/);
  });

  it('writes earlier tool calls and results into the transcript', () => {
    const { prompt } = toPrompt([
      { role: 'user', content: 'Weather in Prague?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Prague"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'sunny' },
    ]);
    assert.match(prompt, /### Assistant\n\[Called tool mcp__client__get_weather \(call id c1\) with arguments \{"city":"Prague"\}\]/);
    assert.match(prompt, /### Tool result \(call id c1\)\nsunny/);
  });

  const result = {
    result: '',
    usage: { input_tokens: 1, output_tokens: 2 },
    tool_calls: [{ id: 'toolu_1', name: 'get_weather', arguments: '{"city":"Prague"}' }],
  };

  it('returns tool calls as a chat completion', () => {
    const { message, finish_reason } = completion({ id: 'x', created: 1, model: 'm', result }).choices[0];
    assert.equal(finish_reason, 'tool_calls');
    assert.deepEqual(message, {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Prague"}' } }],
    });
  });

  it('returns tool calls as Responses API function_call items', () => {
    const body = response({ id: 'resp_1', messageId: 'msg_1', created: 1, model: 'm', result });
    assert.deepEqual(body.output, [
      { type: 'function_call', id: 'fc_toolu_1', call_id: 'toolu_1', name: 'get_weather', arguments: '{"city":"Prague"}', status: 'completed' },
    ]);
    const withText = response({ id: 'resp_1', messageId: 'msg_1', created: 1, model: 'm', result: { ...result, result: 'Let me check.' } });
    assert.deepEqual(withText.output.map((o) => o.type), ['message', 'function_call']);
  });
});
