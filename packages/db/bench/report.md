# Corpus search bench

posts=500000 seed=42 runs=20 warmups=3 budget p95 < 300 ms

| class | n | p95 ms | verdict |
|---|---|---|---|
| single-token | 160 | 600.7 | FAIL |
| multi-token | 160 | 707.5 | FAIL |
| phrase+exclude | 80 | 240.6 | ok |
| trigram | 80 | 563.9 | FAIL |
| filtered | 120 | 871.2 | FAIL |
| newest/price | 80 | 374.1 | FAIL |
| author/date | 120 | 316.8 | FAIL |

## EXPLAIN (representative per class; "Seq Scan on post" is a failure)

- single-token: no seq scan on post
- multi-token: no seq scan on post
- phrase+exclude: no seq scan on post
- trigram: no seq scan on post
- filtered: no seq scan on post
- newest/price: no seq scan on post
- author/date: no seq scan on post

VERDICT: FAIL

## Notes (implementer, 2026-10-05)
- Measured from a laptop against the server-Mac Postgres (shared_buffers small, cold heap). The p95 target is NOT met on this corpus: every vocabulary word matches ~16 % of posts (~80 k rows), so broad queries are heap-bound (bitmap heap scan of ~28 k pages, ~250 ms before ranking/sorting). Selective queries ("ip15 fullbox"-like) are far cheaper but are not separated in this set.
- Follow-ups (out of scope for the slice): selective-vocabulary query classes, a narrower candidate table or covering index, tuning `shared_buffers`.
