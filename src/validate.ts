// Pure validators (no vscode import) so they can be unit-tested.
// Every value that reaches a file, a command line or an AWS call passes through here.

const PARTITION = 'aws(?:-cn|-us-gov|-iso|-iso-b)?';
const REGION_SRC = '[a-z]{2}(?:-[a-z]+)+-\\d{1,2}';

const REGION = new RegExp(`^${REGION_SRC}$`);
/** AWS profile / sso-session names: conservative subset of what the CLI accepts. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.@+=-]{0,63}$/;
/** IAM role names (Identity Center permission-set names follow the same rules). */
const ROLE = /^[A-Za-z0-9_+=,.@-]{1,64}$/;
const ACCOUNT = /^\d{12}$/;
const CLUSTER_ARN = new RegExp(`^arn:${PARTITION}:rds:(${REGION_SRC}):(\\d{12}):cluster:[A-Za-z][A-Za-z0-9-]{0,62}$`);
const SECRET_ARN = new RegExp(`^arn:${PARTITION}:secretsmanager:(${REGION_SRC}):(\\d{12}):secret:[A-Za-z0-9/_+=.@!-]{1,512}$`);
const DATABASE = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
/** Printable ASCII without spaces: rules out newlines, '[' tricks and control characters in INI values. */
const INI_SAFE = /^[\x21-\x5a\x5c\x5e-\x7e]+$/;

export const ENVIRONMENTS = ['dev', 'qa', 'staging', 'prod'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export function isRegion(v: unknown): v is string {
  return typeof v === 'string' && REGION.test(v);
}

export function isProfileName(v: unknown): v is string {
  return typeof v === 'string' && NAME.test(v);
}

export function isRoleName(v: unknown): v is string {
  return typeof v === 'string' && ROLE.test(v);
}

export function isAccountId(v: unknown): v is string {
  return typeof v === 'string' && ACCOUNT.test(v);
}

export function isDatabaseName(v: unknown): v is string {
  return typeof v === 'string' && DATABASE.test(v);
}

export function parseClusterArn(v: unknown): { region: string; account: string } | undefined {
  const m = typeof v === 'string' ? CLUSTER_ARN.exec(v) : null;
  return m ? { region: m[1], account: m[2] } : undefined;
}

export function parseSecretArn(v: unknown): { region: string; account: string } | undefined {
  const m = typeof v === 'string' ? SECRET_ARN.exec(v) : null;
  return m ? { region: m[1], account: m[2] } : undefined;
}

/**
 * IAM Identity Center start URLs: https://<id>.awsapps.com/start (or .cn) and
 * https://identitycenter.amazonaws.com/ssoins-<id> (optionally regional).
 */
export function isSsoStartUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 256 || !INI_SAFE.test(v)) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    return false;
  }
  const host = url.hostname;
  if (/^[a-z0-9-]+\.awsapps\.(com|cn)$/.test(host) || host === 'start.us-gov-home.awsapps.com') {
    return url.pathname.startsWith('/start');
  }
  if (/^identitycenter(\.[a-z0-9-]+)?\.amazonaws\.com$/.test(host)) {
    return /^\/ssoins-[0-9a-f]{16}\/?$/.test(url.pathname);
  }
  return false;
}

/** Last-line defence for anything written to an INI file. */
export function assertIniSafe(label: string, v: string): void {
  if (!INI_SAFE.test(v)) {
    throw new Error(`Refusing to write ${label}: it contains characters that are not allowed in ~/.aws/config.`);
  }
}

export interface Connection {
  name: string;
  environment: Environment;
  profile: string;
  region: string;
  clusterArn: string;
  secretArn: string;
  database: string;
}

/** Per-field problems, used by the connection form; empty means the connection is usable. */
export function connectionFieldErrors(c: Partial<Record<keyof Connection, unknown>>): Partial<Record<keyof Connection, string>> {
  const e: Partial<Record<keyof Connection, string>> = {};
  if (typeof c.name !== 'string' || !c.name.trim() || c.name.length > 64) {
    e.name = 'Required, up to 64 characters';
  }
  if (!ENVIRONMENTS.includes(c.environment as Environment)) {
    e.environment = `Choose one of ${ENVIRONMENTS.join(', ')}`;
  }
  if (!isProfileName(c.profile)) {
    e.profile = 'Not a valid AWS profile name';
  }
  if (!isRegion(c.region)) {
    e.region = 'Not a valid AWS Region code, e.g. us-east-1';
  }
  const cluster = parseClusterArn(c.clusterArn);
  if (!cluster) {
    e.clusterArn = 'Expected arn:aws:rds:<region>:<account>:cluster:<name>';
  } else if (isRegion(c.region) && cluster.region !== c.region) {
    e.clusterArn = `Cluster is in ${cluster.region}, but the connection Region is ${c.region}`;
  }
  const secret = parseSecretArn(c.secretArn);
  if (!secret) {
    e.secretArn = 'Expected arn:aws:secretsmanager:<region>:<account>:secret:<name>';
  } else if (cluster && (cluster.region !== secret.region || cluster.account !== secret.account)) {
    e.secretArn = 'Must be in the same account and Region as the cluster';
  }
  if (!isDatabaseName(c.database)) {
    e.database = 'Not a valid PostgreSQL database name';
  }
  return e;
}

/** Returns a list of problems; empty means the connection is usable. */
export function connectionProblems(c: Partial<Record<keyof Connection, unknown>>): string[] {
  return Object.entries(connectionFieldErrors(c)).map(([field, msg]) => `${field}: ${msg}`);
}
