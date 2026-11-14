// Translation between the OpenAI formats (Chat Completions, Responses) and `claude -p`.
import { randomUUID } from 'node:crypto';
import { HttpError } from './claude.js';

// Model names claude understands. Anything else (e.g. "gpt-4o" hard-coded in a
// client) falls back to claude's default model instead of failing.
const ALIASES = ['fable', 'opus', 'sonnet', 'haiku'];
export const MODELS = ['default', ...ALIASES];

export function resolveModel(requested) {
  if (typeof requested !== 'string') return undefined;
  return ALIASES.includes(requested) || requested.startsWith('claude-') ? requested : undefined;
}

// "text" is Chat Completions; "input_text" and "output_text" are the Responses API.
const TEXT_PARTS = ['text', 'input_text', 'output_text'];

function textOf(content, where) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (TEXT_PARTS.includes(part?.type) && typeof part.text === 'string') return part.text;
        throw new HttpError(400, `${where}: only text content is supported (got "${part?.type}")`);
      })
      .join('');
  }
  throw new HttpError(400, `${where}: "content" must be a string or an array of text parts`);
}

/**
 * claude -p takes one prompt, not a message list. System messages become the system
 * prompt; a single user message is passed through as-is; a longer conversation is
 * written out as a transcript for the model to continue.
 */
export function toPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new HttpError(400, '"messages" must be a non-empty array');
  }

  const system = [];
  const turns = [];
  messages.forEach((m, i) => {
    const where = `messages[${i}]`;
    const text = textOf(m?.content, where);
    if (m.role === 'system' || m.role === 'developer') system.push(text);
    else if (m.role === 'user') turns.push({ label: 'User', text });
    else if (m.role === 'assistant') turns.push({ label: 'Assistant', text });
    else if (m.role === 'tool') turns.push({ label: 'Tool result', text });
    else throw new HttpError(400, `${where}: unknown role "${m?.role}"`);
  });

  if (turns.length === 0) throw new HttpError(400, '"messages" needs at least one non-system message');

  const systemPrompt = system.length ? system.join('\n\n') : undefined;
  if (turns.length === 1 && turns[0].label === 'User') {
    return { systemPrompt, prompt: turns[0].text };
  }

  const transcript = turns.map((t) => `### ${t.label}\n${t.text}`).join('\n\n');
  const prompt =
    'This is the conversation so far. Write the next Assistant message — only its ' +
    'content, without the "### Assistant" heading.\n\n' +
    transcript;
  return { systemPrompt, prompt };
}

/**
 * Responses API `input` → Chat Completions-style messages for toPrompt. It is a
 * string or a list of items: messages, plus the function calls and their outputs
 * from earlier turns, which go into the transcript as text. Reasoning items are
 * skipped.
 */
export function responsesToMessages({ input, instructions, previous_response_id }) {
  if (previous_response_id != null) {
    throw new HttpError(400, '"previous_response_id" is not supported — send the whole conversation in "input"');
  }
  if (instructions != null && typeof instructions !== 'string') throw new HttpError(400, '"instructions" must be a string');
  const messages = instructions?.trim() ? [{ role: 'system', content: instructions }] : [];

  if (typeof input === 'string') return [...messages, { role: 'user', content: input }];
  if (!Array.isArray(input) || input.length === 0) {
    throw new HttpError(400, '"input" must be a string or a non-empty array');
  }
  input.forEach((item, i) => {
    const type = item?.type ?? 'message';
    if (type === 'message') messages.push({ role: item.role, content: item.content });
    else if (type === 'function_call') {
      messages.push({ role: 'assistant', content: `[called ${item.name} with ${item.arguments}]` });
    } else if (type === 'function_call_output') {
      const output = typeof item.output === 'string' ? item.output : textOf(item.output, `input[${i}].output`);
      messages.push({ role: 'tool', content: output });
    } else if (type !== 'reasoning') {
      throw new HttpError(400, `input[${i}]: unsupported item type "${type}"`);
    }
  });
  return messages;
}

function usageOf(result) {
  const u = result?.usage ?? {};
  const prompt = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const completion = u.output_tokens ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

export function newCompletionId() {
  return `chatcmpl-${randomUUID().replaceAll('-', '')}`;
}

export function completion({ id, created, model, result }) {
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: String(result.result ?? '') },
        finish_reason: 'stop',
      },
    ],
    usage: usageOf(result),
  };
}

export function chunk({ id, created, model, delta, finishReason = null, result }) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: delta ? [{ index: 0, delta, finish_reason: finishReason }] : [],
    ...(result ? { usage: usageOf(result) } : {}),
  };
}

function responseUsage(result) {
  const u = result?.usage ?? {};
  const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const output = u.output_tokens ?? 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: u.cache_read_input_tokens ?? 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: input + output,
  };
}

export function newResponseIds() {
  const hex = () => randomUUID().replaceAll('-', '');
  return { id: `resp_${hex()}`, messageId: `msg_${hex()}` };
}

/** The assistant's message as a Responses API output item. */
export function responseMessage({ messageId, text, status = 'completed' }) {
  return {
    type: 'message',
    id: messageId,
    status,
    role: 'assistant',
    content: text == null ? [] : [{ type: 'output_text', text, annotations: [] }],
  };
}

/**
 * A Responses API response object. Without `result` it is the in-progress shell
 * sent at the start of a stream; with `error` it is a failed one.
 */
export function response({ id, messageId, created, model, instructions, result, error }) {
  const status = error ? 'failed' : result ? 'completed' : 'in_progress';
  return {
    id,
    object: 'response',
    created_at: created,
    status,
    error: error ? { code: 'server_error', message: error.message } : null,
    incomplete_details: null,
    instructions: instructions ?? null,
    model,
    output: result ? [responseMessage({ messageId, text: String(result.result ?? '') })] : [],
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    usage: result ? responseUsage(result) : null,
  };
}

export function errorBody(err, status) {
  return {
    error: {
      message: err.message,
      type: status >= 500 ? 'server_error' : 'invalid_request_error',
      code: null,
    },
  };
}
