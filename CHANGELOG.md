# Changelog

## 0.4.0

### Added
- **Aurora MySQL (Preview).** The engine is detected automatically, so the same connection form works for PostgreSQL and MySQL. Supported for MySQL:
  - schema tree and table actions
  - View DDL (via `SHOW CREATE TABLE`)
  - the results grid
  - the cluster monitor (`information_schema` and `performance_schema`)
- **MySQL-aware safety.** Statements run in `START TRANSACTION READ ONLY` with `max_execution_time` and are always rolled back. The tokenizer understands backticks, `#` comments and backslash escapes, and blocks:
  - `SELECT … INTO` (including `INTO OUTFILE S3`)
  - `/*! … */` executable comments
  - Lambda and SageMaker functions
  - `GET_LOCK`, `LOAD_FILE`
- Generated scripts quote identifiers correctly for each engine.


## 0.3.0

### Added
- **Connection manager.** A Connections tree with environment colours and an active marker. Add, edit, duplicate and delete connections in a form with live validation and profile suggestions.
- **Test Connection.** Checks settings, then AWS sign-in, then the Data API, secret and database, then read-only transactions, then schema access, and explains the exact fix for the first failure.
- **Partition-aware schema explorer** with estimated row counts, primary-key and foreign-key markers, types, defaults and comments.
- **Table actions:**
  - Select Top 1000 and Count Rows
  - Script as SELECT, INSERT, UPDATE or DELETE
  - View DDL
  - Copy name
- **New results grid:**
  - smooth scrolling through thousands of rows
  - type-aware sorting
  - resizable columns, four densities and font zoom
  - keyboard navigation and a value inspector
  - copy as CSV, JSON or Markdown, and export to CSV or JSON
- **Query history** view (SQL text only), with re-run.
- **Cluster monitor:**
  - cluster facts
  - CloudWatch metrics
  - database health from PostgreSQL statistics (no extra IAM permissions)
- Plain-language explanations for common AWS and PostgreSQL errors.
- New original icon.


## 0.2.0

Security hardening before the public release. **Breaking:** there are no more built-in connections. See "Upgrading" below.

### Security
- Fixed: connection and SSO settings were written to `~/.aws/config` without validation, so a crafted value could add a `credential_process` line (command execution). All values are now validated, and AuroraLens appends only after you approve the exact text. Activation never writes files.
- All settings are now `application` scope, so a workspace's `.vscode/settings.json` cannot set them.
- Read-only mode is now enforced by the database (`SET TRANSACTION READ ONLY` + `statement_timeout`, always rolled back). The client-side check now uses a SQL tokenizer instead of regexes:
  - Strings that contain words like `'update'` no longer cause false blocks.
  - Side-effect functions such as `pg_terminate_backend`, `set_config`, `dblink*`, `aws_lambda.*` and `aws_s3.*` are blocked.
  - `--` inside string literals is no longer corrupted.
- The SQL AuroraLens runs is your text as written. The only additions are a `LIMIT` on its own line and removed trailing comments and semicolons.
- Metadata queries use Data API parameters instead of string concatenation.
- CSV export and copy escape spreadsheet formulas.
- Webviews use a strict CSP with a cryptographic nonce, and `unsafe-inline` styles are gone.
- Removed organisation-specific defaults (account IDs, ARNs, SSO start URL) from the package.

### Added
- `prod`, `staging` environments. Production is always read-only. QA and staging ask for confirmation before writes when read-only mode is off.
- Guided **Set up AWS IAM Identity Center** command and a welcome view for first run.
- Sign in with an existing profile (`aws sso login --profile`) when no SSO session is configured.
- Windows and Linux AWS CLI support. Sign-in can be cancelled.
- `auroralens.statementTimeoutSeconds` setting.
- Unit tests (`npm test`), Marketplace PNG icon and LICENSE.

### Upgrading from 0.1.x
Copy your team's `auroralens.ssoSession` and `auroralens.connections` into **user** settings. Workspace settings are ignored. Profiles that 0.1.x already created in `~/.aws/config` keep working.

New IAM permissions are needed for read-only mode: `rds-data:BeginTransaction` and `rds-data:RollbackTransaction`.
