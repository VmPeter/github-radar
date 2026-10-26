import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FILTERS_STORAGE_KEY,
  PIPELINE_FILTERS_STORAGE_KEY,
  readFilterPreferences,
  writeFilterPreferences,
} from "../src/lib/filterPreferences.ts";
import {
  DEFAULT_INTERVAL_MS,
  REFRESH_OPTIONS,
  readRefreshInterval,
  refreshOption,
} from "../src/lib/refreshInterval.ts";

const prDefaults = {
  search: "", hideDrafts: false, onlyMine: false,
  failingOnly: false, needsReview: false, canReview: false,
};
const pipelineDefaults = {
  search: "", pendingProdOnly: false, failingOnly: false,
  onlyMine: false, notBump: false, hideUpToDate: false,
};
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

test("both views retain every field independently across reads", () => {
  const storage = memoryStorage();
  const prs = {
    search: "author feature #42", hideDrafts: true, onlyMine: true,
    failingOnly: true, needsReview: true, canReview: true,
  };
  const pipelines = {
    search: "branch abc123", pendingProdOnly: true, failingOnly: true,
    onlyMine: true, notBump: true, hideUpToDate: true,
  };
  writeFilterPreferences(FILTERS_STORAGE_KEY, prs, storage);
  writeFilterPreferences(PIPELINE_FILTERS_STORAGE_KEY, pipelines, storage);
  assert.deepEqual(readFilterPreferences(FILTERS_STORAGE_KEY, prDefaults, storage), prs);
  assert.deepEqual(readFilterPreferences(PIPELINE_FILTERS_STORAGE_KEY, pipelineDefaults, storage), pipelines);
  writeFilterPreferences(FILTERS_STORAGE_KEY, prDefaults, storage);
  assert.deepEqual(readFilterPreferences(PIPELINE_FILTERS_STORAGE_KEY, pipelineDefaults, storage), pipelines);
});

test("valid saved fields merge with defaults while invalid and unknown fields are ignored", () => {
  const storage = memoryStorage();
  storage.setItem(FILTERS_STORAGE_KEY, JSON.stringify({
    search: "keep spaces ", hideDrafts: true, onlyMine: "true",
    failingOnly: 1, needsReview: null, extra: true,
  }));
  assert.deepEqual(readFilterPreferences(FILTERS_STORAGE_KEY, prDefaults, storage), {
    ...prDefaults, search: "keep spaces ", hideDrafts: true,
  });
  storage.setItem(PIPELINE_FILTERS_STORAGE_KEY, JSON.stringify({ notBump: true, search: 42 }));
  assert.deepEqual(readFilterPreferences(PIPELINE_FILTERS_STORAGE_KEY, pipelineDefaults, storage), {
    ...pipelineDefaults, notBump: true,
  });
});

test("missing and malformed preferences safely use fresh default objects", () => {
  const storage = memoryStorage();
  for (const raw of [undefined, "{", "null", "true", "42", '"text"', "[]"]) {
    if (raw !== undefined) storage.setItem(FILTERS_STORAGE_KEY, raw);
    const restored = readFilterPreferences(FILTERS_STORAGE_KEY, prDefaults, storage);
    assert.deepEqual(restored, prDefaults);
    assert.notEqual(restored, prDefaults);
  }
});

test("unavailable storage cannot prevent restoring defaults or saving changes", () => {
  const storage = {
    getItem() { throw new Error("storage blocked"); },
    setItem() { throw new Error("quota exceeded"); },
  };
  assert.deepEqual(readFilterPreferences(FILTERS_STORAGE_KEY, prDefaults, storage), prDefaults);
  assert.doesNotThrow(() => writeFilterPreferences(FILTERS_STORAGE_KEY, { ...prDefaults, search: "changed" }, storage));
  assert.deepEqual(readFilterPreferences(FILTERS_STORAGE_KEY, prDefaults), prDefaults);
  assert.doesNotThrow(() => writeFilterPreferences(FILTERS_STORAGE_KEY, prDefaults));
});

test("refresh defaults and menu fallback select 10m", () => {
  assert.equal(DEFAULT_INTERVAL_MS, 600_000);
  assert.deepEqual(refreshOption(DEFAULT_INTERVAL_MS), { label: "10m", ms: 600_000 });
  assert.deepEqual(refreshOption(123), { label: "10m", ms: 600_000 });
  const storage = memoryStorage();
  assert.equal(readRefreshInterval(storage), 600_000);
  for (const raw of ["broken", "123", "", "NaN"]) {
    storage.setItem("ghpr.refreshInterval", raw);
    assert.equal(readRefreshInterval(storage), 600_000);
  }
  assert.equal(readRefreshInterval({ getItem() { throw new Error("blocked"); } }), 600_000);
});

test("every existing saved interval including Off retains its menu choice", () => {
  const storage = memoryStorage();
  for (const option of REFRESH_OPTIONS) {
    storage.setItem("ghpr.refreshInterval", option.ms === null ? "off" : String(option.ms));
    assert.equal(readRefreshInterval(storage), option.ms);
    assert.deepEqual(refreshOption(readRefreshInterval(storage)), option);
  }
});


test("old personal review selections migrate to Can review without overriding the new setting", () => {
  const storage = memoryStorage();
  storage.setItem(FILTERS_STORAGE_KEY, JSON.stringify({ needsYourReview: true }));
  assert.equal(readFilterPreferences(FILTERS_STORAGE_KEY, prDefaults, storage).canReview, true);
  storage.setItem(FILTERS_STORAGE_KEY, JSON.stringify({ needsYourReview: true, canReview: false }));
  assert.equal(readFilterPreferences(FILTERS_STORAGE_KEY, prDefaults, storage).canReview, false);
});
