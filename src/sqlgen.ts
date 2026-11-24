// SQL generation for table actions (no vscode import, unit-tested). PostgreSQL dialect.

const RESERVED = new Set(
  (
    'all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate collation ' +
    'column concurrently constraint create cross current_catalog current_date current_role current_schema current_time ' +
    'current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign freeze ' +
    'from full grant group having ilike in initially inner intersect into is isnull join lateral leading left like limit ' +
    'localtime localtimestamp natural not notnull null offset on only or order outer overlaps placing primary references ' +
    'returning right select session_user similar some symmetric system_user table tablesample then to trailing true union ' +
    'unique user using variadic verbose when where window with'
  ).split(' '),
);

/** Quotes an identifier only when PostgreSQL requires it. */
export function quoteIdent(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

export function qualified(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

export interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  isPk: boolean;
  isFk: boolean;
  comment: string | null;
}

export interface ConstraintInfo {
  name: string;
  /** p primary key, u unique, f foreign key, c check, x exclusion */
  type: string;
  definition: string;
}

export interface TableDefinition {
  schema: string;
  name: string;
  /** r table, p partitioned table, v view, m materialized view, f foreign table */
  kind: string;
  columns: ColumnInfo[];
  constraints: ConstraintInfo[];
  indexes: string[];
  partitionKey: string | null;
  viewDefinition: string | null;
  comment: string | null;
}

export function selectTop(schema: string, table: string, n: number): string {
  return `SELECT *\nFROM ${qualified(schema, table)}\nLIMIT ${Math.max(1, Math.floor(n))};\n`;
}

export function selectCount(schema: string, table: string): string {
  return `SELECT count(*) AS row_count\nFROM ${qualified(schema, table)};\n`;
}

export function scriptSelect(schema: string, table: string, columns: ColumnInfo[]): string {
  const cols = columns.length ? columns.map((c) => `  ${quoteIdent(c.name)}`).join(',\n') : '  *';
  return `SELECT\n${cols}\nFROM ${qualified(schema, table)}\nWHERE 1 = 1\nLIMIT 100;\n`;
}

function describe(c: ColumnInfo): string {
  const parts = [c.type];
  if (c.isPk) {
    parts.push('PK');
  }
  if (c.notNull && !c.isPk) {
    parts.push('NOT NULL');
  }
  if (c.defaultValue) {
    parts.push(`default ${c.defaultValue}`);
  }
  return parts.join(', ');
}

function aligned(values: string[], comments: string[]): string[] {
  const width = Math.max(...values.map((v) => v.length));
  return values.map((v, i) => `  ${v.padEnd(width)}  -- ${comments[i]}`);
}

export function scriptInsert(schema: string, table: string, columns: ColumnInfo[]): string {
  const names = columns.map((c) => quoteIdent(c.name));
  const values = columns.map((c, i) => (i < columns.length - 1 ? 'NULL,' : 'NULL'));
  return (
    `INSERT INTO ${qualified(schema, table)} (\n${names.map((n) => `  ${n}`).join(',\n')}\n) VALUES (\n` +
    `${aligned(values, columns.map((c) => `${c.name}: ${describe(c)}`)).join('\n')}\n);\n`
  );
}

function pkWhere(columns: ColumnInfo[]): string {
  const pk = columns.filter((c) => c.isPk);
  return pk.length ? pk.map((c) => `${quoteIdent(c.name)} = NULL`).join('\n  AND ') : '/* no primary key: add a condition */ false';
}

export function scriptUpdate(schema: string, table: string, columns: ColumnInfo[]): string {
  const settable = columns.filter((c) => !c.isPk);
  const sets = settable.map((c, i) => `${quoteIdent(c.name)} = NULL${i < settable.length - 1 ? ',' : ''}`);
  return `UPDATE ${qualified(schema, table)}\nSET\n${aligned(sets, settable.map(describe)).join('\n')}\nWHERE ${pkWhere(columns)};\n`;
}

export function scriptDelete(schema: string, table: string, columns: ColumnInfo[]): string {
  return `DELETE FROM ${qualified(schema, table)}\nWHERE ${pkWhere(columns)};\n`;
}

function literal(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** Reconstructs readable DDL from catalog data (for review, not a byte-exact pg_dump). */
export function buildDdl(def: TableDefinition): string {
  const name = qualified(def.schema, def.name);
  const out: string[] = [];
  if (def.kind === 'v' || def.kind === 'm') {
    const what = def.kind === 'm' ? 'MATERIALIZED VIEW' : 'OR REPLACE VIEW';
    out.push(`CREATE ${what} ${name} AS\n${(def.viewDefinition ?? '').trim().replace(/;$/, '')};`);
  } else {
    const lines = def.columns.map((c) => {
      let line = `  ${quoteIdent(c.name)} ${c.type}`;
      if (c.defaultValue) {
        line += ` DEFAULT ${c.defaultValue}`;
      }
      if (c.notNull) {
        line += ' NOT NULL';
      }
      return line;
    });
    for (const k of [...def.constraints].sort((a, b) => 'pufcx'.indexOf(a.type) - 'pufcx'.indexOf(b.type))) {
      lines.push(`  CONSTRAINT ${quoteIdent(k.name)} ${k.definition}`);
    }
    const foreign = def.kind === 'f' ? 'FOREIGN ' : '';
    const partition = def.kind === 'p' && def.partitionKey ? `\nPARTITION BY ${def.partitionKey}` : '';
    out.push(`CREATE ${foreign}TABLE ${name} (\n${lines.join(',\n')}\n)${partition};`);
  }
  for (const ix of def.indexes) {
    out.push(`${ix.trim().replace(/;$/, '')};`);
  }
  const kindWord = def.kind === 'v' ? 'VIEW' : def.kind === 'm' ? 'MATERIALIZED VIEW' : def.kind === 'f' ? 'FOREIGN TABLE' : 'TABLE';
  if (def.comment) {
    out.push(`COMMENT ON ${kindWord} ${name} IS ${literal(def.comment)};`);
  }
  for (const c of def.columns) {
    if (c.comment) {
      out.push(`COMMENT ON COLUMN ${name}.${quoteIdent(c.name)} IS ${literal(c.comment)};`);
    }
  }
  return `${out.join('\n\n')}\n`;
}
