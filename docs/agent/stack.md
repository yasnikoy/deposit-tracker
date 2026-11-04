# Stack and structure

Read before touching the DB, auth, jobs, email, receipt parsing, form generation,
exports, logging or deployment. Fixed for v1; see `docs/ARCHITECTURE.md` →
Technical decisions. Ask before adding dependencies or changing the stack.

## Stack
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
- Form generation: `.docx` agency templates with placeholders, filled with
  docxtemplater + pizzip (approved).
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
- `docs/ARCHITECTURE.md`, `docs/UI.md`, `docs/RUNBOOK.md`.
- `tests/` mirrors `src/`; receipt parser tests in
  `tests/server/receipt-parser.test.ts` use anonymised samples. Real receipts
  live only in the git-ignored `tests/realdata/`.
