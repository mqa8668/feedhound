# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub security advisories:
<https://github.com/mqa8668/feedhound/security/advisories/new>

Do not open a public issue for a security problem. Include the version or
commit, steps to reproduce, and the impact you see.

## Scope

In scope:

- Authentication and session handling (local password mode, Cloudflare Access mode, API keys).
- The feed fetcher: SSRF guard bypasses, DNS rebinding, redirect handling, robots.txt handling, size and time caps.
- Injection, authorization and data exposure issues in the API, the dashboard and the Telegram bot.
- Secrets leaking into logs or API responses.

Out of scope:

- The demo password `demo` and the demo stack, which are for local try-outs only.
- Findings that need `web.allowPrivateHosts=true`, `DEV_AUTH_BYPASS=1` or `AUTH_ALLOW_NO_PASSWORD` set on an exposed deployment. These are documented as unsafe.
- Denial of service from a user who already has operator access.
- Vulnerabilities in third-party dependencies with no practical impact here; report those upstream.

## What to expect

This is a one-person project with no service level agreement. I aim to
acknowledge a report within a week and to fix confirmed issues as time allows.
I will credit you in the changelog unless you prefer otherwise.

Only the latest release is supported.
