import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ensureProfilesWithConsent, login, LoginTarget, output, promptSsoSettings } from './aws';
import {
  Connection,
  historyEnabled,
  isReadOnly,
  loadConnections,
  maxRows,
  saveConnections,
  ssoSettings,
  statementTimeoutSeconds,
} from './config';
import { ConnectionForm } from './connectionForm';
import { diagnose } from './diagnose';
import { explainError } from './explain';
import { checkReadOnly, statementAt, statementRanges, withRowLimit } from './guards';
import { HistoryNode, HistoryStore, HistoryTree } from './history';
import { MonitorPanel } from './monitorPanel';
import { ResultsView } from './resultsPanel';
import * as gen from './sqlgen';
import { ClientPool, ColumnNode, ConnectionNode, ExplorerTree, RelationNode } from './tree';

const label = (c: Connection) => `${c.environment.toUpperCase()} · ${c.name}`;

export function activate(context: vscode.ExtensionContext): void {
  // Activation is side-effect free: nothing here writes files, runs processes or calls AWS.
  const pool = new ClientPool();
  const results = new ResultsView(context.extensionUri, context.globalState);
  const history = new HistoryStore(context.globalState);
  let connections: Connection[] = [];
  let active: Connection | undefined;
  let prompting = false;
  let reportedProblems = '';

  // ---------------- sign-in ----------------
  const doLogin = async (): Promise<void> => {
    let sso = ssoSettings();
    let target: LoginTarget;
    if (!sso && active) {
      target = { profile: active.profile }; // profiles the user already maintains in ~/.aws/config
    } else {
      sso = sso ?? (await promptSsoSettings());
      if (!sso) {
        return;
      }
      if (!(await ensureProfilesWithConsent(connections, sso))) {
        void vscode.window.showInformationMessage(
          'AuroraLens: sign-in cancelled because the AWS config entries were not added. The "AuroraLens" output shows the lines to add yourself.',
        );
        return;
      }
      target = { ssoSession: sso.name };
    }
    const ok = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'AuroraLens: finish the AWS sign-in in your browser…', cancellable: true },
      (_p, token) => login(target, token),
    );
    if (ok) {
      pool.clear();
      void vscode.window.showInformationMessage('AuroraLens: signed in.');
      tree.refresh();
    } else {
      void vscode.window.showErrorMessage('AuroraLens: sign-in failed. See the "AuroraLens" output for details.');
    }
  };

  const promptLogin = async (): Promise<void> => {
    if (prompting) {
      return;
    }
    prompting = true;
    const pick = await vscode.window.showWarningMessage('AuroraLens: you are not signed in to AWS, or your session expired.', 'Sign in');
    prompting = false;
    if (pick === 'Sign in') {
      await doLogin();
    }
  };

  // ---------------- views ----------------
  const tree = new ExplorerTree(pool, () => void promptLogin());
  const treeView = vscode.window.createTreeView('auroralens.explorer', { treeDataProvider: tree, showCollapseAll: true });
  const historyView = vscode.window.createTreeView('auroralens.history', { treeDataProvider: new HistoryTree(history) });
  const lensChanged = new vscode.EventEmitter<void>();
  const status = vscode.window.createStatusBarItem('auroralens.connection', vscode.StatusBarAlignment.Left, 100);
  status.name = 'AuroraLens Connection';
  status.command = 'auroralens.switchEnvironment';

  const select = (conn: Connection | undefined) => {
    active = conn;
    void vscode.commands.executeCommand('setContext', 'auroralens.hasConnection', connections.length > 0);
    status.text = conn ? `$(database) ${label(conn)}` : '$(database) AuroraLens';
    status.tooltip = conn
      ? `AuroraLens: ${conn.name} (${isReadOnly(conn.environment) ? 'read-only' : 'READ-WRITE'}). Click to switch connection.`
      : 'AuroraLens: add a connection to get started';
    status.backgroundColor =
      conn?.environment === 'prod'
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : conn?.environment === 'qa' || conn?.environment === 'staging'
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
    status.show();
    tree.setConnections(connections, conn?.name);
    treeView.description = conn ? `active: ${conn.name}` : undefined;
    lensChanged.fire();
  };

  const setActive = async (conn: Connection) => {
    await context.globalState.update('active', conn.name);
    select(conn);
  };

  const reload = () => {
    const loaded = loadConnections();
    connections = loaded.connections;
    pool.clear();
    const key = loaded.problems.join('\n');
    if (loaded.problems.length && key !== reportedProblems) {
      output.appendLine(`Ignored connections with invalid settings:\n  ${loaded.problems.join('\n  ')}`);
      void vscode.window
        .showWarningMessage(`AuroraLens: ignored ${loaded.problems.length} connection(s) with invalid settings.`, 'Show details')
        .then((pick) => pick && output.show());
    }
    reportedProblems = key;
    const saved = active?.name ?? context.globalState.get<string>('active');
    select(connections.find((c) => c.name === saved) ?? connections[0]);
  };

  // ---------------- running SQL ----------------
  const runSql = async (conn: Connection, raw: string): Promise<void> => {
    const readOnly = isReadOnly(conn.environment);
    if (readOnly) {
      const problem = checkReadOnly(raw);
      if (problem) {
        const suffix = conn.environment === 'prod' ? ' Production connections are always read-only.' : '';
        void vscode.window.showErrorMessage(`AuroraLens: ${problem}${suffix}`);
        return;
      }
    } else if (!raw.trim()) {
      void vscode.window.showWarningMessage('AuroraLens: nothing to run.');
      return;
    } else if (conn.environment !== 'dev') {
      const ok = await vscode.window.showWarningMessage(
        `Run this statement with WRITE access on ${label(conn)}?`,
        { modal: true, detail: 'Read-only mode is off (auroralens.readOnly).' },
        'Run',
      );
      if (ok !== 'Run') {
        return;
      }
    }
    const limit = maxRows();
    const sql = withRowLimit(raw, limit);
    const env = conn.environment.toUpperCase();
    const started = Date.now();
    await results.running({ env, connection: conn.name });
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `AuroraLens: running on ${env}…` },
        () => pool.get(conn).query(sql, { readOnly, timeoutSeconds: statementTimeoutSeconds() }),
      );
      const elapsedMs = Date.now() - started;
      const truncated = sql.endsWith(`\nLIMIT ${limit}`) && result.rows.length >= limit;
      await results.show(result, { env, connection: conn.name, elapsedMs, sql, readOnly, truncated, maxRows: limit });
      if (historyEnabled()) {
        await history.add({ sql: raw.trim(), connection: conn.name, env, at: started, ms: elapsedMs, rows: result.rows.length });
      }
    } catch (err) {
      const why = explainError(err, conn);
      const message = (err as Error)?.message ?? String(err);
      if (why.auth) {
        void promptLogin();
      }
      await results.showError(why, message, { env, connection: conn.name });
      if (historyEnabled()) {
        await history.add({ sql: raw.trim(), connection: conn.name, env, at: started, ms: Date.now() - started, error: why.title });
      }
    }
  };

  const openSql = async (conn: Connection, content: string) => {
    if (active?.name !== conn.name) {
      await setActive(conn);
      vscode.window.setStatusBarMessage(`AuroraLens: active connection is now ${conn.name}`, 4000);
    }
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content });
    await vscode.window.showTextDocument(doc, { preview: false });
  };

  const byName = (name: unknown) => connections.find((c) => c.name === name);
  const connOf = (arg: unknown): Connection | undefined =>
    arg instanceof ConnectionNode ? arg.conn : typeof arg === 'string' ? byName(arg) : active;

  const pickConnection = async (placeHolder: string): Promise<Connection | undefined> => {
    if (!connections.length) {
      void vscode.commands.executeCommand('auroralens.addConnection');
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      connections.map((c) => ({
        label: `${c.environment === 'dev' ? '$(database)' : '$(warning)'} ${label(c)}`,
        description: `${c.database} · ${isReadOnly(c.environment) ? 'read-only' : 'read-write'}`,
        detail: c.name === active?.name ? 'Active' : undefined,
        conn: c,
      })),
      { placeHolder },
    );
    return pick?.conn;
  };

  const relationCommand = (fn: (node: RelationNode) => Promise<void>) => async (node?: RelationNode) => {
    if (!(node instanceof RelationNode)) {
      void vscode.window.showInformationMessage('AuroraLens: right-click a table in the AuroraLens sidebar.');
      return;
    }
    try {
      await fn(node);
    } catch (err) {
      const why = explainError(err, node.conn);
      void vscode.window.showErrorMessage(`AuroraLens: ${why.title}. ${why.fix}`);
    }
  };

  const script = (build: (s: string, t: string, cols: gen.ColumnInfo[]) => string) =>
    relationCommand(async (node) => {
      const cols = await pool.get(node.conn).columns(node.schema, node.name);
      await openSql(node.conn, build(node.schema, node.name, cols));
    });

  reload();

  // ---------------- registrations ----------------
  const cmd = (id: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(id, fn);
  context.subscriptions.push(
    status,
    output,
    lensChanged,
    treeView,
    historyView,
    vscode.window.registerWebviewViewProvider(ResultsView.id, results, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('auroralens')) {
        reload();
      }
    }),
    vscode.languages.registerCodeLensProvider({ language: 'sql' }, {
      onDidChangeCodeLenses: lensChanged.event,
      provideCodeLenses(doc) {
        const env = active ? label(active) : 'no connection';
        return statementRanges(doc.getText()).map((r) => {
          const pos = doc.positionAt(r.start);
          return new vscode.CodeLens(new vscode.Range(pos, pos), {
            title: `$(play) Run on ${env}`,
            tooltip: 'Run this statement (Ctrl/Cmd+Enter)',
            command: 'auroralens.runQuery',
            arguments: [r.start],
          });
        });
      },
    }),

    // --- general ---
    cmd('auroralens.login', doLogin),
    cmd('auroralens.configureSso', async () => {
      if (await promptSsoSettings(ssoSettings())) {
        void vscode.window.showInformationMessage('AuroraLens: AWS SSO settings saved. Run "Sign in" when you are ready.');
      }
    }),
    cmd('auroralens.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:anujshrigiriwar.auroralens')),
    cmd('auroralens.refresh', () => {
      pool.clear();
      tree.refresh();
    }),
    cmd('auroralens.saveCsv', () => results.exportLast('csv')),
    cmd('auroralens.switchEnvironment', async () => {
      const conn = await pickConnection('Select the active connection');
      if (conn) {
        await setActive(conn);
      }
    }),
    cmd('auroralens.newQuery', async (arg?: unknown) => {
      const conn = arg instanceof ConnectionNode ? arg.conn : active;
      if (conn && active?.name !== conn.name) {
        await setActive(conn);
      }
      // Saved to disk so queries survive closing VS Code.
      const dir = path.join(os.homedir(), 'AuroraLens', 'queries');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const file = path.join(dir, `query-${stamp}.sql`);
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, `-- ${conn ? label(conn) : 'AuroraLens'} · ${new Date().toLocaleString()}\nSELECT 1;\n`);
      }
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
    }),
    cmd('auroralens.runQuery', async (at?: number) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage('AuroraLens: open a SQL editor first.');
        return;
      }
      const conn = active ?? (await pickConnection('Run on which connection?'));
      if (!conn) {
        return;
      }
      if (!active) {
        await setActive(conn);
      }
      // Selection wins; otherwise run the statement under the cursor.
      const raw =
        editor.selection.isEmpty || typeof at === 'number'
          ? statementAt(editor.document.getText(), typeof at === 'number' ? at : editor.document.offsetAt(editor.selection.active))
          : editor.document.getText(editor.selection);
      await runSql(conn, raw);
    }),

    // --- connection manager ---
    cmd('auroralens.addConnection', () =>
      ConnectionForm.open(context.extensionUri, undefined, (c) => {
        if (!active) {
          void context.globalState.update('active', c.name);
        }
      }),
    ),
    cmd('auroralens.editConnection', (arg?: unknown) => {
      const conn = connOf(arg);
      if (conn) {
        ConnectionForm.open(context.extensionUri, conn, (c) => {
          if (active?.name === conn.name) {
            void context.globalState.update('active', c.name);
            active = c;
          }
        });
      }
    }),
    cmd('auroralens.duplicateConnection', (arg?: unknown) => {
      const conn = connOf(arg);
      if (conn) {
        ConnectionForm.open(context.extensionUri, undefined, () => undefined, { ...conn, name: `${conn.name}-copy` });
      }
    }),
    cmd('auroralens.deleteConnection', async (arg?: unknown) => {
      const conn = connOf(arg);
      if (!conn) {
        return;
      }
      const ok = await vscode.window.showWarningMessage(
        `Delete the connection "${conn.name}"?`,
        { modal: true, detail: 'This only removes it from AuroraLens settings. Nothing changes in AWS or the database.' },
        'Delete',
      );
      if (ok === 'Delete') {
        if (active?.name === conn.name) {
          active = undefined;
          await context.globalState.update('active', undefined);
        }
        await saveConnections(connections.filter((c) => c.name !== conn.name));
      }
    }),
    cmd('auroralens.setActive', async (arg?: unknown) => {
      const conn = connOf(arg);
      if (conn) {
        await setActive(conn);
      }
    }),
    cmd('auroralens.testConnection', async (arg?: unknown) => {
      const conn = connOf(arg) ?? (await pickConnection('Test which connection?'));
      if (!conn) {
        return;
      }
      let final: { label: string; status: string; detail?: string; fix?: string }[] = [];
      const ok = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `AuroraLens: testing ${conn.name}` },
        (progress) =>
          diagnose(conn, pool.get(conn), (steps) => {
            final = steps;
            const running = steps.find((s) => s.status === 'running');
            if (running) {
              progress.report({ message: running.label });
            }
          }),
      );
      const lines = final.map((s) => `${s.status === 'ok' ? '✓' : s.status === 'fail' ? '✕' : '–'} ${s.label}${s.detail ? `: ${s.detail}` : ''}`);
      const failed = final.find((s) => s.status === 'fail');
      if (ok) {
        void vscode.window.showInformationMessage(`AuroraLens: ${conn.name} is working.`, { modal: true, detail: lines.join('\n') });
      } else {
        const pick = await vscode.window.showErrorMessage(
          `AuroraLens: ${conn.name}: ${failed?.detail ?? 'test failed'}`,
          { modal: true, detail: `${lines.join('\n')}\n\nHow to fix:\n${failed?.fix ?? ''}` },
          ...(failed?.fix && /sign in/i.test(failed.fix) ? ['Sign in'] : []),
          'Edit connection',
        );
        if (pick === 'Sign in') {
          await doLogin();
        } else if (pick === 'Edit connection') {
          await vscode.commands.executeCommand('auroralens.editConnection', conn.name);
        }
      }
    }),
    cmd('auroralens.copyArn', async (arg?: unknown) => {
      const conn = connOf(arg);
      if (conn) {
        await vscode.env.clipboard.writeText(conn.clusterArn);
        vscode.window.setStatusBarMessage('AuroraLens: cluster ARN copied', 3000);
      }
    }),
    cmd('auroralens.openConsole', async (arg?: unknown) => {
      const conn = connOf(arg);
      if (conn) {
        const id = encodeURIComponent(conn.clusterArn.split(':').pop() ?? '');
        await vscode.env.openExternal(
          vscode.Uri.parse(`https://${conn.region}.console.aws.amazon.com/rds/home?region=${conn.region}#database:id=${id};is-cluster=true`),
        );
      }
    }),
    cmd('auroralens.openMonitor', async (arg?: unknown) => {
      const conn = connOf(arg) ?? (await pickConnection('Monitor which connection?'));
      if (conn) {
        MonitorPanel.open(context.extensionUri, conn, pool);
      }
    }),

    // --- table actions ---
    cmd('auroralens.table.selectTop', relationCommand((n) => runSql(n.conn, gen.selectTop(n.schema, n.name, 1000)))),
    cmd('auroralens.table.count', relationCommand((n) => runSql(n.conn, gen.selectCount(n.schema, n.name)))),
    cmd('auroralens.table.openSelect', relationCommand((n) => openSql(n.conn, gen.selectTop(n.schema, n.name, 100)))),
    cmd('auroralens.table.scriptSelect', script(gen.scriptSelect)),
    cmd('auroralens.table.scriptInsert', script(gen.scriptInsert)),
    cmd('auroralens.table.scriptUpdate', script(gen.scriptUpdate)),
    cmd('auroralens.table.scriptDelete', script(gen.scriptDelete)),
    cmd(
      'auroralens.table.ddl',
      relationCommand(async (n) => {
        const def = await pool.get(n.conn).definition(n.schema, n.name);
        const header = `-- ${gen.qualified(n.schema, n.name)} on ${label(n.conn)}\n-- Reconstructed by AuroraLens from the PostgreSQL catalog for review.\n\n`;
        await openSql(n.conn, header + gen.buildDdl(def));
      }),
    ),
    cmd('auroralens.table.copyName', async (n?: RelationNode) => {
      if (n instanceof RelationNode) {
        await vscode.env.clipboard.writeText(gen.qualified(n.schema, n.name));
        vscode.window.setStatusBarMessage(`AuroraLens: copied ${gen.qualified(n.schema, n.name)}`, 3000);
      }
    }),
    cmd('auroralens.column.copyName', async (n?: ColumnNode) => {
      if (n instanceof ColumnNode) {
        await vscode.env.clipboard.writeText(gen.quoteIdent(n.column.name));
        vscode.window.setStatusBarMessage(`AuroraLens: copied ${n.column.name}`, 3000);
      }
    }),

    // --- history ---
    cmd('auroralens.history.open', async (n?: HistoryNode) => {
      if (n) {
        const conn = byName(n.entry.connection);
        const content = `-- ${n.entry.env} · ${n.entry.connection} · ${new Date(n.entry.at).toLocaleString()}\n${n.entry.sql}\n`;
        if (conn) {
          await openSql(conn, content);
        } else {
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'sql', content }));
        }
      }
    }),
    cmd('auroralens.history.run', async (n?: HistoryNode) => {
      const conn = n && byName(n.entry.connection);
      if (n && !conn) {
        void vscode.window.showWarningMessage(`AuroraLens: the connection "${n.entry.connection}" no longer exists.`);
      } else if (n && conn) {
        await runSql(conn, n.entry.sql);
      }
    }),
    cmd('auroralens.history.copy', async (n?: HistoryNode) => {
      if (n) {
        await vscode.env.clipboard.writeText(n.entry.sql);
        vscode.window.setStatusBarMessage('AuroraLens: SQL copied', 3000);
      }
    }),
    cmd('auroralens.history.delete', (n?: HistoryNode) => n && history.remove(n.entry.id)),
    cmd('auroralens.history.clear', async () => {
      const ok = await vscode.window.showWarningMessage('Clear all AuroraLens query history?', { modal: true }, 'Clear');
      if (ok === 'Clear') {
        await history.clear();
      }
    }),
  );
}

export function deactivate(): void {}
