import {
  ArrayValue,
  BeginTransactionCommand,
  ExecuteStatementCommand,
  Field,
  RDSDataClient,
  RollbackTransactionCommand,
  SqlParameter,
} from '@aws-sdk/client-rds-data';
import { fromIni } from '@aws-sdk/credential-providers';
import type { AwsCredentialIdentityProvider } from '@smithy/types';
import * as meta from './metadata';
import type { Engine } from './guards';
import { buildDdl, ColumnInfo, qualified, TableDefinition } from './sqlgen';
import { Connection } from './validate';

export interface QueryResult {
  columns: string[];
  /** PostgreSQL type names from the Data API column metadata (e.g. int4, timestamptz, jsonb). */
  types: string[];
  rows: unknown[][];
}

export interface QueryOptions {
  /** Run inside a READ ONLY transaction that is always rolled back. */
  readOnly: boolean;
  /** Server-side statement_timeout for read-only statements. */
  timeoutSeconds: number;
}

export interface Relation {
  name: string;
  kind: string;
  estimate: number;
  partitions: number;
  comment: string | null;
}

export interface Partition {
  schema: string;
  name: string;
  kind: string;
  estimate: number;
  bound: string | null;
}

type Params = Record<string, string>;

/** Converts a Data API typed field to a plain JS value. */
export function fieldValue(f: Field): unknown {
  if (f.isNull) {
    return null;
  }
  if (f.stringValue !== undefined) {
    return f.stringValue;
  }
  if (f.longValue !== undefined) {
    return f.longValue;
  }
  if (f.doubleValue !== undefined) {
    return f.doubleValue;
  }
  if (f.booleanValue !== undefined) {
    return f.booleanValue;
  }
  if (f.blobValue !== undefined) {
    return `\\x${Buffer.from(f.blobValue).toString('hex')}`;
  }
  if (f.arrayValue !== undefined) {
    return arrayValue(f.arrayValue);
  }
  return null;
}

function arrayValue(a: ArrayValue): unknown[] {
  return a.stringValues ?? a.longValues ?? a.doubleValues ?? a.booleanValues ?? a.arrayValues?.map((x) => (x ? arrayValue(x) : null)) ?? [];
}

export class DataApiClient {
  private readonly client: RDSDataClient;
  readonly credentials: AwsCredentialIdentityProvider;

  constructor(readonly conn: Connection) {
    // fromIni resolves SSO profiles too; nothing is stored by this extension.
    this.credentials = fromIni({ profile: conn.profile });
    this.client = new RDSDataClient({ region: conn.region, credentials: this.credentials });
  }

  private async exec(sql: string, params?: Params, transactionId?: string): Promise<QueryResult> {
    const parameters: SqlParameter[] | undefined = params
      ? Object.entries(params).map(([name, value]) => ({ name, value: { stringValue: value } }))
      : undefined;
    const out = await this.client.send(
      new ExecuteStatementCommand({
        resourceArn: this.conn.clusterArn,
        secretArn: this.conn.secretArn,
        database: this.conn.database,
        sql,
        parameters,
        transactionId,
        // Typed records (not JSON): only this format returns column metadata, which gives real
        // type names, headers for empty results and distinct duplicate labels (SELECT a.id, b.id).
        includeResultMetadata: true,
      }),
    );
    const columns = out.columnMetadata?.map((c) => c.label || c.name || '?column?') ?? [];
    const types = out.columnMetadata?.map((c) => (c.typeName ?? '').toLowerCase()) ?? [];
    const rows = (out.records ?? []).map((r) => r.map(fieldValue));
    return { columns, types, rows };
  }

  private detected?: Engine;
  private detecting?: Promise<Engine>;

  /** The engine once detected, for synchronous callers (CodeLens, copy name); PostgreSQL until known. */
  get knownEngine(): Engine {
    return this.detected ?? 'postgres';
  }

  /** Detects Aurora PostgreSQL vs Aurora MySQL from version(), once per client. */
  engine(): Promise<Engine> {
    if (this.detected) {
      return Promise.resolve(this.detected);
    }
    this.detecting ??= this.exec('SELECT version() AS v')
      .then((r) => (this.detected = engineFromVersion(String(r.rows[0]?.[0] ?? ''))))
      .finally(() => (this.detecting = undefined));
    return this.detecting;
  }

  /**
   * Runs a user statement. In read-only mode the database enforces it: the statement runs in a
   * READ ONLY transaction with a statement timeout, and the transaction is always rolled back,
   * so nothing it does is kept even if a client-side check misses something.
   */
  async query(sql: string, opts: QueryOptions): Promise<QueryResult> {
    if (!opts.readOnly) {
      return this.exec(sql);
    }
    const engine = await this.engine();
    const resourceArn = this.conn.clusterArn;
    const secretArn = this.conn.secretArn;
    const begin = await this.client.send(new BeginTransactionCommand({ resourceArn, secretArn, database: this.conn.database }));
    const transactionId = begin.transactionId;
    if (!transactionId) {
      throw new Error('The Data API did not return a transaction id; refusing to run without read-only protection.');
    }
    const ms = Math.max(1, Math.floor(opts.timeoutSeconds)) * 1000;
    let resetTimeout = false;
    try {
      if (engine === 'mysql') {
        // MySQL cannot change the characteristics of a transaction already in progress, so start a
        // new READ ONLY transaction on the same pinned connection (this implicitly ends the empty
        // one the Data API opened). max_execution_time is session-level, so it is reset below.
        await this.exec(`SET SESSION max_execution_time = ${ms}`, undefined, transactionId);
        resetTimeout = true;
        await this.exec('START TRANSACTION READ ONLY', undefined, transactionId);
      } else {
        await this.exec('SET TRANSACTION READ ONLY', undefined, transactionId);
        await this.exec(`SET LOCAL statement_timeout = ${ms}`, undefined, transactionId);
      }
      return await this.exec(sql, undefined, transactionId);
    } finally {
      if (resetTimeout) {
        await this.exec('SET SESSION max_execution_time = DEFAULT', undefined, transactionId).catch(() => undefined);
      }
      await this.client.send(new RollbackTransactionCommand({ resourceArn, secretArn, transactionId })).catch(() => undefined);
    }
  }

  /** Trusted, fixed catalog SQL from metadata.ts with bound parameters. */
  catalog(sql: string, params?: Params): Promise<QueryResult> {
    return this.exec(sql, params);
  }

  async catalogObjects<T>(sql: string, params?: Params): Promise<T[]> {
    const r = await this.exec(sql, params);
    return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])) as T);
  }

  /** The catalog query set for this cluster's engine. */
  async sqlFor(): Promise<meta.Catalog> {
    return meta.CATALOG[await this.engine()];
  }

  async schemas(): Promise<string[]> {
    return (await this.catalogObjects<{ name: string }>((await this.sqlFor()).schemas)).map((r) => String(r.name));
  }

  async relations(schema: string): Promise<Relation[]> {
    const rows = await this.catalogObjects<Record<string, unknown>>((await this.sqlFor()).relations, { schema });
    return rows.map((r) => ({
      name: String(r.name),
      kind: String(r.kind),
      estimate: Number(r.estimate) || 0,
      partitions: Number(r.partitions) || 0,
      comment: (r.comment as string | null) ?? null,
    }));
  }

  async partitions(schema: string, table: string): Promise<Partition[]> {
    const rows = await this.catalogObjects<Record<string, unknown>>((await this.sqlFor()).partitions, { schema, table });
    return rows.map((r) => ({
      schema: String(r.schema),
      name: String(r.name),
      kind: String(r.kind),
      estimate: Number(r.estimate) || 0,
      bound: (r.bound as string | null) ?? null,
    }));
  }

  async columns(schema: string, table: string): Promise<ColumnInfo[]> {
    const rows = await this.catalogObjects<Record<string, unknown>>((await this.sqlFor()).columns, { schema, table });
    return rows.map((r) => ({
      name: String(r.name),
      type: String(r.type),
      notNull: truthy(r.not_null),
      defaultValue: r.default_value === null || r.default_value === undefined ? null : String(r.default_value),
      isPk: truthy(r.is_pk),
      isFk: truthy(r.is_fk),
      comment: (r.comment as string | null) ?? null,
    }));
  }

  /** Readable DDL: rebuilt from the catalog on PostgreSQL, SHOW CREATE on MySQL. */
  async ddl(schema: string, table: string): Promise<string> {
    if ((await this.engine()) === 'mysql') {
      const r = await this.exec(`SHOW CREATE TABLE ${qualified(schema, table, 'mysql')}`);
      const text = r.rows[0]?.[1];
      return `${String(text ?? '')};\n`;
    }
    return buildDdl(await this.definition(schema, table));
  }

  async definition(schema: string, table: string): Promise<TableDefinition> {
    const p = { schema, table };
    const [info, columns, constraints, indexes] = await Promise.all([
      this.catalogObjects<Record<string, string | null>>(meta.SQL_RELATION_INFO, p),
      this.columns(schema, table),
      this.catalogObjects<{ name: string; type: string; definition: string }>(meta.SQL_CONSTRAINTS, p),
      this.catalogObjects<{ definition: string }>(meta.SQL_INDEXES, p),
    ]);
    const i = info[0] ?? {};
    return {
      schema,
      name: table,
      kind: i.kind ?? 'r',
      columns,
      constraints,
      indexes: indexes.map((x) => x.definition),
      partitionKey: i.partition_key ?? null,
      viewDefinition: i.view_definition ?? null,
      comment: i.comment ?? null,
    };
  }
}

/** PostgreSQL's version() starts with "PostgreSQL"; Aurora MySQL returns e.g. "8.0.mysql_aurora.3.08.0". */
export function engineFromVersion(version: string): Engine {
  return /postgres/i.test(version) ? 'postgres' : 'mysql';
}

/** Booleans arrive as true/false from PostgreSQL and as 1/0 from MySQL. */
function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 't';
}
