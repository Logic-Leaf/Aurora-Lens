# Security Policy

AuroraLens handles access to production databases, so security reports get priority.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report them privately through GitHub: on the [repository](https://github.com/Logic-Leaf/Aurora-Lens), open the **Security** tab and choose **Report a vulnerability**.

Please include:
- the AuroraLens version and VS Code version
- steps to reproduce
- the impact you expect

You will get an acknowledgement within 5 working days. Fixes for confirmed issues are released as soon as practical and credited in the changelog unless you prefer otherwise.

## Supported versions

Only the latest released version receives security fixes.

## Security design

- **No stored credentials.** AuroraLens never stores AWS keys, tokens or database passwords. It uses the AWS SDK credential chain for your profile, and the RDS Data API reads database secrets inside AWS.
- **Database-enforced read-only mode.** Statements run in a `READ ONLY` transaction with a `statement_timeout` and are always rolled back. Production connections are always read-only.
- **No workspace influence.** All settings are `application` scope, so a cloned repository cannot change connections, sign-in or read-only behaviour.
- **No silent writes.** Files outside the extension, such as `~/.aws/config`, are changed only after the user approves the exact text, and every written value is validated first.
- **Webviews** use a strict Content Security Policy with per-load nonces and no remote content.
- **No telemetry.** The extension only talks to AWS endpoints in the user's own account.
