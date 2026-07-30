# Public Main Branch Protection Design

## Goal

Make `WongKaiSung/sql-management` public and immediately protect its default `main` branch with a policy suitable for a solo maintainer. The repository is currently private, clean, and synchronized at `0aea3542cb215b5f45a2caeca81c64ae0476c765`.

## Constraint

GitHub currently returns HTTP 403 for both classic branch protection and repository rulesets, stating that this private repository must be made public or the account upgraded to GitHub Pro. Therefore visibility must change before protection can be applied.

There is no application test workflow on GitHub Actions. The only listed workflow is GitHub's dynamic Dependabot Updates workflow, so no required application status check can be configured yet.

## Protection Policy

Use classic branch protection for `main` with these settings:

- require changes through pull requests;
- require zero approving reviews so the solo owner can merge their own pull requests;
- dismiss stale approvals when new commits are pushed;
- do not require Code Owner review;
- do not require approval of the most recent push;
- enforce protection for administrators;
- require all review conversations to be resolved;
- require linear history;
- block force pushes;
- block branch deletion;
- allow fork synchronization;
- do not require status checks until a project CI workflow exists;
- do not restrict pushes to a named user/team list.

This prevents direct pushes to `main`, including by the repository owner, while keeping self-maintained pull requests mergeable.

## Execution Sequence

1. Verify that local and remote `main` still match, the working tree is clean, tests and syntax checks pass, both dependency audits report zero vulnerabilities, and the current tree/history secret checks remain clean.
2. Remove the workflow design and plan files from the current tracked tree and push that cleanup while the repository is still private and unprotected.
3. Change repository visibility from private to public, explicitly accepting GitHub's visibility-change consequences.
4. Immediately apply the approved classic protection policy to `main` through GitHub's branch protection API.
5. Enable GitHub private vulnerability reporting now that the repository is public, matching `SECURITY.md`.
6. Read back repository visibility, default branch, full protection settings, and private vulnerability reporting status.

## Failure Handling

If the visibility change fails, stop without attempting protection.

If protection fails after the repository becomes public, immediately attempt to return the repository to private, then report both the protection failure and rollback result. This rollback limits exposure but cannot guarantee that no one observed or copied the repository during the public interval.

If protection succeeds but private vulnerability reporting cannot be enabled, keep the repository public and protected, report that secondary failure, and do not weaken branch protection.

## Verification

Completion requires evidence that:

- GitHub reports repository visibility as `PUBLIC`;
- `main` remains the default branch;
- pull requests are required with zero required approvals;
- administrator enforcement, conversation resolution, and linear history are enabled;
- force pushes and deletions are disabled;
- local and remote `main` still point to the same commit;
- the working tree is clean;
- private vulnerability reporting is enabled, or its failure is reported separately.

The change must not rewrite Git history, alter application behavior, or add a required status check that does not exist.
