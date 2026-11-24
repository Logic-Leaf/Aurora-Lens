import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseSections, planProfiles, SsoSettings } from './awsConfig';
import type { Connection } from './config';
import { isProfileName, isRegion, isRoleName, isSsoStartUrl } from './validate';

export const output = vscode.window.createOutputChannel('AuroraLens');

function configPath(): string {
  return process.env.AWS_CONFIG_FILE || path.join(os.homedir(), '.aws', 'config');
}

/**
 * Appends missing sso-session / profile blocks to the AWS config file, but only after the user
 * has seen the exact text and approved it. Existing entries are never edited.
 * Resolves true when nothing was missing or the user approved the addition.
 */
export async function ensureProfilesWithConsent(conns: Connection[], sso: SsoSettings): Promise<boolean> {
  const file = configPath();
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const plan = planProfiles(conns, sso, existing);
  if (!plan.addition) {
    return true;
  }
  const what = [plan.addsSession ? `sso-session "${sso.name}"` : '', ...plan.profiles.map((p) => `profile "${p}"`)].filter(Boolean);
  const approve = 'Add to AWS config';
  const pick = await vscode.window.showWarningMessage(
    `AuroraLens needs to add ${what.length} entr${what.length === 1 ? 'y' : 'ies'} to ${file}`,
    {
      modal: true,
      detail: `The lines below will be appended to the end of the file. Nothing that is already there is changed.\n${plan.addition}`,
    },
    approve,
  );
  if (pick !== approve) {
    output.appendLine(`AWS config not changed (declined). To add the entries yourself, append:\n${plan.addition}`);
    return false;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, plan.addition, { mode: 0o600 });
  output.appendLine(`Appended to ${file}: ${what.join(', ')}`);
  return true;
}

/** Guided setup for IAM Identity Center; saved to user settings (never workspace settings). */
export async function promptSsoSettings(current?: SsoSettings): Promise<SsoSettings | undefined> {
  const startUrl = await vscode.window.showInputBox({
    title: 'Set up AWS IAM Identity Center (1/3)',
    prompt: 'Your AWS access portal URL. Ask your AWS administrator if you do not know it.',
    placeHolder: 'https://my-company.awsapps.com/start',
    value: current?.startUrl,
    ignoreFocusOut: true,
    validateInput: (v) =>
      isSsoStartUrl(v.trim()) ? undefined : 'Enter an https://<id>.awsapps.com/start or https://identitycenter.amazonaws.com/ssoins-… URL',
  });
  if (!startUrl) {
    return undefined;
  }
  const region = await vscode.window.showInputBox({
    title: 'Set up AWS IAM Identity Center (2/3)',
    prompt: 'AWS Region where IAM Identity Center is enabled',
    value: current?.region ?? 'us-east-1',
    ignoreFocusOut: true,
    validateInput: (v) => (isRegion(v.trim()) ? undefined : 'Enter a Region code such as us-east-1'),
  });
  if (!region) {
    return undefined;
  }
  const roleName = await vscode.window.showInputBox({
    title: 'Set up AWS IAM Identity Center (3/3)',
    prompt: 'Permission set (role) name to use for database access',
    placeHolder: 'e.g. DeveloperAccess',
    value: current?.roleName,
    ignoreFocusOut: true,
    validateInput: (v) => (isRoleName(v.trim()) ? undefined : 'Letters, digits and + = , . @ _ - only (max 64)'),
  });
  if (!roleName) {
    return undefined;
  }
  const settings: SsoSettings = {
    name: current?.name && isProfileName(current.name) ? current.name : 'auroralens',
    startUrl: startUrl.trim(),
    region: region.trim(),
    roleName: roleName.trim(),
  };
  await vscode.workspace.getConfiguration('auroralens').update('ssoSession', settings, vscode.ConfigurationTarget.Global);
  return settings;
}

function awsBinary(): string {
  const candidates =
    process.platform === 'win32'
      ? [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Amazon', 'AWSCLIV2', 'aws.exe')]
      : process.platform === 'darwin'
        ? ['/opt/homebrew/bin/aws', '/usr/local/bin/aws']
        : ['/usr/local/bin/aws', '/usr/bin/aws'];
  return candidates.find((p) => fs.existsSync(p)) ?? 'aws';
}

export type LoginTarget = { ssoSession: string } | { profile: string };

/** Runs `aws sso login` for an SSO session (covers every profile on it) or a single profile. */
export function login(target: LoginTarget, cancel?: vscode.CancellationToken): Promise<boolean> {
  const [flag, value] = 'ssoSession' in target ? ['--sso-session', target.ssoSession] : ['--profile', target.profile];
  if (!isProfileName(value)) {
    output.appendLine(`Refusing to run aws sso login: invalid name "${value}".`);
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    output.show(true);
    output.appendLine(`> aws sso login ${flag} ${value}`);
    const env = { ...process.env };
    if (process.platform !== 'win32') {
      env.PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(path.delimiter);
    }
    const proc = spawn(awsBinary(), ['sso', 'login', flag, value], { env, shell: false });
    cancel?.onCancellationRequested(() => proc.kill());
    proc.stdout.on('data', (d) => output.append(String(d)));
    proc.stderr.on('data', (d) => output.append(String(d)));
    proc.on('error', (e) => {
      const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
      output.appendLine(
        missing
          ? 'AWS CLI v2 was not found. Install it from https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html and try again.'
          : `Could not run the AWS CLI: ${e.message}`,
      );
      resolve(false);
    });
    proc.on('close', (code) => resolve(code === 0));
  });
}

/** Profile names from the AWS config and credentials files (read-only; used for suggestions). */
export function listProfiles(): string[] {
  const files = [configPath(), process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(os.homedir(), '.aws', 'credentials')];
  const names = new Set<string>();
  for (const f of files) {
    try {
      const text = fs.readFileSync(f, 'utf8');
      parseSections(text).profiles.forEach((p) => names.add(p));
      // The credentials file uses bare [name] headers.
      for (const m of text.matchAll(/^\s*\[\s*([^\]\s]+)\s*\]\s*$/gm)) {
        if (f !== configPath()) {
          names.add(m[1]);
        }
      }
    } catch {
      // missing file is fine
    }
  }
  return [...names].filter(isProfileName).sort();
}
