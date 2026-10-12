import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { jiraPlugin } from '../server/jiraPlugin.ts';

test('local Jira service persists private credentials, resolves epics, rejects cross-site calls and disconnects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'radar-jira-test-'));
  const previousCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  process.chdir(directory);
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://example.atlassian.net/')) return originalFetch(url, init);
    assert.equal(init?.method ?? 'GET', 'GET', 'Jira is read-only');
    if (String(url).endsWith('/myself')) return new Response(JSON.stringify({ accountId: 'test' }));
    const key = String(url).includes('/issue/UEM-1?') ? 'UEM-1' : 'UEM-100';
    return new Response(JSON.stringify({ key, fields: { summary: key, status: { name: 'In Progress' }, issuetype: { name: key === 'UEM-100' ? 'Epic' : 'Task', hierarchyLevel: key === 'UEM-100' ? 1 : 0 }, ...(key === 'UEM-1' ? { parent: { key: 'UEM-100' } } : {}) } }));
  };
  const server = await createServer({ configFile: false, root: directory, plugins: [jiraPlugin()], server: { host: '127.0.0.1', port: 0, fs: { deny: ['**/.local/**'] } } });
  try {
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const call = (path: string, method = 'GET', body?: unknown, headers = {}) => originalFetch(`${origin}${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Radar-Local': '1', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal((await (await call('/api/jira/config')).json()).configured, false);
    assert.equal((await call('/api/jira/config', 'POST', {}, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await originalFetch(`${origin}/api/jira/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    const saved = await call('/api/jira/config', 'POST', { site: 'https://example.atlassian.net', email: 'person@example.com', token: 'test-secret' });
    assert.equal(saved.status, 200);
    assert.ok(!(await saved.text()).includes('test-secret'));
    const file = join(directory, '.local/jira.json');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).token, 'test-secret');
    assert.ok(!(await (await call('/api/jira/config')).text()).includes('test-secret'));
    const blocked = await call('/.local/jira.json');
    assert.equal(blocked.status, 403);
    assert.ok(!(await blocked.text()).includes('test-secret'));
    assert.equal((await call('/api/jira/resolve', 'POST', { keys: ['invalid'] })).status, 400);
    const resolved = await (await call('/api/jira/resolve', 'POST', { keys: ['UEM-1'] })).json();
    assert.equal(resolved['UEM-1'].epic.key, 'UEM-100');
    assert.equal((await call('/api/jira/config', 'DELETE')).status, 200);
    await assert.rejects(readFile(file), { code: 'ENOENT' });
    assert.equal((await call('/api/jira/resolve', 'POST', { keys: ['UEM-1'] })).status, 409);
  } finally {
    await server.close(); globalThis.fetch = originalFetch; process.chdir(previousCwd); await rm(directory, { recursive: true, force: true });
  }
});
