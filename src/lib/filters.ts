import type { PullRequestNode } from "./github.ts";
import { deriveStatus } from "./status.ts";

export interface Filters {
  search: string;
  hideDrafts: boolean;
  onlyMine: boolean;
  failingOnly: boolean;
  needsReview: boolean;
  canReview: boolean;
}

export const defaultFilters: Filters = {
  search: "",
  hideDrafts: false,
  onlyMine: false,
  failingOnly: false,
  needsReview: false,
  canReview: false,
};

export function matchesFilters(
  pr: PullRequestNode,
  filters: Filters,
  viewer: string | null,
): boolean {
  if (filters.hideDrafts && pr.isDraft) return false;
  if (filters.onlyMine) {
    if (!viewer) return false;
    if (pr.author?.login !== viewer) return false;
  }
  if (filters.failingOnly) {
    const status = deriveStatus(pr);
    if (status.overall !== "failure" && status.overall !== "changes_requested") {
      return false;
    }
  }
  if (filters.needsReview) {
    if (pr.isDraft) return false;
    if (pr.reviewDecision !== "REVIEW_REQUIRED") return false;
  }
  if (filters.canReview) {
    if (!viewer || pr.isDraft || pr.author?.login.toLowerCase() === viewer.toLowerCase()) return false;
    if (pr.reviewEligibility?.canReview !== true) return false;
  }
  if (filters.search.trim().length > 0) {
    const q = filters.search.trim().toLowerCase();
    const haystack = [
      pr.title,
      String(pr.number),
      pr.author?.login ?? "",
      pr.headRefName,
      pr.baseRefName,
    ]
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}
