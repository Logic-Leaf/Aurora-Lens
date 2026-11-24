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
import { ColumnInfo, TableDefinition } from './sqlgen';
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

  /**
   * Runs a user statement. In read-only mode the database enforces it: the statement runs in a
   * `READ ONLY` transaction with a `statement_timeout`, and the transaction is always rolled back,
   * so nothing it does is kept even if a client-side check misses something.
   */
  async query(sql: string, opts: QueryOptions): Promise<QueryResult> {
    if (!opts.readOnly) {
      return this.exec(sql);
    }
    const resourceArn = this.conn.clusterArn;
    const secretArn = this.conn.secretArn;
    const begin = await this.client.send(new BeginTransactionCommand({ resourceArn, secretArn, database: this.conn.database }));
    const transactionId = begin.transactionId;
    if (!transactionId) {
      throw new Error('The Data API did not return a transaction id; refusing to run without read-only protection.');
    }
    try {
      await this.exec('SET TRANSACTION READ ONLY', undefined, transactionId);
      const ms = Math.max(1, Math.floor(opts.timeoutSeconds)) * 1000;
      await this.exec(`SET LOCAL statement_timeout = ${ms}`, undefined, transactionId);
      return await this.exec(sql, undefined, transactionId);
    } finally {
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

  async schemas(): Promise<string[]> {
    return (await this.catalogObjects<{ name: string }>(meta.SQL_SCHEMAS)).map((r) => r.name);
  }

  relations(schema: string): Promise<Relation[]> {
    return this.catalogObjects<Relation>(meta.SQL_RELATIONS, { schema });
  }

  partitions(schema: string, table: string): Promise<Partition[]> {
    return this.catalogObjects<Partition>(meta.SQL_PARTITIONS, { schema, table });
  }

  async columns(schema: string, table: string): Promise<ColumnInfo[]> {
    const rows = await this.catalogObjects<Record<string, unknown>>(meta.SQL_COLUMNS, { schema, table });
    return rows.map((r) => ({
      name: String(r.name),
      type: String(r.type),
      notNull: r.not_null === true,
      defaultValue: (r.default_value as string | null) ?? null,
      isPk: r.is_pk === true,
      isFk: r.is_fk === true,
      comment: (r.comment as string | null) ?? null,
    }));
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
