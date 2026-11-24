// Turns AWS / PostgreSQL errors into "what happened + how to fix it" (no vscode import, unit-tested).

export interface Explanation {
  title: string;
  fix: string;
  /** True when signing in again is the fix. */
  auth?: boolean;
}

interface Rule {
  test: RegExp;
  names?: RegExp;
  explain: (ctx: ExplainContext) => Explanation;
}

export interface ExplainContext {
  clusterArn?: string;
  secretArn?: string;
  database?: string;
  profile?: string;
}

const RULES: Rule[] = [
  {
    test: /token (has )?expired|expired token|sso session|refresh failed|unable to load sso token|could not load credentials|security token included in the request is (invalid|expired)/i,
    names: /ExpiredToken|UnrecognizedClient|InvalidClientTokenId|CredentialsProviderError|TokenProviderError|SSOTokenProviderFailure/,
    explain: (c) => ({
      title: 'Your AWS session has expired or is missing',
      fix: `Sign in again (AuroraLens: Sign in). Profile: ${c.profile ?? 'unknown'}.`,
      auth: true,
    }),
  },
  {
    test: /profile .*could not be found|could not resolve credentials using profile/i,
    explain: (c) => ({
      title: `AWS profile "${c.profile ?? '?'}" does not exist`,
      fix: 'Run Sign in to create it from your IAM Identity Center settings, or pick an existing profile from ~/.aws/config.',
      auth: true,
    }),
  },
  {
    test: /http ?endpoint is not enabled|data api is not enabled|enable-http-endpoint/i,
    explain: (c) => ({
      title: 'The RDS Data API is not enabled on this cluster',
      fix: `Ask an administrator to run: aws rds enable-http-endpoint --resource-arn ${c.clusterArn ?? '<cluster-arn>'}`,
    }),
  },
  {
    test: /DatabaseResumingException|is resuming after being auto-paused|resuming/i,
    names: /DatabaseResumingException/,
    explain: () => ({
      title: 'The cluster is resuming from auto-pause',
      fix: 'Aurora Serverless is waking up. Try again in 15–30 seconds.',
    }),
  },
  {
    test: /not authorized to perform:? rds-data:(\w+)/i,
    explain: () => ({
      title: 'Missing IAM permission for the Data API',
      fix: 'Your role needs rds-data:ExecuteStatement, rds-data:BeginTransaction and rds-data:RollbackTransaction on this cluster.',
    }),
  },
  {
    test: /not authorized to perform:? (rds:Describe\w+|cloudwatch:\w+)/i,
    explain: () => ({
      title: 'Your role cannot read cluster details or metrics',
      fix: 'Monitoring needs rds:DescribeDBClusters, rds:DescribeDBInstances and cloudwatch:GetMetricData. Database health below works without them.',
    }),
  },
  {
    test: /secretsmanager:GetSecretValue|secrets manager can't find|secret.*(not found|marked for deletion)|AccessDenied.*secret/i,
    explain: (c) => ({
      title: 'The database secret cannot be read',
      fix: `Check the secret ARN and that your role has secretsmanager:GetSecretValue on ${c.secretArn ?? 'it'} (and kms:Decrypt if it uses a customer key).`,
    }),
  },
  {
    test: /password authentication failed|authentication failed for user/i,
    explain: () => ({
      title: 'The database rejected the username or password in the secret',
      fix: 'The secret may have been rotated or point at another cluster. Check its username/password.',
    }),
  },
  {
    test: /database "?([^"\s]+)"? does not exist/i,
    explain: (c) => ({
      title: `Database "${c.database ?? '?'}" does not exist on this cluster`,
      fix: 'Check the database name in the connection settings (it is case-sensitive).',
    }),
  },
  {
    test: /DBClusterNotFound|cluster.*not found|resource.*not found|Invalid cluster arn|ResourceNotFound/i,
    explain: () => ({
      title: 'The cluster was not found',
      fix: 'Check the cluster ARN and that the connection Region matches the cluster.',
    }),
  },
  {
    test: /permission denied for (table|schema|relation|sequence|function) ([^\s]+)/i,
    explain: () => ({
      title: 'The database user lacks privileges on that object',
      fix: 'Ask the DBA to GRANT SELECT (or USAGE on the schema) to the user in the secret.',
    }),
  },
  {
    test: /read-only transaction/i,
    explain: () => ({
      title: 'Blocked by read-only mode',
      fix: 'The database refused to change data because this connection is read-only. That is expected.',
    }),
  },
  {
    test: /statement timeout|canceling statement due to statement timeout|StatementTimeoutException/i,
    names: /StatementTimeoutException/,
    explain: () => ({
      title: 'The query took too long',
      fix: 'Add filters or a LIMIT, or raise auroralens.statementTimeoutSeconds (the Data API caps a call at 45 s).',
    }),
  },
  {
    test: /response size|exceeds.*(1 ?MB|limit)|Database returned more than the allowed response size/i,
    explain: () => ({
      title: 'The result is larger than the Data API allows (about 1 MB)',
      fix: 'Select fewer columns or rows, or lower auroralens.maxRows.',
    }),
  },
  {
    test: /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|socket hang up|getaddrinfo|self[- ]signed certificate|unable to get local issuer/i,
    explain: () => ({
      title: 'AuroraLens could not reach AWS',
      fix: 'Check your internet connection, proxy (HTTPS_PROXY) or corporate certificate settings.',
    }),
  },
];

export function explainError(err: unknown, ctx: ExplainContext = {}): Explanation {
  const e = err as { name?: unknown; message?: unknown } | undefined;
  const name = typeof e?.name === 'string' ? e.name : '';
  const message = typeof e?.message === 'string' ? e.message : String(err);
  for (const rule of RULES) {
    if ((rule.names && rule.names.test(name)) || rule.test.test(message)) {
      return rule.explain(ctx);
    }
  }
  return { title: 'The request failed', fix: message };
}

export function isAuthError(err: unknown): boolean {
  return explainError(err).auth === true;
}
