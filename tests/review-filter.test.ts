import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultFilters, matchesFilters } from '../src/lib/filters.ts';
import { fetchViewerReviewRequests, type PullRequestNode } from '../src/lib/github.ts';

const pr = (changes: Partial<PullRequestNode> = {}): PullRequestNode => ({
  id: 'pr-1', number: 1, title: 'Change', url: '', isDraft: false,
  createdAt: '', updatedAt: '', author: { login: 'author', avatarUrl: '' },
  headRefName: 'feature', baseRefName: 'main', mergeable: 'UNKNOWN',
  reviewDecision: 'REVIEW_REQUIRED', additions: 0, deletions: 0,
  commits: { nodes: [] }, comments: { totalCount: 0 }, ...changes,
});
const personal = { ...defaultFilters, canReview: true };

test('personal reviews exclude unrelated teams, unknown requests, drafts and own PRs', () => {
  assert.equal(matchesFilters(pr({ reviewEligibility: { canReview: true, reason: 'Requested from you', unknown: false } }), personal, 'me'), true);
  for (const changes of [
    { reviewEligibility: { canReview: false, reason: 'Waiting on another reviewer', unknown: false } }, {},
    { reviewEligibility: { canReview: true, reason: 'Requested from you', unknown: false }, isDraft: true },
    { reviewEligibility: { canReview: true, reason: 'Requested from you', unknown: false }, author: { login: 'ME', avatarUrl: '' } },
  ]) assert.equal(matchesFilters(pr(changes), personal, 'me'), false);
  assert.equal(matchesFilters(pr({ reviewEligibility: { canReview: true, reason: 'Requested from you', unknown: false } }), personal, null), false);
});

test('outstanding personal requests remain actionable after another reviewer approves', () => {
  const candidate = pr({ reviewEligibility: { canReview: true, reason: 'Requested from you', unknown: false }, reviewDecision: 'APPROVED' });
  assert.equal(matchesFilters(candidate, personal, 'me'), true);
  assert.equal(matchesFilters(candidate, { ...defaultFilters, needsReview: true }, 'me'), false);
  assert.equal(matchesFilters(pr({ reviewEligibility: { canReview: false, reason: 'Waiting on another reviewer', unknown: false } }), { ...defaultFilters, needsReview: true }, 'me'), true);
});

test('review lookup uses GitHub named-request search, paginates and rejects incomplete results', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    const { variables } = JSON.parse(String(init?.body));
    assert.equal(variables.q, 'repo:org/repo is:pr is:open user-review-requested:@me -author:@me');
    assert.equal(variables.cursor, calls++ === 0 ? null : 'next');
    return new Response(JSON.stringify({ data: { search: {
      issueCount: 101, nodes: [{ id: calls === 1 ? 'direct-request' : 'team-request' }, null],
      pageInfo: { hasNextPage: calls === 1, endCursor: calls === 1 ? 'next' : null },
    } } }));
  };
  try {
    assert.deepEqual(await fetchViewerReviewRequests('org', 'repo', 'test-token', undefined, true), new Set(['direct-request', 'team-request']));
    globalThis.fetch = async () => new Response(JSON.stringify({ data: { search: {
      issueCount: 1001, nodes: [], pageInfo: { hasNextPage: true, endCursor: 'next' },
    } } }));
    await assert.rejects(fetchViewerReviewRequests('org', 'repo', 'test-token', undefined, true), /Too many review requests/);
    globalThis.fetch = async () => new Response(JSON.stringify({ data: { search: {
      issueCount: 2, nodes: [], pageInfo: { hasNextPage: true, endCursor: null },
    } } }));
    await assert.rejects(fetchViewerReviewRequests('org', 'repo', 'test-token', undefined, true), /pagination did not advance/);
    globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 });
    await assert.rejects(fetchViewerReviewRequests('org', 'repo', 'test-token', undefined, true));
  } finally {
    globalThis.fetch = original;
  }
});
