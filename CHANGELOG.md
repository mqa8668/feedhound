# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-08

### Added

- RSS, Atom and JSON Feed sources, plus a push API (`POST /api/ingest`) for posts from your own scripts.
- Watches with include terms, exclude terms, regex, price range and buy/sell intent.
- Matches inbox in the dashboard, with live updates over WebSocket.
- Telegram bot with `/link`, `/watch` and `/search` commands, and Telegram alerts for matches.
- Optional LLM enrichment through any OpenAI-compatible endpoint; rules-only mode works without it.
- Feed fetcher with an SSRF address guard (DNS pinning to the validated address), robots.txt checks, a per-host request gap, and size and time caps.
- Local password login with a session cookie, optional Cloudflare Access mode, login rate limiting, and PII masking of API responses.
- Prometheus metrics endpoint, `/healthz` and `/readyz`, collection SLO gauges, and an optional Prometheus and Grafana profile.
- Backup and restore scripts for Postgres.
- Docker Compose stack with a `demo` profile (fixture feeds and demo watches), a `telegram` profile and a `metrics` profile.
- Continuous integration: forbidden-word check, gitleaks, typecheck, lint, backend and web tests, and Docker builds.

[0.1.0]: https://github.com/mqa8668/feedhound/releases/tag/v0.1.0
