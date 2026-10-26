export const FILTERS_STORAGE_KEY = "ghpr.filters";
export const PIPELINE_FILTERS_STORAGE_KEY = "ghpr.pipelineFilters";

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export function readFilterPreferences<T extends object>(
  key: string,
  defaults: T,
  storage?: Pick<PreferenceStorage, "getItem">,
): T {
  const filters = { ...defaults };
  try {
    const raw = (storage ?? localStorage).getItem(key);
    if (raw === null) return filters;
    const saved: unknown = JSON.parse(raw);
    if (typeof saved !== "object" || saved === null || Array.isArray(saved)) {
      return filters;
    }
    for (const field of Object.keys(defaults) as (keyof T)[]) {
      const record = saved as Record<string, unknown>;
      const value = field === 'canReview' && record.canReview === undefined ? record.needsYourReview : record[field as string];
      if (typeof value === typeof defaults[field]) {
        filters[field] = value as T[keyof T];
      }
    }
  } catch {
    // Malformed preferences or unavailable storage leave the defaults usable.
  }
  return filters;
}

export function writeFilterPreferences<T extends object>(
  key: string,
  filters: T,
  storage?: Pick<PreferenceStorage, "setItem">,
): void {
  try {
    (storage ?? localStorage).setItem(key, JSON.stringify(filters));
  } catch {
    // Filter state remains usable when browser storage is blocked or full.
  }
}
