# Public Main Branch Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `WongKaiSung/sql-management` public and immediately protect `main` with the approved solo-maintainer policy.

**Architecture:** Finish all Git/file work while the repository is still private and unprotected, then perform the visibility change and protection API update in one guarded PowerShell operation. Read back every GitHub setting afterward; roll visibility back to private if branch protection fails.

**Tech Stack:** Git, GitHub CLI 2.96+, GitHub REST API version `2022-11-28`, PowerShell, Node.js/pnpm.

## Global Constraints

- Do not rewrite Git history.
- Keep `main` as the default branch.
- Require pull requests with zero approving reviews.
- Enforce protection for administrators.
- Require conversation resolution and linear history.
- Block force pushes and branch deletion.
- Do not require a status check until application CI exists.
- If protection fails after publication, immediately attempt to return the repository to private.
- Do not alter application behavior.

---

### Task 1: Remove Workflow Notes From the Public Tree

**Files:**
- Delete: `docs/superpowers/specs/2026-07-30-public-main-protection-design.md`
- Delete: `docs/superpowers/plans/2026-07-30-public-main-protection.md`

**Interfaces:**
- Consumes: The committed design and execution plan required for this workflow.
- Produces: A current tracked tree with no internal `docs/superpowers/` files before publication.

- [ ] **Step 1: Delete both tracked workflow files with explicit repository-scoped patches**

Use `apply_patch` with one `Delete File` directive for each exact path above. Do not change `.gitignore`; it already ignores `docs/superpowers/`.

- [ ] **Step 2: Verify the current tracked tree excludes workflow notes**

```powershell
$tracked = git ls-files docs/superpowers
if ($tracked) { $tracked; exit 1 }
git diff --check
```

Expected: no tracked paths and a zero exit code.

- [ ] **Step 3: Commit the cleanup**

```powershell
git add -u docs/superpowers
git commit -m "Remove internal release workflow notes"
```

---

### Task 2: Run and Push the Final Private Preflight

**Files:**
- Verify: entire current tracked tree and all reachable Git history.

**Interfaces:**
- Consumes: The public-release candidate on local `main`.
- Produces: A clean, tested private remote commit that needs no direct push after protection is enabled.

- [ ] **Step 1: Run application and dependency verification**

With the bundled Node and pnpm paths available, run:

```powershell
pnpm run check
pnpm test
pnpm audit --prod --json
pnpm dlx npm@10.9.2 audit --omit=dev --json
git diff --check
```

Expected: syntax checks pass, all 64 tests pass, and both audits report zero vulnerabilities.

- [ ] **Step 2: Repeat current-tree and all-history safety scans**

Verify there are no tracked `.env`, key/certificate files, internal workflow notes, old local paths, high-confidence token formats, private-key headers, or credential-bearing URLs. Enumerate every commit from `git rev-list --all` and use `git grep` against each commit. Manually classify password-like matches; only unmistakable example values are acceptable.

- [ ] **Step 3: Push while the repository remains private**

```powershell
gh repo view WongKaiSung/sql-management --json visibility
git status --short --branch
git push origin main
```

Expected: visibility is `PRIVATE`, the working tree is clean, and the push succeeds.

- [ ] **Step 4: Confirm local and remote SHAs match**

```powershell
$local = git rev-parse HEAD
$remote = ((git ls-remote origin refs/heads/main) -split '\s+')[0]
if ($local -ne $remote) { exit 1 }
```

Expected: exact SHA equality.

---

### Task 3: Make the Repository Public and Protect Main

**Files:**
- Modify externally: GitHub repository visibility.
- Modify externally: classic branch protection for `main`.

**Interfaces:**
- Consumes: A synchronized private `main` and authenticated owner-level GitHub CLI session.
- Produces: A public repository whose default branch rejects direct and destructive changes.

- [ ] **Step 1: Prepare the exact branch-protection payload in memory**

```powershell
$protection = @{
  required_status_checks = $null
  enforce_admins = $true
  required_pull_request_reviews = @{
    dismiss_stale_reviews = $true
    require_code_owner_reviews = $false
    required_approving_review_count = 0
    require_last_push_approval = $false
  }
  restrictions = $null
  required_linear_history = $true
  allow_force_pushes = $false
  allow_deletions = $false
  block_creations = $false
  required_conversation_resolution = $true
  lock_branch = $false
  allow_fork_syncing = $true
} | ConvertTo-Json -Depth 5 -Compress
```

- [ ] **Step 2: Change visibility and immediately apply protection**

Run both actions in one guarded PowerShell command:

```powershell
gh repo edit WongKaiSung/sql-management `
  --visibility public `
  --accept-visibility-change-consequences
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$protection | gh api `
  --method PUT `
  -H 'Accept: application/vnd.github+json' `
  -H 'X-GitHub-Api-Version: 2022-11-28' `
  repos/WongKaiSung/sql-management/branches/main/protection `
  --input -

if ($LASTEXITCODE -ne 0) {
  gh repo edit WongKaiSung/sql-management `
    --visibility private `
    --accept-visibility-change-consequences
  exit 1
}
```

Expected: both the visibility and protection API calls succeed. If protection fails, the command attempts rollback and exits nonzero.

---

### Task 4: Enable Reporting and Verify Every Setting

**Files:**
- Modify externally: GitHub private vulnerability reporting setting.
- Verify externally: repository metadata and branch protection.

**Interfaces:**
- Consumes: The now-public, protected repository.
- Produces: A complete evidence record for visibility, branch controls, reporting, Git synchronization, and working-tree cleanliness.

- [ ] **Step 1: Enable private vulnerability reporting**

```powershell
gh api --method PUT repos/WongKaiSung/sql-management/private-vulnerability-reporting
```

Expected: HTTP 204. Failure is reported separately and does not remove successful branch protection.

- [ ] **Step 2: Read back repository and protection state**

```powershell
gh repo view WongKaiSung/sql-management --json visibility,defaultBranchRef,url
gh api repos/WongKaiSung/sql-management/branches/main/protection
gh api repos/WongKaiSung/sql-management/private-vulnerability-reporting
```

Verify the response shows:

```text
visibility = PUBLIC
default branch = main
required approving reviews = 0
enforce admins = true
required conversation resolution = true
required linear history = true
force pushes enabled = false
deletions enabled = false
```

- [ ] **Step 3: Verify Git and deliver the result**

```powershell
git status --short --branch
git rev-parse HEAD
git ls-remote origin refs/heads/main
```

Expected: clean `main`, local/remote SHA equality, and no unpushed work. Report the public URL, exact protection policy, vulnerability-reporting status, verification results, and any rollback or limitation.
