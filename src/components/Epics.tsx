import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useConfig } from '../config/configStore';
import { useAllPullRequests } from '../hooks/usePullRequests';
import { matchesFilters, type Filters } from '../lib/filters';
import { groupByEpic, jiraKeys, type JiraResolution } from '../lib/epics';
import { jiraRequest, type JiraConfig } from '../lib/jira';
import { deriveStatus } from '../lib/status';
import { useRefreshInterval } from '../lib/refreshInterval';
import { JiraSettings } from './JiraSettings';
import { PrCard } from './PrCard';
import { ReviewEligibilityNotice } from './ReviewEligibilityNotice';

interface Props {
  filters: Filters;
  viewer: string | null;
  refreshSignal: number;
  onSummaryChange: (summary: { isFetching: boolean; lastUpdated: number }) => void;
}
export function Epics({ filters, viewer, refreshSignal, onSummaryChange }: Props) {
  const { repos } = useConfig();
  const { entries, busy, refresh } = useAllPullRequests(repos);
  const { value: interval } = useRefreshInterval();
  const client = useQueryClient();
  const [settings, setSettings] = useState(false);
  const [sort, setSort] = useState('key');
  const config = useQuery({ queryKey: ['jira-config'], queryFn: () => jiraRequest<JiraConfig>('config'), retry: false, refetchOnWindowFocus: false });
  const prs = entries.flatMap(entry => (entry.query.data?.pullRequests.nodes ?? []).map(pr => ({ pr, owner: entry.repo.owner, name: entry.repo.name })));
  const keys = [...new Set(prs.flatMap(entry => jiraKeys(entry.pr)))].sort();
  const consumedRefresh = useRef(refreshSignal);
  const clearedRefresh = useRef(refreshSignal);
  const lookup = useQuery({
    queryKey: ['jira-epics', config.data?.site, config.data?.email, config.dataUpdatedAt, keys, refreshSignal],
    enabled: Boolean(config.data?.configured && keys.length), staleTime: 300000,
    retry: false, refetchOnWindowFocus: false, refetchInterval: interval ?? false,
    queryFn: async ({ signal }) => {
      const result: Record<string, JiraResolution> = {};
      const clear = clearedRefresh.current !== refreshSignal;
      clearedRefresh.current = refreshSignal;
      for (let offset = 0; offset < keys.length; offset += 100) {
        Object.assign(result, await jiraRequest<Record<string, JiraResolution>>('resolve', 'POST', { keys: keys.slice(offset, offset + 100), refresh: clear && offset === 0 }, signal));
      }
      return result;
    },
  });
  const groups = useMemo(() => {
    const result = groupByEpic(prs.filter(entry => matchesFilters(entry.pr, filters, viewer)), lookup.data ?? {});
    if (sort === 'name') result.sort((a, b) => Number(Boolean(b.epic)) - Number(Boolean(a.epic)) || a.title.localeCompare(b.title));
    if (sort === 'activity') result.sort((a, b) => Number(Boolean(b.epic)) - Number(Boolean(a.epic)) || Math.max(...b.prs.map(entry => Date.parse(entry.pr.updatedAt))) - Math.max(...a.prs.map(entry => Date.parse(entry.pr.updatedAt))));
    return result;
  }, [prs, lookup.data, filters, viewer, sort]);
  const lastUpdated = entries.reduce((latest, entry) => Math.max(latest, entry.query.dataUpdatedAt), 0);
  useEffect(() => { onSummaryChange({ isFetching: busy || lookup.isFetching, lastUpdated }); }, [busy, lookup.isFetching, lastUpdated, onSummaryChange]);
  useEffect(() => {
    if (consumedRefresh.current === refreshSignal) return;
    consumedRefresh.current = refreshSignal; refresh();
  }, [refreshSignal, refresh]);
  function saved() { client.removeQueries({ queryKey: ['jira-epics'] }); void client.invalidateQueries({ queryKey: ['jira-config'] }); }
  function retryJira() { clearedRefresh.current = -1; void lookup.refetch(); }
  return <div className="space-y-6">
    {filters.canReview && <ReviewEligibilityNotice entries={entries} />}
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <h2 className="font-semibold">Pull requests by epic</h2>
      {config.data?.configured && <span className="text-slate-500">{new URL(config.data.site).hostname}</span>}
      <label className="ml-auto">Sort by <select className="rounded border bg-transparent p-1" value={sort} onChange={event => setSort(event.target.value)}>
        <option value="key">Epic key</option><option value="name">Epic name</option><option value="activity">Latest PR activity</option>
      </select></label>
      <button type="button" className="rounded border px-3 py-1" disabled={!config.data} onClick={() => setSettings(true)}>{config.data?.configured ? 'Jira settings' : 'Connect Jira'}</button>
    </div>
    {config.isPending && <p role="status" className="text-sm">Loading Jira settings…</p>}
    {config.isError && <p role="alert" className="text-sm text-red-600">{config.error.message} <button className="underline" onClick={() => void config.refetch()}>Retry</button></p>}
    {config.data && !config.data.configured && <p className="card p-4 text-sm">Connect Jira to find each PR’s issue and parent epic. Issue keys are read from PR titles, branches and descriptions.</p>}
    {lookup.isFetching && <p role="status" className="text-sm text-slate-500">Resolving Jira issues and epics…</p>}
    {entries.filter(entry => entry.query.isError).map(entry => <p key={`${entry.repo.owner}/${entry.repo.name}`} role="alert" className="text-sm text-red-600">{entry.repo.owner}/{entry.repo.name}: {entry.query.error?.message} <button className="underline" onClick={entry.query.refetch}>Retry</button></p>)}
    {entries.some(entry => entry.incomplete) && <p className="text-xs text-slate-500">Repository loading is incomplete; epic counts reflect PRs loaded so far.</p>}
    {groups.length === 0 && <p className="text-sm text-slate-500">{busy ? 'Loading pull requests…' : 'No pull requests match the current filters.'}</p>}
    {groups.map(group => {
      const statuses = group.prs.map(entry => deriveStatus(entry.pr));
      return <section key={group.key} className="space-y-3">
        <header className="flex flex-wrap items-center gap-2 border-b border-slate-200 pb-2 dark:border-slate-800">
          {group.epic ? <a className="font-semibold hover:underline" href={group.epic.url} target="_blank" rel="noreferrer">{group.key} · {group.title}</a> : <h3 className="font-semibold">{group.title}</h3>}
          {group.epic?.status && <span className="pill bg-slate-100 dark:bg-slate-800">{group.epic.status}</span>}
          {group.key === 'unresolved' && (lookup.isError || group.prs.some(entry => entry.keys.some(key => lookup.data?.[key]?.error))) && <button className="text-xs underline" disabled={lookup.isFetching} onClick={retryJira}>Retry Jira</button>}
          <span className="ml-auto text-xs text-slate-500">{group.prs.length} PRs · {statuses.filter(status => status.readyToMerge).length} ready · {statuses.filter(status => status.overall === 'failure' || status.overall === 'changes_requested').length} need attention · {statuses.filter(status => !status.approved && !status.isDraft).length} awaiting review</span>
        </header>
        {group.key === 'unresolved' && lookup.isError && <p role="alert" className="text-sm text-red-600">{lookup.error.message}</p>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {group.prs.map(entry => <div key={entry.pr.id} className="space-y-1">
            <div className="flex flex-wrap gap-2 text-xs text-slate-500"><span>{entry.owner}/{entry.name}</span>
              {entry.keys.map(key => <span key={key}>
                {config.data?.configured ? <a className="underline" href={`${config.data.site}/browse/${encodeURIComponent(key)}`} target="_blank" rel="noreferrer" title={lookup.data?.[key]?.issue?.summary}>{key}</a> : key}
                {lookup.data?.[key]?.error && <span className="ml-1 text-red-600">{lookup.data[key].error}</span>}
              </span>)}
            </div>
            <PrCard pr={entry.pr} owner={entry.owner} name={entry.name} />
          </div>)}
        </div>
      </section>;
    })}
    {settings && config.data && <JiraSettings config={config.data} onSaved={saved} onClose={() => setSettings(false)} />}
  </div>;
}
