'use strict';

const http = require('node:http');
const { PassThrough } = require('node:stream');
const { URL } = require('node:url');
const WebSocket = require('ws');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 1456;
const DEFAULT_UPSTREAM_BASE = 'https://chatgpt.com/backend-api/codex';
const GATEWAY_API_KEY = 'codex-switch-local-gateway';
const ORIGINATOR = 'codex-switch';
const REASONING_INCLUDE_MARKER = 'reasoning.encrypted_content';
const DEFAULT_CODEX_CLI_VERSION = '0.125.0';

function startGateway(options) {
  const state = new GatewayState(options);
  const host = options.host || DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const server = http.createServer((request, response) => {
    state.handleHTTP(request, response).catch((error) => {
      state.sendJSON(response, 502, {
        error: { message: `codex-switch gateway failed: ${error.message || String(error)}` },
      });
    });
  });

  const wss = new WebSocket.Server({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    state.handleUpgrade(request, socket, head, wss);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        host,
        port: typeof address === 'object' && address ? address.port : port,
        close: () => new Promise((done) => server.close(done)),
        state,
      });
    });
  });
}

class GatewayState {
  constructor(options) {
    this.loadConfig = options.loadConfig;
    this.upstreamBase = (options.upstreamBase || process.env.CODEXBAR_WIN_UPSTREAM_BASE || DEFAULT_UPSTREAM_BASE).replace(/\/+$/, '');
    this.stickyBindings = new Map();
    this.runtimeBlockedUntil = new Map();
    this.lastRoutedAccountId = null;
  }

  async handleHTTP(request, response) {
    const route = routeFromPath(request.url || '/');
    if (request.method !== 'POST' || !route) {
      this.sendJSON(response, 404, { error: { message: 'not found' } });
      return;
    }

    const body = await readRequestBody(request);
    const stickyKey = stickyKeyForRequest(request, body, route);
    const candidates = this.candidates(stickyKey);
    if (candidates.length === 0) {
      this.sendJSON(response, 503, { error: { message: 'aggregate gateway unavailable: no routable OpenAI account' } });
      return;
    }

    for (let index = 0; index < candidates.length; index += 1) {
      const account = candidates[index];
      const canFailover = index < candidates.length - 1;
      const upstream = await this.proxyPOST(request, body, route, account);
      if (isRetryableStatus(upstream.statusCode)) {
        this.blockAccount(account, retryAtFromHeaders(upstream.headers));
        this.clearBinding(stickyKey, account.id);
        if (canFailover) {
          upstream.stream.destroy();
          continue;
        }
      }

      const buffered = await previewUpstreamStream(upstream);
      const signal = accountProtocolSignal(buffered.previewText);
      if (signal && canFailover) {
        this.blockAccount(account, signal.retryAt);
        this.clearBinding(stickyKey, account.id);
        buffered.stream.destroy();
        upstream.stream.destroy();
        continue;
      }

      this.bind(stickyKey, account.id);
      response.writeHead(upstream.statusCode, filterResponseHeaders(upstream.headers));
      buffered.stream.pipe(response);
      return;
    }

    this.sendJSON(response, 502, { error: { message: 'codex-switch gateway failed to reach OpenAI upstream' } });
  }

  async proxyPOST(clientRequest, body, route, account) {
    const normalizedBody = route === 'compact'
      ? normalizeCompactRequestBody(body)
      : normalizeResponsesRequestBody(body);
    const upstreamURL = new URL(`${this.upstreamBase}/responses${route === 'compact' ? '/compact' : ''}`);
    const headers = copyRequestHeaders(clientRequest.headers);
    headers.authorization = `Bearer ${account.accessToken}`;
    headers['chatgpt-account-id'] = account.openAIAccountId;
    headers.originator = ORIGINATOR;
    headers['openai-beta'] = 'responses=experimental';
    headers['content-length'] = Buffer.byteLength(normalizedBody);
    if (route === 'compact') {
      headers.accept = 'application/json';
      headers.version ||= DEFAULT_CODEX_CLI_VERSION;
      const seed = compactSessionSeed(body);
      if (seed) {
        headers.session_id ||= seed;
        headers.conversation_id ||= seed;
      }
    }

    return requestUpstream(upstreamURL, {
      method: 'POST',
      headers,
      body: normalizedBody,
    });
  }

  handleUpgrade(request, socket, head, wss) {
    const route = routeFromPath(request.url || '/');
    if (route !== 'responses') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (clientWS) => {
      this.handleWebSocket(request, clientWS).catch((error) => {
        try {
          clientWS.close(1011, error.message || 'gateway error');
        } catch (_) {
          clientWS.terminate();
        }
      });
    });
  }

  async handleWebSocket(request, clientWS) {
    const stickyKey = stickyKeyForHeaders(request.headers);
    const candidates = this.candidates(stickyKey);
    if (candidates.length === 0) {
      clientWS.close(1011, 'no routable OpenAI account');
      return;
    }

    let upstreamWS = null;
    let selectedAccount = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const account = candidates[index];
      try {
        upstreamWS = await this.connectUpstreamWebSocket(request, account);
        selectedAccount = account;
        break;
      } catch (error) {
        if (isAccountScopedStatus(error.statusCode)) {
          this.blockAccount(account);
          if (index < candidates.length - 1) continue;
        }
        throw error;
      }
    }
    if (!upstreamWS || !selectedAccount) {
      clientWS.close(1011, 'failed to establish upstream websocket');
      return;
    }

    this.bind(stickyKey, selectedAccount.id);
    clientWS.on('message', (data, isBinary) => {
      if (upstreamWS.readyState === WebSocket.OPEN) upstreamWS.send(data, { binary: isBinary });
    });
    upstreamWS.on('message', (data, isBinary) => {
      const text = isBinary ? data.toString('utf8') : String(data);
      const signal = accountProtocolSignal(text);
      if (signal) {
        this.blockAccount(selectedAccount, signal.retryAt);
        this.clearBinding(stickyKey, selectedAccount.id);
      }
      if (clientWS.readyState === WebSocket.OPEN) clientWS.send(data, { binary: isBinary });
    });
    clientWS.on('close', () => upstreamWS.close());
    upstreamWS.on('close', () => clientWS.close());
    clientWS.on('error', () => upstreamWS.close());
    upstreamWS.on('error', () => clientWS.close(1011, 'upstream websocket error'));
  }

  connectUpstreamWebSocket(request, account) {
    const upstreamURL = new URL(`${this.upstreamBase}/responses`);
    upstreamURL.protocol = upstreamURL.protocol === 'https:' ? 'wss:' : 'ws:';
    const headers = copyRequestHeaders(request.headers);
    delete headers.upgrade;
    delete headers.connection;
    delete headers['sec-websocket-key'];
    delete headers['sec-websocket-version'];
    delete headers['sec-websocket-extensions'];
    headers.authorization = `Bearer ${account.accessToken}`;
    headers['chatgpt-account-id'] = account.openAIAccountId;
    headers.originator = ORIGINATOR;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(upstreamURL, request.headers['sec-websocket-protocol'], {
        headers,
        handshakeTimeout: 8000,
      });
      ws.once('open', () => resolve(ws));
      ws.once('unexpected-response', (_request, response) => {
        const error = new Error(`upstream websocket status ${response.statusCode}`);
        error.statusCode = response.statusCode;
        reject(error);
      });
      ws.once('error', reject);
    });
  }

  candidates(stickyKey) {
    const config = this.loadConfig();
    const provider = (config.providers || []).find((item) => item.kind === 'openai-oauth');
    const accounts = (provider?.accounts || [])
      .filter((account) => account.accessToken && account.refreshToken && account.idToken)
      .filter((account) => !this.isBlocked(account.id));
    if (stickyKey && this.stickyBindings.has(stickyKey)) {
      const stickyId = this.stickyBindings.get(stickyKey).accountId;
      const index = accounts.findIndex((account) => account.id === stickyId);
      if (index > 0) {
        const [sticky] = accounts.splice(index, 1);
        accounts.unshift(sticky);
      }
    }
    return accounts;
  }

  bind(stickyKey, accountId) {
    this.lastRoutedAccountId = accountId;
    if (!stickyKey) return;
    this.stickyBindings.set(stickyKey, { accountId, updatedAt: Date.now() });
    this.pruneSticky();
  }

  clearBinding(stickyKey, accountId) {
    if (!stickyKey) return;
    if (this.stickyBindings.get(stickyKey)?.accountId === accountId) this.stickyBindings.delete(stickyKey);
  }

  blockAccount(account, retryAt) {
    this.runtimeBlockedUntil.set(account.id, retryAt?.getTime?.() || Date.now() + 10 * 60 * 1000);
    if (this.lastRoutedAccountId === account.id) this.lastRoutedAccountId = null;
  }

  isBlocked(accountId) {
    const until = this.runtimeBlockedUntil.get(accountId);
    if (!until) return false;
    if (until <= Date.now()) {
      this.runtimeBlockedUntil.delete(accountId);
      return false;
    }
    return true;
  }

  pruneSticky() {
    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    for (const [key, value] of this.stickyBindings) {
      if (value.updatedAt < cutoff) this.stickyBindings.delete(key);
    }
    while (this.stickyBindings.size > 256) {
      const oldest = [...this.stickyBindings.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
      if (!oldest) break;
      this.stickyBindings.delete(oldest[0]);
    }
  }

  sendJSON(response, statusCode, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(statusCode, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      connection: 'close',
    });
    response.end(body);
  }
}

function routeFromPath(requestPath) {
  const pathname = new URL(requestPath, 'http://localhost').pathname.replace(/\/+$/, '') || '/';
  if (['/v1/responses', '/responses', '/backend-api/codex/responses', '/openai/v1/responses'].includes(pathname)) return 'responses';
  if (['/v1/responses/compact', '/responses/compact', '/backend-api/codex/responses/compact', '/openai/v1/responses/compact'].includes(pathname)) return 'compact';
  return null;
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function requestUpstream(url, options) {
  const transport = url.protocol === 'https:' ? require('node:https') : require('node:http');
  return new Promise((resolve, reject) => {
    const request = transport.request(url, { method: options.method, headers: options.headers }, (response) => {
      resolve({ statusCode: response.statusCode || 502, headers: response.headers, stream: response });
    });
    request.on('error', reject);
    request.end(options.body);
  });
}

function previewUpstreamStream(upstream, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const output = new PassThrough();
    const chunks = [];
    let total = 0;
    let resolved = false;

    function settle() {
      if (resolved) return;
      resolved = true;
      resolve({
        stream: output,
        previewText: Buffer.concat(chunks).toString('utf8'),
      });
    }

    upstream.stream.on('data', (chunk) => {
      output.write(chunk);
      if (resolved) return;
      chunks.push(chunk);
      total += chunk.length;
      const text = Buffer.concat(chunks).toString('utf8');
      if (accountProtocolSignal(text) || !shouldKeepBufferingSSEPayload(text) || total >= limit) {
        settle();
      }
    });
    upstream.stream.on('end', () => {
      output.end();
      settle();
    });
    upstream.stream.on('error', (error) => {
      output.destroy(error);
      if (!resolved) reject(error);
    });
  });
}

function normalizeResponsesRequestBody(body) {
  const json = parseJSON(body);
  if (!json) return body;
  json.store = false;
  json.stream = true;
  delete json.max_output_tokens;
  delete json.temperature;
  delete json.top_p;
  json.instructions ??= '';
  json.tools ??= [];
  json.parallel_tool_calls ??= false;
  const includes = Array.isArray(json.include) ? json.include : [];
  if (!includes.includes(REASONING_INCLUDE_MARKER)) includes.push(REASONING_INCLUDE_MARKER);
  json.include = includes;
  return Buffer.from(JSON.stringify(json));
}

function normalizeCompactRequestBody(body) {
  const json = parseJSON(body);
  if (!json) return body;
  const next = {};
  for (const key of ['model', 'input', 'instructions', 'previous_response_id']) {
    if (Object.prototype.hasOwnProperty.call(json, key)) next[key] = json[key];
  }
  next.instructions ??= '';
  return Buffer.from(JSON.stringify(next));
}

function parseJSON(body) {
  try {
    return JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
  } catch (_) {
    return null;
  }
}

function copyRequestHeaders(headers) {
  const next = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (['host', 'content-length', 'authorization', 'chatgpt-account-id', 'connection', 'originator'].includes(lower)) continue;
    if (Array.isArray(value)) next[lower] = value.join(', ');
    else if (value != null) next[lower] = String(value);
  }
  return next;
}

function filterResponseHeaders(headers) {
  const next = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (['content-length', 'transfer-encoding', 'connection'].includes(lower)) continue;
    next[name] = value;
  }
  next.connection = 'close';
  return next;
}

function stickyKeyForRequest(request, body, route) {
  return stickyKeyForHeaders(request.headers) || (route === 'compact' ? compactSessionSeed(body) : null);
}

function stickyKeyForHeaders(headers) {
  return firstNonEmpty(headers.session_id, headers.conversation_id, headers['x-codex-window-id']);
}

function compactSessionSeed(body) {
  const json = parseJSON(body);
  if (!json) return null;
  return firstNonEmpty(json.prompt_cache_key, json.session_id, json.conversation_id);
}

function firstNonEmpty(...values) {
  return values.map((value) => String(value || '').trim()).find(Boolean) || null;
}

function isRetryableStatus(statusCode) {
  return isAccountScopedStatus(statusCode) || (statusCode >= 500 && statusCode <= 599);
}

function isAccountScopedStatus(statusCode) {
  return [401, 403, 429].includes(Number(statusCode));
}

function retryAtFromHeaders(headers) {
  const retryAfter = headers['retry-after'];
  if (!retryAfter) return null;
  const value = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return new Date(Date.now() + seconds * 1000);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function accountProtocolSignal(payload) {
  const text = String(payload || '').trim();
  if (!text) return null;
  const object = parseJSON(Buffer.from(text));
  if (object) {
    const candidates = [object, object.error, object.response, object.response?.error].filter(Boolean);
    for (const item of candidates) {
      const signal = makeProtocolSignal(item.code, item.type, item.message, item);
      if (signal) return signal;
    }
  }
  return isRuntimeLimitSignal(null, null, text) ? { message: text, retryAt: retryAtFromHumanMessage(text) } : null;
}

function makeProtocolSignal(code, type, message, object) {
  if (!isRuntimeLimitSignal(code, type, message)) return null;
  return { message, retryAt: retryAtFromJSONObject(object) || retryAtFromHumanMessage(message) };
}

function isRuntimeLimitSignal(code, type, message) {
  const normalizedCode = String(code || '').toLowerCase();
  const normalizedType = String(type || '').toLowerCase();
  const normalizedMessage = String(message || '').toLowerCase();
  if (normalizedCode.includes('usage_limit') || normalizedCode.includes('rate_limit') || normalizedCode.includes('insufficient_quota')) return true;
  if (normalizedType.includes('usage_limit') || normalizedType.includes('rate_limit')) return true;
  if (normalizedMessage.includes('usage limit') && (normalizedMessage.includes('hit') || normalizedMessage.includes('reached'))) return true;
  if (normalizedMessage.includes('rate limit') && (normalizedMessage.includes('hit') || normalizedMessage.includes('reached') || normalizedMessage.includes('exceeded'))) return true;
  return false;
}

function retryAtFromJSONObject(object) {
  if (!object) return null;
  if (object.retry_after != null) {
    const seconds = Number(object.retry_after);
    if (Number.isFinite(seconds)) return new Date(Date.now() + seconds * 1000);
    const date = new Date(object.retry_after);
    if (!Number.isNaN(date.getTime())) return date;
  }
  for (const key of ['retry_after_seconds']) {
    const seconds = Number(object[key]);
    if (Number.isFinite(seconds)) return new Date(Date.now() + seconds * 1000);
  }
  for (const key of ['reset_at', 'resets_at']) {
    const timestamp = Number(object[key]);
    if (Number.isFinite(timestamp)) return new Date(timestamp * 1000);
  }
  return null;
}

function retryAtFromHumanMessage(message) {
  const match = String(message || '').match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?\s+\d{1,2}:\d{2}\s*(?:AM|PM)/i);
  if (!match) return null;
  const cleaned = match[0].replace(/(\d)(st|nd|rd|th)/i, '$1');
  const date = new Date(cleaned);
  return Number.isNaN(date.getTime()) ? null : date;
}

function shouldKeepBufferingSSEPayload(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return true;
  if (accountProtocolSignal(trimmed)) return false;
  return trimmed.startsWith('data:') && !trimmed.includes('\n\n');
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  GATEWAY_API_KEY,
  startGateway,
  normalizeResponsesRequestBody,
  normalizeCompactRequestBody,
  accountProtocolSignal,
};
