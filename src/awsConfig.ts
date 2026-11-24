// Pure planning of ~/.aws/config additions (no vscode import, unit-tested).
// AuroraLens never edits existing entries; it only proposes new blocks, and the
// caller must show them to the user and get consent before appending.

import { assertIniSafe, Connection, isProfileName, isRegion, isRoleName, isSsoStartUrl, parseClusterArn } from './validate';

export interface SsoSettings {
  name: string;
  startUrl: string;
  region: string;
  roleName: string;
}

export interface ConfigPlan {
  /** Exact text to append; empty when nothing is missing. */
  addition: string;
  profiles: string[];
  addsSession: boolean;
}

export function ssoSettingsProblems(s: Partial<Record<keyof SsoSettings, unknown>> | undefined | null): string[] {
  if (!s) {
    return ['AWS SSO is not configured'];
  }
  const p: string[] = [];
  if (!isProfileName(s.name)) {
    p.push('name is not a valid sso-session name');
  }
  if (!isSsoStartUrl(s.startUrl)) {
    p.push('startUrl must be an IAM Identity Center start URL (https://<id>.awsapps.com/start)');
  }
  if (!isRegion(s.region)) {
    p.push('region is not a valid AWS region');
  }
  if (!isRoleName(s.roleName)) {
    p.push('roleName is not a valid permission-set name');
  }
  return p;
}

/** Section names present in an INI file: "profile x" → profile x, "sso-session y" → session y. */
export function parseSections(text: string): { profiles: Set<string>; sessions: Set<string> } {
  const profiles = new Set<string>();
  const sessions = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*\[\s*([^\]]+?)\s*\]\s*$/.exec(line);
    if (!m) {
      continue;
    }
    const header = m[1];
    if (header === 'default') {
      profiles.add('default');
    } else if (header.startsWith('profile ')) {
      profiles.add(header.slice(8).trim());
    } else if (header.startsWith('sso-session ')) {
      sessions.add(header.slice(12).trim());
    }
  }
  return { profiles, sessions };
}

export function planProfiles(conns: Connection[], sso: SsoSettings, existing: string): ConfigPlan {
  const problems = ssoSettingsProblems(sso);
  if (problems.length) {
    throw new Error(`AWS SSO settings are invalid: ${problems.join('; ')}`);
  }
  const { profiles, sessions } = parseSections(existing);
  const lines: string[] = [];
  const created: string[] = [];
  const addsSession = !sessions.has(sso.name);

  const block = (header: string, entries: [string, string][]) => {
    assertIniSafe('section name', header.replace(/ /g, '_'));
    lines.push('', `[${header}]`);
    for (const [k, v] of entries) {
      assertIniSafe(k, v);
      lines.push(`${k} = ${v}`);
    }
  };

  if (addsSession) {
    block(`sso-session ${sso.name}`, [
      ['sso_start_url', sso.startUrl],
      ['sso_region', sso.region],
      ['sso_registration_scopes', 'sso:account:access'],
    ]);
  }
  for (const c of conns) {
    if (profiles.has(c.profile) || created.includes(c.profile)) {
      continue;
    }
    const arn = parseClusterArn(c.clusterArn);
    if (!arn || !isProfileName(c.profile) || !isRegion(c.region)) {
      continue; // invalid connections never reach the file
    }
    block(`profile ${c.profile}`, [
      ['sso_session', sso.name],
      ['sso_account_id', arn.account],
      ['sso_role_name', sso.roleName],
      ['region', c.region],
    ]);
    created.push(c.profile);
  }
  return { addition: lines.length ? `${lines.join('\n')}\n` : '', profiles: created, addsSession };
}
