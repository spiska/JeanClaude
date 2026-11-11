// Translation between the OpenAI Chat Completions format and `claude -p`.
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

function textOf(content, where) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part?.type === 'text' && typeof part.text === 'string') return part.text;
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

export function errorBody(err, status) {
  return {
    error: {
      message: err.message,
      type: status >= 500 ? 'server_error' : 'invalid_request_error',
      code: null,
    },
  };
}
