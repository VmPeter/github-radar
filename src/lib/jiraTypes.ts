export type JiraKind = 'cloud' | 'datacenter';

export function inferJiraKind(site: string): JiraKind {
  try { return /^[a-z0-9-]+\.atlassian\.net$/i.test(new URL(site).hostname) ? 'cloud' : 'datacenter'; }
  catch { return 'cloud'; }
}

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  url: string;
}
export interface JiraResolution {
  issue?: JiraIssue;
  epic?: JiraIssue;
  error?: string;
}
