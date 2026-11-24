import * as vscode from 'vscode';
import type { Connection } from './config';
import { isReadOnly } from './config';
import { DataApiClient, Partition, Relation } from './dataApi';
import { explainError } from './explain';
import { formatCount } from './formats';
import { ColumnInfo } from './sqlgen';
import { parseClusterArn } from './validate';

const ENV_COLOR: Record<string, string> = {
  dev: 'charts.green',
  qa: 'charts.yellow',
  staging: 'charts.orange',
  prod: 'charts.red',
};

const KIND: Record<string, { icon: string; label: string; context: string }> = {
  r: { icon: 'table', label: 'table', context: 'table' },
  p: { icon: 'layers', label: 'partitioned table', context: 'table' },
  v: { icon: 'eye', label: 'view', context: 'view' },
  m: { icon: 'symbol-structure', label: 'materialized view', context: 'view' },
  f: { icon: 'link-external', label: 'foreign table', context: 'table' },
  // MySQL partitions are part of their table, not separately queryable.
  x: { icon: 'symbol-array', label: 'partition', context: 'partition' },
};

export class ClientPool {
  private readonly clients = new Map<string, DataApiClient>();

  get(conn: Connection): DataApiClient {
    const key = JSON.stringify(conn);
    let c = this.clients.get(key);
    if (!c) {
      c = new DataApiClient(conn);
      this.clients.set(key, c);
    }
    return c;
  }

  clear(): void {
    this.clients.clear();
  }
}

export class ConnectionNode extends vscode.TreeItem {
  readonly kind = 'connection';
  constructor(readonly conn: Connection, active: boolean) {
    super(conn.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `c:${conn.name}`;
    this.contextValue = active ? 'connection.active' : 'connection';
    this.iconPath = new vscode.ThemeIcon(active ? 'database' : 'circle-large-outline', new vscode.ThemeColor(ENV_COLOR[conn.environment]));
    const mode = isReadOnly(conn.environment) ? 'read-only' : 'read-write';
    this.description = `${conn.environment.toUpperCase()} · ${conn.database}${active ? ' · active' : ''}`;
    const arn = parseClusterArn(conn.clusterArn);
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${escapeMd(conn.name)}** $(circle-filled) ${conn.environment.toUpperCase()} · ${mode}\n\n`);
    md.appendMarkdown(`| | |\n|---|---|\n`);
    md.appendMarkdown(`| Cluster | ${code(conn.clusterArn.split(':').pop() ?? '')} |\n`);
    md.appendMarkdown(`| Database | ${code(conn.database)} |\n`);
    md.appendMarkdown(`| Account / Region | ${arn?.account ?? '?'} / ${conn.region} |\n`);
    md.appendMarkdown(`| AWS profile | ${code(conn.profile)} |\n`);
    this.tooltip = md;
  }
}

export class SchemaNode extends vscode.TreeItem {
  readonly kind = 'schema';
  constructor(readonly conn: Connection, readonly schema: string) {
    super(schema, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `s:${conn.name}/${schema}`;
    this.contextValue = 'schema';
    this.iconPath = new vscode.ThemeIcon('symbol-namespace');
  }
}

export class RelationNode extends vscode.TreeItem {
  readonly kind = 'relation';
  constructor(
    readonly conn: Connection,
    readonly schema: string,
    readonly name: string,
    readonly relKind: string,
    estimate: number,
    partitions: number,
    comment: string | null,
    bound?: string | null,
  ) {
    super(name, relKind === 'x' ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
    const k = KIND[relKind] ?? KIND.r;
    this.id = `r:${conn.name}/${schema}/${name}`;
    this.contextValue = `relation.${k.context}`;
    this.iconPath = new vscode.ThemeIcon(k.icon);
    const parts: string[] = [];
    if (relKind === 'p') {
      parts.push(`${partitions} partition${partitions === 1 ? '' : 's'}`);
    }
    if (relKind !== 'v') {
      parts.push(`~${formatCount(estimate)} rows`);
    }
    this.description = bound ? bound.replace(/^FOR VALUES /, '') : parts.join(' · ');
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${escapeMd(schema)}.${escapeMd(name)}** · ${k.label}`);
    if (relKind !== 'v') {
      md.appendMarkdown(`\n\nEstimated rows: ${formatCount(estimate)} (from table statistics)`);
    }
    if (bound) {
      md.appendMarkdown(`\n\n${code(bound)}`);
    }
    if (comment) {
      md.appendMarkdown(`\n\n${escapeMd(comment)}`);
    }
    this.tooltip = md;
  }
}

export class PartitionsFolderNode extends vscode.TreeItem {
  readonly kind = 'partitions';
  constructor(readonly conn: Connection, readonly schema: string, readonly table: string, count: number) {
    super(`Partitions`, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `p:${conn.name}/${schema}/${table}`;
    this.description = String(count);
    this.iconPath = new vscode.ThemeIcon('folder-library');
    this.contextValue = 'partitions';
  }
}

export class ColumnNode extends vscode.TreeItem {
  readonly kind = 'column';
  constructor(readonly conn: Connection, readonly schema: string, readonly table: string, readonly column: ColumnInfo) {
    super(column.name, vscode.TreeItemCollapsibleState.None);
    this.id = `col:${conn.name}/${schema}/${table}/${column.name}`;
    this.contextValue = 'column';
    this.iconPath = new vscode.ThemeIcon(column.isPk ? 'key' : column.isFk ? 'references' : 'symbol-field');
    const flags = [column.isPk ? 'PK' : '', column.isFk ? 'FK' : '', column.notNull && !column.isPk ? 'not null' : ''].filter(Boolean);
    this.description = [column.type, ...flags].join(' · ');
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${escapeMd(column.name)}** ${code(column.type)}`);
    if (flags.length) {
      md.appendMarkdown(`\n\n${flags.join(', ')}`);
    }
    if (column.defaultValue) {
      md.appendMarkdown(`\n\nDefault: ${code(column.defaultValue)}`);
    }
    if (column.comment) {
      md.appendMarkdown(`\n\n${escapeMd(column.comment)}`);
    }
    this.tooltip = md;
  }
}

export class MessageNode extends vscode.TreeItem {
  readonly kind = 'message';
  constructor(text: string, icon: string, tooltip?: string, command?: vscode.Command) {
    super(text, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.tooltip = tooltip;
    this.command = command;
    this.contextValue = 'message';
  }
}

export type Node = ConnectionNode | SchemaNode | RelationNode | PartitionsFolderNode | ColumnNode | MessageNode;

export class ExplorerTree implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private connections: Connection[] = [];
  private active?: string;

  constructor(
    private readonly pool: ClientPool,
    private readonly onAuthError: (conn: Connection) => void,
  ) {}

  setConnections(list: Connection[], active?: string): void {
    this.connections = list;
    this.active = active;
    this.emitter.fire(undefined);
  }

  refresh(node?: Node): void {
    this.emitter.fire(node);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return node;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      return this.connections.map((c) => new ConnectionNode(c, c.name === this.active));
    }
    if (node instanceof MessageNode || node instanceof ColumnNode) {
      return [];
    }
    const conn = node.conn;
    const db = this.pool.get(conn);
    try {
      if (node instanceof ConnectionNode) {
        const schemas = await db.schemas();
        return schemas.length ? schemas.map((s) => new SchemaNode(conn, s)) : [new MessageNode('No schemas visible to this user', 'info')];
      }
      if (node instanceof SchemaNode) {
        const rels: Relation[] = await db.relations(node.schema);
        return rels.length
          ? rels.map((r) => new RelationNode(conn, node.schema, r.name, r.kind, Number(r.estimate), Number(r.partitions), r.comment))
          : [new MessageNode('No tables or views', 'info')];
      }
      if (node instanceof PartitionsFolderNode) {
        const parts: Partition[] = await db.partitions(node.schema, node.table);
        return parts.map((p) => new RelationNode(conn, p.schema, p.name, p.kind, Number(p.estimate), 0, null, p.bound));
      }
      if (node instanceof RelationNode) {
        const cols = (await db.columns(node.schema, node.name)).map((c) => new ColumnNode(conn, node.schema, node.name, c));
        if (node.relKind === 'p') {
          const count = (await db.partitions(node.schema, node.name)).length;
          return [new PartitionsFolderNode(conn, node.schema, node.name, count), ...cols];
        }
        return cols;
      }
      return [];
    } catch (err) {
      const why = explainError(err, conn);
      if (why.auth) {
        this.onAuthError(conn);
        return [
          new MessageNode('Sign-in needed: click to sign in with AWS SSO', 'key', why.fix, {
            command: 'auroralens.login',
            title: 'Sign in',
          }),
        ];
      }
      return [
        new MessageNode(why.title, 'error', `${why.fix}\n\n${(err as Error).message}`, {
          command: 'auroralens.testConnection',
          title: 'Diagnose',
          arguments: [conn.name],
        }),
      ];
    }
  }
}

/** Inline code span; backslash escapes do not work inside backticks, so backticks are replaced. */
function code(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``;
}

function escapeMd(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
