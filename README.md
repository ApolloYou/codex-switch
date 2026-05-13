# codex-switch

**you only oauth once (yooo)**

Windows account switcher for OpenAI Codex Desktop. Import each ChatGPT account once with official `codex login`, then switch accounts from a small native panel while keeping one shared Codex history.

![codex-switch demo](assets/demo.png)

> Unofficial community tool. Not affiliated with OpenAI.

## What It Does

- One-click Codex account switching on Windows
- Uses official Codex OAuth tokens imported from `codex login`
- Keeps `%USERPROFILE%\.codex\sessions` shared across accounts
- Optionally restarts Codex Desktop after switching so the new auth takes effect
- Shows 5h / 7d remaining quota per account
- Estimates used tokens from quota percentages
- Masks email names by default for screenshots and demos
- Supports OpenAI-compatible API key providers
- Includes an experimental local aggregate gateway

## Requirements

- Windows
- Node.js 18+
- OpenAI Codex CLI / Desktop installed and available as `codex`

## Install

```powershell
npm install
node .\codex-switch.js init
```

Optional desktop shortcut:

```powershell
npm run shortcut
```

You can also double-click:

```text
Codex Switch.cmd
```

## Add Accounts

Use official Codex OAuth login, then import the token into codex-switch:

```powershell
codex login
npm run import:codex-auth -- "account label"
```

Repeat once per account.

List accounts:

```powershell
node .\codex-switch.js list
```

## Start The Panel

```powershell
npm run panel
```

Select an account and click `Switch`. Codex Desktop caches auth in memory, so the panel can restart Codex Desktop after switching.

## Quota And Token Estimates

The panel shows remaining quota:

- `5h`: remaining 5-hour rolling quota
- `7d`: remaining weekly rolling quota

Used-token estimates are local approximations:

```text
5h Used = 16M * (100 - 5h remaining %) / 100
7d Used = 100M * (100 - 7d remaining %) / 100
```

These are not official billable token counts. Codex exposes rate-limit percentages, not exact per-account billing totals.

## Manual Switching

```powershell
node .\codex-switch.js use --provider openai-oauth --account openai-xxxxxxxx
```

Switching writes:

- `%USERPROFILE%\.codex\auth.json`
- `%USERPROFILE%\.codex\config.toml`

It does not move:

- `%USERPROFILE%\.codex\sessions`
- `%USERPROFILE%\.codex\archived_sessions`

## OpenAI-Compatible Providers

```powershell
node .\codex-switch.js add-provider --id openrouter --label "OpenRouter" --kind openai-compatible --base-url "https://openrouter.ai/api/v1"
node .\codex-switch.js add-account --provider openrouter --label "OpenRouter Main" --api-key "sk-or-..."
node .\codex-switch.js use --provider openrouter --account acct-xxxxxxxx
```

## Experimental Aggregate Gateway

```powershell
node .\codex-switch.js aggregate-on
node .\codex-switch.js gateway-start
```

This points Codex at:

```text
http://127.0.0.1:1456/v1
```

Gateway support is experimental.

## Config

codex-switch stores its own config in:

```text
%USERPROFILE%\.codex-switch\config.json
```

If an older `%USERPROFILE%\.codexbar-win\config.json` exists, it is copied forward automatically.

## Development

```powershell
npm run test:gateway
npm run smoke
npm run usage -- --json
node --check .\codex-switch.js
node --check .\usage.js
powershell -NoProfile -ExecutionPolicy Bypass -File .\codex-switch-panel.ps1 -NoLaunch
```

## Security

OAuth tokens stay local. See [SECURITY.md](SECURITY.md).
