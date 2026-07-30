# Security Policy

## Supported versions

Only the latest version on the `main` branch receives security fixes. Older commits and private forks are not maintained by this project.

## Reporting a vulnerability

Please use the repository's **Security** tab and select **Report a vulnerability** to submit details through GitHub's private vulnerability-reporting flow.

Do not disclose sensitive details, proof-of-concept payloads, credentials, or affected systems in a public issue. Include the affected version or commit, reproduction steps, expected impact, and any suggested mitigation in the private report. Reports are acknowledged and assessed on a best-effort basis.

SQL Management intentionally uses a single-tenant, unauthenticated HTTP API and documents the required deployment controls in the README. Bypasses of server-enforced read-only restrictions, unintended credential disclosure, or paths that allow access beyond the configured database permissions should be reported as security issues.
