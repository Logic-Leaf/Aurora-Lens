import * as vscode from 'vscode';
import { SsoSettings, ssoSettingsProblems } from './awsConfig';
import { connectionProblems } from './validate';
import type { Connection, Environment } from './validate';

export type { Connection, Environment };

// All AuroraLens settings are `application` scope (package.json), so a cloned repository's
// .vscode/settings.json cannot set them. `inspect().globalValue` makes that explicit in code too.
function userValue<T>(key: string): T | undefined {
  const info = vscode.workspace.getConfiguration('auroralens').inspect<T>(key);
  return info?.globalValue ?? info?.defaultValue;
}

export interface LoadedConnections {
  connections: Connection[];
  /** Human-readable reasons for each connection that was ignored. */
  problems: string[];
}

export function loadConnections(): LoadedConnections {
  const raw = userValue<unknown>('connections');
  const list = Array.isArray(raw) ? raw : [];
  const connections: Connection[] = [];
  const problems: string[] = [];
  const names = new Set<string>();
  list.forEach((item, idx) => {
    const c = (item && typeof item === 'object' ? item : {}) as Partial<Record<keyof Connection, unknown>>;
    const label = typeof c.name === 'string' && c.name ? `"${c.name.slice(0, 64)}"` : `#${idx + 1}`;
    const issues = connectionProblems(c);
    if (typeof c.name === 'string' && names.has(c.name)) {
      issues.push('duplicate name');
    }
    if (issues.length) {
      problems.push(`${label}: ${issues.join('; ')}`);
      return;
    }
    names.add(c.name as string);
    connections.push(c as Connection);
  });
  return { connections, problems };
}

/** Writes the full connection list to USER settings (never workspace). Callers validate first. */
export async function saveConnections(list: Connection[]): Promise<void> {
  const clean = list.map(({ name, environment, profile, region, clusterArn, secretArn, database }) => ({
    name,
    environment,
    profile,
    region,
    clusterArn,
    secretArn,
    database,
  }));
  await vscode.workspace.getConfiguration('auroralens').update('connections', clean, vscode.ConfigurationTarget.Global);
}

export function historyEnabled(): boolean {
  return userValue<boolean>('history.enabled') !== false;
}

/** The configured SSO session, or undefined when it is not set or invalid. */
export function ssoSettings(): SsoSettings | undefined {
  const s = userValue<SsoSettings | null>('ssoSession');
  return s && ssoSettingsProblems(s).length === 0 ? s : undefined;
}

/** Production is always read-only; the setting cannot turn that off. */
export function isReadOnly(env: Environment): boolean {
  return env === 'prod' || userValue<boolean>('readOnly') !== false;
}

export function maxRows(): number {
  const v = userValue<number>('maxRows');
  return typeof v === 'number' && v >= 1 ? Math.min(Math.floor(v), 10000) : 500;
}

export function statementTimeoutSeconds(): number {
  const v = userValue<number>('statementTimeoutSeconds');
  return typeof v === 'number' && v >= 1 ? Math.min(Math.floor(v), 300) : 30;
}
