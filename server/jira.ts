import type { JiraIssue, JiraResolution } from '../src/lib/jiraTypes.ts';
import { inferJiraKind, type JiraKind } from '../src/lib/jiraTypes.ts';

export interface JiraCredentials { site: string; email: string; token: string; kind?: JiraKind }
interface RawIssue {
  key: string;
  fields: { summary: string; status?: { name: string }; issuetype: { name: string; hierarchyLevel?: number }; parent?: { key: string }; [key: string]: unknown };
}

export async function detectJiraSite(site: string, fetcher: typeof fetch = fetch): Promise<{ site: string; kind: JiraKind }> {
  const validated = validateCredentials({ site, token: 'site-detection', email: 'site-detection', kind: 'datacenter' });
  if (inferJiraKind(validated.site) === 'cloud') return { site: validated.site, kind: 'cloud' };
  try {
    const response = await fetcher(`${validated.site}/rest/api/2/serverInfo`, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const info = await response.json() as { deploymentType?: string; baseUrl?: string };
      if (info.deploymentType?.toLowerCase() === 'cloud') {
        const canonical = typeof info.baseUrl === 'string' && inferJiraKind(info.baseUrl) === 'cloud'
          ? validateCredentials({ site: info.baseUrl, token: 'site-detection', email: 'site-detection', kind: 'cloud' }).site : validated.site;
        return { site: canonical, kind: 'cloud' };
      }
    }
  } catch { /* Private Data Center servers may require authentication for serverInfo. */ }
  return { site: validated.site, kind: 'datacenter' };
}

export function validateCredentials(value: unknown): JiraCredentials {
  const input = value as Partial<JiraCredentials> | null;
  if (!input || typeof input.site !== 'string' || typeof input.token !== 'string' || !input.token.trim()) throw new Error('Enter your Jira site and token.');
  let url: URL;
  try { url = new URL(input.site); } catch { throw new Error('Use your Jira site HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use your Jira site HTTPS URL without embedded credentials.');
  const kind = input.kind ?? inferJiraKind(input.site);
  if (kind !== 'cloud' && kind !== 'datacenter') throw new Error('Use your Jira Cloud or Data Center connection type.');
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  if (kind === 'cloud' && !email) throw new Error('Enter your Atlassian email for Jira Cloud.');
  const context = kind === 'datacenter' ? url.pathname.split(/\/(?:browse|secure|rest)(?:\/|$)/)[0].replace(/\/+$/, '') : '';
  return { site: `${url.origin}${context}`, email, token: input.token.trim(), kind };
}

export function createJiraClient(credentials: JiraCredentials, fetcher: typeof fetch = fetch) {
  const cache = new Map<string, { expires: number; result: JiraResolution }>();
  let epicField: Promise<string | undefined> | undefined;
  const kind = credentials.kind ?? inferJiraKind(credentials.site);
  async function request(path: string): Promise<unknown> {
    let response: Response;
    try { response = await fetcher(`${credentials.site}/rest/api/${kind === 'datacenter' ? '2' : '3'}/${path}`, {
      headers: { Authorization: kind === 'datacenter' ? `Bearer ${credentials.token}` : `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64')}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000), redirect: 'error',
    }); } catch { throw new Error('Jira connection failed. Check the site URL and your network or VPN connection.'); }
    if (!response.ok) throw new Error(response.status === 401 ? kind === 'datacenter' ? 'Jira authentication failed. Use a personal access token from this Jira site.' : 'Jira authentication failed. Check your email and API token.'
      : response.status === 403 ? 'Jira access denied. Check your project permissions.'
      : response.status === 404 ? 'Jira issue unavailable or not accessible.'
      : response.status === 429 ? 'Jira rate limit reached. Retry shortly.' : `Jira request failed (${response.status}).`);
    try { return await response.json(); } catch { throw new Error('Jira returned a login page or invalid response. Check your token and connection type.'); }
  }
  function summary(issue: RawIssue): JiraIssue {
    return { key: issue.key, summary: issue.fields.summary, status: issue.fields.status?.name ?? '', url: `${credentials.site}/browse/${encodeURIComponent(issue.key)}` };
  }
  async function resolve(key: string): Promise<JiraResolution> {
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.result;
    let original: JiraIssue | undefined;
    let current = key;
    const seen = new Set<string>();
    for (let depth = 0; depth < 10; depth++) {
      if (seen.has(current)) throw new Error('Jira parent hierarchy contains a cycle.');
      seen.add(current);
      const issue = await request(`issue/${encodeURIComponent(current)}?fields=summary,status,issuetype,parent${epicField ? `,${await epicField ?? ''}` : ''}`) as RawIssue;
      original ??= summary(issue);
      if (issue.fields.issuetype.hierarchyLevel === 1 || issue.fields.issuetype.name.toLowerCase() === 'epic') {
        const result = { issue: original, epic: summary(issue) };
        cache.set(key, { result, expires: Date.now() + 300000 });
        return result;
      }
      let parent = issue.fields.parent?.key;
      if (!parent) {
        // Older company-managed projects may still expose an Epic Link custom field.
        epicField ??= request('field').then(value => (value as Array<{ id: string; schema?: { custom?: string } }>).find(field => field.schema?.custom === 'com.pyxis.greenhopper.jira:gh-epic-link')?.id).catch(() => undefined);
        const field = await epicField;
        if (field) {
          const legacy = field in issue.fields ? issue : await request(`issue/${encodeURIComponent(current)}?fields=${encodeURIComponent(field)}`) as RawIssue;
          const link = legacy.fields[field];
          if (typeof link === 'string' && /^[A-Z][A-Z0-9_]*-\d+$/.test(link)) parent = link;
        }
      }
      if (!parent) {
        const result = { issue: original };
        cache.set(key, { result, expires: Date.now() + 300000 });
        return result;
      }
      current = parent;
    }
    throw new Error('Jira parent hierarchy is too deep to resolve.');
  }
  return { request, resolve, clear: () => cache.clear() };
}
