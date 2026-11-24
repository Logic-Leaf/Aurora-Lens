# Contributing to AuroraLens

Thank you for helping improve AuroraLens. Bug reports, ideas and pull requests are all welcome.

## Reporting bugs and ideas

- **Bugs:** open a [bug report](https://github.com/Logic-Leaf/auroralens/issues/new?template=bug_report.yml).
- **Ideas:** open a [feature request](https://github.com/Logic-Leaf/auroralens/issues/new?template=feature_request.yml).
- **Security issues:** do **not** open a public issue. Follow [SECURITY.md](SECURITY.md).

Never paste account IDs, ARNs, endpoints, query results or credentials into an issue.

## Development setup

Requirements: Node.js 20+, VS Code 1.85+, and AWS CLI v2 (for testing sign-in).

```sh
git clone https://github.com/Logic-Leaf/auroralens.git
cd auroralens
npm ci
npm run compile   # type-check and bundle
npm test          # unit tests
```

Press **F5** in VS Code to launch an Extension Development Host with AuroraLens loaded.

## Project layout

| Path | Purpose |
|---|---|
| `src/extension.ts` | Activation, commands and wiring |
| `src/dataApi.ts` | RDS Data API client, read-only transactions, engine detection |
| `src/guards.ts` | Dialect-aware SQL tokenizer, read-only checks, row limits |
| `src/metadata.ts` | Catalog and health queries for PostgreSQL and MySQL |
| `src/sqlgen.ts` | Script and DDL generation |
| `src/explain.ts` | Plain-language explanations for AWS and database errors |
| `src/tree.ts`, `src/history.ts` | Sidebar views |
| `src/*Panel.ts`, `src/connectionForm.ts` | Webview hosts |
| `media/` | Webview UI (plain HTML, CSS and JS; no remote content) |
| `src/test/` | Unit tests (`node:test`) |

## Pull requests

1. Keep each pull request focused on one change.
2. Add or update tests for behaviour changes. `npm test` must pass.
3. Update `CHANGELOG.md` and the README when user-facing behaviour changes.
4. Changes to security-sensitive code get extra review:
   - `guards.ts`
   - `dataApi.ts` (read-only enforcement)
   - `validate.ts` and `awsConfig.ts` (input validation and `~/.aws/config` writes)
   - the webview CSP in `webview.ts`

## Principles

- **Never store secrets.** No AWS keys, tokens or database passwords on disk.
- **Safe by default.** Read-only is enforced by the database. Production is always read-only.
- **No telemetry.** AuroraLens only talks to AWS endpoints in the user's own account.
- **No surprises.** Never modify user files without showing the exact change and asking first.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE) and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).
