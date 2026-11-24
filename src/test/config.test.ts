import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSections, planProfiles, SsoSettings, ssoSettingsProblems } from '../awsConfig';
import { csvCell, toCsv } from '../formats';
import { Connection, connectionProblems, isSsoStartUrl } from '../validate';

const conn: Connection = {
  name: 'orders-dev',
  environment: 'dev',
  profile: 'orders-dev',
  region: 'us-east-1',
  clusterArn: 'arn:aws:rds:us-east-1:111122223333:cluster:orders-dev',
  secretArn: 'arn:aws:secretsmanager:us-east-1:111122223333:secret:rds!cluster-0000-AbCdEf',
  database: 'orders',
};
const sso: SsoSettings = { name: 'auroralens', startUrl: 'https://example.awsapps.com/start', region: 'us-east-1', roleName: 'DeveloperAccess' };

describe('connectionProblems', () => {
  it('accepts a valid connection, including prod', () => {
    assert.deepEqual(connectionProblems(conn), []);
    assert.deepEqual(connectionProblems({ ...conn, environment: 'prod' }), []);
  });
  it('rejects newline / INI injection in the profile name', () => {
    assert.ok(connectionProblems({ ...conn, profile: 'x]\ncredential_process = touch /tmp/pwned\n[profile y' }).length);
  });
  it('rejects mismatched regions and accounts', () => {
    assert.ok(connectionProblems({ ...conn, region: 'eu-west-1' }).some((p) => /Cluster is in us-east-1/.test(p)));
    assert.ok(
      connectionProblems({ ...conn, secretArn: 'arn:aws:secretsmanager:us-east-1:999999999999:secret:x' }).some((p) => /same account/.test(p)),
    );
  });
  it('rejects unknown environments and bad ARNs', () => {
    assert.ok(connectionProblems({ ...conn, environment: 'production' }).length);
    assert.ok(connectionProblems({ ...conn, clusterArn: 'arn:aws:rds:us-east-1:1:cluster:x' }).length);
  });
});

describe('isSsoStartUrl', () => {
  it('accepts real portal URL shapes', () => {
    assert.ok(isSsoStartUrl('https://my-co.awsapps.com/start'));
    assert.ok(isSsoStartUrl('https://my-co.awsapps.com/start/#/'));
    assert.ok(isSsoStartUrl('https://identitycenter.amazonaws.com/ssoins-0123456789abcdef'));
  });
  it('rejects injection, http, other hosts and credentials in the URL', () => {
    assert.ok(!isSsoStartUrl('https://my-co.awsapps.com/start\ncredential_process = evil'));
    assert.ok(!isSsoStartUrl('http://my-co.awsapps.com/start'));
    assert.ok(!isSsoStartUrl('https://evil.example.com/start'));
    assert.ok(!isSsoStartUrl('https://awsapps.com.evil.com/start'));
    assert.ok(!isSsoStartUrl('https://user:pw@my-co.awsapps.com/start'));
  });
});

describe('planProfiles', () => {
  it('plans a session and a profile for an empty config', () => {
    const plan = planProfiles([conn], sso, '');
    assert.equal(plan.addsSession, true);
    assert.deepEqual(plan.profiles, ['orders-dev']);
    assert.equal(
      plan.addition,
      '\n[sso-session auroralens]\nsso_start_url = https://example.awsapps.com/start\nsso_region = us-east-1\nsso_registration_scopes = sso:account:access\n' +
        '\n[profile orders-dev]\nsso_session = auroralens\nsso_account_id = 111122223333\nsso_role_name = DeveloperAccess\nregion = us-east-1\n',
    );
  });
  it('adds nothing when the session and profile already exist', () => {
    const existing = '[sso-session auroralens]\nsso_start_url = x\n\n[profile orders-dev]\nregion = us-east-1\n';
    assert.equal(planProfiles([conn], sso, existing).addition, '');
  });
  it('matches section headers exactly, not as substrings', () => {
    const existing = '# [profile orders-dev]\n[profile orders-dev-old]\n';
    assert.deepEqual(planProfiles([conn], sso, existing).profiles, ['orders-dev']);
    assert.ok(parseSections('[default]\n[ profile a ]').profiles.has('a'));
  });
  it('refuses to plan with injected SSO settings', () => {
    assert.throws(() => planProfiles([conn], { ...sso, roleName: 'Dev\ncredential_process = evil' }, ''));
    assert.throws(() => planProfiles([conn], { ...sso, startUrl: 'https://x.awsapps.com/start\n[profile z]' }, ''));
    assert.ok(ssoSettingsProblems(null).length);
  });
  it('never writes an invalid connection to the file', () => {
    const bad = { ...conn, profile: 'a\nb' };
    assert.deepEqual(planProfiles([bad], sso, '[sso-session auroralens]\n').profiles, []);
  });
});

describe('csv', () => {
  it('neutralises spreadsheet formulas in text but not real numbers', () => {
    assert.equal(csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
    assert.equal(csvCell('+1'), "'+1");
    assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
    assert.equal(csvCell(-5), '-5');
    assert.equal(csvCell(null), '');
  });
  it('quotes commas, quotes, newlines and leading/trailing spaces', () => {
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('a"b'), '"a""b"');
    assert.equal(csvCell('a\nb'), '"a\nb"');
    assert.equal(csvCell(' a'), '" a"');
  });
  it('renders a whole table with CRLF line endings', () => {
    assert.equal(toCsv(['a', 'b'], [[1, 'x'], [null, { k: 1 }]]), 'a,b\r\n1,x\r\n,"{""k"":1}"\r\n');
  });
});
