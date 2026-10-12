import { formatDistanceToNowStrict } from "date-fns";
import { Settings, Radar, GitPullRequest, Rocket, SlidersHorizontal } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { RefreshControl } from "./RefreshControl";

export type RadarView = "prs" | "epics" | "pipelines";

interface HeaderProps {
  view: RadarView;
  onViewChange: (view: RadarView) => void;
  viewer: string | null;
  isFetching: boolean;
  lastUpdated: number;
  onRefresh: () => void;
  onOpenSettings: () => void;
  onOpenConfig: () => void;
}

interface NavTabProps {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}

function NavTab({ active, onClick, icon, label }: NavTabProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium leading-none transition-colors " +
        (active
          ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
          : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800")
      }
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

function useTicker(intervalMs: number): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return 0;
}

export function Header({
  view,
  onViewChange,
  viewer,
  isFetching,
  lastUpdated,
  onRefresh,
  onOpenSettings,
  onOpenConfig,
}: HeaderProps) {
  useTicker(15_000);
  const updatedLabel =
    lastUpdated > 0
      ? formatDistanceToNowStrict(new Date(lastUpdated), { addSuffix: true })
      : "never";

  return (
    <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/80 backdrop-blur-md dark:border-slate-800 dark:bg-slate-950/80">
      <div className="mx-auto px-4 py-3 flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Radar className="h-5 w-5 text-emerald-500" />
          <h1 className="text-base font-semibold tracking-tight">GitHub Radar</h1>
        </div>

        <nav className="ml-2 flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 p-0.5 dark:border-slate-800 dark:bg-slate-900">
          <NavTab active={view === 'epics'} onClick={() => onViewChange('epics')} icon={<GitPullRequest className="h-3.5 w-3.5" />} label="Epics" />
          <NavTab
            active={view === "prs"}
            onClick={() => onViewChange("prs")}
            icon={<GitPullRequest className="h-3.5 w-3.5" />}
            label="Pull requests"
          />
          <NavTab
            active={view === "pipelines"}
            onClick={() => onViewChange("pipelines")}
            icon={<Rocket className="h-3.5 w-3.5" />}
            label="Pipelines"
          />
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <span
            className="text-xs text-slate-500 dark:text-slate-400 tabular-nums hidden sm:inline"
            title={
              lastUpdated > 0
                ? new Date(lastUpdated).toLocaleString()
                : "No successful fetch yet; repositories update individually"
            }
          >
            Latest update {updatedLabel}
          </span>

          <RefreshControl isFetching={isFetching} onRefresh={onRefresh} />

          <button
            type="button"
            onClick={onOpenConfig}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 text-xs font-medium leading-none shadow-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
            title="Edit repository configuration"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Config</span>
          </button>

          <button
            type="button"
            onClick={onOpenSettings}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 text-xs font-medium leading-none shadow-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
            title={viewer ? `Signed in as ${viewer}` : "Configure token"}
          >
            <Settings className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">
              {viewer ? `@${viewer}` : "Token"}
            </span>
          </button>
        </div>
      </div>
    </header>
  );
}
