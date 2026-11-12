#!/usr/bin/env node
// Stands in for the `claude` CLI in tests (CLAUDE_BIN points here). It reads the
// prompt from stdin and answers "echo: <prompt>", in the json or stream-json format
// the real CLI uses. The prompt can ask for special behaviour:
//   FAIL    the run fails (is_error, exit code 1)
//   TOOL    the answer comes in two model turns, as around a tool call
// The arguments it got are returned in the result as `fake_args`, so tests can check them.

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  const failed = prompt.includes('FAIL');
  const answer = `echo: ${prompt}`;
  const result = {
    type: 'result',
    subtype: failed ? 'error_during_execution' : 'success',
    is_error: failed,
    result: failed ? 'something went wrong' : answer,
    session_id: flag('--resume') ?? '00000000-0000-4000-8000-000000000000',
    total_cost_usd: 0.0123,
    usage: { input_tokens: 3, cache_creation_input_tokens: 4, cache_read_input_tokens: 5, output_tokens: 6 },
    fake_args: args,
  };
  const print = (event) => process.stdout.write(JSON.stringify(event) + '\n');

  if (flag('--output-format') === 'stream-json') {
    const messageStart = () => print({ type: 'stream_event', event: { type: 'message_start' } });
    const text = (t) => print({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });
    print({ type: 'system', subtype: 'init' });
    messageStart();
    if (prompt.includes('TOOL')) {
      text('Let me look.');
      messageStart(); // the next turn, after the "tool call"
    }
    if (!failed) {
      text(answer.slice(0, 6));
      text(answer.slice(6));
    }
    print({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 2000000000, status: 'allowed' } } },
    });
    print(result);
  } else {
    print(result);
  }
  process.exitCode = failed ? 1 : 0;
});
