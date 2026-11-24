// SQL helpers built on a small dialect-aware tokenizer (no vscode import, unit-tested).
//
// IMPORTANT: the read-only check here is a usability guard and defence in depth only.
// The real enforcement is server side: read-only statements run inside a READ ONLY
// transaction that is always rolled back (see dataApi.ts), and teams should point
// AuroraLens at a secret for a read-only database user.

export type Engine = 'postgres' | 'mysql';

export type TokenType = 'word' | 'quotedIdent' | 'string' | 'number' | 'param' | 'punct' | 'semicolon' | 'comment' | 'space';

export interface Token {
  type: TokenType;
  text: string;
  start: number;
  end: number;
}

const DOLLAR_TAG = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/y;
const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
const isWordStart = (c: string | undefined) => c !== undefined && /[A-Za-z_\u0080-￿]/.test(c);
const isWordPart = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_$\u0080-￿]/.test(c);
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

/** Scans a quoted run starting after the opening quote; a doubled quote is an escaped quote. */
function skipQuoted(sql: string, i: number, quote: string, backslashEscapes: boolean): number {
  while (i < sql.length) {
    if (backslashEscapes && sql[i] === '\\') {
      i += 2;
    } else if (sql[i] === quote) {
      if (sql[i + 1] !== quote) {
        return i + 1;
      }
      i += 2;
    } else {
      i++;
    }
  }
  return sql.length;
}

/**
 * PostgreSQL: '…' and E'…' strings, "…" identifiers, $tag$…$tag$ strings, nested block comments.
 * MySQL: '…' and "…" strings with backslash escapes, `…` identifiers, # comments, "-- " comments
 * (dash dash space), non-nesting block comments.
 */
export function tokenize(sql: string, engine: Engine = 'postgres'): Token[] {
  const my = engine === 'mysql';
  const out: Token[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const start = i;
    const c = sql[i];
    let type: TokenType;
    if (isSpace(c)) {
      while (i < n && isSpace(sql[i])) {
        i++;
      }
      type = 'space';
    } else if ((c === '-' && sql[i + 1] === '-' && (!my || isSpace(sql[i + 2]) || i + 2 >= n)) || (my && c === '#')) {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? n : nl;
      type = 'comment';
    } else if (c === '/' && sql[i + 1] === '*') {
      if (my) {
        const end = sql.indexOf('*/', i + 2);
        i = end < 0 ? n : end + 2;
      } else {
        // PostgreSQL block comments nest.
        let depth = 1;
        i += 2;
        while (i < n && depth > 0) {
          if (sql[i] === '/' && sql[i + 1] === '*') {
            depth++;
            i += 2;
          } else if (sql[i] === '*' && sql[i + 1] === '/') {
            depth--;
            i += 2;
          } else {
            i++;
          }
        }
      }
      type = 'comment';
    } else if (c === "'") {
      i = skipQuoted(sql, i + 1, "'", my);
      type = 'string';
    } else if (my && c === '"') {
      i = skipQuoted(sql, i + 1, '"', true);
      type = 'string';
    } else if (my && c === '`') {
      i = skipQuoted(sql, i + 1, '`', false);
      type = 'quotedIdent';
    } else if (!my && (c === 'E' || c === 'e') && sql[i + 1] === "'" && !isWordPart(sql[i - 1])) {
      i = skipQuoted(sql, i + 2, "'", true);
      type = 'string';
    } else if (!my && c === '"') {
      i = skipQuoted(sql, i + 1, '"', false);
      type = 'quotedIdent';
    } else if (!my && c === '$') {
      DOLLAR_TAG.lastIndex = i;
      const m = DOLLAR_TAG.exec(sql);
      if (m) {
        const close = sql.indexOf(m[0], i + m[0].length);
        i = close < 0 ? n : close + m[0].length;
        type = 'string';
      } else if (isDigit(sql[i + 1])) {
        i++;
        while (isDigit(sql[i])) {
          i++;
        }
        type = 'param';
      } else {
        i++;
        type = 'punct';
      }
    } else if (isWordStart(c) || (my && c === '$')) {
      i++;
      while (i < n && isWordPart(sql[i])) {
        i++;
      }
      type = 'word';
    } else if (isDigit(c) || (c === '.' && isDigit(sql[i + 1]))) {
      while (i < n && (isDigit(sql[i]) || sql[i] === '.' || sql[i] === '_' || sql[i] === 'e' || sql[i] === 'E')) {
        i++;
      }
      type = 'number';
    } else if (c === ':' && isWordStart(sql[i + 1]) && sql[i - 1] !== ':') {
      // RDS Data API named parameter (:name). "::type" casts are excluded by the look-behind.
      i++;
      while (i < n && isWordPart(sql[i])) {
        i++;
      }
      type = 'param';
    } else if (c === ';') {
      i++;
      type = 'semicolon';
    } else {
      i++;
      type = 'punct';
    }
    out.push({ type, text: sql.slice(start, i), start, end: i });
  }
  return out;
}

const significant = (t: Token) => t.type !== 'space' && t.type !== 'comment';

/** Start/end offsets of each statement, skipping leading blank lines and comments. */
export function statementRanges(text: string, engine: Engine = 'postgres'): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let first: Token | undefined;
  for (const t of tokenize(text, engine)) {
    if (t.type === 'semicolon') {
      if (first) {
        out.push({ start: first.start, end: t.end });
      }
      first = undefined;
    } else if (!first && significant(t)) {
      first = t;
    }
  }
  if (first) {
    out.push({ start: first.start, end: text.length });
  }
  return out;
}

/** The statement containing the cursor offset (used when nothing is selected). */
export function statementAt(text: string, offset: number, engine: Engine = 'postgres'): string {
  const ranges = statementRanges(text, engine);
  const hit = ranges.find((r) => offset <= r.end) ?? ranges[ranges.length - 1];
  return hit ? text.slice(hit.start, hit.end) : '';
}

/** First statement keywords allowed in read-only mode. */
const READ_ONLY_START: Record<Engine, Set<string>> = {
  postgres: new Set(['select', 'with', 'explain', 'show', 'values', 'table']),
  mysql: new Set(['select', 'with', 'explain', 'show', 'values', 'table', 'describe', 'desc']),
};

/**
 * Functions with effects that a read-only transaction does not stop: signalling other
 * sessions, session-level state on a pooled connection, server files, and calls out to AWS.
 */
const BLOCKED_FUNCTIONS: Record<Engine, Set<string>> = {
  postgres: new Set([
    'pg_terminate_backend',
    'pg_cancel_backend',
    'pg_reload_conf',
    'pg_rotate_logfile',
    'pg_switch_wal',
    'pg_create_restore_point',
    'pg_promote',
    'set_config',
    'pg_advisory_lock',
    'pg_advisory_lock_shared',
    'pg_try_advisory_lock',
    'pg_try_advisory_lock_shared',
    'pg_read_file',
    'pg_read_binary_file',
    'pg_ls_dir',
    'lo_import',
    'lo_export',
    'query_export_to_s3',
    'table_import_from_s3',
  ]),
  mysql: new Set([
    'get_lock',
    'release_lock',
    'release_all_locks',
    'load_file',
    'lambda_sync',
    'lambda_async',
    'aws_sagemaker_invoke_endpoint',
    'aws_comprehend_detect_sentiment',
    'aws_comprehend_detect_sentiment_confidence',
    'aws_bedrock_invoke_model',
    'sys_exec',
    'sys_eval',
  ]),
};
/** Aurora extension schemas whose functions call other AWS services. */
const BLOCKED_SCHEMAS = new Set(['aws_lambda', 'aws_s3', 'aws_ml', 'aws_comprehend', 'aws_sagemaker', 'aws_bedrock']);

function unquote(t: Token): string {
  if (t.type !== 'quotedIdent') {
    return t.text;
  }
  const q = t.text[0];
  return t.text.slice(1, -1).split(q + q).join(q);
}

function isBlockedFunction(engine: Engine, schema: string | undefined, name: string): boolean {
  return (
    BLOCKED_FUNCTIONS[engine].has(name) ||
    (engine === 'postgres' && name.startsWith('dblink')) ||
    (schema !== undefined && BLOCKED_SCHEMAS.has(schema)) ||
    (engine === 'mysql' && schema === 'mysql' && name.startsWith('lambda'))
  );
}

/** Returns an error message when the statement must be blocked, otherwise undefined. */
export function checkReadOnly(sql: string, engine: Engine = 'postgres'): string | undefined {
  const all = tokenize(sql, engine);
  if (engine === 'mysql' && all.some((t) => t.type === 'comment' && t.text.startsWith('/*!'))) {
    // MySQL executes the contents of /*! ... */ comments.
    return 'Read-only mode: MySQL executable comments (/*! … */) are not allowed.';
  }
  const toks = all.filter(significant);
  while (toks.length && toks[toks.length - 1].type === 'semicolon') {
    toks.pop();
  }
  if (!toks.length) {
    return 'Query is empty.';
  }
  if (toks.some((t) => t.type === 'semicolon')) {
    return 'Only one statement at a time is allowed.';
  }
  const allowed = READ_ONLY_START[engine];
  if (toks[0].type !== 'word' || !allowed.has(toks[0].text.toLowerCase())) {
    const list = engine === 'mysql' ? 'SELECT, WITH, EXPLAIN, SHOW, DESCRIBE, VALUES and TABLE' : 'SELECT, WITH, EXPLAIN, SHOW, VALUES and TABLE';
    return `Read-only mode: only ${list} statements are allowed.`;
  }
  const isName = (t: Token | undefined) => t !== undefined && (t.type === 'word' || t.type === 'quotedIdent');
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    const word = t.type === 'word' ? t.text.toLowerCase() : '';
    // U&"..." / U&'...' can spell any identifier with escapes and dodge the checks below.
    if (engine === 'postgres' && word === 'u' && toks[k + 1]?.text === '&') {
      return 'Read-only mode: Unicode-escaped identifiers (U&"...") are not allowed.';
    }
    // MySQL SELECT ... INTO OUTFILE / DUMPFILE / OUTFILE S3 writes outside the transaction.
    if (engine === 'mysql' && word === 'into') {
      return 'Read-only mode: SELECT … INTO is not allowed.';
    }
    if (isName(t) && toks[k + 1]?.text === '(') {
      const name = unquote(t).toLowerCase();
      const schema = toks[k - 1]?.text === '.' && isName(toks[k - 2]) ? unquote(toks[k - 2]).toLowerCase() : undefined;
      if (isBlockedFunction(engine, schema, name)) {
        return `Read-only mode: ${schema ? `${schema}.` : ''}${name}() has side effects and is blocked.`;
      }
    }
  }
  return undefined;
}

/**
 * Appends a LIMIT to a top-level SELECT/VALUES/TABLE (or read-only WITH) that has none.
 * The user's text is kept as written; only leading/trailing comments and trailing semicolons
 * are dropped, and the LIMIT goes on its own line so a `-- comment` cannot swallow it.
 */
export function withRowLimit(sql: string, limit: number, engine: Engine = 'postgres'): string {
  const sig = tokenize(sql, engine).filter(significant);
  while (sig.length && sig[sig.length - 1].type === 'semicolon') {
    sig.pop();
  }
  if (!sig.length) {
    return sql.trim();
  }
  const body = sql.slice(sig[0].start, sig[sig.length - 1].end);
  const first = sig[0].type === 'word' ? sig[0].text.toLowerCase() : '';
  if (!['select', 'values', 'table', 'with'].includes(first)) {
    return body;
  }
  let depth = 0;
  for (const t of sig) {
    if (t.text === '(') {
      depth++;
    } else if (t.text === ')') {
      depth--;
    } else if (depth === 0 && t.type === 'word') {
      // Existing limit, a locking clause (must follow LIMIT), SELECT INTO, or a data-modifying WITH.
      if (['limit', 'fetch', 'for', 'lock', 'into', 'insert', 'update', 'delete', 'merge'].includes(t.text.toLowerCase())) {
        return body;
      }
    }
  }
  return `${body}\nLIMIT ${Math.max(1, Math.floor(limit))}`;
}
