import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { QueryResult } from './dataApi';
import { Explanation } from './explain';
import { toCsv, toJson, toMarkdown } from './formats';
import { webviewHtml, webviewOptions } from './webview';

export interface ResultMeta {
  env: string;
  connection: string;
  elapsedMs: number;
  sql: string;
  readOnly: boolean;
  truncated: boolean;
  maxRows: number;
}

interface Prefs {
  density: string;
  fontSize: number;
}

const PREFS_KEY = 'auroralens.results.prefs';
type Pending = { type: 'result'; result: QueryResult; meta: ResultMeta } | { type: 'error' | 'running'; payload: object };

/** Results grid in the bottom panel (next to Terminal). */
export class ResultsView implements vscode.WebviewViewProvider {
  static readonly id = 'auroralens.results';
  private view?: vscode.WebviewView;
  private ready = false;
  private pending?: Pending;
  private last?: QueryResult;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly state: vscode.Memento,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    view.webview.options = webviewOptions(this.extensionUri);
    view.webview.html = webviewHtml(view.webview, this.extensionUri, 'AuroraLens Results', ['results.js'], ['results.css']);
    view.webview.onDidReceiveMessage((m) => void this.onMessage(m));
    view.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
    });
  }

  private async onMessage(m: { type?: string; format?: string; indices?: unknown; text?: unknown; prefs?: Prefs }): Promise<void> {
    if (m?.type === 'ready') {
      this.ready = true;
      this.flush();
    } else if (m?.type === 'prefs' && m.prefs) {
      await this.state.update(PREFS_KEY, { density: String(m.prefs.density), fontSize: Number(m.prefs.fontSize) });
    } else if (m?.type === 'copyText' && typeof m.text === 'string') {
      await vscode.env.clipboard.writeText(m.text);
    } else if ((m?.type === 'copy' || m?.type === 'export') && this.last) {
      const rows = this.rowsFor(m.indices);
      const format = m.format === 'json' ? 'json' : m.format === 'markdown' ? 'markdown' : 'csv';
      const text = format === 'json' ? toJson(this.last.columns, rows) : format === 'markdown' ? toMarkdown(this.last.columns, rows) : toCsv(this.last.columns, rows);
      if (m.type === 'copy') {
        await vscode.env.clipboard.writeText(text);
      } else {
        await this.saveFile(text, format === 'json' ? 'json' : 'csv', rows.length);
      }
    }
  }

  /** Rows in the grid's current (filtered / sorted) order; indices come from the webview, so validate them. */
  private rowsFor(indices: unknown): unknown[][] {
    const all = this.last?.rows ?? [];
    if (!Array.isArray(indices)) {
      return all;
    }
    return indices.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < all.length).map((i) => all[i]);
  }

  private async saveFile(text: string, ext: 'csv' | 'json', count: number): Promise<void> {
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), 'AuroraLens', 'exports', `result-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`)),
      filters: ext === 'csv' ? { CSV: ['csv'] } : { JSON: ['json'] },
    });
    if (!target) {
      return;
    }
    fs.mkdirSync(path.dirname(target.fsPath), { recursive: true });
    fs.writeFileSync(target.fsPath, text);
    void vscode.window.showInformationMessage(`AuroraLens: saved ${count} rows to ${path.basename(target.fsPath)}`, 'Open').then((pick) => {
      if (pick) {
        void vscode.commands.executeCommand('vscode.open', target);
      }
    });
  }

  private flush(): void {
    if (!this.view || !this.ready || !this.pending) {
      return;
    }
    const p = this.pending;
    if (p.type === 'result') {
      void this.view.webview.postMessage({
        type: 'result',
        columns: p.result.columns,
        types: p.result.types,
        rows: p.result.rows,
        meta: p.meta,
        prefs: this.state.get<Prefs>(PREFS_KEY),
      });
      this.view.description = `${p.meta.env} · ${p.result.rows.length.toLocaleString()} rows`;
    } else {
      void this.view.webview.postMessage({ type: p.type, ...p.payload });
    }
  }

  private async reveal(): Promise<void> {
    if (!this.view) {
      await vscode.commands.executeCommand(`${ResultsView.id}.focus`);
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    } else {
      this.view.show(true);
    }
  }

  async running(meta: Pick<ResultMeta, 'env' | 'connection'>): Promise<void> {
    this.pending = { type: 'running', payload: { meta } };
    await this.reveal();
    this.flush();
  }

  async show(result: QueryResult, meta: ResultMeta): Promise<void> {
    this.last = result;
    this.pending = { type: 'result', result, meta };
    await this.reveal();
    this.flush();
  }

  async showError(why: Explanation, message: string, meta: Pick<ResultMeta, 'env' | 'connection'>): Promise<void> {
    this.pending = { type: 'error', payload: { title: why.title, fix: why.fix, message, meta } };
    await this.reveal();
    this.flush();
  }

  async exportLast(format: 'csv' | 'json'): Promise<void> {
    if (!this.last) {
      void vscode.window.showInformationMessage('AuroraLens: run a query first.');
      return;
    }
    const text = format === 'json' ? toJson(this.last.columns, this.last.rows) : toCsv(this.last.columns, this.last.rows);
    await this.saveFile(text, format, this.last.rows.length);
  }
}
