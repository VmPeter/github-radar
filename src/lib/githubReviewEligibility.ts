import ignore from 'ignore';
import { graphql, type PullRequestNode } from './github.ts';
import { githubRequest } from './githubRequest.ts';
import { reviewEligibility, type ReviewRequirements } from './reviewEligibility.ts';

type Page<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor?: string | null } };
type Review = { state: string; author: { login: string } | null };
type Requirements = ReviewRequirements & { teamRules: Array<{ reviewerId: string; minimumApprovals: number; filePatterns: string[] }> };
type ReviewContext = {
  viewerDidAuthor: boolean;
  reviewDecision: string | null;
  baseRefName: string;
  baseRefOid: string;
  reviewRequests: Page<{ requestedReviewer: { __typename: string; login?: string } | null }>;
  latestOpinionatedReviews: Page<Review>;
  baseRef: {
    branchProtectionRule: { requireLastPushApproval: boolean } | null;
    refUpdateRule: { requiredApprovingReviewCount: number | null; requiresCodeOwnerReviews: boolean } | null;
    rules: Page<{ repositoryRuleset?: { enforcement: string }; parameters: {
      requiredApprovingReviewCount?: number;
      requireCodeOwnerReview?: boolean;
      requireLastPushApproval?: boolean;
      requiredReviewers?: Requirements['teamRules'];
    } | null }>;
  } | null;
};

export interface OwnerRule { owners: string[]; matches: (path: string) => boolean }

// CODEOWNERS uses gitignore paths, with last matching line taking precedence.
// Negation, character ranges and escaped '#' are explicitly unsupported by GitHub.
export function parseCodeOwners(text: string): OwnerRule[] {
  return text.split(/\r?\n/).flatMap(line => {
    const value = line.trim();
    if (!value || value.startsWith('#')) return [];
    const [pattern, ...rest] = value.split(/\s+/);
    const comment = rest.findIndex(part => part.startsWith('#'));
    const owners = (comment < 0 ? rest : rest.slice(0, comment)).map(owner => owner.toLowerCase());
    if (pattern.startsWith('!') || pattern.includes('[') || pattern.startsWith('\\#')) return [];
    if (owners.some(owner => !/^@[\w-]+(?:\/[\w.-]+)?$/.test(owner))) throw new Error('Unsupported CODEOWNERS owner');
    const matcher = ignore().add(pattern);
    return [{ owners, matches: (path: string) => matcher.test(path).ignored }];
  });
}

export async function canApproveUnmetOwnerGroup(paths: string[], rules: OwnerRule[], approvals: string[], viewer: string,
  isOwner: (owner: string, login: string) => Promise<boolean>): Promise<boolean> {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const owners = [...rules].reverse().find(rule => rule.matches(path))?.owners ?? [];
    if (owners.length) groups.set([...owners].sort().join(' '), owners);
  }
  for (const owners of groups.values()) {
    let viewerOwns = false;
    for (const owner of owners) if (await isOwner(owner, viewer)) { viewerOwns = true; break; }
    if (!viewerOwns) continue;
    let satisfied = false;
    for (const approver of approvals) {
      for (const owner of owners) if (await isOwner(owner, approver)) { satisfied = true; break; }
      if (satisfied) break;
    }
    if (satisfied) continue;
    return true;
  }
  return false;
}

function requirements(context: ReviewContext): Requirements | null {
  if (!context.baseRef || context.baseRef.rules.pageInfo.hasNextPage) return null;
  const result: Requirements = { requiredApprovingReviewCount: context.baseRef.refUpdateRule?.requiredApprovingReviewCount ?? 0,
    requireCodeOwnerReview: context.baseRef.refUpdateRule?.requiresCodeOwnerReviews ?? false,
    requireLastPushApproval: context.baseRef.branchProtectionRule?.requireLastPushApproval ?? false, teamRules: [] };
  for (const rule of context.baseRef.rules.nodes) {
    if (rule.repositoryRuleset && rule.repositoryRuleset.enforcement !== 'ACTIVE') continue;
    const params = rule.parameters;
    if (typeof params?.requiredApprovingReviewCount !== 'number') continue;
    result.requiredApprovingReviewCount = Math.max(result.requiredApprovingReviewCount, params.requiredApprovingReviewCount);
    result.requireCodeOwnerReview ||= params.requireCodeOwnerReview ?? false;
    result.requireLastPushApproval ||= params.requireLastPushApproval ?? false;
    result.teamRules.push(...(params.requiredReviewers ?? []).filter(team => team.minimumApprovals > 0));
  }
  result.requiredTeamReviews = result.teamRules.length > 0;
  return result;
}

export function createReviewEligibilityLoader(token: string) {
  // Per-sweep caches: never share permissions, membership or requirements across tokens/refreshes.
  const ownerFiles = new Map<string, OwnerRule[]>();
  const memberships = new Map<string, boolean>();
  const teamOwners = new Map<string, string>();
  async function requiredTeamOwner(id: string, owner: string, name: string, signal: AbortSignal, initial: boolean) {
    const key = `${owner}/${name}:${id}`;
    if (teamOwners.has(key)) return teamOwners.get(key)!;
    let cursor: string | null = null;
    do {
      const data: { node: { slug: string; organization: { login: string }; repositories: {
        edges: Array<{ permission: string; node: { nameWithOwner: string } }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      } } | null } = await graphql(`query RequiredTeam($id: ID!, $name: String!, $cursor: String) {
        node(id: $id) { ... on Team { slug organization { login }
          repositories(first: 100, query: $name, after: $cursor) {
            edges { permission node { nameWithOwner } } pageInfo { hasNextPage endCursor }
          }
        } }
      }`, { id, name, cursor }, token, signal, initial);
      const team = data.node;
      if (!team?.repositories) throw new Error('Required team unavailable');
      const repo = team.repositories.edges.find(edge => edge.node.nameWithOwner.toLowerCase() === `${owner}/${name}`.toLowerCase());
      if (repo) {
        if (!['WRITE', 'MAINTAIN', 'ADMIN'].includes(repo.permission)) throw new Error('Required team lacks approval permission');
        const identity = `@${team.organization.login}/${team.slug}`.toLowerCase();
        teamOwners.set(key, identity);
        return identity;
      }
      const page = team.repositories.pageInfo;
      if (!page.hasNextPage || !page.endCursor || page.endCursor === cursor) throw new Error('Required team permission unavailable');
      cursor = page.endCursor;
    } while (true);
  }
  async function isOwner(owner: string, login: string, signal: AbortSignal, initial: boolean) {
    if (!owner.includes('/')) return owner === `@${login.toLowerCase()}`;
    const key = `${owner}:${login.toLowerCase()}`;
    if (memberships.has(key)) return memberships.get(key)!;
    const [org, slug] = owner.slice(1).split('/');
    let cursor: string | null = null;
    do {
      const data: { organization: { team: { members: Page<{ login: string }> } | null } | null } = await graphql(`
        query OwnerMembership($org: String!, $slug: String!, $login: String!, $cursor: String) {
          organization(login: $org) { team(slug: $slug) {
            members(first: 100, query: $login, after: $cursor) { nodes { login } pageInfo { hasNextPage endCursor } }
          } }
        }`, { org, slug, login, cursor }, token, signal, initial);
      const page = data.organization?.team?.members;
      if (!page) throw new Error('Team membership unavailable');
      if (page.nodes.some(member => member.login.toLowerCase() === login.toLowerCase())) { memberships.set(key, true); return true; }
      if (!page.pageInfo.hasNextPage) { memberships.set(key, false); return false; }
      const next = page.pageInfo.endCursor;
      if (!next || next === cursor) throw new Error('Team membership pagination incomplete');
      cursor = next;
    } while (true);
  }
  async function codeOwners(owner: string, name: string, oid: string, signal: AbortSignal, initial: boolean) {
    const key = `${owner}/${name}:${oid}`;
    if (ownerFiles.has(key)) return ownerFiles.get(key)!;
    const data = await graphql<{ repository: Record<string, { text: string | null; byteSize: number; isTruncated: boolean } | null> }>(`
      query CodeOwners($owner: String!, $name: String!, $github: String!, $root: String!, $docs: String!) {
        repository(owner: $owner, name: $name) {
          github: object(expression: $github) { ... on Blob { text byteSize isTruncated } }
          root: object(expression: $root) { ... on Blob { text byteSize isTruncated } }
          docs: object(expression: $docs) { ... on Blob { text byteSize isTruncated } }
        }
      }`, { owner, name, github: `${oid}:.github/CODEOWNERS`, root: `${oid}:CODEOWNERS`, docs: `${oid}:docs/CODEOWNERS` }, token, signal, initial);
    const file = data.repository.github ?? data.repository.root ?? data.repository.docs;
    if (file && (file.text === null || file.isTruncated || file.byteSize >= 3 * 1024 * 1024)) throw new Error('CODEOWNERS unavailable');
    if (file) {
      const validation = await githubRequest<{ errors: unknown[] }>(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/codeowners/errors?ref=${encodeURIComponent(oid)}`,
        { headers: { Accept: 'application/vnd.github+json' } }, token, signal, initial);
      if (!Array.isArray(validation.errors) || validation.errors.length) throw new Error('CODEOWNERS contains invalid ownership rules');
    }
    const parsed = parseCodeOwners(file?.text ?? '');
    ownerFiles.set(key, parsed);
    return parsed;
  }
  async function files(owner: string, name: string, number: number, signal: AbortSignal, initial: boolean) {
    const paths: string[] = [];
    let cursor: string | null = null;
    do {
      const data: { repository: { pullRequest: { files: Page<{ path: string }> | null; changedFiles: number } } } = await graphql(`
        query ReviewFiles($owner: String!, $name: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $name) { pullRequest(number: $number) {
            changedFiles files(first: 100, after: $cursor) { nodes { path } pageInfo { hasNextPage endCursor } }
          } }
        }`, { owner, name, number, cursor }, token, signal, initial);
      const pr = data.repository.pullRequest;
      if (!pr.files) throw new Error('Changed files unavailable');
      paths.push(...pr.files.nodes.map(file => file.path));
      if (!pr.files.pageInfo.hasNextPage) {
        if (paths.length !== pr.changedFiles) throw new Error('Changed files incomplete');
        return paths;
      }
      const next = pr.files.pageInfo.endCursor;
      if (!next || next === cursor) throw new Error('Changed file pagination incomplete');
      cursor = next;
    } while (true);
  }
  return async (owner: string, name: string, prs: PullRequestNode[], directRequests: Set<string> | null, signal: AbortSignal, initial = false): Promise<PullRequestNode[]> => {
    if (!prs.length) return prs;
    let data: { viewer: { login: string }; repository: { viewerPermission: string | null; [key: string]: unknown } | null };
    try {
      data = await graphql(`query ReviewEligibility($owner: String!, $name: String!) {
        viewer { login }
        repository(owner: $owner, name: $name) {
          viewerPermission
          ${prs.map((pr, index) => `p${index}: pullRequest(number: ${pr.number}) {
            viewerDidAuthor reviewDecision baseRefName baseRefOid
            reviewRequests(first: 100) { nodes { requestedReviewer { __typename ... on User { login } } } pageInfo { hasNextPage } }
            latestOpinionatedReviews(first: 100, writersOnly: true) { nodes { state author { login } } pageInfo { hasNextPage } }
            baseRef {
              branchProtectionRule { requireLastPushApproval }
              refUpdateRule { requiredApprovingReviewCount requiresCodeOwnerReviews }
              rules(first: 100) { nodes { repositoryRuleset { enforcement } parameters { ... on PullRequestParameters {
                requiredApprovingReviewCount requireCodeOwnerReview requireLastPushApproval
                requiredReviewers { reviewerId minimumApprovals filePatterns }
              } } } pageInfo { hasNextPage } }
            }
          }`).join('\n')}
        }
      }`, { owner, name }, token, signal, initial);
      if (!data.repository) throw new Error('Repository unavailable');
    } catch {
      signal.throwIfAborted();
      return prs.map(pr => ({ ...pr, reviewEligibility: {
        canReview: !pr.isDraft && directRequests?.has(pr.id) === true,
        reason: directRequests?.has(pr.id) ? 'Requested from you' : 'Review eligibility unavailable', unknown: !directRequests?.has(pr.id),
      } }));
    }
    const viewer = data.viewer.login;
    const viewerCanApprove = ['WRITE', 'MAINTAIN', 'ADMIN'].includes(data.repository!.viewerPermission ?? '');
    const result: PullRequestNode[] = [];
    for (const [index, pr] of prs.entries()) {
      const context = data.repository![`p${index}`] as ReviewContext | null;
      if (!context) { result.push({ ...pr, reviewEligibility: { canReview: !pr.isDraft && directRequests?.has(pr.id) === true, reason: 'Review eligibility unavailable', unknown: true } }); continue; }
      const directlyRequested = directRequests?.has(pr.id) || context.reviewRequests.nodes.some(request => request.requestedReviewer?.__typename === 'User' && request.requestedReviewer.login?.toLowerCase() === viewer.toLowerCase());
      const reviews = context.latestOpinionatedReviews.nodes;
      const approvals = reviews.filter(review => review.state === 'APPROVED').flatMap(review => review.author ? [review.author.login] : []);
      const viewerReview = reviews.find(review => review.author?.login.toLowerCase() === viewer.toLowerCase());
      const required = requirements(context);
      const input = { isDraft: pr.isDraft, viewerDidAuthor: context.viewerDidAuthor, viewerCanApprove,
        directlyRequested, reviewDecision: context.reviewDecision, viewerHasApproved: viewerReview?.state === 'APPROVED',
        viewerRequestedChanges: viewerReview?.state === 'CHANGES_REQUESTED', approvingReviews: approvals.length,
        canProvideCodeOwnerApproval: false, canProvideTeamApproval: false, requirements: required };
      let eligibility = reviewEligibility(input);
      if (!eligibility.canReview && !pr.isDraft && !context.viewerDidAuthor && viewerCanApprove && !input.viewerHasApproved && context.reviewDecision !== 'APPROVED') {
        if (context.latestOpinionatedReviews.pageInfo.hasNextPage) {
          eligibility = { canReview: false, unknown: true, reason: 'Review eligibility unavailable' };
        } else if (required && (required.requireCodeOwnerReview || required.requiredTeamReviews)) {
          try {
            const paths = await files(owner, name, pr.number, signal, initial);
            let unresolved = false;
            if (required.requireCodeOwnerReview) {
              try {
                const rules = await codeOwners(owner, name, context.baseRefOid, signal, initial);
                input.canProvideCodeOwnerApproval = await canApproveUnmetOwnerGroup(paths, rules, approvals, viewer,
                  (codeOwner, login) => isOwner(codeOwner, login, signal, initial));
              } catch { signal.throwIfAborted(); unresolved = true; }
            }
            for (const team of required.teamRules) {
              if (input.canProvideCodeOwnerApproval) break;
              try {
                const patterns = ignore().add(team.filePatterns);
                if (!paths.some(path => patterns.test(path).ignored)) continue;
                const identity = await requiredTeamOwner(team.reviewerId, owner, name, signal, initial);
                if (!await isOwner(identity, viewer, signal, initial)) continue;
                let approved = 0;
                for (const login of approvals) if (await isOwner(identity, login, signal, initial)) approved++;
                if (approved < team.minimumApprovals) { input.canProvideTeamApproval = true; break; }
              } catch { signal.throwIfAborted(); unresolved = true; }
            }
            eligibility = reviewEligibility(input);
            if (unresolved && !eligibility.canReview) eligibility = { canReview: false, unknown: true, reason: 'Review eligibility unavailable' };
          } catch {
            signal.throwIfAborted();
            eligibility = { canReview: false, unknown: true, reason: 'Review eligibility unavailable' };
          }
        }
      }
      if (!directlyRequested && !pr.isDraft && !context.viewerDidAuthor && data.repository!.viewerPermission === null) eligibility = { canReview: false, unknown: true, reason: 'Review eligibility unavailable' };
      // Missing later reviews can hide the viewer's already-counted approval.
      if (!directlyRequested && !pr.isDraft && !context.viewerDidAuthor && context.latestOpinionatedReviews.pageInfo.hasNextPage) eligibility = { canReview: false, unknown: true, reason: 'Review eligibility unavailable' };
      result.push({ ...pr, reviewEligibility: eligibility });
    }
    return result;
  };
}
