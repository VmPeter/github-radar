import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewEligibility, type ReviewEligibilityInput } from '../src/lib/reviewEligibility.ts';

const input = (changes: Partial<ReviewEligibilityInput> = {}): ReviewEligibilityInput => ({
  isDraft: false, viewerDidAuthor: false, viewerCanApprove: true,
  directlyRequested: false, reviewDecision: 'REVIEW_REQUIRED', viewerHasApproved: false,
  approvingReviews: 0, canProvideCodeOwnerApproval: false,
  requirements: { requiredApprovingReviewCount: 1, requireCodeOwnerReview: false, requireLastPushApproval: false },
  ...changes,
});

test('unrequested writers can contribute a missing general approval', () => {
  assert.deepEqual(reviewEligibility(input()), { canReview: true, reason: 'Your approval can count', unknown: false });
  assert.equal(reviewEligibility(input({ viewerCanApprove: false })).canReview, false);
});

test('named requests are included even when eligibility cannot be established or requirements are met', () => {
  for (const changes of [
    { requirements: null }, { viewerCanApprove: false },
    { reviewDecision: 'APPROVED' }, { viewerHasApproved: true },
  ]) assert.deepEqual(reviewEligibility(input({ ...changes, directlyRequested: true })), {
    canReview: true, reason: 'Requested from you', unknown: false,
  });
});

test('own PRs and drafts never become approvable through a named request', () => {
  assert.equal(reviewEligibility(input({ directlyRequested: true, isDraft: true })).reason, 'Draft');
  assert.equal(reviewEligibility(input({ directlyRequested: true, viewerDidAuthor: true })).reason, 'Cannot approve your own PR');
});

test('existing approvals do not create another useful general approval', () => {
  assert.equal(reviewEligibility(input({ viewerHasApproved: true })).reason, 'Already approved by you');
  assert.equal(reviewEligibility(input({ reviewDecision: 'APPROVED' })).reason, 'Review requirements already met');
  assert.equal(reviewEligibility(input({ approvingReviews: 1 })).canReview, false);
});

test('eligible ownership of an unmet code-owner group can contribute after the general count is met', () => {
  const requirements = { requiredApprovingReviewCount: 1, requireCodeOwnerReview: true, requireLastPushApproval: false };
  assert.equal(reviewEligibility(input({ approvingReviews: 1, requirements, canProvideCodeOwnerApproval: true })).reason, 'Your code owner approval can count');
  assert.equal(reviewEligibility(input({ approvingReviews: 1, requirements })).canReview, false);
  assert.equal(reviewEligibility(input({ approvingReviews: 1, canProvideCodeOwnerApproval: true })).canReview, false);
});

test('missing requirements and unresolved last-push/team eligibility remain unknown', () => {
  assert.equal(reviewEligibility(input({ requirements: null })).unknown, true);
  for (const flags of [{ requireLastPushApproval: true }, { requiredTeamReviews: true }]) {
    const requirements = { requiredApprovingReviewCount: 1, requireCodeOwnerReview: false, requireLastPushApproval: false, ...flags };
    assert.equal(reviewEligibility(input({ approvingReviews: 1, requirements })).unknown, true);
    assert.equal(reviewEligibility(input({ requirements })).canReview, true);
  }
});

test('changes requested from another reviewer do not imply this viewer can resolve them', () => {
  assert.equal(reviewEligibility(input({ approvingReviews: 1, reviewDecision: 'CHANGES_REQUESTED' })).reason, 'Waiting on another reviewer');
});

test('the viewer can replace their own blocking request for changes without known rules', () => {
  assert.deepEqual(reviewEligibility(input({
    approvingReviews: 1, reviewDecision: 'CHANGES_REQUESTED', viewerRequestedChanges: true, requirements: null,
  })), { canReview: true, reason: 'Your approval can resolve requested changes', unknown: false });
  assert.equal(reviewEligibility(input({ viewerRequestedChanges: true, viewerCanApprove: false })).canReview, false);
  assert.equal(reviewEligibility(input({ viewerRequestedChanges: true, reviewDecision: 'APPROVED' })).canReview, false);
  assert.equal(reviewEligibility(input({ viewerRequestedChanges: true, viewerDidAuthor: true })).canReview, false);
  assert.equal(reviewEligibility(input({ viewerRequestedChanges: true, isDraft: true })).canReview, false);
});
