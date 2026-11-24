import { CloudWatchClient, GetMetricDataCommand, MetricDataQuery } from '@aws-sdk/client-cloudwatch';
import { DescribeDBClustersCommand, DescribeDBInstancesCommand, RDSClient } from '@aws-sdk/client-rds';
import * as vscode from 'vscode';
import type { Connection } from './config';
import { isReadOnly } from './config';
import { explainError } from './explain';
import * as meta from './metadata';
import { ClientPool } from './tree';
import { webviewHtml, webviewOptions } from './webview';

const RANGES: Record<string, { hours: number; period: number }> = {
  '1h': { hours: 1, period: 60 },
  '6h': { hours: 6, period: 300 },
  '24h': { hours: 24, period: 900 },
  '7d': { hours: 168, period: 3600 },
};

/**
 * Cluster overview: AWS facts and CloudWatch metrics (needs rds:Describe* and
 * cloudwatch:GetMetricData) plus live database health from PostgreSQL statistics views
 * (needs nothing beyond the connection's own Data API access). Each section loads and
 * fails independently, so missing permissions only hide that one section.
 */
export class MonitorPanel {
  private static panels = new Map<string, MonitorPanel>();
  private readonly panel: vscode.WebviewPanel;
  private range = '6h';
  private serverless = false;
  private writers = new Set<string | undefined>();

  static open(extensionUri: vscode.Uri, conn: Connection, pool: ClientPool): void {
    const open = MonitorPanel.panels.get(conn.name);
    if (open) {
      open.panel.reveal();
      return;
    }
    MonitorPanel.panels.set(conn.name, new MonitorPanel(extensionUri, conn, pool));
  }

  private constructor(
    extensionUri: vscode.Uri,
    private readonly conn: Connection,
    private readonly pool: ClientPool,
  ) {
    this.panel = vscode.window.createWebviewPanel('auroralens.monitor', `Monitor · ${conn.name}`, vscode.ViewColumn.Active, {
      ...webviewOptions(extensionUri),
      retainContextWhenHidden: true,
    });
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.svg');
    this.panel.webview.html = webviewHtml(this.panel.webview, extensionUri, 'Monitor', ['monitor.js'], ['monitor.css']);
    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m));
    this.panel.onDidDispose(() => MonitorPanel.panels.delete(conn.name));
  }

  private get clusterId(): string {
    return this.conn.clusterArn.split(':').pop() ?? '';
  }

  private post(msg: object): void {
    void this.panel.webview.postMessage(msg);
  }

  private async onMessage(m: { type?: string; range?: string; text?: string }): Promise<void> {
    if (m?.type === 'ready' || m?.type === 'refresh') {
      if (m.range && RANGES[m.range]) {
        this.range = m.range;
      }
      this.post({
        type: 'init',
        connection: this.conn.name,
        env: this.conn.environment.toUpperCase(),
        readOnly: isReadOnly(this.conn.environment),
        cluster: this.clusterId,
        region: this.conn.region,
        range: this.range,
      });
      await this.loadAll();
    } else if (m?.type === 'console') {
      const r = this.conn.region;
      await vscode.env.openExternal(
        vscode.Uri.parse(`https://${r}.console.aws.amazon.com/rds/home?region=${r}#database:id=${encodeURIComponent(this.clusterId)};is-cluster=true`),
      );
    } else if (m?.type === 'copyText' && typeof m.text === 'string') {
      await vscode.env.clipboard.writeText(m.text);
    }
  }

  private async section(name: string, load: () => Promise<unknown>): Promise<void> {
    try {
      this.post({ type: 'section', name, data: await load() });
    } catch (err) {
      const why = explainError(err, this.conn);
      this.post({ type: 'section', name, error: { title: why.title, fix: why.fix, message: (err as Error)?.message ?? String(err) } });
    }
  }

  private async loadAll(): Promise<void> {
    const db = this.pool.get(this.conn);
    const rds = new RDSClient({ region: this.conn.region, credentials: db.credentials });
    const cw = new CloudWatchClient({ region: this.conn.region, credentials: db.credentials });
    // Cluster facts first: they tell the metrics section whether the cluster is Serverless v2.
    await this.section('cluster', () => this.loadCluster(rds));
    await Promise.all([
      this.section('metrics', () => this.loadMetrics(cw)),
      this.section('instances', () => this.loadInstances(rds)),
      this.section('overview', async () => (await db.catalogObjects(meta.SQL_DB_OVERVIEW))[0] ?? {}),
      this.section('sessions', () => db.catalogObjects(meta.SQL_DB_SESSIONS)),
      this.section('running', () => db.catalogObjects(meta.SQL_DB_LONG_RUNNING)),
      this.section('largest', () => db.catalogObjects(meta.SQL_DB_LARGEST_TABLES)),
      this.section('statements', async () => {
        try {
          return await db.catalogObjects(meta.SQL_DB_TOP_STATEMENTS);
        } catch (err) {
          if (/pg_stat_statements|does not exist|must be loaded/i.test((err as Error)?.message ?? '')) {
            return { unavailable: true };
          }
          throw err;
        }
      }),
    ]);
  }

  private async loadCluster(rds: RDSClient): Promise<object> {
    const out = await rds.send(new DescribeDBClustersCommand({ DBClusterIdentifier: this.conn.clusterArn }));
    const c = out.DBClusters?.[0];
    if (!c) {
      throw new Error('DBClusterNotFound');
    }
    const v2 = c.ServerlessV2ScalingConfiguration;
    this.serverless = !!v2 || (c.DBClusterMembers ?? []).length === 0;
    this.writers = new Set((c.DBClusterMembers ?? []).filter((m) => m.IsClusterWriter).map((m) => m.DBInstanceIdentifier));
    return {
      id: c.DBClusterIdentifier,
      status: c.Status,
      engine: c.Engine,
      engineVersion: c.EngineVersion,
      engineMode: c.EngineMode,
      capacity: v2 ? `${v2.MinCapacity}–${v2.MaxCapacity} ACU (Serverless v2)` : undefined,
      dataApi: c.HttpEndpointEnabled === true,
      encrypted: c.StorageEncrypted === true,
      iamAuth: c.IAMDatabaseAuthenticationEnabled === true,
      deletionProtection: c.DeletionProtection === true,
      backupDays: c.BackupRetentionPeriod,
      multiAz: c.MultiAZ === true,
      members: (c.DBClusterMembers ?? []).length,
      endpoint: c.Endpoint,
      readerEndpoint: c.ReaderEndpoint,
      port: c.Port,
      created: c.ClusterCreateTime?.toISOString(),
    };
  }

  private async loadInstances(rds: RDSClient): Promise<object[]> {
    const out = await rds.send(new DescribeDBInstancesCommand({ Filters: [{ Name: 'db-cluster-id', Values: [this.conn.clusterArn] }] }));
    return (out.DBInstances ?? []).map((i) => ({
      id: i.DBInstanceIdentifier,
      role: this.writers.has(i.DBInstanceIdentifier) ? 'writer' : 'reader',
      class: i.DBInstanceClass,
      status: i.DBInstanceStatus,
      az: i.AvailabilityZone,
      performanceInsights: i.PerformanceInsightsEnabled === true,
    }));
  }

  private async loadMetrics(cw: CloudWatchClient): Promise<object> {
    const { hours, period } = RANGES[this.range];
    const end = new Date();
    const start = new Date(end.getTime() - hours * 3600 * 1000);
    const metric = (id: string, name: string, stat: string): MetricDataQuery => ({
      Id: id,
      MetricStat: {
        Metric: { Namespace: 'AWS/RDS', MetricName: name, Dimensions: [{ Name: 'DBClusterIdentifier', Value: this.clusterId }] },
        Period: period,
        Stat: stat,
      },
    });
    const defs = [
      { id: 'cpu', name: 'CPUUtilization', title: 'CPU utilisation', unit: 'percent', stat: 'Average' },
      { id: 'conn', name: 'DatabaseConnections', title: 'Database connections', unit: 'count', stat: 'Average' },
      { id: 'mem', name: 'FreeableMemory', title: 'Freeable memory', unit: 'bytes', stat: 'Average' },
      this.serverless
        ? { id: 'acu', name: 'ServerlessDatabaseCapacity', title: 'Capacity (ACU)', unit: 'acu', stat: 'Average' }
        : { id: 'commit', name: 'CommitLatency', title: 'Commit latency', unit: 'ms', stat: 'Average' },
    ];
    const out = await cw.send(
      new GetMetricDataCommand({
        StartTime: start,
        EndTime: end,
        ScanBy: 'TimestampAscending',
        MetricDataQueries: defs.map((d) => metric(d.id, d.name, d.stat)),
      }),
    );
    const byId = new Map((out.MetricDataResults ?? []).map((r) => [r.Id, r]));
    return {
      range: this.range,
      start: start.getTime(),
      end: end.getTime(),
      series: defs.map((d) => {
        const r = byId.get(d.id);
        const points = (r?.Timestamps ?? []).map((t, i) => ({ t: t.getTime(), v: r?.Values?.[i] ?? 0 })).sort((a, b) => a.t - b.t);
        return { id: d.id, title: d.title, unit: d.unit, points };
      }),
    };
  }
}
