# SQL Management Rename Design

## Goal

Rename the project’s public brand from DualSQL/SQLConnect to **SQL Management** and publish it in a GitHub repository named `sql-management`.

## Scope

- Change user-facing application titles, headings, labels, and descriptive text to **SQL Management**.
- Update README and developer-facing project descriptions so the repository presents one consistent name.
- Update safe descriptive metadata, including the package name/description, to use `sql-management` and SQL Management.
- Create the GitHub repository with the slug `sql-management`.

## Compatibility Boundary

Preserve identifiers whose renaming could reset user state or disrupt existing deployments:

- localStorage keys and saved profile identifiers
- environment-variable names
- Docker container, image, service, and volume identifiers
- PostgreSQL/SQL Server application identifiers
- internal API routes and protocol fields

Existing installations should retain saved connections and continue using their current deployment configuration after the visible rename.

## Repository Scope

The initial repository will include application source, tests, documentation, lockfiles, Docker/IIS deployment files, and maintenance utilities. It will exclude `.env`, dependencies, package stores, logs, generated distributions, crash dumps, and stale backup files.

## Validation

- Search non-generated project files for stale public-facing DualSQL/SQLConnect branding.
- Run `npm run check` and `npm test`.
- Inspect the staged file list before committing.
- Verify the pushed repository name, visibility, default branch, and commit SHA through GitHub.
