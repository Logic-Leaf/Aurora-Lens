import * as vscode from 'vscode';
import { listProfiles } from './aws';
import { loadConnections, saveConnections } from './config';
import { DataApiClient } from './dataApi';
import { diagnose } from './diagnose';
import { Connection, connectionFieldErrors, ENVIRONMENTS } from './validate';
import { webviewHtml, webviewOptions } from './webview';

type Values = Partial<Record<keyof Connection, string>>;

const FIELDS: (keyof Connection)[] = ['name', 'environment', 'profile', 'region', 'clusterArn', 'secretArn', 'database'];

function pick(raw: unknown): Values {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Values = {};
  for (const f of FIELDS) {
    out[f] = typeof src[f] === 'string' ? (src[f] as string).trim() : '';
  }
  return out;
}

/** Add / edit a connection in a form, with live validation and a built-in connection test. */
export class ConnectionForm {
  private static panels = new Map<string, ConnectionForm>();
  private readonly panel: vscode.WebviewPanel;
  private testing = false;

  static open(extensionUri: vscode.Uri, existing: Connection | undefined, onSaved: (c: Connection) => void, preset?: Values): void {
    const key = existing?.name ?? '\u0000new';
    const open = ConnectionForm.panels.get(key);
    if (open) {
      open.panel.reveal();
      return;
    }
    ConnectionForm.panels.set(key, new ConnectionForm(extensionUri, existing, onSaved, key, preset));
  }

  private constructor(
    extensionUri: vscode.Uri,
    private readonly existing: Connection | undefined,
    private readonly onSaved: (c: Connection) => void,
    private readonly key: string,
    private readonly preset?: Values,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'auroralens.connection',
      existing ? `Edit · ${existing.name}` : 'New Connection',
      vscode.ViewColumn.Active,
      { ...webviewOptions(extensionUri), retainContextWhenHidden: true },
    );
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.svg');
    this.panel.webview.html = webviewHtml(this.panel.webview, extensionUri, 'Connection', ['connection.js'], ['connection.css']);
    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m));
    this.panel.onDidDispose(() => ConnectionForm.panels.delete(this.key));
  }

  private post(msg: object): void {
    void this.panel.webview.postMessage(msg);
  }

  private errorsFor(v: Values): Record<string, string> {
    const errors: Record<string, string> = { ...connectionFieldErrors(v) };
    const clash = loadConnections().connections.some((c) => c.name === v.name && c.name !== this.existing?.name);
    if (clash) {
      errors.name = 'Another connection already uses this name';
    }
    return errors;
  }

  private async onMessage(m: { type?: string; values?: unknown }): Promise<void> {
    if (m?.type === 'ready') {
      const values = this.existing ? pick(this.existing) : { environment: 'dev', ...this.preset };
      this.post({
        type: 'init',
        mode: this.existing ? 'edit' : 'new',
        values,
        profiles: listProfiles(),
        environments: ENVIRONMENTS,
      });
      return;
    }
    const v = pick(m?.values);
    if (m?.type === 'validate') {
      this.post({ type: 'errors', errors: this.errorsFor(v) });
    } else if (m?.type === 'test') {
      if (this.testing) {
        return;
      }
      this.testing = true;
      try {
        const conn = v as Connection;
        const valid = Object.keys(connectionFieldErrors(v)).length === 0;
        await diagnose(conn, valid ? new DataApiClient(conn) : undefined, (steps) => this.post({ type: 'steps', steps }));
      } finally {
        this.testing = false;
        this.post({ type: 'testDone' });
      }
    } else if (m?.type === 'save') {
      const errors = this.errorsFor(v);
      if (Object.keys(errors).length) {
        this.post({ type: 'errors', errors, focus: true });
        return;
      }
      const conn = v as Connection;
      const list = loadConnections().connections;
      const idx = this.existing ? list.findIndex((c) => c.name === this.existing!.name) : -1;
      if (idx >= 0) {
        list[idx] = conn;
      } else {
        list.push(conn);
      }
      await saveConnections(list);
      this.onSaved(conn);
      void vscode.window.showInformationMessage(`AuroraLens: ${this.existing ? 'updated' : 'added'} connection "${conn.name}".`);
      this.panel.dispose();
    } else if (m?.type === 'cancel') {
      this.panel.dispose();
    }
  }
}
