'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');
const { startGateway } = require('../gateway');

async function main() {
  const seen = [];
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({
        url: request.url,
        authorization: request.headers.authorization,
        account: request.headers['chatgpt-account-id'],
        body: JSON.parse(body),
      });
      if (request.headers.authorization === 'Bearer token-a') {
        response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
        response.end(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'rate limit exceeded' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"ok":true}\n\n');
    });
  });
  await listen(upstream, '127.0.0.1', 0);
  const upstreamPort = upstream.address().port;

  const config = {
    providers: [{
      id: 'openai-oauth',
      kind: 'openai-oauth',
      accounts: [
        { id: 'acct-a', label: 'A', accessToken: 'token-a', refreshToken: 'r-a', idToken: 'i-a', openAIAccountId: 'remote-a' },
        { id: 'acct-b', label: 'B', accessToken: 'token-b', refreshToken: 'r-b', idToken: 'i-b', openAIAccountId: 'remote-b' },
      ],
    }],
  };

  const gateway = await startGateway({
    host: '127.0.0.1',
    port: 0,
    upstreamBase: `http://127.0.0.1:${upstreamPort}`,
    loadConfig: () => config,
  });
  const gatewayPort = gateway.state ? gateway.port : gateway.port;

  const first = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      session_id: 'thread-1',
    },
    body: JSON.stringify({ model: 'gpt-test', input: 'hello', temperature: 1 }),
  });
  assert.equal(first.status, 200);
  assert.match(await first.text(), /"ok":true/);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].authorization, 'Bearer token-a');
  assert.equal(seen[1].authorization, 'Bearer token-b');
  assert.equal(seen[1].account, 'remote-b');
  assert.equal(seen[1].body.stream, true);
  assert.equal(seen[1].body.store, false);
  assert.equal(seen[1].body.temperature, undefined);

  const second = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      session_id: 'thread-1',
    },
    body: JSON.stringify({ model: 'gpt-test', input: 'again' }),
  });
  assert.equal(second.status, 200);
  assert.equal(seen.at(-1).authorization, 'Bearer token-b');

  await gateway.close();
  await close(upstream);
  console.log('Gateway smoke test passed');
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
