#!/usr/bin/env node
// A minimal stdio MCP server that offers the API client's tools to claude.
// claude starts it with the path of a JSON file holding the tool list. It never
// answers a tool call: JeanClaude stops claude as soon as the model has asked for
// one and returns the call to the client, which runs it and sends the result back
// in its next request.

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const tools = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');

createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id === undefined) return; // a notification
  if (m.method === 'initialize') {
    send({
      id: m.id,
      result: {
        protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'jeanclaude-client-tools', version: '1' },
      },
    });
  } else if (m.method === 'tools/list') {
    send({ id: m.id, result: { tools } });
  } else if (m.method === 'tools/call') {
    // Left unanswered on purpose (see above).
  } else if (m.method === 'ping') {
    send({ id: m.id, result: {} });
  } else {
    send({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
  }
});
