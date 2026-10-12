import { getToken } from "./token.ts";
import { githubRequest, GitHubApiError } from "./githubRequest.ts";
export { GitHubApiError } from "./githubRequest.ts";

async function graphql<T>(query: string, variables: Record<string, unknown>, token?: string, signal?: AbortSignal, initial = false): Promise<T> {
  const effectiveToken = token ?? getToken() ?? "";
  const json = await githubRequest<{ data?: T }>("https://api.github.com/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  }, effectiveToken, signal, initial);
  if (!json.data) throw new GitHubApiError("Empty GraphQL response", undefined, true);
  return json.data;
}

export interface Viewer { login: string; avatarUrl: string }
export async function fetchViewer(token: string): Promise<Viewer> {
  const data = await graphql<{ viewer: Viewer }>("query Viewer { viewer { login avatarUrl } }", {}, token);
  return data.viewer;
}

export type CheckState =
  | "SUCCESS"
  | "FAILURE"
  | "ERROR"
  | "PENDING"
  | "EXPECTED";

export type MergeableState = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

export type ReviewDecision =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "REVIEW_REQUIRED"
  | null;

export interface PullRequestNode {
  id: string;
  number: number;
  title: string;
  body?: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  author: { login: string; avatarUrl: string } | null;
  headRefName: string;
  baseRefName: string;
  mergeable: MergeableState;
  reviewDecision: ReviewDecision;
  additions: number;
  deletions: number;
  commits: {
    nodes: Array<{
      commit: {
        oid: string;
        statusCheckRollup: { state: CheckState } | null;
      };
    }>;
  };
  comments: { totalCount: number };
}

export interface RepoPullRequests {
  nameWithOwner: string;
  url: string;
  pullRequests: { nodes: PullRequestNode[] };
}

export interface PullRequestCountTarget {
  owner: string;
  name: string;
  members?: readonly string[];
}

export interface PullRequestPage {
  nameWithOwner: string;
  url: string;
  nodes: PullRequestNode[];
  totalCount: number;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

const PR_FIELDS = `
          id
          number
          title
          body
          url
          isDraft
          createdAt
          updatedAt
          author {
            login
            avatarUrl
          }
          headRefName
          baseRefName
          mergeable
          reviewDecision
          additions
          deletions
          commits(last: 1) {
            nodes {
              commit {
                oid
                statusCheckRollup {
                  state
                }
              }
            }
          }
          comments {
            totalCount
          }
`;

function teamSearch(owner: string, name: string, members: readonly string[]): string {
  return [`repo:${owner}/${name}`, "is:pr", "is:open", "sort:updated-desc", ...members.map(m => `author:${m}`)].join(" ");
}

export async function fetchPullRequestCounts(targets: readonly PullRequestCountTarget[], token: string, signal?: AbortSignal): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (let offset = 0; offset < targets.length; offset += 5) {
    signal?.throwIfAborted();
    const batch = targets.slice(offset, offset + 5);
    const variables: Record<string, unknown> = {};
    const declarations: string[] = [];
    const selections: string[] = [];
    batch.forEach((target, index) => {
      if (target.members?.length === 0) { counts[`${target.owner}/${target.name}`] = 0; return; }
      if (target.members) {
        declarations.push(`$q${index}: String!`);
        variables[`q${index}`] = teamSearch(target.owner, target.name, target.members);
        selections.push(`r${index}: search(query: $q${index}, type: ISSUE) { issueCount }`);
      } else {
        declarations.push(`$owner${index}: String!`, `$name${index}: String!`);
        variables[`owner${index}`] = target.owner; variables[`name${index}`] = target.name;
        selections.push(`r${index}: repository(owner: $owner${index}, name: $name${index}) { pullRequests(states: OPEN) { totalCount } }`);
      }
    });
    if (!selections.length) continue;
    const data = await graphql<Record<string, { issueCount?: number; pullRequests?: { totalCount: number } } | null>>(`query PullRequestCounts(${declarations.join(", ")}) { ${selections.join("\n")} }`, variables, token, signal);
    batch.forEach((target, index) => {
      if (target.members?.length === 0) return;
      const result = data[`r${index}`];
      const count = target.members ? result?.issueCount : result?.pullRequests?.totalCount;
      if (typeof count === "number") counts[`${target.owner}/${target.name}`] = count;
    });
  }
  return counts;
}

export async function fetchPullRequestPage(owner: string, name: string, cursor: string | null, members?: readonly string[], token?: string, signal?: AbortSignal, initial = false): Promise<PullRequestPage> {
  signal?.throwIfAborted();
  const effectiveToken = token ?? getToken() ?? "";
  const summary = { nameWithOwner: `${owner}/${name}`, url: `https://github.com/${owner}/${name}` };
  if (members) {
    if (!members.length) return { ...summary, nodes: [], totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null } };
    type SearchNode = (PullRequestNode & { __typename: "PullRequest" }) | { __typename: string };
    const data = await graphql<{ search: { nodes: SearchNode[]; issueCount: number; pageInfo: PullRequestPage["pageInfo"] } }>(`
      query TeamPRPage($q: String!, $cursor: String) {
        search(query: $q, type: ISSUE, first: 25, after: $cursor) {
          issueCount pageInfo { hasNextPage endCursor }
          nodes { __typename ... on PullRequest { ${PR_FIELDS} } }
        }
      }`, { q: teamSearch(owner, name, members), cursor }, effectiveToken, signal, initial);
    return { ...summary, nodes: data.search.nodes.filter((node): node is PullRequestNode & { __typename: "PullRequest" } => node.__typename === "PullRequest"), totalCount: data.search.issueCount, pageInfo: data.search.pageInfo };
  }
  const data = await graphql<{ repository: { nameWithOwner: string; url: string; pullRequests: { nodes: PullRequestNode[]; totalCount: number; pageInfo: PullRequestPage["pageInfo"] } } | null }>(`
    query RepoPRPage($owner: String!, $name: String!, $cursor: String) {
      repository(owner: $owner, name: $name) {
        nameWithOwner url
        pullRequests(states: OPEN, first: 25, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
          totalCount pageInfo { hasNextPage endCursor }
          nodes { ${PR_FIELDS} }
        }
      }
    }`, { owner, name, cursor }, effectiveToken, signal, initial);
  if (!data.repository) throw new GitHubApiError(`Repository not found: ${owner}/${name}`, 404);
  return { nameWithOwner: data.repository.nameWithOwner, url: data.repository.url, ...data.repository.pullRequests };
}
