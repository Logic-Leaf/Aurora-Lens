import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkReadOnly, statementAt, statementRanges, tokenize, withRowLimit } from '../guards';

const kinds = (sql: string) => tokenize(sql).filter((t) => t.type !== 'space').map((t) => `${t.type}:${t.text}`);

describe('tokenize', () => {
  it('does not treat -- inside a string as a comment', () => {
    assert.deepEqual(kinds("SELECT '--x'"), ['word:SELECT', "string:'--x'"]);
  });
  it('handles doubled quotes, E-strings with backslashes, and quoted identifiers', () => {
    assert.deepEqual(kinds("'it''s' E'a\\'b' \"we\"\"ird\""), ["string:'it''s'", "string:E'a\\'b'", 'quotedIdent:"we""ird"']);
  });
  it('handles dollar quotes with and without tags', () => {
    assert.deepEqual(kinds('$$a;b$$ $fn$ x $$ y $fn$'), ['string:$$a;b$$', 'string:$fn$ x $$ y $fn$']);
  });
  it('handles nested block comments', () => {
    assert.deepEqual(kinds('/* a /* b */ c */ SELECT'), ['comment:/* a /* b */ c */', 'word:SELECT']);
  });
  it('separates :params from ::casts and $1 params', () => {
    assert.deepEqual(kinds('x::int = :id AND $1'), ['word:x', 'punct::', 'punct::', 'word:int', 'punct:=', 'param::id', 'word:AND', 'param:$1']);
  });
  it('does not read a word ending in e as an E-string prefix', () => {
    assert.deepEqual(kinds("name'x'"), ['word:name', "string:'x'"]);
  });
});

describe('statementRanges / statementAt', () => {
  const text = "SELECT ';' AS a;\n-- note; here\nSELECT $$;$$;\n/* ; */ SELECT 3";
  it('ignores semicolons in strings, dollar quotes and comments', () => {
    const r = statementRanges(text).map((x) => text.slice(x.start, x.end));
    assert.deepEqual(r, ["SELECT ';' AS a;", 'SELECT $$;$$;', 'SELECT 3']);
  });
  it('finds the statement under the cursor', () => {
    assert.equal(statementAt(text, text.indexOf('$$')), 'SELECT $$;$$;');
    assert.equal(statementAt(text, text.length), 'SELECT 3');
  });
});

describe('checkReadOnly', () => {
  const allowed = [
    "SELECT 'update' AS action",
    "SELECT * FROM audit WHERE note = 'drop table users; delete'",
    'SELECT 1;',
    'select 1 -- ; trailing comment',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'EXPLAIN SELECT * FROM t',
    'SHOW server_version',
    'VALUES (1), (2)',
    'TABLE users',
    'SELECT "update" FROM t', // a column named update
    'SELECT count(*), now(), pg_size_pretty(pg_database_size(current_database()))',
  ];
  for (const sql of allowed) {
    it(`allows: ${sql}`, () => assert.equal(checkReadOnly(sql), undefined));
  }

  const blocked: [string, RegExp][] = [
    ['', /empty/],
    ['-- only a comment', /empty/],
    ['UPDATE t SET a = 1', /only SELECT/],
    ['SET ROLE admin', /only SELECT/],
    ['DO $$ BEGIN PERFORM 1; END $$', /only SELECT/],
    ['CALL proc()', /only SELECT/],
    ['SELECT 1; DELETE FROM t', /one statement/],
    ['SELECT pg_terminate_backend(123)', /pg_terminate_backend/],
    ['SELECT PG_CANCEL_BACKEND (123)', /pg_cancel_backend/],
    ['SELECT "pg_terminate_backend"(123)', /pg_terminate_backend/],
    ['SELECT pg_catalog.pg_terminate_backend(123)', /pg_terminate_backend/],
    ["SELECT set_config('search_path', 'x', false)", /set_config/],
    ['SELECT pg_advisory_lock(1)', /pg_advisory_lock/],
    ["SELECT aws_lambda.invoke('fn', '{}'::json)", /aws_lambda/],
    ['SELECT * FROM aws_s3.query_export_to_s3(1)', /aws_s3/],
    ["SELECT dblink_exec('host=x', 'DELETE FROM t')", /dblink_exec/],
    ['SELECT U&"pg\\005fterminate_backend"(1)', /Unicode-escaped/],
  ];
  for (const [sql, msg] of blocked) {
    it(`blocks: ${sql || '(empty)'}`, () => assert.match(checkReadOnly(sql) ?? 'ALLOWED', msg));
  }
});

describe('withRowLimit', () => {
  it('appends LIMIT on its own line and keeps -- inside strings intact', () => {
    assert.equal(withRowLimit("SELECT '--x' AS a;", 50), "SELECT '--x' AS a\nLIMIT 50");
  });
  it('drops a trailing comment so it cannot swallow the LIMIT', () => {
    assert.equal(withRowLimit('SELECT 1 -- note', 5), 'SELECT 1\nLIMIT 5');
  });
  it('keeps comments inside the statement', () => {
    assert.equal(withRowLimit('SELECT /* keep */ 1', 5), 'SELECT /* keep */ 1\nLIMIT 5');
  });
  it('leaves an existing top-level LIMIT or FETCH alone', () => {
    assert.equal(withRowLimit('SELECT * FROM t LIMIT 10', 5), 'SELECT * FROM t LIMIT 10');
    assert.equal(withRowLimit('SELECT * FROM t FETCH FIRST 3 ROWS ONLY', 5), 'SELECT * FROM t FETCH FIRST 3 ROWS ONLY');
  });
  it('still limits when only a subquery has a LIMIT', () => {
    assert.equal(withRowLimit('SELECT * FROM (SELECT * FROM t LIMIT 5) s', 9), 'SELECT * FROM (SELECT * FROM t LIMIT 5) s\nLIMIT 9');
  });
  it('limits WITH ... SELECT but not data-modifying WITH', () => {
    assert.equal(withRowLimit('WITH x AS (SELECT 1) SELECT * FROM x', 2), 'WITH x AS (SELECT 1) SELECT * FROM x\nLIMIT 2');
    assert.equal(withRowLimit('WITH x AS (SELECT 1) DELETE FROM t', 2), 'WITH x AS (SELECT 1) DELETE FROM t');
  });
  it('does not touch locking clauses, SELECT INTO, EXPLAIN or DML', () => {
    assert.equal(withRowLimit('SELECT * FROM t FOR UPDATE', 2), 'SELECT * FROM t FOR UPDATE');
    assert.equal(withRowLimit('SELECT * INTO t2 FROM t', 2), 'SELECT * INTO t2 FROM t');
    assert.equal(withRowLimit('EXPLAIN SELECT 1', 2), 'EXPLAIN SELECT 1');
    assert.equal(withRowLimit('DELETE FROM t;', 2), 'DELETE FROM t');
  });
  it('treats "limit" inside a string as text', () => {
    assert.equal(withRowLimit("SELECT 'limit 5'", 3), "SELECT 'limit 5'\nLIMIT 3");
  });
});
