import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { explainError, isAuthError } from '../explain';
import { formatBytes, formatCount, toJson, toMarkdown } from '../formats';
import { buildDdl, ColumnInfo, qualified, quoteIdent, scriptDelete, scriptInsert, scriptSelect, scriptUpdate, selectTop } from '../sqlgen';
import { connectionFieldErrors } from '../validate';

const cols: ColumnInfo[] = [
  { name: 'id', type: 'bigint', notNull: true, defaultValue: "nextval('t_id_seq'::regclass)", isPk: true, isFk: false, comment: null },
  { name: 'Order', type: 'text', notNull: false, defaultValue: null, isPk: false, isFk: false, comment: "customer's order" },
  { name: 'account_id', type: 'uuid', notNull: true, defaultValue: null, isPk: false, isFk: true, comment: null },
];

describe('sqlgen', () => {
  it('quotes identifiers only when required', () => {
    assert.equal(quoteIdent('accounts'), 'accounts');
    assert.equal(quoteIdent('Order'), '"Order"');
    assert.equal(quoteIdent('user'), '"user"');
    assert.equal(quoteIdent('my table'), '"my table"');
    assert.equal(quoteIdent('we"ird'), '"we""ird"');
    assert.equal(qualified('public', 'select'), 'public."select"');
  });
  it('builds Select Top and an explicit column SELECT', () => {
    assert.equal(selectTop('public', 'accounts', 1000), 'SELECT *\nFROM public.accounts\nLIMIT 1000;\n');
    assert.match(scriptSelect('public', 't', cols), /SELECT\n {2}id,\n {2}"Order",\n {2}account_id\nFROM public\.t/);
  });
  it('builds INSERT / UPDATE / DELETE templates keyed on the primary key', () => {
    const ins = scriptInsert('public', 't', cols);
    assert.match(ins, /INSERT INTO public\.t \(\n {2}id,\n {2}"Order",\n {2}account_id\n\) VALUES \(/);
    assert.match(ins, /-- id: bigint, PK, default nextval/);
    assert.match(scriptUpdate('public', 't', cols), /WHERE id = NULL;/);
    assert.doesNotMatch(scriptUpdate('public', 't', cols), /SET[\s\S]*\bid = NULL,/);
    assert.equal(scriptDelete('s', 't', cols), 'DELETE FROM s.t\nWHERE id = NULL;\n');
    assert.match(scriptDelete('s', 't', [cols[1]]), /no primary key/);
  });
  it('reconstructs table DDL with constraints, partitioning, indexes and comments', () => {
    const ddl = buildDdl({
      schema: 'public',
      name: 'events',
      kind: 'p',
      columns: cols,
      constraints: [
        { name: 'events_account_fk', type: 'f', definition: 'FOREIGN KEY (account_id) REFERENCES accounts(id)' },
        { name: 'events_pkey', type: 'p', definition: 'PRIMARY KEY (id)' },
      ],
      indexes: ['CREATE INDEX events_account_idx ON public.events USING btree (account_id)'],
      partitionKey: 'RANGE (id)',
      viewDefinition: null,
      comment: "it's partitioned",
    });
    assert.match(ddl, /CREATE TABLE public\.events \(\n {2}id bigint DEFAULT nextval\('t_id_seq'::regclass\) NOT NULL,/);
    assert.ok(ddl.indexOf('events_pkey') < ddl.indexOf('events_account_fk'), 'primary key comes first');
    assert.match(ddl, /\)\nPARTITION BY RANGE \(id\);/);
    assert.match(ddl, /CREATE INDEX events_account_idx ON public\.events USING btree \(account_id\);/);
    assert.match(ddl, /COMMENT ON TABLE public\.events IS 'it''s partitioned';/);
    assert.match(ddl, /COMMENT ON COLUMN public\.events\."Order" IS 'customer''s order';/);
  });
  it('reconstructs a view', () => {
    const ddl = buildDdl({ schema: 'public', name: 'v', kind: 'v', columns: [], constraints: [], indexes: [], partitionKey: null, viewDefinition: ' SELECT 1;', comment: null });
    assert.equal(ddl, 'CREATE OR REPLACE VIEW public.v AS\nSELECT 1;\n');
  });
});

describe('formats', () => {
  it('renders JSON objects keyed by column', () => {
    assert.deepEqual(JSON.parse(toJson(['a', 'b'], [[1, null]])), [{ a: 1, b: null }]);
  });
  it('renders a Markdown table, escaping pipes and newlines', () => {
    assert.equal(toMarkdown(['a', 'b'], [['x|y', 'l1\nl2'], [null, 2]]), '| a | b |\n| --- | --- |\n| x\\|y | l1<br>l2 |\n| *NULL* | 2 |\n');
  });
  it('formats counts and sizes compactly', () => {
    assert.equal(formatCount(950), '950');
    assert.equal(formatCount(12_400), '12.4K');
    assert.equal(formatCount(3_100_000), '3.1M');
    assert.equal(formatCount(250_000_000), '250M');
    assert.equal(formatBytes(1536), '1.5 KB');
  });
});

describe('explainError', () => {
  it('recognises expired SSO sessions as auth errors', () => {
    assert.ok(isAuthError({ name: 'CredentialsProviderError', message: 'x' }));
    assert.ok(isAuthError(new Error('The SSO session associated with this profile has expired')));
    assert.ok(!isAuthError(new Error('invalid input syntax for type json: Token "x" is invalid')));
  });
  it('explains a disabled Data API with the exact fix command', () => {
    const e = explainError(new Error('HttpEndpoint is not enabled for cluster x'), { clusterArn: 'arn:aws:rds:us-east-1:1:cluster:x' });
    assert.match(e.title, /Data API is not enabled/);
    assert.match(e.fix, /enable-http-endpoint --resource-arn arn:aws:rds:us-east-1:1:cluster:x/);
  });
  it('explains missing IAM, secrets, database and read-only errors', () => {
    assert.match(explainError(new Error('User: x is not authorized to perform: rds-data:ExecuteStatement')).title, /IAM permission/);
    assert.match(explainError(new Error('User: x is not authorized to perform: cloudwatch:GetMetricData')).title, /metrics/);
    assert.match(explainError(new Error('not authorized to perform: secretsmanager:GetSecretValue')).title, /secret/);
    assert.match(explainError(new Error('database "nope" does not exist'), { database: 'nope' }).title, /"nope" does not exist/);
    assert.match(explainError(new Error('ERROR: cannot execute nextval() in a read-only transaction')).title, /read-only/);
    assert.match(explainError({ name: 'DatabaseResumingException', message: 'x' }).title, /resuming/);
  });
  it('falls back to the raw message', () => {
    assert.deepEqual(explainError(new Error('something odd')), { title: 'The request failed', fix: 'something odd' });
  });
});

describe('connectionFieldErrors', () => {
  it('reports each bad field separately', () => {
    const e = connectionFieldErrors({ name: '', environment: 'dev', profile: 'p', region: 'us-east-1', clusterArn: 'x', secretArn: 'y', database: 'd' });
    assert.deepEqual(Object.keys(e).sort(), ['clusterArn', 'name', 'secretArn']);
  });
});

describe('fieldValue (Data API typed records)', () => {
  it('converts every field kind', async () => {
    const { fieldValue } = await import('../dataApi');
    assert.equal(fieldValue({ isNull: true }), null);
    assert.equal(fieldValue({ stringValue: '12.5' }), '12.5');
    assert.equal(fieldValue({ longValue: 42 }), 42);
    assert.equal(fieldValue({ doubleValue: 1.5 }), 1.5);
    assert.equal(fieldValue({ booleanValue: false }), false);
    assert.equal(fieldValue({ blobValue: new Uint8Array([0xde, 0xad]) }), '\\xdead');
    assert.deepEqual(fieldValue({ arrayValue: { longValues: [1, 2] } }), [1, 2]);
    assert.deepEqual(fieldValue({ arrayValue: { arrayValues: [{ stringValues: ['a'] }] } }), [['a']]);
  });
});
