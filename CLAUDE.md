# Container Deposit Refund Tracker

Internal web app that tracks sea-freight container deposits paid per B/L,
requests refunds from shipping agencies by email (or records portal requests),
and reconciles incoming, usually batched, refunds against open B/Ls.
It replaces Excel + Outlook tracking and must be faster than Excel for daily work.

**Source of truth:** `docs/ARCHITECTURE.md`. Read the relevant section before
any task that touches domain logic, data model, email, settings, screens or
deployment. If the code and the document disagree, stop and ask. When a
decision changes, update the document (including its Change log) in the same
change.

**UI source of truth:** `docs/UI.md` (navigation map, page patterns, shared
components, status colours, amount/date/empty-value rules, keyboard, wording).
Read it before any UI change and follow its checklist (section 11).

## Language
- Code, identifiers, DB names, comments, commits, docs: English.
- UI: Turkish only. All UI strings live in `src/i18n/tr.json`; never inline
  Turkish text in components.
- Outgoing email templates and agency form templates are Turkish and live in
  settings / agency configuration, not in code.
- Display formats: dates `DD.MM.YYYY`, Turkish number formatting,
  timezone `Europe/Istanbul`.

## Hard rules
1. **No hardcoded business values.** Durations, thresholds, templates, lists
   come from `getSetting(key, { agencyId?, blId? })`
   (B/L override → agency override → global; null inherits).
   B/L number patterns and form templates come from agency configuration.
   Initial values only in the seed file.
2. **Invariants live in code** (ARCHITECTURE.md → Immutable business rules,
   all 17). Enforce them in `src/domain` inside transactions and with
   `CHECK`/`UNIQUE`/foreign-key constraints where expressible.
   Never relax one without asking.
3. **Money:** integer minor units (cents) plus a currency code; never floating
   point. Every amount travels with its currency. No FX conversion anywhere.
   Locale formatting happens only in the UI and exports.
4. **Balances are derived** from `ledger_entries`; never add a stored balance.
   A refund's unallocated remainder is computed, never stored. Voided records
   contribute nothing.
5. **Dates:** business dates stored as `YYYY-MM-DD` text, event timestamps as
   UTC ISO-8601 text. Due dates are computed on read, never stored; there are
   no manual date overrides or snooze. All business-day math goes through the
   engine, in `Europe/Istanbul`.
6. **Permissions are enforced on the server** through one
   `can(user, action, entity)` check in every mutation, inline edit, bulk
   action and undo; UI hiding is cosmetic. Accountant creates, corrects and
   voids money records; operations creates and voids B/Ls, confirms
   allocations and records deductions (never corrects money records); both
   accountant and operations record deposit transfers, which an accountant books;
   admin manages settings, users, form templates, allocation and transfer
   reversals (admin only), write-off approvals and opening-balance records.
7. **Audit:** every state change, correction, void, reversal, undo, write-off
   and settings change writes to `audit_log` with actor, role used,
   before/after and reason.
8. **Nothing is deleted.** Payments, refunds and B/Ls are only voided, with a
   reason, and only while they have no confirmed allocation. Voided records
   leave working lists, balances and reports but stay in timelines and audit.
9. **Undo is compensating, never destructive.** It writes a compensating entry
   referencing the original, within the undo-window setting, and never applies
   to confirmed allocations, sent emails, money records, write-offs or settings.
10. **No auto-confirm.** Allocation suggestions, email match suggestions and
    B/L numbers extracted from receipts are applied only after a user confirms.
    The app never interprets agency replies.
11. **Status transitions are never forced** by the UI, inline editing, bulk
    actions or undo. Money fields and statuses are never inline-editable.
    Every bulk action shows a confirmation listing the affected B/Ls.
12. **Mailbox safety:** never move, delete, flag or mark as read any message in
    the shared mailbox. IMAP is used only to copy sent emails to the sent folder;
    the app does not read the mailbox (emails are archived from Outlook by hand).
13. **Email in development:** `EMAIL_MODE=dry-run` by default outside
    production; dry-run logs and stores emails but never sends. Never send to
    real agency addresses from a non-production environment.
14. **Secrets** (SMTP/IMAP passwords) are encrypted at rest. The key comes from
    a key file outside the data folder; never in the DB, logs or backups.
15. **Data folder is sacred.** Updates never touch it. Migrations run on start
    only after an automatic backup.
16. **UI follows `docs/UI.md`.** New or changed screens reuse its page patterns
    and shared components, its status-colour table, amount/currency rule and
    terms. A new pattern, component kind, colour, status chip or term is a
    decision: ask first, then update `docs/UI.md` (and the change log) in the
    same change. If code and `docs/UI.md` disagree, stop and ask.

## Working style
- Small, focused changes; one migration per schema change.
- Test-first for `src/domain` and the receipt parser → [testing](docs/agent/testing.md).
- A commit never bumps the version or tags; it adds lines under **Unreleased**
  in the `docs/ARCHITECTURE.md` change log → [releases](docs/agent/releases.md).
- Ask before adding dependencies or changing the stack.
- When a requirement is ambiguous, ask instead of guessing.

## Commands
Toolchain is pinned in `mise.toml` (Node 24, pnpm); prefix with `mise exec --`
if mise is not activated in the shell. Runtime data goes to `DATA_DIR`
(default `./data`, git-ignored). The mail password key file is `KEY_FILE` (default
`deposit.key` next to the data folder, git-ignored); it must stay outside `DATA_DIR`.
- `pnpm dev` dev server on :3000 (migrations + seed run on start)
- `pnpm test` Vitest; `pnpm test:e2e` Playwright (own server on :3100, fresh `data-e2e/`)
- `pnpm lint`, `pnpm typecheck`
- `pnpm db:generate` new migration from `src/server/db/schema.ts` (one per schema change)
- `pnpm db:prepare` apply migrations (after automatic backup) and load missing seed settings
- `pnpm create-admin [username] [display name]` create an admin (password prompted)
- `pnpm build` standalone build, then a check that no runtime data is in it
- `pnpm build:portable` Windows portable zip (see `docs/RUNBOOK.md`)

## Detailed instructions
Read the matching file before working in its area:
- [Stack and structure](docs/agent/stack.md) — libraries, DB/auth/jobs/email setup, folder layout
- [Out of scope](docs/agent/scope.md) — features never to add; check before proposing one
- [Testing](docs/agent/testing.md) — test-first areas and domain scenarios
- [Releases](docs/agent/releases.md) — versioning and the release procedure
- [graphify](docs/agent/graphify.md) — knowledge-graph usage details

**graphify:** when `graphify-out/graph.json` exists, run `graphify query "<question>"`
before your first grep, search or source-file read for a codebase question, and put
this rule in every subagent prompt that explores code.
