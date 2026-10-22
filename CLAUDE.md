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

## Language
- Code, identifiers, DB names, comments, commits, docs: English.
- UI: Turkish only. All UI strings live in `src/i18n/tr.json`; never inline
  Turkish text in components.
- Outgoing email templates and agency form templates are Turkish and live in
  settings / agency configuration, not in code.
- Display formats: dates `DD.MM.YYYY`, Turkish number formatting,
  timezone `Europe/Istanbul`.

## Stack (fixed for v1, see ARCHITECTURE.md → Technical decisions)
- Node.js 24 LTS (pinned via mise; same version in the portable zip).
- Next.js (App Router, TypeScript strict, standalone output), pnpm.
- SQLite via better-sqlite3: WAL mode, foreign keys on, busy timeout set.
  Single app process; a lock file prevents a second instance.
- Drizzle ORM (SQLite dialect) with SQL migrations committed to the repo.
  Use partial unique indexes so voided rows do not block constraints.
- UI: Tailwind CSS + shadcn/ui, TanStack Table (sorting, filtering, inline
  editing), react-hook-form + zod. zod schemas are shared; every server entry
  point validates input, including inline edits and bulk actions.
- Auth: username + password (argon2id via `@node-rs/argon2`; no email login), DB-backed sessions in an httpOnly cookie,
  no idle timeout, failed-login lockout from settings. Roles: ACCOUNTANT,
  OPERATIONS, ADMIN; a user may hold several. Users are deactivated, never deleted.
- Background jobs: in-process scheduler with a `jobs` table (IMAP polling,
  sending, backups, daily unprocessed-reply email, weekly summary).
  Overdue jobs run once on start. Send jobs retry 3 times with backoff,
  then mark the request failed.
- Email: nodemailer (SMTP), ImapFlow (IMAP), mailparser. Raw messages stored as `.eml`.
- Receipt parsing: pdfjs-dist + one parser module for our bank's layout;
  extracts name, amount, currency, date and B/L number candidates.
- Form generation: `.docx` agency templates with placeholders, filled by a
  docx templating library. **The library is not yet approved: ask first.**
- Exports: CSV without extra dependencies (UTF-8 with BOM, `;` separator,
  Turkish number/date formats); clipboard copy as tab-separated text.
- Logging: pino, daily rotating files in the data folder, kept 30 days.
- Tests: Vitest (unit/domain), Playwright (create B/L, send request,
  allocate refund, bulk reply).
- Deployment: portable zip for Windows x64 (portable Node.js, standalone build,
  prebuilt native modules, start/stop/backup/create-admin `.cmd` scripts).
  No Docker, no installer, no database server. Runs on one office PC,
  plain HTTP on the office LAN at port 3000.
- Desktop-only UI (Chrome / Edge).

## Structure
- `src/domain/` pure business logic, no I/O: business-day engine, settings
  resolution, B/L lifecycle, allocation engine, balances, invariants,
  void/undo rules, B/L number pattern matching.
- `src/server/` DB access, jobs, email, file storage, receipt parser,
  form generation, CSV export, `can()` auth checks.
- `src/server/db/schema.ts` Drizzle schema; `drizzle/` migrations.
- `src/app/` routes and UI; shared table component with search, bulk actions,
  inline editing, keyboard shortcuts and per-user layout.
- `seed/settings.json` initial setting values, lists and email templates.
- `scripts/` `.cmd` scripts and the `build:portable` packaging.
- `docs/ARCHITECTURE.md`, `docs/RUNBOOK.md`.
- `tests/` mirrors `src/`; sample receipts in `tests/fixtures/receipts/`.

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
   allocations and records deductions (never corrects money records);
   admin manages settings, users, form templates, allocation reversals
   (admin only), write-off approvals and opening-balance records.
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
    the shared mailbox. IMAP is read-only; processed UIDs are tracked in the DB.
13. **Email in development:** `EMAIL_MODE=dry-run` by default outside
    production; dry-run logs and stores emails but never sends. Never send to
    real agency addresses from a non-production environment.
14. **Secrets** (SMTP/IMAP passwords) are encrypted at rest. The key comes from
    a key file outside the data folder; never in the DB, logs or backups.
15. **Data folder is sacred.** Updates never touch it. Migrations run on start
    only after an automatic backup.

## Out of scope (do not add)
- Removed after review: escalation, snooze, auto-confirm of allocations,
  bank-fee tolerance.
- Not in the domain: partial refunds, FX conversion, deposit tariff tables,
  container-level return tracking.
- Not planned: phone/WhatsApp follow-up logging, Excel import for migration,
  accounting software export.
- Deferred beyond v1: native `.xlsx` export, PDF form field mapping, bulk form
  printing / QR splitting, keyword reply suggestions, OCR, Outlook add-in,
  VPN or server hosting. See ARCHITECTURE.md → Deferred.

## Working style
- Test-first for `src/domain` and the receipt parser, especially the
  business-day engine and the allocation engine. Use the scenarios in
  ARCHITECTURE.md as test cases, e.g.:
  - A 3,000 + B 2,500 + C 1,500 USD open, refund 6,300 → no exact subset,
    FIFO suggests A + B + C 800 with a 700 difference.
  - Same case with a 700 statement deduction on C → exact subset A + B + C.
  - Overpayment → remainder stays unallocated on the refund.
  - Multiple exact combinations → ranked oldest-first, never auto-confirmed.
  - Search cap (30 oldest candidates / 500 ms) hit → result flagged incomplete.
  - Voided B/Ls and refunds are never allocation candidates.
  - Approved write-off closes a B/L; unapproved one does not.
  - Undo after the window, or of a confirmed allocation, is rejected.
  - Receipt description with zero, one or several B/L candidates.
  - Weekends from settings; half-day (arife) holidays per setting.
- Small, focused changes; one migration per schema change.
- Ask before adding dependencies or changing the stack.
- When a requirement is ambiguous, ask instead of guessing.

## Build order
1. Scaffold, SQLite + Drizzle setup, auth, roles, `can()`, audit log,
   shared table component (search, sort, filter, per-user layout,
   keyboard navigation)
2. Settings system with seed, holidays, business-day engine,
   agencies with B/L number patterns
3. Accounting: deposit payments with receipts/invoices (single and bulk upload
   with review queue, receipt parser stubbed until real samples arrive),
   B/L creation (single, dual-role continuous flow, bulk table),
   corrections and voiding
4. All B/Ls screen and global search, agency form templates and prefilled form
   download, due-requests list, standing documents, email preview and sending,
   sent-folder copy, portal requests
5. Thread reply import, match suggestions, manual mailbox link, Replies screen
   with quick buttons and bulk reply types, unprocessed badge and daily email
6. Refunds, allocation engine and review screen, deductions, disputes,
   write-off approval, undo, opening-balance form
7. Dashboard, notes and mentions, notifications, reports, weekly summary,
   CSV export and clipboard copy, inline editing, remaining keyboard shortcuts
8. Portable packaging, backups, health page, `docs/RUNBOOK.md`

## Commands
_To be filled in once the project is scaffolded (dev, test, lint, migrate,
seed, build:portable)._