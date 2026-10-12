import type { JiraKind } from './jiraTypes';
export interface JiraConfig { configured: boolean; site: string; email: string; kind?: JiraKind }

export async function jiraRequest<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/jira/${path}`, {
    method, signal,
    headers: { 'Content-Type': 'application/json', 'X-Radar-Local': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let result;
  try { result = await response.json(); } catch { throw new Error('Local Jira service unavailable. Run Radar using npm run dev or npm run preview.'); }
  if (!response.ok) throw new Error(result.error ?? 'Jira request failed.');
  return result as T;
}
