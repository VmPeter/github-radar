import type { RepoQuery } from '../hooks/usePullRequests';

export function ReviewEligibilityNotice({ entries }: { entries: RepoQuery[] }) {
  const unknown = entries.flatMap(entry => (entry.query.data?.pullRequests.nodes ?? []).filter(pr => pr.reviewEligibility?.unknown).map(pr => ({ pr, repo: entry.repo.name })));
  if (!unknown.length) return null;
  return <details className="text-xs text-slate-500 dark:text-slate-400">
    <summary className="cursor-pointer">Review eligibility is unknown for {unknown.length} PR{unknown.length === 1 ? '' : 's'}; these are excluded from “Can review”.</summary>
    <p className="mt-2">GitHub did not expose enough information to confirm the remaining requirements or your eligibility. Check these PRs directly.</p>
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
      {unknown.map(({ pr, repo }) => <li key={pr.id}><a className="underline" href={pr.url} target="_blank" rel="noreferrer">{repo}#{pr.number}</a></li>)}
    </ul>
  </details>;
}
