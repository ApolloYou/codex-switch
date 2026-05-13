# Security

codex-switch stores OAuth tokens locally in:

- `%USERPROFILE%\.codex-switch\config.json`
- `%USERPROFILE%\.codex\auth.json`

Do not commit these files. They are outside the repository by default.

The project does not operate a hosted server and does not upload tokens. Usage polling is performed locally through the installed `codex app-server` command with temporary per-account `CODEX_HOME` folders under `.tmp-usage/`, which is ignored by Git.
