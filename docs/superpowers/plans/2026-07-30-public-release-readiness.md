# SQL Management Public-Release Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare SQL Management for a possible public release while keeping the GitHub repository private.

**Architecture:** Remove the optional vulnerable XLSX export path end-to-end, upgrade the SQL Server client within the Node.js 18 baseline, then replace internal-facing documentation with public-facing setup and security guidance. Preserve compatibility-sensitive runtime identifiers and all existing Git history; verification determines readiness but never changes visibility.

**Tech Stack:** Node.js 18+, Express 4, vanilla HTML/CSS/JavaScript, Node test runner, npm and pnpm lockfiles, GitHub repository settings.

## Global Constraints

- Keep `WongKaiSung/sql-management` private throughout the work.
- Preserve existing Git history unless a real secret is discovered.
- Preserve compatibility-sensitive localStorage keys, Docker identifiers, database `application_name` values, and IIS defaults.
- Retain CSV and JSON export; remove XLSX export completely.
- Use `mssql@11.0.1` and retain the Node.js `>=18` engine floor.
- Do not add unrelated dependency upgrades or application refactors.
- Do not commit `.env`, logs, dependencies, build output, backups, or crash dumps.
- Update both `package-lock.json` and `pnpm-lock.yaml` consistently.

---

### Task 1: Remove XLSX Export Test-First

**Files:**
- Modify: `tests/ui-structure.test.js`
- Modify: `tests/server-smoke.test.js`
- Modify: `server.js:59`
- Modify: `public/index.html:1900,2013,6204,8960-8995,9309`

**Interfaces:**
- Consumes: Existing Express vendor routes and frontend export controls.
- Produces: CSV/JSON-only result export UI with no `/vendor/xlsx` route, `XLSX_CDN`, `downloadXLSX`, or XLSX help entry.

- [ ] **Step 1: Write failing structural tests**

In `tests/ui-structure.test.js`, keep Chart.js in the lazy-asset positive assertions and add explicit negative assertions:

```js
assert.doesNotMatch(html, /\/vendor\/xlsx\//);
assert.doesNotMatch(html, /\bdownloadXLSX\b/);
assert.doesNotMatch(html, />↓ XLSX</);
```

In `tests/server-smoke.test.js`, remove the XLSX URL from the HTTP 200 route list and assert it is not served:

```js
const removedXlsxResponse = await fetch(`${baseUrl}/vendor/xlsx/dist/xlsx.full.min.js`);
assert.equal(removedXlsxResponse.status, 404);
```

- [ ] **Step 2: Run the focused tests and confirm the intended failure**

Run:

```powershell
pnpm exec node --test tests/ui-structure.test.js tests/server-smoke.test.js
```

Expected: FAIL because the HTML still contains the XLSX vendor path/function/button and the server still returns HTTP 200 for the asset.

- [ ] **Step 3: Remove the minimal XLSX implementation**

Apply targeted patches that:

- delete `app.use('/vendor/xlsx', express.static(packageRoot('xlsx')));` from `server.js`;
- delete the fixed SQL Server and PostgreSQL `↓ XLSX` buttons;
- delete the dynamic-panel `↓ XLSX` button;
- change the added-tools comment to omit XLSX;
- delete `const XLSX_CDN = ...` and the complete `downloadXLSX(side)` function;
- delete the XLSX row from the keyboard/tools help table.

Do not change CSV, JSON, chart, explain, or other export behavior.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run:

```powershell
pnpm exec node --test tests/ui-structure.test.js tests/server-smoke.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit the behavioral change**

```powershell
git add server.js public/index.html tests/ui-structure.test.js tests/server-smoke.test.js
git commit -m "Remove vulnerable XLSX export"
```

---

### Task 2: Remediate Production Dependencies

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: The package manifests used by npm and pnpm installations.
- Produces: A dependency graph without `xlsx`, using `mssql@11.0.1` and patched transitive dependencies.

- [ ] **Step 1: Update the direct dependency declarations**

Patch `package.json` so the relevant dependency block is:

```json
"mssql": "^11.0.1",
"pg": "^8.11.3",
"sql-formatter": "15.4.10"
```

There must be no `xlsx` entry.

- [ ] **Step 2: Regenerate the pnpm lockfile and installation**

With the bundled Node runtime prepended to `PATH`, run:

```powershell
pnpm install --lockfile-only
pnpm install
```

Expected: `pnpm-lock.yaml` resolves `mssql@11.0.1` and contains no `xlsx@0.18.5` package.

- [ ] **Step 3: Regenerate the npm lockfile**

Use npm 10 under the same Node runtime without adding it as a project dependency:

```powershell
pnpm dlx npm@10.9.2 install --package-lock-only --ignore-scripts
```

Expected: `package-lock.json` records `mssql@11.0.1`, contains no `node_modules/xlsx`, and leaves source files unchanged.

- [ ] **Step 4: Verify the manifests and production audit**

Run:

```powershell
pnpm exec node -e "const p=require('./package.json'); if(p.dependencies.xlsx||p.dependencies.mssql!=='^11.0.1') process.exit(1)"
rg -n 'xlsx|mssql@10|node_modules/mssql.*10\.0' package.json package-lock.json pnpm-lock.yaml
pnpm audit --prod --json
```

Expected: the Node check exits 0; `rg` returns no stale dependency matches; the audit reports zero high and zero critical production vulnerabilities. Investigate and document any lower-severity result before continuing.

- [ ] **Step 5: Run syntax checks and the complete test suite**

```powershell
pnpm run check
pnpm test
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit the dependency remediation**

```powershell
git add package.json package-lock.json pnpm-lock.yaml
git commit -m "Remediate production dependencies"
```

---

### Task 3: Publish Accurate README and Security Guidance

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Create: `SECURITY.md`
- Create: `.github/dependabot.yml`

**Interfaces:**
- Consumes: Current application behavior, `.env.example`, package scripts, deployment guides, and MIT license.
- Produces: Public onboarding, explicit operating risks, a private vulnerability-reporting path, and weekly npm dependency monitoring.

- [ ] **Step 1: Rewrite the README**

Replace the current README with these concrete sections:

1. `SQL Management` overview and a prominent single-tenant/no-auth warning.
2. Current features covering both database engines, panels/split view, profiles/read-only enforcement, browsing, tabs/history/snippets, multi-statement execution, comparison, filtering/stats, CSV/JSON export, row counts, paste-as-VALUES, schema diff, cancellation, timeout, and audit logging.
3. Requirements: Node.js 18+, SQL Server and/or PostgreSQL access.
4. Quick start using `npm install`, copying `.env.example`, `npm start`, and `http://127.0.0.1:3000`.
5. Configuration table matching `.env.example`.
6. Security and privacy guidance covering unauthenticated API access, loopback binding, reverse-proxy/network controls, server-enforced read-only profiles, advisory destructive-query prompts, least-privilege database accounts, localStorage credentials/history, audit-log SQL text, TLS choices, and log retention.
7. Development commands: `npm run check`, `npm test`, and `pnpm audit --prod`.
8. Deployment links for Docker and IIS.
9. Vulnerability reporting link to `SECURITY.md` and license link to `LICENSE`.

Do not include approximate line counts, XLSX export, real passwords, company hosts, or claims of multi-user isolation.

- [ ] **Step 2: Make the environment template unmistakably synthetic**

In `.env.example`, replace `Password1` and `postgres` password values with empty values:

```env
MSSQL_PASSWORD=
PG_PASSWORD=
```

Keep usernames and loopback defaults because they are configuration examples, not secrets.

- [ ] **Step 3: Add the security policy**

Create `SECURITY.md` containing:

- only the latest version on `main` is supported;
- reporters should use GitHub's `Report a vulnerability` private reporting flow;
- sensitive details must not be posted in a public issue;
- the project will acknowledge and assess reports on a best-effort basis;
- the unauthenticated single-tenant deployment model is documented behavior, while bypasses of server-enforced read-only restrictions are security issues.

- [ ] **Step 4: Add Dependabot configuration**

Create `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
```

- [ ] **Step 5: Validate documentation against source**

Run:

```powershell
rg -n "XLSX|Password1|PG_PASSWORD=postgres|2500 lines|6200 lines" README.md .env.example SECURITY.md
rg -n "HOST|PORT|QUERY_TIMEOUT_MS|MSSQL_|PG_" .env.example README.md
git diff --check
```

Expected: the first search has no matches; the second lets the implementer compare all documented variables; `git diff --check` exits 0.

- [ ] **Step 6: Commit public documentation and policy**

```powershell
git add README.md .env.example SECURITY.md .github/dependabot.yml
git commit -m "Document secure public deployment"
```

---

### Task 4: Sanitize the Current Tracked Tree

**Files:**
- Modify: `deploy/build-image.ps1`
- Modify: `deploy/DOCKER-HOSTING-GUIDE.md`
- Modify: `deploy/setup-iis-site.ps1`
- Modify: `deploy/IIS-HOSTING-GUIDE.md`
- Modify: `web.config`
- Modify: `reclaim-pg.js`
- Delete: `docs/superpowers/`

**Interfaces:**
- Consumes: Existing deployment instructions and compatibility-sensitive deployment defaults.
- Produces: Neutral public examples in the current tree, with internal design/planning notes absent from HEAD.

- [ ] **Step 1: Replace local paths and host examples**

Use targeted patches with these mappings:

```text
D:\KS\SQL                         -> C:\apps\sql-management
dbserver.corp.local               -> db.example.com
sql.yourcompany.local             -> sql.example.com
pnbdev.example                    -> db.example.com
```

Keep `host.docker.internal` because it is a standard Docker hostname. Keep `SQLConnect` IIS site/app-pool defaults and internal runtime identifiers for compatibility.

- [ ] **Step 2: Remove internal planning files from the tracked tree**

Delete every tracked file below `docs/superpowers/`, including this plan and its design spec, using explicit repository-scoped patches. Do not change `.gitignore`; it already prevents these workflow files from being re-added accidentally.

- [ ] **Step 3: Scan the candidate public tree**

Run:

```powershell
rg -n "D:\\KS\\SQL|pnbdev\.example|corp\.local|yourcompany\.local" --glob "!node_modules/**" --glob "!.git/**" .
git ls-files docs/superpowers .env "*.pem" "*.key" "*.pfx" "*.p12" "*.jks" "*.keystore"
git diff --check
```

Expected: all commands produce no prohibited matches or tracked sensitive/internal files; `git diff --check` exits 0.

- [ ] **Step 4: Commit current-tree sanitization**

```powershell
git add deploy web.config reclaim-pg.js
git add -u docs/superpowers
git commit -m "Sanitize public repository tree"
```

---

### Task 5: Complete Security and Release Verification

**Files:**
- Verify: Entire current tracked tree and all reachable Git history.
- Modify externally if available: GitHub private vulnerability reporting setting only.

**Interfaces:**
- Consumes: The complete release candidate and GitHub repository metadata.
- Produces: Evidence-backed readiness verdict, pushed commits, and an unchanged private visibility setting.

- [ ] **Step 1: Run final local verification from the bundled Node runtime**

```powershell
pnpm run check
pnpm test
pnpm audit --prod --json
git diff --check
```

Expected: syntax checks and tests pass; audit has zero high/critical vulnerabilities; whitespace check exits 0.

- [ ] **Step 2: Verify complete XLSX removal and compatibility preservation**

```powershell
rg -n "xlsx|XLSX|downloadXLSX|/vendor/xlsx" package.json package-lock.json pnpm-lock.yaml server.js public/index.html tests README.md
rg -n "SQLConnectUX|sqlconnectWorkspacePanels:v1|sqlconnectWorkspaceBackup:v1" public/index.html tests/ui-structure.test.js
```

Expected: the first search has no matches; the second confirms required compatibility identifiers remain.

- [ ] **Step 3: Scan the current tree and reachable history for secrets**

Run current-tree filename and content scans, then enumerate every reachable commit with `git rev-list --all` and inspect commit blobs for:

- private-key headers;
- credential-bearing URLs;
- common cloud/API token formats;
- assignments to password, secret, token, or API-key names.

Classify only unmistakably synthetic documentation values as approved placeholders. If any real credential appears, stop, keep the repository private, rotate it, and report the blocker.

- [ ] **Step 4: Check GitHub security settings without changing visibility**

Using the authenticated GitHub CLI:

```powershell
gh repo view WongKaiSung/sql-management --json visibility,defaultBranchRef
gh api repos/WongKaiSung/sql-management/private-vulnerability-reporting
```

If private vulnerability reporting can be enabled while the repository is private, enable it with:

```powershell
gh api --method PUT repos/WongKaiSung/sql-management/private-vulnerability-reporting
```

If GitHub reports that the setting is unavailable for private repositories, record that limitation and do not alter visibility.

- [ ] **Step 5: Confirm the working tree is clean and push**

```powershell
git status --short --branch
git push
git rev-parse HEAD
git ls-remote origin refs/heads/main
```

Expected: no uncommitted tracked changes; push succeeds; local and remote SHAs match.

- [ ] **Step 6: Deliver the verdict**

Report the exact test count, dependency-audit severity totals, secret-scan findings and limitations, GitHub visibility, private vulnerability reporting status, pushed commit SHA, and any residual risks. Say `safe to make public` only if every gate passes; otherwise state the blocker and keep the repository private.
