# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.13] - 2026-11-01

### Fixed

Maintainer review round for PR #4 (explicit quick-store read-back and wrap-up suppression):

- **Full read-back verification (review #1).** The explicit-store read-back no longer
  accepts a 40-character prefix as proof. `verified` now requires the entry id
  returned by `show`, the title, and the complete body (whitespace-trimmed) to match
  what was sent, with the wording "id, title and full content match". A different
  returned id, a tampered or missing tail, or a different title reports DIFFERENT
  (mismatch); a failed or malformed envelope reports unavailable and keeps the Saved
  receipt. No outcome triggers a second write. Counter-example tests: wrong id,
  same prefix with different tail, truncated tail, wrong title, full match, show
  failure, malformed envelope — all with exactly one write.
- **Removed unattributable whole-store time suppression (review #2, PI-04 partial).**
  The wrap-up no longer queries `list` freshness at all: a store timestamp cannot be
  attributed to this request, so a write one second before the request, an older
  write, or a parallel client's write during the request could never be
  distinguished — the previous requestStart heuristic both mis-suppressed and
  mis-proved storage. Whether this request's fact is already stored is decided
  inside the same bounded worker by its own recall/show reads (one background
  budget unchanged; ownerless agent continuation unchanged). PI-04 is documented as
  partially resolved: false suppression is gone; attribution-based suppression
  waits for engine-provided per-write evidence.
- **Sanitized relayed engine errors/actions (review #3).** `warn` receipt errors and
  `pending` receipt actions now pass the same `containsSecret` filter as candidate
  lines (secret-bearing entries are dropped whole), skip non-strings, cap each line
  at 200 characters, and cap the count (3 warnings / 6 actions). Action text is
  labeled "Engine suggestions to evaluate, not authorization". Tests: credential
  action/error dropped, over-long action truncated, non-strings skipped, count cap.
- **Background warn is no longer swallowed (review #4).** When the background
  worker's `remember` returns `warn` with a valid id and the read-back confirms the
  write, it reports exactly one fixed sanitized warning
  ("Background memory stored with engine warnings (id <8>); inspect if needed") —
  never a failure, never a re-send, never a change to the stored verdict. A warn
  with a failed read-back keeps the existing unconfirmed path.

### Changed

- Tests extended into CI (behavior-check / wrap-up-check, already wired to the
  three-platform Pi 1.3.0/1.4.0 matrix); real AgentSession isolation assertions
  unchanged. Version synchronized in `package.json` and both `package-lock.json`
  root fields (0.1.12 → 0.1.13).
- README states honestly: explicit quick-store candidate/parent selection remains
  the model's responsibility; this release adds read-back only, and PI-04 is
  partially resolved.

## [0.1.12] - 2026-11-01

- Explicit quick-store result-state contract with `show` read-back
  (verified/mismatch/unavailable), request-scoped wrap-up freshness suppression,
  warn receipts treated as written, pending receipts relaying candidates and
  engine-suggested actions.
  (Superseded in 0.1.13: the prefix-only read-back and the request-scoped
  freshness suppression were both replaced — see above.)