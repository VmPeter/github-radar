import { useEffect, useMemo, useRef } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useAllPullRequests, type RepoQuery } from "../hooks/usePullRequests";
import { repoKey } from "../config/schema";
import { useConfig } from "../config/configStore";
import { matchesFilters, type Filters } from "../lib/filters";
import { useCollapsedGroups } from "../lib/collapsedGroups";
import { RepoSection } from "./RepoSection";
import { ReviewEligibilityNotice } from './ReviewEligibilityNotice';

interface DashboardProps {
  filters: Filters;
  viewer: string | null;
  onSummaryChange: (s: { isFetching: boolean; lastUpdated: number }) => void;
  refreshSignal: number;
}

export function Dashboard({
  filters,
  viewer,
  onSummaryChange,
  refreshSignal,
}: DashboardProps) {
  const { isCollapsed, toggle } = useCollapsedGroups();
  const { groups, repos } = useConfig();

  const disabledKeys = useMemo(() => {
    const set = new Set<string>();
    for (const g of groups) {
      if (isCollapsed(g.name)) {
        for (const r of g.repos) set.add(repoKey(r));
      }
    }
    return set;
  }, [isCollapsed, groups]);

  const { entries, busy, refresh } = useAllPullRequests(repos, disabledKeys);

  const entryByKey = useMemo(() => {
    const map = new Map<string, RepoQuery>();
    for (const e of entries) map.set(repoKey(e.repo), e);
    return map;
  }, [entries]);

  const isFetching = busy;
  const lastUpdated = entries.reduce<number>((acc, e) => {
    const t = e.query.dataUpdatedAt;
    return t > acc ? t : acc;
  }, 0);

  useEffect(() => {
    onSummaryChange({ isFetching, lastUpdated });
  }, [isFetching, lastUpdated, onSummaryChange]);

  const consumedRefresh = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal === consumedRefresh.current) return;
    consumedRefresh.current = refreshSignal;
    refresh();
  }, [refreshSignal, refresh]);

  return (
    <div className="space-y-10">
      {filters.canReview && <ReviewEligibilityNotice entries={entries} />}
      {groups.map((group) => {
        const collapsed = isCollapsed(group.name);
        const repoCount = group.repos.length;

        const visibleEntries = collapsed
          ? []
          : group.repos
              .map((repo) => entryByKey.get(repoKey(repo)))
              .filter((e): e is RepoQuery => Boolean(e))
              .filter((e) => hasContentToRender(e, filters, viewer));

        const showBody = !collapsed && visibleEntries.length > 0;

        return (
          <section key={group.name} className={showBody ? "space-y-4" : ""}>
            <h2 className="border-b border-slate-200 dark:border-slate-800 pb-1">
              <button
                type="button"
                onClick={() => toggle(group.name)}
                aria-expanded={!collapsed}
                className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 transition-colors"
              >
                {collapsed ? (
                  <ChevronRight className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
                <span>{group.name}</span>
                <span className="font-normal text-slate-400 dark:text-slate-500 normal-case tracking-normal">
                  ({repoCount} {repoCount === 1 ? "repo" : "repos"})
                </span>
              </button>
            </h2>
            {showBody && (
              <div className="space-y-6">
                {visibleEntries.map((entry) => (
                  <RepoSection
                    key={repoKey(entry.repo)}
                    entry={entry}
                    filters={filters}
                    viewer={viewer}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function hasContentToRender(
  entry: RepoQuery,
  filters: Filters,
  viewer: string | null,
): boolean {
  const q = entry.query;
  if (q.data) {
    const nodes = q.data?.pullRequests.nodes ?? [];
    return nodes.some((pr) => matchesFilters(pr, filters, viewer));
  }
  return true;
}
