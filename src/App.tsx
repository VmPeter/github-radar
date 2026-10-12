import { useCallback, useEffect, useState } from "react";
import { Header, type RadarView } from "./components/Header";
import { Dashboard } from "./components/Dashboard";
import { Pipelines } from "./components/Pipelines";
import { Epics } from './components/Epics';
import { FilterBar } from "./components/FilterBar";
import { PipelineFilterBar } from "./components/PipelineFilterBar";
import { TokenGate } from "./components/TokenGate";
import { ConfigEditor } from "./components/ConfigEditor";
import { useToken, useViewer } from "./lib/token";
import { defaultFilters, type Filters } from "./lib/filters";
import {
  defaultPipelineFilters,
  type PipelineFilters,
} from "./lib/pipelineFilters";
import {
  FILTERS_STORAGE_KEY,
  PIPELINE_FILTERS_STORAGE_KEY,
  readFilterPreferences,
  writeFilterPreferences,
} from "./lib/filterPreferences";

export function App() {
  const token = useToken();
  const viewer = useViewer();
  const [view, setView] = useState<RadarView>("prs");
  const [filters, setFilters] = useState<Filters>(() =>
    readFilterPreferences(FILTERS_STORAGE_KEY, defaultFilters),
  );
  const [pipelineFilters, setPipelineFilters] = useState<PipelineFilters>(
    () =>
      readFilterPreferences(PIPELINE_FILTERS_STORAGE_KEY, defaultPipelineFilters),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [summary, setSummary] = useState({ isFetching: false, lastUpdated: 0 });
  const [refreshSignal, setRefreshSignal] = useState(0);

  useEffect(() => {
    writeFilterPreferences(FILTERS_STORAGE_KEY, filters);
  }, [filters]);
  useEffect(() => {
    writeFilterPreferences(PIPELINE_FILTERS_STORAGE_KEY, pipelineFilters);
  }, [pipelineFilters]);

  const handleSummary = useCallback(
    (s: { isFetching: boolean; lastUpdated: number }) => {
      setSummary((prev) =>
        prev.isFetching === s.isFetching && prev.lastUpdated === s.lastUpdated
          ? prev
          : s,
      );
    },
    [],
  );

  const handleRefresh = () => setRefreshSignal((n) => n + 1);

  const showFirstRunGate = !token;
  const showSettingsGate = settingsOpen;

  return (
    <div className="min-h-screen flex flex-col">
      <Header
        view={view}
        onViewChange={setView}
        viewer={viewer}
        isFetching={summary.isFetching}
        lastUpdated={summary.lastUpdated}
        onRefresh={handleRefresh}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenConfig={() => setConfigOpen(true)}
      />
      <main className="mx-auto w-full flex-1 px-4 py-6 space-y-6">
        {view !== "pipelines" ? (
          <FilterBar
            filters={filters}
            onChange={setFilters}
            viewerKnown={Boolean(viewer)}
          />
        ) : (
          <PipelineFilterBar
            filters={pipelineFilters}
            onChange={setPipelineFilters}
            viewerKnown={Boolean(viewer)}
          />
        )}

        {token ? (
          view === "epics" ? <Epics filters={filters} viewer={viewer} onSummaryChange={handleSummary} refreshSignal={refreshSignal} /> : view === "prs" ? (
            <Dashboard
              filters={filters}
              viewer={viewer}
              onSummaryChange={handleSummary}
              refreshSignal={refreshSignal}
            />
          ) : (
            <Pipelines
              filters={pipelineFilters}
              viewer={viewer}
              onSummaryChange={handleSummary}
              refreshSignal={refreshSignal}
            />
          )
        ) : (
          <div className="text-center py-20 text-sm text-slate-500 dark:text-slate-400">
            Connect a GitHub personal access token to load{" "}
            {view !== "pipelines" ? "pull requests" : "pipelines"}.
          </div>
        )}
      </main>

      {showFirstRunGate && <TokenGate mode="first-run" />}
      {showSettingsGate && token && (
        <TokenGate
          mode="settings"
          initialToken={token}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {configOpen && <ConfigEditor onClose={() => setConfigOpen(false)} />}
    </div>
  );
}
