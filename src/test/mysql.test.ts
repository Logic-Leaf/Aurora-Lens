import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { engineFromVersion } from '../dataApi';
import { checkReadOnly, statementRanges, tokenize, withRowLimit } from '../guards';
import { qualified, quoteIdent, scriptDelete, selectTop } from '../sqlgen';

const kinds = (sql: string) =>
  tokenize(sql, 'mysql')
    .filter((t) => t.type !== 'space')
    .map((t) => `${t.type}:${t.text}`);

describe('engine detection', () => {
  it('recognises PostgreSQL and Aurora MySQL version strings', () => {
    assert.equal(engineFromVersion('PostgreSQL 18.3 on aarch64-unknown-linux-gnu'), 'postgres');
    assert.equal(engineFromVersion('8.0.mysql_aurora.3.08.0'), 'mysql');
  });
});

describe('MySQL tokenizer', () => {
  it('handles backtick identifiers, # comments and double-quoted strings', () => {
    assert.deepEqual(kinds('SELECT `a``b` # note; here\nFROM t'), ['word:SELECT', 'quotedIdent:`a``b`', 'comment:# note; here', 'word:FROM', 'word:t']);
    assert.deepEqual(kinds(`SELECT "it\\"s"`), ['word:SELECT', `string:"it\\"s"`]);
  });
  it('treats -- as a comment only when followed by whitespace', () => {
    assert.deepEqual(kinds('SELECT 1--1'), ['word:SELECT', 'number:1', 'punct:-', 'punct:-', 'number:1']);
    assert.deepEqual(kinds('SELECT 1 -- c'), ['word:SELECT', 'number:1', 'comment:-- c']);
  });
  it('handles backslash escapes in single-quoted strings', () => {
    assert.deepEqual(kinds("SELECT 'a\\';b'"), ['word:SELECT', "string:'a\\';b'"]);
  });
  it('splits statements using MySQL rules', () => {
    const text = "SELECT '#;' ; # ; comment\nSELECT `x;y` FROM t";
    assert.deepEqual(
      statementRanges(text, 'mysql').map((r) => text.slice(r.start, r.end)),
      ["SELECT '#;' ;", 'SELECT `x;y` FROM t'],
    );
  });
});

describe('MySQL read-only guard', () => {
  const allowed = ['SELECT * FROM `orders`', 'SHOW TABLES', 'DESCRIBE orders', "SELECT 'into outfile' AS note", 'SELECT /*+ MAX_EXECUTION_TIME(1000) */ 1'];
  for (const sql of allowed) {
    it(`allows: ${sql}`, () => assert.equal(checkReadOnly(sql, 'mysql'), undefined));
  }
  const blocked: [string, RegExp][] = [
    ["SELECT * FROM t INTO OUTFILE S3 's3://bucket/x'", /INTO/],
    ['SELECT a INTO @x FROM t', /INTO/],
    ['SELECT 1 /*!50000 , SLEEP(1) */', /executable comments/],
    ["SELECT mysql.lambda_async('arn:aws:lambda:x', '{}')", /lambda_async/],
    ["SELECT lambda_sync('arn', '{}')", /lambda_sync/],
    ["SELECT GET_LOCK('x', 10)", /get_lock/],
    ["SELECT LOAD_FILE('/etc/passwd')", /load_file/],
    ['SELECT `get_lock`(1)', /get_lock/],
    ['SET autocommit = 0', /only SELECT/],
    ['UPDATE t SET a = 1', /only SELECT/],
  ];
  for (const [sql, msg] of blocked) {
    it(`blocks: ${sql}`, () => assert.match(checkReadOnly(sql, 'mysql') ?? 'ALLOWED', msg));
  }
  it('treats "into" as an identifier in PostgreSQL and a string in MySQL (both allowed)', () => {
    assert.equal(checkReadOnly('SELECT "into" FROM t'), undefined);
    assert.equal(checkReadOnly('SELECT "into" FROM t', 'mysql'), undefined);
  });
});

describe('MySQL row limit and scripts', () => {
  it('adds LIMIT but not after LOCK IN SHARE MODE', () => {
    assert.equal(withRowLimit('SELECT * FROM t # note', 10, 'mysql'), 'SELECT * FROM t\nLIMIT 10');
    assert.equal(withRowLimit('SELECT * FROM t LOCK IN SHARE MODE', 10, 'mysql'), 'SELECT * FROM t LOCK IN SHARE MODE');
  });
  it('always backtick-quotes identifiers', () => {
    assert.equal(quoteIdent('orders', 'mysql'), '`orders`');
    assert.equal(quoteIdent('we`ird', 'mysql'), '`we``ird`');
    assert.equal(qualified('shop', 'order', 'mysql'), '`shop`.`order`');
    assert.equal(selectTop('shop', 'orders', 1000, 'mysql'), 'SELECT *\nFROM `shop`.`orders`\nLIMIT 1000;\n');
    const cols = [{ name: 'id', type: 'int', notNull: true, defaultValue: null, isPk: true, isFk: false, comment: null }];
    assert.equal(scriptDelete('shop', 'orders', cols, 'mysql'), 'DELETE FROM `shop`.`orders`\nWHERE `id` = NULL;\n');
  });
});
