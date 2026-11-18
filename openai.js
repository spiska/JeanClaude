// Translation between the OpenAI formats (Chat Completions, Responses) and `claude -p`.
import { randomUUID } from 'node:crypto';
import { CLIENT_TOOL_PREFIX, HttpError } from './claude.js';

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

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const TOOL_NOTE =
  `Tools whose names start with ${CLIENT_TOOL_PREFIX} belong to the application you are talking through: ` +
  'when you call one, the application runs it and its result comes back in the conversation. Earlier tool ' +
  'calls and their results are written out in the conversation as text. To call a tool, always use it ' +
  'directly — never write a tool call out as text.';

// OpenAI's hosted web search tool, in its current and dated names.
const WEB_SEARCH = /^web_search(_preview)?(_\d{4}_\d{2}_\d{2})?$/;
const SEARCH_NOTE = 'You can search the web with WebSearch: do so when the question needs current or outside information.';
const SEARCH_NOW = 'Search the web with WebSearch before you answer.';

/**
 * The client's tools, from either API's `tools` and `tool_choice` (Chat
 * Completions nests each function in `function`, the Responses API does not).
 * Function tools become MCP tool definitions for claude. OpenAI's web search tool
 * (or Chat Completions' `web_search_options`) is served by claude's own
 * WebSearch. Returns those plus a note for claude's system prompt, or nothing when
 * there are no tools or tool_choice is "none".
 */
export function clientTools({ tools, tool_choice, web_search_options }) {
  if (tools != null && !Array.isArray(tools)) throw new HttpError(400, '"tools" must be an array');
  let webSearch = web_search_options != null && typeof web_search_options === 'object';
  const list = [];
  (tools ?? []).forEach((t, i) => {
    if (WEB_SEARCH.test(t?.type)) {
      webSearch = true;
      return;
    }
    if (t?.type !== 'function') {
      throw new HttpError(400, `tools[${i}]: only function and web search tools are supported (got "${t?.type}")`);
    }
    const f = t.function ?? t;
    if (typeof f.name !== 'string' || !TOOL_NAME.test(f.name)) {
      throw new HttpError(400, `tools[${i}]: the name must be 1-64 letters, digits, "_" or "-"`);
    }
    const schema = f.parameters && typeof f.parameters === 'object' ? f.parameters : {};
    list.push({ name: f.name, description: typeof f.description === 'string' ? f.description : '', inputSchema: { type: 'object', ...schema } });
  });
  if (tool_choice === 'none' || (!list.length && !webSearch)) return {};

  const choice = tool_choice && typeof tool_choice === 'object' ? tool_choice : undefined;
  const forceSearch = WEB_SEARCH.test(choice?.type) || (tool_choice === 'required' && !list.length);
  if (forceSearch) webSearch = true;
  const forced = choice && !forceSearch ? (choice.function?.name ?? choice.name) : undefined;
  if (forced !== undefined && !list.some((t) => t.name === forced)) {
    throw new HttpError(400, `"tool_choice" names a tool that is not in "tools": ${forced}`);
  }

  const notes = [];
  if (list.length) {
    notes.push(TOOL_NOTE);
    if (forced) notes.push(`Now call the tool ${CLIENT_TOOL_PREFIX}${forced}.`);
    else if (tool_choice === 'required') notes.push('Now call at least one of these tools.');
  }
  if (webSearch) notes.push(forceSearch ? SEARCH_NOW : SEARCH_NOTE);
  return { ...(list.length ? { tools: list } : {}), webSearch, toolInstruction: notes.join(' ') };
}

/** An earlier tool call written out for the transcript. */
function callText(call, where) {
  const name = call?.function?.name;
  if (typeof name !== 'string') throw new HttpError(400, `${where}: a tool call needs "function.name"`);
  const args = typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments ?? {});
  return `[Called tool ${CLIENT_TOOL_PREFIX}${name} (call id ${call.id ?? '?'}) with arguments ${args}]`;
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
    else if (m.role === 'assistant') {
      if (m.tool_calls != null && !Array.isArray(m.tool_calls)) throw new HttpError(400, `${where}: "tool_calls" must be an array`);
      const calls = (m.tool_calls ?? []).map((call, j) => callText(call, `${where}.tool_calls[${j}]`));
      turns.push({ label: 'Assistant', text: [text, ...calls].filter(Boolean).join('\n') });
    } else if (m.role === 'tool') {
      turns.push({ label: `Tool result${m.tool_call_id ? ` (call id ${m.tool_call_id})` : ''}`, text });
    }
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
      // Calls made together belong to one assistant turn, with any text before them.
      const call = { id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } };
      const last = messages.at(-1);
      if (last?.role === 'assistant') last.tool_calls = [...(last.tool_calls ?? []), call];
      else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
    } else if (type === 'function_call_output') {
      const output = typeof item.output === 'string' ? item.output : textOf(item.output, `input[${i}].output`);
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: output });
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

/** The tool calls claude asked for, in the Chat Completions format. */
export function chatToolCalls(result) {
  return (result?.tool_calls ?? []).map((call, index) => ({
    index,
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: call.arguments },
  }));
}

export function completion({ id, created, model, result }) {
  const text = String(result.result ?? '');
  const calls = chatToolCalls(result).map(({ index, ...call }) => call);
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: calls.length
          ? { role: 'assistant', content: text || null, tool_calls: calls }
          : { role: 'assistant', content: text },
        finish_reason: calls.length ? 'tool_calls' : 'stop',
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

/** A tool call claude asked for, as a Responses API output item. */
export function functionCallItem(call, status = 'completed') {
  return {
    type: 'function_call',
    id: `fc_${call.id}`,
    call_id: call.id,
    name: call.name,
    arguments: status === 'completed' ? call.arguments : '',
    status,
  };
}

/** A web search claude ran, as a Responses API output item. */
export function webSearchItem(search, status = 'completed') {
  return { type: 'web_search_call', id: `ws_${search.id}`, status, action: { type: 'search', query: search.query } };
}

/**
 * A finished response's output: the web searches, the message (left out when
 * there are only tool calls), then the tool calls.
 */
function responseOutput(messageId, result) {
  const text = String(result.result ?? '');
  const calls = result.tool_calls ?? [];
  return [
    ...(result.web_searches ?? []).map((search) => webSearchItem(search)),
    ...(text || !calls.length ? [responseMessage({ messageId, text })] : []),
    ...calls.map((call) => functionCallItem(call)),
  ];
}

/**
 * A Responses API response object. Without `result` it is the in-progress shell
 * sent at the start of a stream; with `error` it is a failed one.
 */
export function response({ id, messageId, created, model, instructions, tools, toolChoice, parallelToolCalls, result, error }) {
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
    output: result ? responseOutput(messageId, result) : [],
    parallel_tool_calls: parallelToolCalls ?? true,
    tool_choice: toolChoice ?? 'auto',
    tools: tools ?? [],
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
