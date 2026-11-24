import * as vscode from 'vscode';

/** One executed statement. Only the SQL text and metadata are kept, never result data. */
export interface HistoryEntry {
  id: string;
  sql: string;
  connection: string;
  env: string;
  at: number;
  ms: number;
  rows?: number;
  error?: string;
}

const KEY = 'auroralens.history';
const MAX = 200;

export class HistoryStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly state: vscode.Memento) {}

  all(): HistoryEntry[] {
    return this.state.get<HistoryEntry[]>(KEY, []);
  }

  async add(e: Omit<HistoryEntry, 'id'>): Promise<void> {
    const entry = { ...e, id: `${e.at}-${Math.random().toString(36).slice(2, 8)}` };
    await this.state.update(KEY, [entry, ...this.all()].slice(0, MAX));
    this.emitter.fire();
  }

  async remove(id: string): Promise<void> {
    await this.state.update(
      KEY,
      this.all().filter((e) => e.id !== id),
    );
    this.emitter.fire();
  }

  async clear(): Promise<void> {
    await this.state.update(KEY, []);
    this.emitter.fire();
  }
}

export class HistoryNode extends vscode.TreeItem {
  constructor(readonly entry: HistoryEntry) {
    super(firstLine(entry.sql), vscode.TreeItemCollapsibleState.None);
    this.id = entry.id;
    this.contextValue = 'history';
    this.iconPath = new vscode.ThemeIcon(entry.error ? 'error' : 'history', entry.error ? new vscode.ThemeColor('errorForeground') : undefined);
    const outcome = entry.error ? 'failed' : `${entry.rows ?? 0} rows`;
    this.description = `${entry.env} · ${entry.connection} · ${outcome} · ${ago(entry.at)}`;
    const md = new vscode.MarkdownString();
    md.appendCodeblock(entry.sql, 'sql');
    md.appendMarkdown(`\n${entry.env} · ${entry.connection} · ${new Date(entry.at).toLocaleString()} · ${entry.ms} ms · ${outcome}`);
    if (entry.error) {
      md.appendMarkdown(`\n\n${entry.error.replace(/[\\`*_[\]<>]/g, '\\$&')}`);
    }
    this.tooltip = md;
    this.command = { command: 'auroralens.history.open', title: 'Open', arguments: [this] };
  }
}

export class HistoryTree implements vscode.TreeDataProvider<HistoryNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly store: HistoryStore) {
    store.onDidChange(() => this.emitter.fire());
  }

  getTreeItem(node: HistoryNode): vscode.TreeItem {
    return node;
  }

  getChildren(): HistoryNode[] {
    return this.store.all().map((e) => new HistoryNode(e));
  }
}

function firstLine(sql: string): string {
  const line = sql.replace(/\s+/g, ' ').trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function ago(at: number): string {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) {
    return 'just now';
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m ago`;
  }
  if (s < 86400) {
    return `${Math.floor(s / 3600)}h ago`;
  }
  return `${Math.floor(s / 86400)}d ago`;
}
