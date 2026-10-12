import type { PullRequestNode } from './github.ts';

import type { JiraIssue, JiraResolution } from './jiraTypes.ts';
export type { JiraIssue, JiraResolution } from './jiraTypes.ts';
export interface EpicPr {
  pr: PullRequestNode;
  owner: string;
  name: string;
}
export interface EpicGroup {
  key: string;
  epic?: JiraIssue;
  title: string;
  prs: Array<EpicPr & { keys: string[] }>;
}

export function jiraKeys(pr: Pick<PullRequestNode, 'title' | 'headRefName' | 'body'>): string[] {
  return [...new Set([pr.title, pr.headRefName, pr.body ?? ''].flatMap(text =>
    [...text.matchAll(/\b([A-Z][A-Z0-9_]*-\d+)\b/gi)].map(match => match[1].toUpperCase())))];
}

export function groupByEpic(prs: EpicPr[], resolutions: Record<string, JiraResolution>): EpicGroup[] {
  const groups = new Map<string, EpicGroup>();
  const seen = new Set<string>();
  for (const entry of prs) {
    if (seen.has(entry.pr.id)) continue;
    seen.add(entry.pr.id);
    const keys = jiraKeys(entry.pr);
    const epics = new Map(keys.flatMap(key => resolutions[key]?.epic ? [[resolutions[key].epic!.key, resolutions[key].epic!] as const] : []));
    const targets: Array<{ key: string; epic?: JiraIssue; title: string }> = epics.size
      ? [...epics.values()].map(epic => ({ key: epic.key, epic, title: epic.summary }))
      : [{ key: keys.some(key => !resolutions[key] || resolutions[key].error) ? 'unresolved' : keys.length ? 'no-epic' : 'no-issue',
          title: keys.some(key => !resolutions[key] || resolutions[key].error) ? 'Jira lookup pending or unavailable' : keys.length ? 'Issues without an epic' : 'No Jira issue found' }];
    for (const target of targets) {
      const group = groups.get(target.key) ?? { ...target, prs: [] };
      group.prs.push({ ...entry, keys });
      groups.set(target.key, group);
    }
  }
  return [...groups.values()].sort((a, b) => Number(Boolean(b.epic)) - Number(Boolean(a.epic)) || a.key.localeCompare(b.key, undefined, { numeric: true }));
}
