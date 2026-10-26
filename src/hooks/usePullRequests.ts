import { useMemo, useRef } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { fetchPullRequestCounts, fetchPullRequestPage, fetchViewerReviewRequests, type PullRequestNode, type RepoPullRequests } from '../lib/github';
import { useToken } from '../lib/token';
import { useRefreshInterval } from '../lib/refreshInterval';
import { repoKey, type Repo } from '../config/schema';
import { createPagedLoad, mergeNodes, type LoadProgress, type RollingTarget } from '../lib/rollingRefresh';
import { useRollingRefresh, useAuthScope } from './useRollingRefresh';
import { createReviewEligibilityLoader } from '../lib/githubReviewEligibility';

export interface RadarQuery<T> {
  data?: T;
  error?: Error;
  isFetching: boolean;
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
  dataUpdatedAt: number;
  refetch: () => void;
}
export interface RepoQuery {
  repo: Repo;
  query: RadarQuery<RepoPullRequests>;
  progress?: LoadProgress;
  incomplete: boolean;
}
export function useAllPullRequests(repos: Repo[], disabledKeys?: ReadonlySet<string>) {
  const token = useToken(), auth = useAuthScope(token), client = useQueryClient();
  const { value: interval } = useRefreshInterval();
  const descriptors = useMemo(() => repos.map(repo => {
    const members = repo.teamMembers ? [...repo.teamMembers].sort() : undefined;
    const queryKey = ['repo-prs', auth, repo.owner, repo.name, members ?? null];
    return { repo, members, queryKey, key: JSON.stringify(queryKey) };
  }), [repos, auth]);
  const observers = useQueries({ queries: descriptors.map(d => ({
    queryKey: d.queryKey, enabled: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
    retry: false, queryFn: async (): Promise<RepoPullRequests> => { throw new Error('Use rolling refresh'); },
  })) });
  const counts = useRef(new Map<string, number>());
  const targets = useMemo<RollingTarget[]>(() => descriptors.filter(d => !disabledKeys?.has(repoKey(d.repo))).map(d => ({
    key: d.key,
    create(initial = false) {
      const count = initial ? undefined : counts.current.get(d.key);
      const summary = { nameWithOwner: repoKey(d.repo), url: `https://github.com/${repoKey(d.repo)}` };
      let overflow = Boolean(d.members && count !== undefined && count > 1000);
      let restartCursor = false;
      let reviewRequests: Set<string> | null | undefined;
      const loadEligibility = createReviewEligibilityLoader(token!);
      const authors = new Set(d.members?.map(m => m.toLowerCase()));
      const step = createPagedLoad<PullRequestNode>(
        async (cursor, signal, initial) => {
          if (reviewRequests === undefined) {
            try { reviewRequests = await fetchViewerReviewRequests(d.repo.owner, d.repo.name, token!, signal, initial); }
            catch { signal.throwIfAborted(); reviewRequests = null; }
          }
          let page = await fetchPullRequestPage(d.repo.owner, d.repo.name, restartCursor ? null : cursor, overflow ? undefined : d.members, token ?? undefined, signal, initial);
          if (!overflow && d.members && page.totalCount > 1000) {
            overflow = true; restartCursor = true;
            page = await fetchPullRequestPage(d.repo.owner, d.repo.name, null, undefined, token ?? undefined, signal, initial);
          }
          const restart = restartCursor;
          restartCursor = false;
          return { ...page, nodes: await loadEligibility(d.repo.owner, d.repo.name, page.nodes, reviewRequests, signal, initial), restart };
        },
        node => !overflow || Boolean(node.author && authors.has(node.author.login.toLowerCase())), count,
      );
      return async (signal, initial) => {
        const update = await step(signal, initial);
        return { ...update, progress: overflow ? { ...update.progress!, total: update.done ? (update.data as PullRequestNode[]).length : count } : update.progress,
          data: { ...summary, pullRequests: { nodes: update.data as PullRequestNode[] } } };
      };
    },
  })), [descriptors, disabledKeys, token]);
  const { states, busy, refresh } = useRollingRefresh({ targets, interval, token, initialBurst: true,
    async prepare(keys, signal, update) {
      const selected = descriptors.filter(d => keys.has(d.key));
      for (let i = 0; i < selected.length; i += 5) {
        const batch = selected.slice(i, i + 5);
        try {
          const result = await fetchPullRequestCounts(batch.map(d => ({ owner: d.repo.owner, name: d.repo.name, members: d.members })), token!, signal);
          for (const d of batch) {
            const count = result[repoKey(d.repo)];
            if (count === undefined) counts.current.delete(d.key); else counts.current.set(d.key, count);
            update(d.key, { progress: { loaded: 0, total: count, counting: false, countError: count === undefined ? 'Count unavailable' : undefined } });
          }
        } catch (error) {
          if (signal.aborted) throw error;
          for (const d of batch) { counts.current.delete(d.key); update(d.key, { progress: { loaded: 0, counting: false, countError: 'Count unavailable; loading pages' } }); }
        }
      }
    },
    mergeData(previous, incoming) {
      const next = incoming as RepoPullRequests;
      const old = previous as RepoPullRequests | undefined;
      return { ...next, pullRequests: { nodes: mergeNodes(old?.pullRequests.nodes ?? [], next.pullRequests.nodes, false) } };
    },
    onComplete(key, data) { const descriptor = descriptors.find(d => d.key === key); if (descriptor) client.setQueryData(descriptor.queryKey, data); },
  });
  const entries: RepoQuery[] = descriptors.map((d, i) => {
    const observer = observers[i], state = states[d.key];
    const incoming = state?.data as RepoPullRequests | undefined;
    const data = observer.data && incoming && (state?.done === false || Boolean(state?.error))
      ? { ...observer.data, pullRequests: { nodes: mergeNodes(observer.data.pullRequests.nodes, incoming.pullRequests.nodes, false) } }
      : observer.data ?? incoming;
    return { repo: d.repo, progress: state?.progress, incomplete: !observer.data && !state?.complete,
      query: { data, error: state?.error, isFetching: Boolean(state?.fetching), isPending: !data && !state?.error,
        isError: Boolean(state?.error), isSuccess: Boolean(data), dataUpdatedAt: observer.dataUpdatedAt,
        refetch: () => refresh(d.key) } };
  });
  return { entries, busy, refresh };
}
