# SQL Management Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the existing application as **SQL Management** in a private GitHub repository named `sql-management`, while preserving compatibility-sensitive internal identifiers.

**Architecture:** Treat branding as a presentation and metadata concern. Add focused Node tests for public branding and compatibility identifiers, update only public strings and safe metadata, curate the initial Git file set, then publish the existing `main` branch directly because this is a new repository with no pre-existing base branch.

**Tech Stack:** Node.js 18+, Express, inline HTML/CSS/JavaScript, CodeMirror 5, `node:test`, Git, GitHub CLI 2.96+

## Global Constraints

- The public display name is exactly **SQL Management**.
- The repository and safe package slug are exactly `sql-management`.
- Preserve localStorage keys, saved-profile identifiers, environment-variable names, Docker container/image/service/volume identifiers, PostgreSQL/SQL Server application identifiers, internal API routes, and protocol fields.
- Include application source, tests, documentation, lockfiles, Docker/IIS deployment files, and maintenance utilities.
- Exclude `.env`, dependencies, package stores, logs, generated distributions, crash dumps, and stale backup files.
- Create the initial GitHub repository as private; visibility can be changed later without changing Git history.

---

### Task 1: Curate and commit the source baseline

**Files:**
- Modify: `.gitignore:1-9`
- Include unchanged source: `.dockerignore`, `.env.example`, `AGENTS.md`, `CLAUDE.md`, `Dockerfile`, `LICENSE`, `README.md`, `deploy/`, `docker-compose.yml`, `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `public/index.html`, `public/ux-helpers.js`, `reclaim-pg.js`, `server.js`, `tests/`, `web.config`

**Interfaces:**
- Consumes: the existing local project tree and the design commit `f4d4158`
- Produces: a reviewable baseline commit containing source files but no credentials or generated artifacts

- [ ] **Step 1: Extend repository ignores for known local/generated files**

Append these exact entries to `.gitignore`:

```gitignore
.pnpm-store/
dist/
iisnode/
*.bak
*.stackdump
public/index_FIXED.html
```

- [ ] **Step 2: Verify sensitive and generated paths are ignored**

Run:

```powershell
git check-ignore -v -- .env node_modules logs .pnpm-store dist iisnode server.js.bak bash.exe.stackdump public/index_FIXED.html
```

Expected: every supplied path is listed with a matching `.gitignore` rule. `.env.example` must not appear.

- [ ] **Step 3: Stage only the intended baseline files**

Run:

```powershell
git add -- .dockerignore .env.example .gitignore AGENTS.md CLAUDE.md Dockerfile LICENSE README.md deploy docker-compose.yml package.json package-lock.json pnpm-lock.yaml public/index.html public/ux-helpers.js reclaim-pg.js server.js tests web.config
```

- [ ] **Step 4: Inspect the baseline and verify credentials are absent**

Run:

```powershell
git diff --cached --check
git diff --cached --name-only
git ls-files --error-unmatch .env
```

Expected: the first command has no output; the second lists only the paths from Step 3; the third exits non-zero because `.env` is not staged or tracked.

- [ ] **Step 5: Run the unchanged baseline checks**

Run:

```powershell
npm run check
npm test
```

Expected: both commands exit 0 before branding changes begin.

- [ ] **Step 6: Commit the baseline**

Run:

```powershell
git commit -m "Import SQL management application"
```

Expected: the commit includes the curated application tree and leaves only ignored local artifacts untracked.

---

### Task 2: Rename the visible application shell with compatibility tests

**Files:**
- Modify: `tests/ui-structure.test.js:1-20`
- Modify: `tests/ux-helpers.test.js:166-174`
- Modify: `public/index.html:6,1770,1777,9228`
- Modify: `public/ux-helpers.js:211-216`

**Interfaces:**
- Consumes: `readHtml()` in `tests/ui-structure.test.js` and `validateWorkspacePayload()` in `public/ux-helpers.js`
- Produces: visible SQL Management branding while retaining `SQLConnectUX` and the existing localStorage keys

- [ ] **Step 1: Add a failing shell-branding test**

Add this test after the final-newline test in `tests/ui-structure.test.js`:

```javascript
test('public shell uses SQL Management branding without changing compatibility identifiers', () => {
  const html = readHtml();

  assert.match(html, /<title>SQL Management<\/title>/);
  assert.match(html, /<h1>SQL Management<\/h1>/);
  assert.match(html, /SQL Management could not start the query editor\./);
  assert.match(html, /sql-management-workspace-/);
  assert.match(html, /SQLConnectUX/);
  assert.match(html, /sqlconnectWorkspacePanels:v1/);
  assert.match(html, /sqlconnectWorkspaceBackup:v1/);
});
```

- [ ] **Step 2: Change the existing workspace-error expectations first**

In `tests/ux-helpers.test.js`, replace both expected error strings with:

```javascript
'Invalid SQL Management workspace file'
```

- [ ] **Step 3: Run the focused tests and confirm they fail for the old branding**

Run:

```powershell
node --test tests/ui-structure.test.js tests/ux-helpers.test.js
```

Expected: failures mention the old `SQLConnect` title/header, old workspace download filename, and old invalid-file message.

- [ ] **Step 4: Apply the minimal public-string replacements**

Make these exact replacements:

```text
<title>SQLConnect</title>                               -> <title>SQL Management</title>
SQLConnect could not start the query editor.           -> SQL Management could not start the query editor.
<h1>SQLConnect</h1>                                    -> <h1>SQL Management</h1>
sqlconnect-workspace-${date}.json                      -> sql-management-workspace-${date}.json
Invalid SQLConnect workspace file                      -> Invalid SQL Management workspace file
```

Do not rename `SQLConnectUX`, `sqlconnectWorkspacePanels:v1`, `sqlconnectRecentlyClosedTabs:v1`, or `sqlconnectWorkspaceBackup:v1`.

- [ ] **Step 5: Run the focused tests and confirm they pass**

Run:

```powershell
node --test tests/ui-structure.test.js tests/ux-helpers.test.js
```

Expected: all focused tests pass.

- [ ] **Step 6: Commit the application-shell rename**

Run:

```powershell
git add -- public/index.html public/ux-helpers.js tests/ui-structure.test.js tests/ux-helpers.test.js
git commit -m "Rename application shell to SQL Management"
```

---

### Task 3: Rename safe project metadata and documentation

**Files:**
- Modify: `package.json:2-4`
- Modify: `package-lock.json:2-9`
- Modify: `README.md:1-3`
- Modify: `AGENTS.md:7`
- Modify: `CLAUDE.md:7`
- Modify: `.env.example:1`
- Modify: `Dockerfile:1`
- Modify: `LICENSE:3`
- Modify: `server.js:1892-1895`
- Modify: `web.config:3`
- Modify: `deploy/DOCKER-HOSTING-GUIDE.md:1,115`
- Modify: `deploy/IIS-HOSTING-GUIDE.md:1,80,86`
- Modify: `deploy/install-service.ps1:4`
- Modify: `deploy/setup-iis-site.ps1:3`

**Interfaces:**
- Consumes: package metadata, documentation headings, server startup output, and existing deployment defaults
- Produces: consistent SQL Management presentation with compatibility identifiers verified by structured checks and an explicit audit

- [ ] **Step 1: Record the old metadata and compatibility baseline**

Run:

```powershell
node -e "const p=require('./package.json'); const l=require('./package-lock.json'); console.log(JSON.stringify({packageName:p.name,description:p.description,lockName:l.name,lockRootName:l.packages[''].name},null,2))"
rg -n '(SQLConnectUX|sqlconnectWorkspacePanels:v1|application_name LIKE|\$SiteName|container_name: dualsql)' public reclaim-pg.js deploy docker-compose.yml
```

Expected: package metadata reports `dualsql`; the compatibility command lists the identifiers that must survive the rename.

- [ ] **Step 2: Update safe package metadata**

Apply these exact values in `package.json` and the two root-name fields in `package-lock.json`:

```json
"name": "sql-management",
"description": "SQL Management — web-based SQL client for MSSQL and PostgreSQL"
```

- [ ] **Step 3: Update public prose without renaming operational identifiers**

Use **SQL Management** for the file headings, comments, copyright, server startup banner, and prose locations listed in the Files section. Keep these exact technical values unchanged wherever they occur:

```text
dualsql
SQLConnectUX
sqlconnectWorkspacePanels:v1
sqlconnectRecentlyClosedTabs:v1
sqlconnectWorkspaceBackup:v1
application_name LIKE 'sqlconnect%'
$SiteName = "SQLConnect"
$AppPool = "SQLConnect"
```

In deployment guides, change product prose and headings but retain commands, image names, container names, IIS site names, and IIS app-pool names.

- [ ] **Step 4: Validate structured metadata and run the full project checks**

Run:

```powershell
node -e "const assert=require('node:assert/strict'); const p=require('./package.json'); const l=require('./package-lock.json'); assert.equal(p.name,'sql-management'); assert.equal(p.description,'SQL Management — web-based SQL client for MSSQL and PostgreSQL'); assert.equal(l.name,'sql-management'); assert.equal(l.packages[''].name,'sql-management')"
npm run check
npm test
```

Expected: all commands exit 0.

- [ ] **Step 5: Audit every residual old-name occurrence against the compatibility allowlist**

Run:

```powershell
rg -n --hidden -g '!.env' -g '!node_modules/**' -g '!.pnpm-store/**' -g '!logs/**' -g '!dist/**' -g '!.claude/**' -g '!.superpowers/**' -g '!docs/superpowers/**' -g '!*.bak' -g '!public/index_FIXED.html' '(DualSQL|SQLConnect|dualsql|sqlconnect)' .
```

Expected: residual occurrences are limited to Docker/build artifact identifiers, `SQLConnectUX`, localStorage/workspace compatibility keys, PostgreSQL `sqlconnect%` application-name matching, and preserved IIS `$SiteName`/`$AppPool` values. No title, heading, descriptive package metadata, startup banner, copyright, or public error message uses the old names.

- [ ] **Step 6: Commit metadata and documentation**

Run:

```powershell
git add -- .env.example AGENTS.md CLAUDE.md Dockerfile LICENSE README.md package.json package-lock.json server.js web.config deploy
git diff --cached --check
git commit -m "Rename project branding to SQL Management"
```

---

### Task 4: Verify and publish the private GitHub repository

**Files:**
- Inspect only: all tracked files and Git history
- External result: `WongKaiSung/sql-management` on GitHub

**Interfaces:**
- Consumes: a clean local `main` branch with the design, baseline, shell-branding, and project-branding commits
- Produces: an `origin` remote tracking GitHub `main`, with local and remote commit SHAs matching

- [ ] **Step 1: Run final local verification**

Run:

```powershell
npm run check
npm test
git diff --check
git status --short
git log --oneline --decorate -5
```

Expected: checks pass, the worktree is clean, and the recent log contains all implementation commits.

- [ ] **Step 2: Reconfirm credential exclusions**

Run:

```powershell
git check-ignore -v -- .env node_modules logs .pnpm-store dist server.js.bak bash.exe.stackdump public/index_FIXED.html
git ls-files --error-unmatch .env
git grep -n -I -E '(MSSQL_PASSWORD|PG_PASSWORD)=[^[:space:]]+' -- ':!.env.example'
```

Expected: ignored paths are listed; `.env` is not tracked; the credential grep has no output.

- [ ] **Step 3: Confirm the GitHub target does not already exist**

Run:

```powershell
gh repo view WongKaiSung/sql-management
```

Expected: GitHub reports that the repository cannot be found. If it exists, stop rather than overwriting or retargeting it.

- [ ] **Step 4: Create the private repository and push `main`**

Run:

```powershell
gh repo create WongKaiSung/sql-management --private --source . --remote origin --push
```

Expected: GitHub creates the repository, adds `origin`, pushes `main`, and configures upstream tracking. No pull request is needed for this initial publication because there was no pre-existing default branch.

- [ ] **Step 5: Verify remote identity, visibility, branch, and SHA**

Run:

```powershell
git remote -v
git status --short --branch
gh repo view WongKaiSung/sql-management --json nameWithOwner,visibility,defaultBranchRef,url
git rev-parse HEAD
git ls-remote origin refs/heads/main
```

Expected: `origin` points to `WongKaiSung/sql-management`; visibility is `PRIVATE`; default branch is `main`; the local HEAD SHA equals the remote `refs/heads/main` SHA.
