import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { createJiraClient, detectJiraSite, validateCredentials, type JiraCredentials } from './jira.ts';
import type { JiraResolution } from '../src/lib/jiraTypes.ts';

export function jiraPlugin(): Plugin {
  const directory = resolve('.local');
  const file = resolve(directory, 'jira.json');
  let credentials: JiraCredentials | undefined;
  let client: ReturnType<typeof createJiraClient> | undefined;
  const ready = readFile(file, 'utf8').then(text => {
    credentials = validateCredentials(JSON.parse(text));
    client = createJiraClient(credentials);
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') console.error('Could not load local Jira settings. Reconnect Jira in the Epics view.');
  });
  let tail: Promise<unknown> = Promise.resolve();
  async function body(req: IncomingMessage): Promise<unknown> {
    let text = '';
    for await (const chunk of req) {
      text += chunk;
      if (text.length > 65536) throw new Error('Request too large.');
    }
    return JSON.parse(text);
  }
  function reply(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    // Local-only, same-origin service. JSON + custom header prevent cross-site form writes.
    const host = req.headers.host ?? '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host) ||
      (req.headers.origin && req.headers.origin !== `http://${host}`) ||
      (req.method !== 'GET' && (req.headers['x-radar-local'] !== '1' || !req.headers['content-type']?.startsWith('application/json')))) {
      reply(res, 403, { error: 'Jira connections are available only from this local app.' }); return;
    }
    await ready;
    const path = req.url?.split('?')[0];
    try {
      if (path === '/api/jira/site' && req.method === 'POST') {
        const input = await body(req) as { site?: unknown };
        if (typeof input.site !== 'string') throw new Error('Enter your Jira site URL.');
        reply(res, 200, await detectJiraSite(input.site));
      } else if (path === '/api/jira/config' && req.method === 'GET') {
        reply(res, 200, { configured: Boolean(client), site: credentials?.site ?? '', email: credentials?.email ?? '', kind: credentials?.kind });
      } else if (path === '/api/jira/config' && req.method === 'POST') {
        const input = await body(req) as Partial<JiraCredentials>;
        const detected = !input.kind && typeof input.site === 'string' ? await detectJiraSite(input.site) : undefined;
        const next = validateCredentials({ ...input, ...detected });
        const nextClient = createJiraClient(next);
        await nextClient.request('myself');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
        await rename(`${file}.tmp`, file);
        credentials = next; client = nextClient;
        reply(res, 200, { configured: true, site: next.site, email: next.email, kind: next.kind });
      } else if (path === '/api/jira/config' && req.method === 'DELETE') {
        await rm(file, { force: true }); credentials = undefined; client = undefined;
        reply(res, 200, { configured: false, site: '', email: '' });
      } else if (path === '/api/jira/resolve' && req.method === 'POST') {
        if (!client) { reply(res, 409, { error: 'Connect Jira to resolve epics.' }); return; }
        const input = await body(req) as { keys?: unknown; refresh?: boolean };
        if (!Array.isArray(input.keys) || input.keys.length > 100 || input.keys.some(key => typeof key !== 'string' || !/^[A-Z][A-Z0-9_]*-\d+$/.test(key))) {
          reply(res, 400, { error: 'Provide up to 100 valid Jira issue keys.' }); return;
        }
        if (input.refresh) client.clear();
        const results: Record<string, JiraResolution> = {};
        for (const key of new Set(input.keys as string[])) {
          try { results[key] = await client.resolve(key); }
          catch (error) { results[key] = { error: error instanceof Error && error.message.startsWith('Jira') ? error.message : 'Jira lookup failed. Retry shortly.' }; }
        }
        reply(res, 200, results);
      } else reply(res, 404, { error: 'Unknown Jira endpoint.' });
    } catch (error) {
      reply(res, 400, { error: error instanceof Error && /^(Jira|Enter |Use your)/.test(error.message) ? error.message : 'Could not save Jira settings. Check the URL and try again.' });
    }
  }
  const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith('/api/jira/')) { next(); return; }
    const task = tail.then(() => handle(req, res));
    tail = task.catch(() => { if (!res.writableEnded) reply(res, 500, { error: 'Local Jira service failed.' }); });
  };
  return { name: 'local-jira', configureServer(server) { server.middlewares.use(middleware); }, configurePreviewServer(server) { server.middlewares.use(middleware); } };
}
