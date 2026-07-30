# SQL Management Public-Release Readiness Design

## Goal

Prepare SQL Management for a possible public GitHub release without changing repository visibility. The work will replace the internal-facing README with public documentation, remove known vulnerable functionality that is not required, update the remaining database dependency, reduce internal project noise in the current tree, and add standard security maintenance files.

The repository must remain private throughout this work. Public visibility is a separate, explicit action that will only be considered after the verification gates pass and the owner requests it.

## Release Strategy

Preserve the existing Git history. The audit found no actual credentials, private keys, tracked `.env` files, or non-placeholder secrets in reachable commits. Historical local paths, generic host examples, and planning documents are presentation noise rather than sensitive data, so they do not justify a destructive history rewrite.

If a later complete-history scan finds a real secret, stop the release process, rotate the credential first, and reassess whether history rewriting is necessary. Do not publish while that issue remains unresolved.

## README

Rewrite `README.md` for people encountering the project for the first time. It will contain:

- A concise description of SQL Management and its single-tenant deployment model.
- A current feature summary for SQL Server, PostgreSQL, split view, schema browsing, query tabs and history, snippets, multi-statement execution, result comparison, filtering and statistics, CSV/JSON export, row counts, paste-as-VALUES, and schema diff.
- Requirements and a quick start using Node.js 18 or later.
- Configuration guidance based on `.env.example`, without real credentials or organization-specific values.
- Docker and IIS deployment links or concise instructions.
- A security and privacy section that states:
  - the HTTP API has no user authentication;
  - the server binds to `127.0.0.1` by default;
  - binding to `0.0.0.0` is appropriate only behind trusted network controls or an authenticated reverse proxy;
  - read-only profiles are enforced by the server, while destructive-query prompts are advisory client-side safeguards;
  - connection profiles and query history may be stored in browser localStorage;
  - query audit logs are written locally and may contain sensitive SQL text;
  - operators are responsible for database permissions, TLS settings, log retention, and access controls.
- Development commands for syntax checking, tests, and production dependency auditing.
- Links to `SECURITY.md` and the MIT `LICENSE`.

The README will describe the current implementation rather than quoting approximate source-file line counts that will become stale.

## Dependency Remediation

### Remove XLSX export

Remove `xlsx@0.18.5`, which currently has two high-severity advisories and has no patched npm release in the installed package line. XLSX export is optional and the owner confirmed that it is not a hard requirement.

Removal includes:

- deleting the Express vendor route for the package;
- removing XLSX export buttons and browser-side loader/export code;
- removing or replacing tests that require the XLSX asset;
- removing `xlsx` from `package.json`, `package-lock.json`, and `pnpm-lock.yaml`;
- retaining CSV and JSON export.

### Upgrade SQL Server client

Upgrade `mssql` from `10.0.4` to `11.0.1`. This stays compatible with the project's Node.js 18 baseline while moving its `tedious` and Azure identity dependency chain to patched versions. Update both npm and pnpm lockfiles consistently.

No unrelated major dependency upgrades are in scope.

## Public-Tree Sanitization

Replace machine- and organization-specific examples in tracked deployment documentation with neutral values such as `C:\apps\sql-management` and reserved example-domain hosts. Preserve compatibility-sensitive application internals, including existing localStorage keys, Docker identifiers, database `application_name` values, and IIS defaults.

Remove `docs/superpowers/` from the final tracked tree because it contains internal design and implementation notes that are not useful to public users. Those files remain in preserved Git history. Local ignored artifacts such as `.env`, logs, dependency directories, backups, crash dumps, and build output remain untracked and must not be added.

## Security Maintenance Files and Settings

Add `SECURITY.md` with the supported-version policy, a request not to disclose vulnerabilities in public issues, and instructions to use GitHub private vulnerability reporting.

Add `.github/dependabot.yml` configured for weekly npm dependency checks at the repository root with a small open-pull-request limit.

Enable GitHub private vulnerability reporting for the repository if the setting is available. Do not change repository visibility.

## Verification

Implementation is complete only when all of these gates pass from a clean working tree candidate:

1. Application syntax checks pass.
2. The complete automated test suite passes after the intentional XLSX test changes.
3. `pnpm audit --prod --json` reports no known production vulnerabilities at high or critical severity. Any remaining lower-severity advisory must be documented and assessed before declaring the repository public-ready.
4. The current tracked tree contains no real credentials, private keys, `.env` files, internal planning documents, local absolute workspace paths, or organization-specific hostnames.
5. A complete reachable-history scan finds no real secrets. Approved documentation placeholders are acceptable only when unmistakably synthetic.
6. XLSX export code, UI controls, routes, dependency declarations, and lockfile entries are absent; CSV and JSON export tests continue to pass.
7. The README's commands and security claims match the application and `.env.example`.
8. The local branch is clean after commit, the push succeeds, and local and remote commit SHAs match.
9. GitHub still reports the repository as private.

Passing these gates supports a recommendation that the repository is safe to make public; it does not authorize changing visibility.

## Delivery

Commit the remediation in reviewable units, push the completed work to GitHub, and report:

- tests and audit results;
- the secret-scan scope and findings;
- any residual risk or advisory;
- confirmation that the repository remains private;
- a clear public-readiness verdict.

If a gate fails, keep the repository private and report the blocker instead of giving a public-ready verdict.
