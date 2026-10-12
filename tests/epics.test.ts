import test from 'node:test';
import assert from 'node:assert/strict';
import { jiraKeys, groupByEpic } from '../src/lib/epics.ts';
import type { PullRequestNode } from '../src/lib/github.ts';
import { createJiraClient, detectJiraSite, validateCredentials } from '../server/jira.ts';

const issue = (key: string, level = 0, parent?: string) => ({ key, fields: { summary: `Summary ${key}`, status: { name: 'In Progress' }, issuetype: { name: level === 1 ? 'Epic' : level === -1 ? 'Subtask' : 'Task', hierarchyLevel: level }, ...(parent ? { parent: { key: parent } } : {}) } });
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const credentials = { site: 'https://example.atlassian.net', email: 'person@example.com', token: 'secret' };
const pr = (id: string, title: string, body = '') => ({ id, title, body, headRefName: 'feature/uem-12' }) as PullRequestNode;

test('extracts deduplicated Jira keys from title, branch and description', () => {
  assert.deepEqual(jiraKeys({ title: '[UEM-12] fix', headRefName: 'feature/uem-12', body: 'Relates to https://example.atlassian.net/browse/ABC-99 and UEM-12' }), ['UEM-12', 'ABC-99']);
  assert.deepEqual(jiraKeys({ title: 'No issue', headRefName: 'feature/fix' }), []);
});

test('groups across repos and multiple epics, deduplicates PRs and preserves unmatched issues', () => {
  const first = { pr: pr('1', 'UEM-12 ABC-99'), owner: 'org', name: 'ios' };
  const groups = groupByEpic([first, first, { pr: pr('2', 'UEM-12'), owner: 'org', name: 'android' },
    { pr: { ...pr('3', 'No Jira'), headRefName: 'feature' }, owner: 'org', name: 'backend' },
    { pr: { ...pr('4', 'XYZ-1'), headRefName: 'feature' }, owner: 'org', name: 'backend' },
    { pr: { ...pr('5', 'ERR-1'), headRefName: 'feature' }, owner: 'org', name: 'backend' },
  ], {
    'UEM-12': { epic: { key: 'UEM-10', summary: 'Payments', status: 'In progress', url: '' } },
    'ABC-99': { epic: { key: 'ABC-9', summary: 'Accounts', status: 'In progress', url: '' } },
    'XYZ-1': { issue: { key: 'XYZ-1', summary: 'Standalone', status: '', url: '' } },
    'ERR-1': { error: 'Jira access denied.' },
  });
  assert.equal(groups.find(group => group.key === 'UEM-10')?.prs.length, 2);
  for (const key of ['ABC-9', 'no-issue', 'no-epic', 'unresolved']) assert.equal(groups.find(group => group.key === key)?.prs.length, 1);
});

test('follows subtask parents to epic, handles direct epic references and caches results', async () => {
  const calls: string[] = [];
  const records = { 'UEM-1': issue('UEM-1', -1, 'UEM-2'), 'UEM-2': issue('UEM-2', 0, 'UEM-3'), 'UEM-3': issue('UEM-3', 1) };
  const client = createJiraClient(credentials, async (url, init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), `Basic ${Buffer.from('person@example.com:secret').toString('base64')}`);
    calls.push(String(url));
    const key = String(url).match(/issue\/([^?]+)/)?.[1] as keyof typeof records;
    return reply(records[key]);
  });
  const result = await client.resolve('UEM-1');
  assert.equal(result.issue?.key, 'UEM-1'); assert.equal(result.epic?.key, 'UEM-3');
  await client.resolve('UEM-1'); assert.equal(calls.length, 3);
  assert.equal((await client.resolve('UEM-3')).epic?.key, 'UEM-3');
  client.clear(); await client.resolve('UEM-1'); assert.equal(calls.length, 7);
});

test('supports legacy Epic Link and distinguishes an issue with no epic', async () => {
  const client = createJiraClient(credentials, async url => {
    const path = String(url);
    if (path.endsWith('/field')) return reply([{ id: 'customfield_10014', schema: { custom: 'com.pyxis.greenhopper.jira:gh-epic-link' } }]);
    if (path.includes('/issue/UEM-3')) return reply(issue('UEM-3', 1));
    if (path.includes('/issue/UEM-4')) return reply({ ...issue('UEM-4'), fields: { ...issue('UEM-4').fields, customfield_10014: null } });
    if (path.includes('fields=customfield_10014')) return reply({ fields: { customfield_10014: 'UEM-3' } });
    return reply(issue('UEM-1'));
  });
  assert.equal((await client.resolve('UEM-1')).epic?.key, 'UEM-3');
  assert.equal((await client.resolve('UEM-4')).epic, undefined);
});

test('rejects hierarchy cycles and reports auth/rate errors without exposing response bodies', async () => {
  const cycle = createJiraClient(credentials, async () => reply(issue('UEM-1', 0, 'UEM-1')));
  await assert.rejects(cycle.resolve('UEM-1'), /cycle/);
  for (const [status, expected] of [[401, /authentication/], [403, /denied/], [404, /unavailable/], [429, /rate limit/]] as const) {
    const client = createJiraClient(credentials, async () => reply({ message: 'secret upstream data' }, status));
    await assert.rejects(client.resolve('UEM-1'), error => error instanceof Error && expected.test(error.message) && !error.message.includes('secret'));
  }
});

test('supports custom HTTPS Jira sites and rejects insecure or embedded credentials', () => {
  assert.equal(validateCredentials({ ...credentials, site: `${credentials.site}/browse/UEM-1` }).site, credentials.site);
  assert.equal(validateCredentials({ site: 'https://jira.prod.vipps.io', token: 'personal-token' }).kind, 'datacenter');
  assert.equal(validateCredentials({ site: 'https://jira.example.com/jira/', token: 'personal-token' }).site, 'https://jira.example.com/jira');
  for (const site of ['http://example.atlassian.net', 'https://user:pass@example.atlassian.net', 'http://localhost:9999', 'invalid', 'file:///tmp/jira']) assert.throws(() => validateCredentials({ ...credentials, site }));
  assert.throws(() => validateCredentials({ ...credentials, email: '' }), /email/);
});

test('detects custom Cloud aliases without credentials and uses their canonical Cloud URL', async () => {
  const detected = await detectJiraSite('https://jira.prod.vipps.io', async (url, init) => {
    assert.equal(String(url), 'https://jira.prod.vipps.io/rest/api/2/serverInfo');
    assert.equal(new Headers(init?.headers).has('Authorization'), false);
    return reply({ deploymentType: 'Cloud', baseUrl: 'https://vipps.atlassian.net' });
  });
  assert.deepEqual(detected, { kind: 'cloud', site: 'https://vipps.atlassian.net' });
  const client = createJiraClient(validateCredentials({ ...credentials, ...detected }), async (url, init) => {
    assert.equal(String(url), 'https://vipps.atlassian.net/rest/api/3/myself');
    assert.ok(new Headers(init?.headers).get('Authorization')?.startsWith('Basic '));
    return reply({ accountId: 'test' });
  });
  await client.request('myself');
});

test('Data Center uses REST v2 bearer authentication and preserves context paths', async () => {
  const client = createJiraClient(validateCredentials({ site: 'https://jira.example.com/jira', token: 'personal-token' }), async (url, init) => {
    assert.equal(String(url), 'https://jira.example.com/jira/rest/api/2/issue/UEM-3?fields=summary,status,issuetype,parent');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer personal-token');
    return reply(issue('UEM-3', 1));
  });
  assert.equal((await client.resolve('UEM-3')).epic?.url, 'https://jira.example.com/jira/browse/UEM-3');
});
