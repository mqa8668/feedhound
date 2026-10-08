# Contributing

Issues and pull requests are welcome. This project was built for personal use,
so response times vary.

## Setup

```bash
bun install
cp .env.example .env
docker compose up -d postgres
bun run db:migrate
```

Tests that touch the database use `TEST_DATABASE_URL`. The database name must
end with `_test`; the test code refuses to run otherwise, and the database may
be truncated freely. Never point it at data you care about.

## Checks before a pull request

```bash
bun run typecheck
bun run lint
bun run test
scripts/check-forbidden-words.sh
```

`scripts/check-forbidden-words.sh` fails on vocabulary that must not appear in
the tree (third-party social network scraping terms, private hosts and paths).
Run it before you push.

## Adding a connector

A connector fetches one kind of source. Add one file in
`apps/agent/src/web/connectors` (see `feed.ts` for the shape) and one line in
`apps/agent/src/web/registry.ts`. Add a test next to it. Connectors must go
through the shared fetcher so SSRF checks, robots.txt, the per-host gap and the
size and time caps apply. Do not add connectors that log in to third-party sites.

## Tests

Add or update tests for any behavior change. Prefer small, focused tests next
to the code (`*.test.ts`). Bug fixes should include a test that fails without
the fix.

## Commit style

Short imperative subject line, 72 characters or fewer (for example
`Pin validated DNS address in fetcher`). Explain the reason in the body when it
is not obvious. Keep unrelated changes in separate commits.
