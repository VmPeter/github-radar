import assert from 'node:assert/strict';
import test from 'node:test';
import { createReviewEligibilityLoader, parseCodeOwners, canApproveUnmetOwnerGroup } from '../src/lib/githubReviewEligibility.ts';
import type { PullRequestNode } from '../src/lib/github.ts';

const page = <T>(nodes: T[], hasNextPage = false) => ({ nodes, pageInfo: { hasNextPage } });
const review = (login: string, state = 'APPROVED') => ({ state, author: { login } });
const pr = (): PullRequestNode => ({
  id: 'pr-1', number: 1, title: 'Change', url: '', isDraft: false,
  createdAt: '', updatedAt: '', author: { login: 'author', avatarUrl: '' },
  headRefName: 'feature', baseRefName: 'main', mergeable: 'UNKNOWN',
  reviewDecision: 'REVIEW_REQUIRED', additions: 0, deletions: 0,
  commits: { nodes: [] }, comments: { totalCount: 0 },
});
function context(options: { approvals?: ReturnType<typeof review>[]; count?: number; codeOwners?: boolean; reviewsTruncated?: boolean; rulesTruncated?: boolean; teamRequest?: boolean;
  teamRules?: Array<{ reviewerId: string; minimumApprovals: number; filePatterns: string[] }> } = {}) {
  return {
    viewerDidAuthor: false, reviewDecision: 'REVIEW_REQUIRED', baseRefName: 'main', baseRefOid: 'base-oid',
    reviewRequests: page(options.teamRequest ? [{ requestedReviewer: { __typename: 'Team' } }] : []),
    latestOpinionatedReviews: page(options.approvals ?? [], options.reviewsTruncated),
    baseRef: {
      branchProtectionRule: null, refUpdateRule: null,
      rules: page([{ parameters: {
        requiredApprovingReviewCount: options.count ?? 1,
        requireCodeOwnerReview: options.codeOwners ?? false, requireLastPushApproval: false, requiredReviewers: options.teamRules ?? [],
      } }], options.rulesTruncated),
    },
  };
}
type Mock = (query: string, variables: Record<string, unknown>) => unknown;
async function loadWith(mock: Mock, direct = new Set<string>(), codeOwnerErrors: unknown[] = []) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/codeowners/errors?')) return new Response(JSON.stringify({ errors: codeOwnerErrors }));
    const { query, variables } = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ data: mock(query, variables) }));
  };
  try {
    const [result] = await createReviewEligibilityLoader('test-token')('org', 'repo', [pr()], direct, new AbortController().signal, true);
    return result.reviewEligibility!;
  } finally { globalThis.fetch = original; }
}
const eligibilityResponse = (value: ReturnType<typeof context>, viewerPermission: string | null = 'WRITE') => ({ viewer: { login: 'me' }, repository: { viewerPermission, p0: value } });

test('writers can supply a missing general approval without any review request', async () => {
  assert.deepEqual(await loadWith(() => eligibilityResponse(context())), {
    canReview: true, reason: 'Your approval can count', unknown: false,
  });
  assert.equal((await loadWith(() => eligibilityResponse(context({ approvals: [review('me')], count: 2 })))).canReview, false);
});

test('direct by-name requests survive unavailable eligibility context', async () => {
  assert.deepEqual(await loadWith(() => { throw new Error('API unavailable'); }, new Set(['pr-1'])), {
    canReview: true, reason: 'Requested from you', unknown: false,
  });
});

test('a team request alone cannot qualify after general requirements are met', async () => {
  assert.equal((await loadWith(() => eligibilityResponse(context({ approvals: [review('other')], teamRequest: true })))).canReview, false);
});

test('CODEOWNERS uses last matching lines, supports empty ownership, and accepts any alternate owner approval', async () => {
  const rules = parseCodeOwners('* @me\n/docs/** @other @me\n/docs/private/** @other\n/docs/free/**\n');
  const isOwner = async (owner: string, login: string) => owner === `@${login.toLowerCase()}`;
  assert.equal(await canApproveUnmetOwnerGroup(['src/code.ts'], rules, [], 'me', isOwner), true);
  assert.equal(await canApproveUnmetOwnerGroup(['docs/private/secret.md'], rules, [], 'me', isOwner), false);
  assert.equal(await canApproveUnmetOwnerGroup(['docs/free/readme.md'], rules, [], 'me', isOwner), false);
  assert.equal(await canApproveUnmetOwnerGroup(['docs/readme.md'], rules, [], 'me', isOwner), true);
  assert.equal(await canApproveUnmetOwnerGroup(['docs/readme.md'], rules, ['other'], 'me', isOwner), false);
});

test('loader uses base CODEOWNERS precedence and recognizes approvals from alternate owners', async () => {
  for (const [text, expected] of [['* @other\n/src/** @me', true], ['* @me\n/src/** @other', false], ['* @me @other', false]] as const) {
    const result = await loadWith((query, variables) => {
      if (query.includes('query ReviewEligibility')) return eligibilityResponse(context({ approvals: [review('other')], codeOwners: true }));
      if (query.includes('query CodeOwners')) {
        assert.equal(variables.github, 'base-oid:.github/CODEOWNERS');
        return { repository: { github: { text, byteSize: text.length, isTruncated: false }, root: null, docs: null } };
      }
      if (query.includes('query ReviewFiles')) return { repository: { pullRequest: { changedFiles: 1, files: page([{ path: 'src/code.ts' }]) } } };
      throw new Error('Unexpected query');
    });
    assert.equal(result.canReview, expected, JSON.stringify(result));
    assert.equal(result.unknown, false);
  }
});

test('team membership uses exact login matches and hidden membership stays unknown', async () => {
  for (const [members, expected, unknown] of [[['ME'], true, false], [['someone-me-like'], false, false], [null, false, true]] as const) {
    const result = await loadWith((query, variables) => {
      if (query.includes('query ReviewEligibility')) return eligibilityResponse(context({ approvals: [review('unrelated')], codeOwners: true }));
      if (query.includes('query CodeOwners')) return { repository: { github: { text: '* @org/owners', byteSize: 13, isTruncated: false } } };
      if (query.includes('query ReviewFiles')) return { repository: { pullRequest: { changedFiles: 1, files: page([{ path: 'src/code.ts' }]) } } };
      if (query.includes('query OwnerMembership')) return { organization: { team: members === null ? null : { members: page(variables.login === 'me' ? members.map(login => ({ login })) : []) } } };
      throw new Error('Unexpected query');
    });
    assert.equal(result.canReview, expected, JSON.stringify(result));
    assert.equal(result.unknown, unknown);
  }
});

test('truncated reviews/rules and incomplete changed-file pages cannot claim eligibility', async () => {
  for (const options of [{ reviewsTruncated: true }, { rulesTruncated: true }]) {
    const result = await loadWith(() => eligibilityResponse(context(options)));
    assert.equal(result.canReview, false); assert.equal(result.unknown, true);
  }
  const result = await loadWith(query => {
    if (query.includes('query ReviewEligibility')) return eligibilityResponse(context({ approvals: [review('other')], codeOwners: true }));
    if (query.includes('query CodeOwners')) return { repository: { github: { text: '* @me', byteSize: 5, isTruncated: false } } };
    if (query.includes('query ReviewFiles')) return { repository: { pullRequest: { changedFiles: 2, files: page([{ path: 'one.ts' }]) } } };
    throw new Error('Unexpected query');
  });
  assert.equal(result.canReview, false); assert.equal(result.unknown, true);
});

test('required teams qualify members only while a matching approval requirement is unmet', async () => {
  const scenarios = [
    { path: 'src/code.ts', memberApproved: false, permission: 'WRITE', teamPermission: 'WRITE', hidden: false, expected: true },
    { path: 'src/code.ts', memberApproved: true, permission: 'WRITE', teamPermission: 'WRITE', hidden: false, expected: false },
    { path: 'src/excluded/code.ts', memberApproved: false, permission: 'WRITE', teamPermission: 'WRITE', hidden: false, expected: false },
    { path: 'docs/readme.md', memberApproved: false, permission: 'WRITE', teamPermission: 'WRITE', hidden: false, expected: false },
    { path: 'src/code.ts', memberApproved: false, permission: 'READ', teamPermission: 'WRITE', hidden: false, expected: false },
    { path: 'src/code.ts', memberApproved: false, permission: 'WRITE', teamPermission: 'READ', hidden: false, expected: false },
    { path: 'src/code.ts', memberApproved: false, permission: 'WRITE', teamPermission: 'WRITE', hidden: true, expected: false },
  ];
  for (const scenario of scenarios) {
    let teamQueries = 0;
    const result = await loadWith((query, variables) => {
      if (query.includes('query ReviewEligibility')) return eligibilityResponse(context({
        approvals: [review('other')], teamRules: [{ reviewerId: 'team-id', minimumApprovals: 1, filePatterns: ['src/**', '!src/excluded/', '!src/excluded/**'] }],
      }), scenario.permission);
      if (query.includes('query ReviewFiles')) return { repository: { pullRequest: { changedFiles: 1, files: page([{ path: scenario.path }]) } } };
      if (query.includes('query RequiredTeam')) {
        teamQueries++;
        assert.equal(variables.id, 'team-id');
        return { node: { slug: 'owners', organization: { login: 'org' }, repositories: {
          edges: [{ permission: scenario.teamPermission, node: { nameWithOwner: 'org/repo' } }], pageInfo: { hasNextPage: false },
        } } };
      }
      if (query.includes('query OwnerMembership')) return { organization: { team: scenario.hidden ? null : { members: page(
        variables.login === 'me' || scenario.memberApproved ? [{ login: String(variables.login) }] : [],
      ) } } };
      throw new Error('Unexpected query');
    });
    assert.equal(result.canReview, scenario.expected, JSON.stringify({ scenario, result }));
    if (scenario.expected) assert.equal(result.reason, 'Your required team approval can count');
    if (scenario.hidden || scenario.teamPermission === 'READ') assert.equal(result.unknown, true);
    if (scenario.path !== 'src/code.ts' || scenario.permission === 'READ') assert.equal(teamQueries, 0);
  }
});

test('GitHub CODEOWNERS validation errors cannot establish ownership eligibility', async () => {
  const result = await loadWith(query => {
    if (query.includes('query ReviewEligibility')) return eligibilityResponse(context({ approvals: [review('other')], codeOwners: true }));
    if (query.includes('query ReviewFiles')) return { repository: { pullRequest: { changedFiles: 1, files: page([{ path: 'src/code.ts' }]) } } };
    if (query.includes('query CodeOwners')) return { repository: { github: { text: '* @me', byteSize: 5, isTruncated: false } } };
    throw new Error('Unexpected query');
  }, new Set(), [{ line: 1, kind: 'Invalid owner', message: 'Owner cannot approve' }]);
  assert.deepEqual(result, { canReview: false, reason: 'Review eligibility unavailable', unknown: true });
});
