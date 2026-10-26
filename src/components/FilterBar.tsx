import { Search, X } from "lucide-react";
import type { Filters } from "../lib/filters";

interface FilterBarProps {
  filters: Filters;
  onChange: (next: Filters) => void;
  viewerKnown: boolean;
}

interface ToggleProps {
  label: string;
  active: boolean;
  onToggle: () => void;
  disabled?: boolean;
  title?: string;
}

function Toggle({ label, active, onToggle, disabled, title }: ToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      className={
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed " +
        (active
          ? "border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900"
          : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800")
      }
    >
      {label}
    </button>
  );
}

export function FilterBar({ filters, onChange, viewerKnown }: FilterBarProps) {
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative flex-1 min-w-[12rem]">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
        <input
          type="text"
          value={filters.search}
          onChange={(e) => set({ search: e.target.value })}
          placeholder="Search title, author, branch, #number"
          className="w-full rounded-md border border-slate-300 bg-white py-1.5 pl-7 pr-7 text-sm shadow-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 dark:border-slate-700 dark:bg-slate-900"
        />
        {filters.search && (
          <button
            type="button"
            onClick={() => set({ search: "" })}
            aria-label="Clear search"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="h-3.5 w-3.5 text-slate-400" />
          </button>
        )}
      </div>
      <Toggle
        label="Hide drafts"
        active={filters.hideDrafts}
        onToggle={() => set({ hideDrafts: !filters.hideDrafts })}
      />
      <Toggle
        label="Only mine"
        active={filters.onlyMine}
        onToggle={() => set({ onlyMine: !filters.onlyMine })}
        disabled={!viewerKnown}
        title={viewerKnown ? "Show only PRs authored by you" : "Set a token to identify yourself"}
      />
      <Toggle
        label="Needs attention"
        active={filters.failingOnly}
        onToggle={() => set({ failingOnly: !filters.failingOnly })}
        title="Show only PRs with failing checks or changes requested"
      />
      <Toggle
        label="Awaiting review"
        active={filters.needsReview}
        onToggle={() => set({ needsReview: !filters.needsReview })}
        title="Show only open PRs still waiting on required reviewers"
      />
      <Toggle
        label="Can review"
        active={filters.canReview}
        onToggle={() => set({ canReview: !filters.canReview })}
        disabled={!viewerKnown}
        title={viewerKnown ? "Your approval can help meet an unmet review requirement, or you were requested directly by name. Uncertain eligibility is shown separately." : "Set a token to identify yourself"}
      />
    </div>
  );
}
