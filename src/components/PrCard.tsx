import { formatDistanceToNowStrict } from "date-fns";
import { GitBranch, MessageSquare, ExternalLink, CheckCircle2, GitMerge } from "lucide-react";
import type { PullRequestNode } from "../lib/github";
import { deriveStatus } from "../lib/status";
import { StatusFooter } from "./StatusFooter";

interface PrCardProps {
  pr: PullRequestNode;
  owner: string;
  name: string;
}

function plusMinus(additions: number, deletions: number) {
  return (
    <span className="font-mono text-xs">
      <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>
      {" "}
      <span className="text-rose-600 dark:text-rose-400">-{deletions}</span>
    </span>
  );
}

export function PrCard({ pr, owner, name }: PrCardProps) {
  const status = deriveStatus(pr);
  const age = formatDistanceToNowStrict(new Date(pr.createdAt), { addSuffix: true });
  const updated = formatDistanceToNowStrict(new Date(pr.updatedAt), { addSuffix: true });

  return (
    <article className="card flex flex-col overflow-hidden transition-colors hover:border-slate-300 dark:hover:border-slate-700">
      <header className="flex items-start gap-2 p-3">
        {pr.author?.avatarUrl ? (
          <img
            src={pr.author.avatarUrl}
            alt={pr.author.login}
            className="h-7 w-7 rounded-full flex-shrink-0 mt-0.5"
            loading="lazy"
          />
        ) : (
          <div className="h-7 w-7 rounded-full bg-slate-200 dark:bg-slate-700 flex-shrink-0 mt-0.5" />
        )}
        <div className="min-w-0 flex-1">
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="block text-sm font-medium leading-snug line-clamp-2 hover:underline group"
          >
            {pr.title}
            <ExternalLink className="inline h-3 w-3 ml-1 opacity-0 group-hover:opacity-60 transition-opacity" />
          </a>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            <span className="font-mono">#{pr.number}</span>
            <span aria-hidden>&middot;</span>
            <span className="truncate">{pr.author?.login ?? "unknown"}</span>
            {status.approved && (
              <span className="pill bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                title={status.readyToMerge ? "Approved, checks passing and mergeable; GitHub verifies final merge requirements" : "Review approved; check CI and merge status before merging"}>
                {status.readyToMerge ? <GitMerge className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
                {status.readyToMerge ? "Ready to merge" : "Approved"}
              </span>
            )}
            {pr.isDraft && (
              <span className="pill bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                Draft
              </span>
            )}
            {!pr.isDraft && pr.reviewEligibility?.canReview && (
              <span className="pill bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                title={pr.reviewEligibility.reason}>
                {pr.reviewEligibility.reason === 'Requested from you' ? 'Requested from you' : 'Can review'}
              </span>
            )}
            {pr.reviewEligibility?.unknown && <span className="pill bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400" title="Unable to confirm whether your approval would help meet the remaining requirements. Open the PR to check.">Eligibility unknown</span>}
          </div>
        </div>
      </header>

      <div className="px-3 pb-3 space-y-1.5">
        <div className="flex items-center gap-1 text-xs text-slate-600 dark:text-slate-400 min-w-0">
          <GitBranch className="h-3 w-3 flex-shrink-0" />
          <span className="font-mono truncate" title={`${pr.headRefName} -> ${pr.baseRefName}`}>
            {pr.headRefName}
            <span className="mx-1 text-slate-400">&rarr;</span>
            {pr.baseRefName}
          </span>
        </div>
        <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
          <span title={`Opened ${age} \u00b7 updated ${updated}`}>
            opened {age}
          </span>
          <span className="flex items-center gap-2">
            {plusMinus(pr.additions, pr.deletions)}
            {pr.comments.totalCount > 0 && (
              <span className="inline-flex items-center gap-0.5">
                <MessageSquare className="h-3 w-3" />
                {pr.comments.totalCount}
              </span>
            )}
          </span>
        </div>
      </div>

      <StatusFooter status={status} owner={owner} name={name} sha={pr.commits.nodes[0]?.commit.oid} prUrl={pr.url} />
    </article>
  );
}
