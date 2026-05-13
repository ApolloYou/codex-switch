'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROJECT_DIR = __dirname;
const CONFIG_PATH = path.join(os.homedir(), '.codex-switch', 'config.json');
const LEGACY_CONFIG_PATH = path.join(os.homedir(), '.codexbar-win', 'config.json');
const CACHE_PATH = path.join(os.homedir(), '.codex-switch', 'usage-cache.json');
const TMP_ROOT = path.join(PROJECT_DIR, '.tmp-usage');
const TOKEN_BUDGETS = {
  primary: 16_000_000,
  secondary: 100_000_000,
};

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const accountId = valueAfter(args, '--account');
  migrateLegacyConfig();
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const provider = (config.providers || []).find((item) => item.kind === 'openai-oauth' || item.id === 'openai-oauth');
  if (!provider) throw new Error('No OpenAI OAuth provider found.');

  const accounts = accountId
    ? provider.accounts.filter((account) => account.id === accountId || account.label === accountId)
    : provider.accounts;

  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const cache = readCache();
  const results = [];
  for (const account of accounts) {
    const result = await readUsageWithRetry(account).catch((error) => {
      const cached = cache[account.id];
      if (cached) {
        return { ...cached, stale: true, error: compactError(error) };
      }
      return {
        id: account.id,
        label: account.label,
        openAIAccountId: account.openAIAccountId,
        ok: false,
        error: compactError(error),
      };
    });
    results.push(result);
  }
  writeCache(results);

  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const item of results) {
      console.log(`${item.label}\t${item.ok ? item.summary : `ERR ${item.error}`}`);
    }
  }
}

async function readUsageWithRetry(account) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await readUsageViaCodexAppServer(account);
    } catch (error) {
      lastError = error;
      await sleep(700 * attempt);
    }
  }
  throw lastError;
}

function readUsageViaCodexAppServer(account) {
  return new Promise((resolve, reject) => {
    const codexHome = prepareCodexHome(account);
    const child = childProcess.spawn('codex', ['app-server'], {
      cwd: PROJECT_DIR,
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let buffer = '';
    let settled = false;
    const timeout = setTimeout(() => finish(new Error('Timed out reading usage.')), 45000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) handleLine(line);
    });
    child.stderr.on('data', () => {});
    child.on('error', finish);
    child.on('exit', (code, signal) => {
      if (!settled) finish(new Error(`codex app-server exited before usage response: ${code ?? signal}`));
    });

    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-switch', version: '0.1.0' } } });
    setTimeout(() => send({ id: 2, method: 'account/rateLimits/read', params: {} }), 600);

    function handleLine(line) {
      if (!line.trim().startsWith('{')) return;
      let message;
      try { message = JSON.parse(line); } catch (_) { return; }
      if (message.id !== 2) return;
      if (message.error) {
        finish(new Error(JSON.stringify(message.error)));
        return;
      }
      const rateLimits = message.result?.rateLimits || message.result?.rateLimitsByLimitId?.codex;
      if (!rateLimits) {
        finish(new Error(`Usage response did not include rateLimits: ${line}`));
        return;
      }
      finish(null, normalizeResult(account, rateLimits));
    }

    function send(payload) {
      if (!settled) child.stdin.write(`${JSON.stringify(payload)}\n`);
    }

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { child.kill(); } catch (_) {}
      if (error) reject(error);
      else resolve(result);
    }
  });
}

function prepareCodexHome(account) {
  const safe = String(account.id).replace(/[^a-zA-Z0-9_.-]/g, '_');
  const codexHome = path.join(TMP_ROOT, safe);
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      id_token: account.idToken,
      access_token: account.accessToken,
      refresh_token: account.refreshToken,
      account_id: account.openAIAccountId,
    },
    last_refresh: account.lastRefresh || new Date().toISOString(),
  }, null, 2));
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5.4"\n');
  return codexHome;
}

function normalizeResult(account, rateLimits) {
  const primary = normalizeWindow(rateLimits.primary);
  const secondary = normalizeWindow(rateLimits.secondary);
  const credits = rateLimits.credits || null;
  const planType = rateLimits.planType || rateLimits.plan_type || null;
  const estimate = estimateTokens(primary, secondary);
  const parts = [];
  if (planType) parts.push(String(planType));
  if (primary) parts.push(`${windowLabel(primary)} ${primary.remainingPercent}% left`);
  if (secondary) parts.push(`${windowLabel(secondary)} ${secondary.remainingPercent}% left`);
  return {
    id: account.id,
    label: account.label,
    openAIAccountId: account.openAIAccountId,
    ok: true,
    planType,
    primary,
    secondary,
    credits,
    shortWindowLabel: primary ? windowLabel(primary) : '5h',
    longWindowLabel: secondary ? windowLabel(secondary) : '7d',
    primaryUsedTokens: estimate.primaryUsedTokens,
    secondaryUsedTokens: estimate.secondaryUsedTokens,
    primaryUsedLabel: estimate.primaryUsedLabel,
    secondaryUsedLabel: estimate.secondaryUsedLabel,
    todayCost: estimate.primaryUsedLabel,
    monthCost: estimate.secondaryUsedLabel,
    estimateNote: estimate.note,
    summary: parts.length ? parts.join(' | ') : 'usage unavailable',
    refreshedAt: new Date().toISOString(),
  };
}

function estimateTokens(primary, secondary) {
  const primaryUsed = Number(primary?.usedPercent || 0);
  const secondaryUsed = Number(secondary?.usedPercent || 0);
  const primaryUsedTokens = Math.round(TOKEN_BUDGETS.primary * (primaryUsed / 100));
  const secondaryUsedTokens = Math.round(TOKEN_BUDGETS.secondary * (secondaryUsed / 100));
  return {
    primaryUsedTokens,
    secondaryUsedTokens,
    primaryUsedLabel: formatTokens(primaryUsedTokens),
    secondaryUsedLabel: formatTokens(secondaryUsedTokens),
    note: 'Estimate only: 5h budget=16M tokens, 7d budget=100M tokens.',
  };
}

function formatTokens(tokens) {
  if (!Number.isFinite(tokens)) return '-';
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000;
    return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}K`;
  }
  return String(tokens);
}

function windowLabel(window) {
  const minutes = Number(window?.windowDurationMins || 0);
  if (minutes > 0 && minutes % 10080 === 0) return `${(minutes / 10080) * 7}d`;
  if (minutes > 0 && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes > 0 && minutes % 60 === 0) return `${minutes / 60}h`;
  return minutes > 0 ? `${minutes}m` : 'window';
}

function normalizeWindow(value) {
  if (!value) return null;
  const usedPercent = value.usedPercent ?? value.used_percent;
  if (usedPercent == null) return null;
  return {
    usedPercent: Number(usedPercent),
    remainingPercent: Math.max(0, Math.min(100, 100 - Number(usedPercent))),
    windowDurationMins: value.windowDurationMins ?? value.window_minutes ?? null,
    resetsAt: value.resetsAt ?? value.resets_at ?? null,
  };
}

function valueAfter(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function compactError(error) {
  const message = error?.message || String(error);
  return message.replace(/\s+/g, ' ').slice(0, 240);
}

function migrateLegacyConfig() {
  if (fs.existsSync(CONFIG_PATH) || !fs.existsSync(LEGACY_CONFIG_PATH)) return;
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.copyFileSync(LEGACY_CONFIG_PATH, CONFIG_PATH);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readCache() {
  try {
    const rows = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    const map = {};
    for (const row of rows) {
      if (row?.id && row.ok) map[row.id] = row;
    }
    return map;
  } catch (_) {
    return {};
  }
}

function writeCache(results) {
  const okRows = results.filter((row) => row.ok);
  if (okRows.length === 0) return;
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(okRows, null, 2));
}
