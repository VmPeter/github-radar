export interface ReviewRequirements {
  requiredApprovingReviewCount: number;
  requireCodeOwnerReview: boolean;
  requireLastPushApproval: boolean;
  requiredTeamReviews?: boolean;
}

export interface ReviewEligibilityInput {
  isDraft: boolean;
  viewerDidAuthor: boolean;
  viewerCanApprove: boolean;
  directlyRequested: boolean;
  reviewDecision: string | null;
  viewerHasApproved: boolean;
  viewerRequestedChanges?: boolean;
  approvingReviews: number;
  canProvideCodeOwnerApproval: boolean;
  canProvideTeamApproval?: boolean;
  requirements: ReviewRequirements | null;
}

export interface ReviewEligibility {
  canReview: boolean;
  reason: string;
  unknown: boolean;
}

export function reviewEligibility(input: ReviewEligibilityInput): ReviewEligibility {
  const result = (canReview: boolean, reason: string, unknown = false): ReviewEligibility => ({ canReview, reason, unknown });
  if (input.isDraft) return result(false, 'Draft');
  if (input.viewerDidAuthor) return result(false, 'Cannot approve your own PR');
  if (input.directlyRequested) return result(true, 'Requested from you');
  if (input.reviewDecision === 'APPROVED') return result(false, 'Review requirements already met');
  if (input.viewerHasApproved) return result(false, 'Already approved by you', Boolean(input.requirements?.requireLastPushApproval));
  if (!input.viewerCanApprove) return result(false, 'Waiting on another reviewer');
  if (input.viewerRequestedChanges) return result(true, 'Your approval can resolve requested changes');
  const requirements = input.requirements;
  if (!requirements) return result(false, 'Review eligibility unavailable', true);
  if (input.approvingReviews < requirements.requiredApprovingReviewCount) {
    return result(true, 'Your approval can count');
  }
  if (requirements.requireCodeOwnerReview && input.canProvideCodeOwnerApproval) {
    return result(true, 'Your code owner approval can count');
  }
  if (input.canProvideTeamApproval) return result(true, 'Your required team approval can count');
  // A remaining last-push or team-specific requirement needs additional evidence.
  // Repository write access alone cannot establish that this viewer qualifies.
  if (requirements.requireLastPushApproval || requirements.requiredTeamReviews) {
    return result(false, 'Review eligibility unavailable', true);
  }
  if (requirements.requireCodeOwnerReview || input.reviewDecision === 'CHANGES_REQUESTED') {
    return result(false, 'Waiting on another reviewer');
  }
  return result(false, 'Review requirements already met');
}
