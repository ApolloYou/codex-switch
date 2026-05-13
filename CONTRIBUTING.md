# Contributing

Thanks for taking a look at codex-switch.

## Local Setup

```powershell
npm install
npm run panel
```

## Checks

Run these before opening a pull request:

```powershell
node --check .\codex-switch.js
node --check .\usage.js
node --check .\import-codex-auth.js
npm run smoke
npm run test:gateway
```

`npm run usage -- --json` requires locally imported Codex OAuth accounts.

## Security

Do not include real OAuth tokens, `%USERPROFILE%\.codex`, `%USERPROFILE%\.codex-switch`, `.tmp-*`, or `.tmp-usage` data in issues or pull requests.

