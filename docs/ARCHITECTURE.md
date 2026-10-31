# Container Deposit Refund Tracker — Architecture

Oct 20, 2026 · updated Oct 30, 2026 (see Change log)

## Purpose and scope

An internal web app that makes sure every sea-freight container deposit our company pays is requested back, collected and reconciled to the cent. It replaces the current Excel + email tracking and must be faster to use than Excel for daily work.

- **Problems solved:** forgotten refunds, delayed refunds, unchecked deductions (demurrage/detention, damage, cleaning), no consolidated reporting.
- **Volume:** 20–100 deposits per month, 10+ shipping lines/agencies, 2–10 users.
- **Unit of tracking:** the B/L (bill of lading). One deposit per B/L, paid with one bank transfer or one invoice offset. The agency refunds a B/L in one go once all its containers are returned empty; partial refunds do not occur. Deposit amounts vary per shipment, so there is no tariff table.
- **Refunds arrive batched:** an agency usually pays several B/Ls in one transfer, so reconciliation is the core workflow.
- **Currency:** deposits are paid in USD or EUR (or offset against invoices) and refunded in the same currency. No FX conversion in the app.
- **Process today:** we request the refund roughly 1–2 weeks after paying the deposit. If containers are not yet returned, the agency says so and we ask again later. Empty-return events are not tracked by us. Most requests go by email; some agencies require the first request on their web portal and continue by email.
- **v1 boundary:** the app generates a prefilled refund request form from each agency's Word template; the form is printed, stamped, signed and scanned outside the app and uploaded once per B/L; follow-ups reuse the same form. The app sends, follows up, and reconciles.

## Conventions and tech stack

All code, identifiers, database names, comments and docs are in **English**; only the user interface, the outgoing email templates and the agency form templates are **Turkish**. The app runs on one designated office desktop PC in Turkey, so data stays in-country (KVKK).

- **Language:** UI strings live in a single Turkish locale file (`tr.json`), never inline in components. Dates shown as DD.MM.YYYY, amounts with Turkish number formatting, timezone Europe/Istanbul.
- **Stack:** Next.js (TypeScript) full-stack app, SQLite, Drizzle ORM with SQL migrations, in-app authentication with roles.
- **Background jobs:** an in-process scheduler with a SQLite job table for IMAP polling, email sending, the optional daily unprocessed-reply email and the optional weekly summary email. Jobs run only on the designated PC; when it is off nothing runs, and missed work (mail polling, due lists, backup) catches up at the next start.
- **Deployment:** a portable folder on the designated PC's internal disk; no installer, no Docker, no separate database server (see Operations and deployment). Daily database and file backups.
- **Network access:** plain HTTP on the office network at http://\<computer-name>:3000; never exposed to the internet. Remote access only through a VPN into the office network, not in v1.
- **Files:** uploaded forms, form templates, receipts, invoices and email attachments stored in the app's data folder on the PC's internal disk, referenced from the database. Not publicly accessible.
- **Secrets:** SMTP/IMAP credentials stored encrypted (AES-256-GCM); the encryption key lives in a key file outside the data folder (`KEY_FILE`, default `deposit.key` next to the data folder, created when the first password is saved), never in the database or in backups; a copy is kept offline in a safe place. The settings screen, history and audit log only show that a password was changed.
- **Engineering rule:** no business constant is hardcoded. Durations, thresholds, templates, lists and B/L number patterns come from the settings system or agency configuration. Business invariants are the only rules that live in code.
- **Testing:** the business-day engine, the refund allocation algorithm and the receipt parser are written test-first, with the scenarios in this document as test cases.

## Technical decisions

These choices are fixed for v1 so implementation can start without further debate.

| Area | Decision |
| --- | --- |
| Database | SQLite in one file on the PC's internal disk, through better-sqlite3. WAL mode, foreign keys on, busy timeout set. Only the single app process opens the file; a lock file stops a second instance from starting |
| ORM and schema | Drizzle ORM (SQLite dialect), SQL migrations committed to the repo. Business invariants backed by `CHECK`, `UNIQUE` (including partial unique indexes that ignore voided rows) and foreign-key constraints where expressible; the rest enforced in the domain layer inside transactions |
| UI | Tailwind CSS + shadcn/ui components; TanStack Table for dense, sortable, filterable lists with inline editing; react-hook-form + zod for forms |
| Validation | zod schemas shared between server actions/API and forms; every server entry point validates input, including inline cell edits and bulk actions |
| Money | Stored as integer minor units (cents) with a currency code; never floating point. Formatting to Turkish locale happens only in the UI and in exports |
| Dates | Business dates stored as `YYYY-MM-DD` text; event timestamps as UTC ISO-8601 text. All business-day logic runs in Europe/Istanbul |
| Authentication | Username + password (no email-based login; the app runs only on the office LAN), hashed with argon2id. Database-backed sessions in an httpOnly cookie; no idle timeout; failed-login lockout is a setting (default 5 attempts); a locked account stays locked until an admin unlocks it or sets a temporary password. Minimum password length is a setting. Sessions end on logout, deactivation, or a password change or reset. At least one active admin must always remain, and admins cannot deactivate themselves. No self-service reset: an admin sets a temporary password that must be changed at next login. The first admin is created with `create-admin.cmd`. Users are deactivated, never deleted |
| Authorization | One server-side `can(user, action, entity)` check used by every mutation, inline edit, bulk action and undo; UI hiding is cosmetic only |
| Email | nodemailer (SMTP), ImapFlow (IMAP), mailparser (parsing). Raw messages stored as `.eml` files |
| Jobs | In-process scheduler with a `jobs` table (run\_at, attempts, status), checked every few seconds. Send jobs retry 3 times with backoff (1, 5 and 15 minutes), then mark the request failed. IMAP polling runs on the poll-interval setting. On start, overdue jobs run once to catch up; a job cut off by a restart runs again (a send already accepted by the server could then repeat, which is accepted as rare) |
| Mail outage | If SMTP or IMAP is unreachable, a banner on every screen shows since when; queued sends wait and retry; nothing is lost |
| Receipt parsing | pdfjs-dist text extraction plus one parser module for the bank's layout, covered by tests with real sample receipts. Extracts name, amount, currency, date and, for outgoing payments, B/L number candidates from the transfer description |
| Form generation | Agency form templates are `.docx` files with placeholders, filled server-side by docxtemplater + pizzip (approved Oct 24, 2026) |
| Exports | CSV generated without extra dependencies: UTF-8 with BOM, semicolon separator, Turkish number and date formats, so Turkish Excel opens it directly. Clipboard copy uses tab-separated values |
| Exact-subset search | Backtracking over candidates sorted oldest first, pruned by remaining amount; capped at the 30 oldest candidates and 500 ms. When the cap is hit, the screen says the search was incomplete |
| Testing | Vitest for unit and domain tests; Playwright for a small set of end-to-end flows (create B/L, send request, allocate refund, bulk reply) |
| Logging | pino structured logs to daily rotating files in the data folder, kept 30 days; streams run in-process (no worker-thread transports) so the standalone build is self-contained |
| Rendering | Next.js Cache Components are off: every screen is session-bound and shows live data, so pages render dynamically on each request |
| Versioning | Semantic Versioning, with `package.json` as the single source. 0.x during the build (0.6.0 = build step 6, 0.7.0 = step 7, …; a later part of a step raises the patch number, e.g. 0.6.1 = step 6c); 1.0.0 at go-live, once this document is implemented. From then on MAJOR = an update that needs manual steps or breaks compatibility, MINOR = new features, PATCH = fixes only. `pnpm version minor\|patch` raises it and tags the commit (`v0.7.0`). The version is shown in the app header and written to the log at every start; from build step 8 also on the health page and in the portable zip's name (`deposit-tracker-<version>-win-x64.zip`). The change log of this document serves as release notes |
| Updates | Releases are published on GitHub Releases of the public repository: the portable zip, its SHA-256 and an Ed25519 signature made with a release key that never leaves the developer's machine. The app on the office PC only reaches out (HTTPS to the GitHub API, daily and at start); nothing comes in. It verifies the signature with the public key built into the app (Node's built-in crypto, no new dependency), so neither a changed download nor a compromised GitHub account can install code. Only an admin starts an update; it is staged and applied by `start.cmd` before the app starts (files of a running app are locked on Windows), with the previous `app` folder kept for rollback and an automatic switch back when the health check fails. A major version (manual steps) is never applied this way: the app only points to the runbook. Older versions are never installed. No secrets live in the repository: data, keys and `.env` files are git-ignored |
| Packaging | pnpm for development. `pnpm build:portable` produces one zip: a portable Node.js runtime, the Next.js standalone build with prebuilt native modules for Windows x64, and start/stop/backup/create-admin `.cmd` scripts |

## Roles and permissions

Money enters the system through the accountant role; money is attributed to B/Ls through the operations role. A user may hold both roles; every action is logged under the person who did it and the role used.

| Role | Can do | Cannot do |
| --- | --- | --- |
| Accountant | Open outgoing deposit payment records by uploading bank receipts (one or many at once) or, for offsets, the invoice, or without them for now and attach them later. Enter incoming refunds and offsets. Correct or void own money records with a reason while they have no confirmed allocation. Optionally note a B/L number on a payment as a hint. Follow the Operations work lists read-only: All B/Ls, agencies, due requests and payments awaiting a B/L. | Create or edit B/Ls (sees linked B/L numbers read-only, with a copy button), allocate refunds, record deductions. |
| Operations | Create B/Ls from payment records (one at a time or in bulk), edit B/Ls and containers, void a B/L created with wrong data while it has no confirmed allocation, write notes with @mentions, generate and upload forms, send requests, record portal requests, record agency replies (also in bulk), record deductions, allocate refunds, mark disputes, attach a missing deposit receipt or invoice, undo own recent actions, send the report email to internal addresses. | Create or correct money records, including a deposit's amount or currency (the accountant corrects the payment record and the B/L follows). |
| Admin | Everything in settings, users and roles; agency form templates; reverse a confirmed allocation with a reason; approve write-offs; void any record after its allocations are reversed. | — |

A user holding both accountant and operations roles gets a continuous flow: after saving a deposit payment, the same screen continues to B/L creation with agency, amount, currency and extracted B/L number prefilled. The audit log records each step under its own role.

Role permissions are enforced on the server, not only hidden in the UI. Every state change and every settings change is written to the audit log with user, the role used and timestamp.

## B/L lifecycle

A B/L moves from payment through repeated requests to collection; it is closed only by confirmed refund allocations and classified deductions, never by hand.

**Allowed transitions** (any transition not listed is rejected by the domain layer):

| From | To | Trigger |
| --- | --- | --- |
| `PAID` | `DUE` | Computed on read, never stored: payment date + first-request duration has been reached |
| `PAID` (upcoming) / `DUE` | `REQUESTED` | Refund request email sent successfully, or portal request recorded (attempt 1) |
| `REQUESTED` | `AWAITING_RETURN` | Reply type *container not yet returned* recorded |
| `AWAITING_RETURN` | `REQUESTED` | Follow-up request sent successfully |
| `REQUESTED` / `AWAITING_RETURN` | `COLLECTED` | Confirmed allocations + classified deductions = deposit |
| `REQUESTED` / `AWAITING_RETURN` | `COLLECTED` | Deductions from a statement take the whole deposit (e.g. the agency applied it to one of its invoices); no refund follows |
| `REQUESTED` / `AWAITING_RETURN` | `DEDUCTION_OPEN` | Confirmed allocation leaves a shortfall marked `UNEXPLAINED` |
| `DEDUCTION_OPEN` | `COLLECTED` | Every `UNEXPLAINED` deduction replaced by a real type, and the balance closes |
| `DEDUCTION_OPEN` | `DISPUTED` | A deduction is marked disputed |
| `DISPUTED` | `COLLECTED` | Difference paid (allocated) or dispute cleared with a note, and the balance closes |
| any open status | `COLLECTED` | Admin approves a `WRITE_OFF` deduction that closes the balance |
| `COLLECTED` / `DEDUCTION_OPEN` / `DISPUTED` | status before the allocation | Admin reverses a confirmed allocation; status is recomputed from the remaining history |
| `AWAITING_RETURN` / `COLLECTED` | status before the action | The user undoes, within the undo window, the *not yet returned* reply or the settling statement deduction that caused the move, while the B/L is still where it left it |

No status change: a failed send, an *approved, payment to follow* reply, a *deduction statement received* reply, deductions recorded from a statement before payment, voiding (a flag, not a status). The stored `status` column never holds `DUE`.

The seven statuses are `PAID`, `DUE`, `REQUESTED`, `AWAITING_RETURN`, `DEDUCTION_OPEN`, `DISPUTED` and `COLLECTED`. `DUE` is derived from the payment date and the duration settings, not set by a user. For portal agencies, recording the portal request moves the B/L to `REQUESTED`. Each "not yet returned" reply schedules the next request after the follow-up interval; there is no escalation. When the follow-up date arrives, the B/L stays in Awaiting return but appears in the due list as a follow-up; sending it moves the B/L back to Requested. A failed send leaves the status unchanged. An agency approval reply is recorded as a reply type and does not change the status. A shortfall in an allocated refund opens a deduction, which either gets a type (then `COLLECTED`) or is disputed and stays open until the difference is paid or accepted. Deductions recorded from a statement before payment do not open `DEDUCTION_OPEN`; they lower the expected amount instead.

A write-off is a deduction of the system type `WRITE_OFF`, approved by an admin; it closes the B/L through the normal rule (allocations + classified deductions = deposit). Voiding is not a status: a voided B/L keeps its last status, is flagged as voided and is excluded from all working lists, balances and reports.

## Immutable business rules

These invariants live in code, are enforced in the domain layer and database constraints, and are not configurable. Everything else is a setting.

1. A B/L can reach `COLLECTED` only through confirmed refund allocations (or confirmed offsets) whose total, plus classified deductions (including approved write-offs), equals the deposit.
2. A refund may be allocated only to B/Ls of the same agency and the same currency.
3. The sum of allocations of a refund can never exceed the refund amount. Any remainder stays "unallocated" on the refund; it is computed, never stored.
4. A B/L with an unexplained deduction or an open dispute cannot be closed.
5. Balances are always derived from ledger entries (payment, offset, deduction, refund allocation, opening balance). No editable balance field exists. Voided records contribute nothing.
6. Allocation suggestions, email match suggestions and extracted B/L numbers are never applied without a user's confirmation. There is no auto-confirm.
7. Money records are created, corrected and voided only by a user acting with the accountant role; allocations only by a user acting with the operations role. One user may hold both roles; the audit log records which role was used. The single exception: an `OPENING_BALANCE` record is entered by an admin through the opening-balance form.
8. A confirmed allocation can be reversed only by an admin, with a reason, and the reversal is logged.
9. Status transitions follow the lifecycle above; no transition may be skipped or forced from the UI, by inline editing, bulk actions or undo. Status labels and colours are configurable; the transitions are not.
10. The app never moves, deletes or marks as read any email in the shared mailbox.
11. A B/L is created only from a deposit payment record, and each payment record has at most one active (non-voided) B/L. The single exception is a migrated record with an `OPENING_BALANCE` ledger entry.
12. Every bank refund record requires an uploaded bank receipt and every offset refund the uploaded invoice; every opening-balance record requires the original deposit receipt. A deposit payment may be saved, and its B/L created, without its receipt (bank) or invoice (offset); it can be attached later, also after requests went out, and a request email for a B/L without it is sent only after an explicit confirmation.
13. A deposit's amount or currency cannot change while it has a confirmed allocation.
14. A refund request cannot be sent or recorded for a B/L without an uploaded form (when the corresponding rule setting is on), and a B/L being drafted by one user is locked for others.
15. Records are never deleted. Payments, refunds and B/Ls can only be voided, with a reason, and only while they have no confirmed allocation; voiding a payment requires its B/L to be voided first.
16. A write-off requires an admin approval and a reason.
17. Undo creates compensating entries, never deletes rows, and never applies to confirmed allocations, sent emails, money records, write-offs or settings.

## Data model

The B/L is the central entity; money moves are ledger rows; emails relate to B/Ls many-to-many. Nullable override columns on `agencies` and `bills_of_lading` mean "inherit from the level above". Voidable tables carry `voided_at`, `voided_by` and `void_reason`.

| Table | Purpose | Key fields |
| --- | --- | --- |
| `agencies` | Shipping lines / agencies | name (unique, case-insensitive), active, email recipients (one to/cc list for all request types), bank sender aliases, bl\_number\_patterns (list of regular expressions), form\_template\_document\_id, batch\_sending (bool), request\_channel (EMAIL, PORTAL), portal\_url, nullable setting overrides, notes |
| `deposit_payments` | Outgoing deposit, opened by accountant, with its receipt or invoice or without it for now | agency\_id, amount, currency, paid\_at, kind (BANK, OFFSET), evidence\_file\_id (null until attached), extracted\_fields (json), extracted\_bl\_numbers (json list), bl\_no\_hint (accountant note), void fields |
| `bills_of_lading` | One deposit per B/L, created from a deposit payment | bl\_no, deposit\_payment\_id (unique among non-voided; null only for migrated records), agency\_id, currency, deposit\_amount, paid\_at, status, locked\_by, locked\_at, nullable setting overrides, void fields |
| `containers` | Containers under a B/L | bl\_id, container\_no, type |
| `ledger_entries` | Every money movement on a B/L (B/L level only); append-only: a correction writes a compensating entry (negated amount, `compensates_entry_id`) plus a new entry, and an entry can be compensated once. Amounts are positive for every type (payments, deductions and allocations alike); only compensating entries are negative | bl\_id, type (PAYMENT, OFFSET, DEDUCTION, REFUND\_ALLOCATION, OPENING\_BALANCE), amount (signed), currency, deduction\_type\_id, deduction\_source (STATEMENT, SHORTFALL, WRITE\_OFF), document\_id (the agency's deduction statement; mandatory for STATEMENT), disputed (bool) and dispute\_note (set once on an unexplained deduction, never cleared: the entry is compensated instead), date, source refs, refund\_allocation\_id, compensates\_entry\_id (undo) |
| `refunds` | Incoming money entered by accountant | agency\_id, amount, currency, value\_date, kind (BANK, OFFSET), evidence\_file\_id, unallocated\_reason (set when operations leaves the remainder on purpose), void fields. Status is computed from confirmed allocations, never stored: `OPEN`, `PARTIALLY_ALLOCATED`, `ALLOCATED`, or remainder left unallocated with a reason |
| `refund_allocations` | Split of a refund over B/Ls | refund\_id, bl\_id, amount, state (CONFIRMED, REVERSED), bl\_status\_before (restored on reversal), confirmed\_by, role\_used, reversed\_by, reversed\_at, reversal\_reason. Each confirmed row also writes a REFUND\_ALLOCATION ledger entry; a shortfall deduction confirmed with it references the same allocation |
| `write_offs` | Write-off proposals (rule 16) | bl\_id, amount (what the B/L lacked when proposed), currency, reason, state (PROPOSED, APPROVED, REJECTED), proposed\_by, decided\_by, decided\_at, decision\_note (mandatory on rejection), ledger\_entry\_id (the WRITE\_OFF deduction written on approval). One open proposal per B/L |
| `requests` | Each request cycle | bl\_id, type (REFUND, DEDUCTION\_STATEMENT), channel (EMAIL, PORTAL), email\_id (null for portal), portal\_ref, requested\_on (business date the clock counts from), sent\_at, attempt\_no (one live request per attempt; a failed send keeps its number for the retry), send\_status (QUEUED, SENT, FAILED), failure\_reason |
| `emails` | Sent messages and in-thread replies | direction, agency\_id, message\_id, in\_reply\_to, references, from, to, cc, bcc, subject, body as sent, send\_status, dry\_run, send\_attempts, last\_error, queued\_by, role\_used, sent\_at, copied\_to\_sent\_at, raw\_document\_id (the `.eml`), received\_at (incoming only). Whether an incoming email is processed is computed from `replies`, never stored |
| `email_attachments` | Files sent with an email | email\_id, document\_id |
| `report_emails` | Operations report emails (an `emails` row with no agency and no requests) | email\_id, sections, filters as chosen |
| `standing_documents` | Signature circular and power of attorney; the newest per slot is current | slot (SIGNATURE\_CIRCULAR, POWER\_OF\_ATTORNEY), document\_id, uploaded\_by |
| `jobs` | Scheduler queue | kind (SEND\_EMAIL, COPY\_TO\_SENT\_FOLDER, …), payload, run\_at, status, attempts, last\_error |
| `service_status` | Mail server reachability for the outage banner | service (SMTP, IMAP), failing\_since, last\_error, last\_ok\_at |
| `email_bl_links` | Incoming emails and the B/Ls they concern (outgoing emails reach their B/Ls through `requests`) | email\_id, bl\_id, linked\_by (THREAD, SUGGESTION, MANUAL), linked\_by\_user (null for THREAD), unlinked\_at/unlinked\_by (undo of a link by hand) |
| `email_match_suggestions` | Possible matches: an incoming email outside a known thread that names an open B/L | email\_id, bl\_id, state (OPEN, ACCEPTED, DISMISSED), resolved\_by, resolved\_at |
| `replies` | An agency answer for one B/L, recorded by operations | bl\_id, reply\_type\_id, replied\_on (business date: the day the email arrived, or the date the user gives), email\_id (null for a reply without email), note, created\_by, role\_used, undone\_at/undone\_by (undo). One in effect per email and B/L |
| `mailbox_state` | How far the poller has read the inbox folder | folder, uid\_validity, last\_uid, last\_polled\_at |
| `documents` | Uploaded and generated files, stored under the data folder as `files/YYYY/MM/<uuid>.<ext>` | owner type/id (null until attached), kind (FORM, FORM\_TEMPLATE, GENERATED\_FORM, RECEIPT, INVOICE, DEDUCTION\_STATEMENT, STANDING, OTHER), original name, stored path, MIME type, size, SHA-256, uploaded\_by (null for files imported from the mailbox), withdrawn\_at/withdrawn\_by (an upload taken back by undo) |
| `receipt_queue` | Review queue for bulk receipt upload | document\_id, extracted fields, created\_by, resolution (SAVED, DISCARDED), payment\_id |
| `notes` | Team notes on a B/L | bl\_id, author\_id, body, mentioned user ids, created\_at, undone\_at/undone\_by (undo) |
| `notifications` | In-app notifications | user\_id, kind (MENTION, CORRECTION, UNPROCESSED\_REPLY, WRITE\_OFF\_PROPOSED, WRITE\_OFF\_DECIDED), entity type and id, detail (what the text needs, kept as it was), created\_at, read\_at. An overdue reply notifies each user once |
| `user_preferences` | Per-user UI state (not audited) | user\_id, key (e.g. table id), value (json: columns, order, sort, filters, density) |
| `settings` / `settings_history` | Typed global settings and their change log | key, value (json), type, validation, old/new value, changed\_by |
| `holidays` | Business-day calendar | date (unique), name, kind (FULL, HALF) |
| `email_templates` | Turkish templates with sections for batched emails | key (REFUND\_REQUEST, FOLLOW\_UP, DEDUCTION\_STATEMENT, BATCH, BATCH\_LINE, REPLY\_QUOTE, DAILY\_UNPROCESSED), subject, body with placeholders and section blocks |
| `deduction_types`, `reply_types`, `bank_accounts`, `currencies` | Configurable lists | name, active, sort order; reply types also carry a system code (NOT\_RETURNED, APPROVED, STATEMENT\_RECEIVED, INFO; null for types an admin adds) |
| `users`, `user_roles`, `audit_log` | Users with one or more roles; every state change | username (unique, case-insensitive), display name, password hash, must\_change\_password, active, failed\_login\_count, locked\_at; user\_id + role; actor, role used, action, entity, before/after, reason, undo\_of, at |
| `sessions` | Login sessions | id (SHA-256 of the cookie token), user\_id, created\_at, last\_seen\_at, revoked\_at |

`UNEXPLAINED` and `WRITE_OFF` are system deduction types: they can be relabelled but never deleted, and `UNEXPLAINED` can be replaced by a real type. Allocation suggestions are computed on screen and not stored; only confirmed allocations become rows. Seed reply types: *container not yet returned*, *approved, payment to follow*, *deduction statement received*, *info only / no action*. They are system types: renamable and reorderable, never deactivated. Only *container not yet returned* changes the status; *info only* marks a reply processed without restarting the follow-up clock; every other type (including ones an admin adds) restarts the clock and changes nothing else.

## Settings system

Every duration, threshold, template and list is editable in a Turkish settings panel; code reads values only through `getSetting(key, { agencyId?, blId? })`.

**Resolution:** B/L override → agency override → global setting. A null override inherits. Initial values come from a seed file loaded at install, not from code.

**Dates are computed, not stored.** Due dates are derived on read from events + current settings, so a settings change applies to all open B/Ls immediately. There are no manual date overrides in v1.

**Business-day engine:** one module, `addBusinessDays(date, n)` / `businessDaysBetween(a, b)`, driven by the weekend-days setting and the `holidays` table. `addBusinessDays(d, n)` is the n-th business day after `d` (`n = 0` returns `d`); `businessDaysBetween(a, b)` counts business days after `a` up to and including `b` (negative when `b` is earlier), so the two are inverses. Half days (arife) count as business days only when the calendar setting says so. "Today" is the Europe/Istanbul date. Every duration declares its day type; v1 uses business days for all app reminders. Calendar days are reserved for any future demurrage logic.

**Impact preview:** before saving a change, the panel shows how many B/Ls move into or out of each list (e.g. "14 B/Ls become due today"). It covers the request-timing durations, weekend days and the half-day rule in settings, and agency and B/L overrides; holiday edits are not previewed in v1.

**Overrides:** only the request-timing durations are overridable per agency and per B/L: first request due, "upcoming" window, follow-up interval, statement request delay, statement follow-up interval. All other settings are global. Agency overrides (agency card) and B/L overrides (B/L detail) are set by an admin. A reason can be given with any settings, override or holiday change (optional) and is stored in the audit log and settings history.

| Group | Settings |
| --- | --- |
| Calendar | Weekend days; holiday list (date, name, full/half day); whether half days (arife) count as business days; bulk holiday entry per year |
| Durations (business days) | Days after payment until first refund request is due; days in advance a B/L shows as "upcoming"; days between follow-ups after "not yet returned"; days after an unexplained deduction until the statement request is due; days between statement-request follow-ups; days before an unprocessed agency reply raises a warning; aging report bucket edges |
| Reports | Internal email domains (report recipients must belong to one); default report recipients; report email template |
| Notifications | In-app notifications always on; which events notify (unprocessed reply, correction, mention, write-off approval) (step 7); daily unprocessed-reply email on/off, time and recipients (step 5); weekly summary email on/off, its weekday, time and recipients |
| Email server | SMTP/IMAP host, port, encryption, user, encrypted app password; sent-folder name; inbox folder the poller reads; IMAP poll interval; sender display name; default CC/BCC; signature; max attachment size; send-test button |
| Templates (Turkish) | Refund request, follow-up, deduction statement request, daily unprocessed-reply email, weekly summary; batched template sections; placeholders; live preview |
| Lists | Deduction types, reply types, active currencies, our bank accounts (used only to fill `{bank_name}` / `{iban}` in agency forms), status display labels and colours |
| Reconciliation | Number of alternative suggestions shown |
| Rules | Block sending without an uploaded form; standing documents attached to every request; duplicate-record warning; draft lock timeout; undo window; allowed file types |
| Users | Users and their roles (one or more); failed-login lockout attempts; minimum password length |
| Backups | Daily backup time; number of daily and weekly copies kept; second backup location |

Agency-level configuration (not global settings): B/L number patterns, form template, recipients, sending mode, request channel, portal URL, active flag. Editable by operations on the agency card; the form template and setting overrides by admin. Agencies are deactivated, never deleted.

**B/L number patterns:** up to 20 regular expressions per agency, matched case-insensitively; candidates are upper-cased and listed in order of appearance. A pattern is rejected when it is invalid, longer than 200 characters, matches empty text, or nests quantifiers (e.g. `(A+)+`), which could hang the server. The agency card has a test field.

**Holidays** are calendar configuration: entered one by one or pasted in bulk per year (`date; name; Tam/Yarım`), and may be edited or removed; every change is audited.

### Seed values

| Setting | Default |
| --- | --- |
| Weekend days | Saturday, Sunday |
| Half days (arife) count as business days | No |
| First refund request due after payment | 7 business days |
| "Upcoming" shown in advance | 2 business days |
| Follow-up after "not yet returned" | 5 business days |
| Statement request after an unexplained deduction | 2 business days |
| Statement-request follow-up interval | 5 business days |
| Unprocessed reply warning | 1 business day |
| Aging buckets | 0–20, 21–40, 41–60, 60+ business days |
| Deduction types | Demurrage/detention, Other (plus the system types Unexplained and Write-off) |
| Reply types | Container not yet returned; Approved, payment to follow; Deduction statement received; Info only / no action |
| Currencies | USD, EUR |
| Daily unprocessed-reply email | Off; 09:00 when on |
| Weekly summary email | Off |
| Alternative allocation suggestions shown | 3 |
| Draft lock timeout | 30 minutes |
| Undo window | 10 minutes |
| Session idle timeout / failed-login lockout | None / 5 attempts |
| Minimum password length | 8 characters |
| Allowed file types / max size | PDF, JPG/JPEG, PNG, EML, DOC/DOCX, XLS/XLSX / 10 MB |
| Block sending without uploaded form | On |
| Attach standing documents to every request | On |
| Email server | smtp.yandex.com:465 and imap.yandex.com:993 (SSL/TLS), sent folder "Sent", inbox folder "INBOX", poll every 5 minutes, attachments up to 25 MB in total; sender, user and password entered at setup |
| Duplicate-record warning | On |
| Daily backup time | 12:30 |
| Backup copies kept | 14 daily / 8 weekly |

### Email template drafts (Turkish)

Starting texts; editable in settings. The daily unprocessed-reply email (internal, never to agencies) has its own template with `{count}`, `{warning_days}`, `{agency_lines}` and `{link}`. Placeholders: `{agency_name}`, `{bl_no}`, `{containers}`, `{amount}`, `{currency}`, `{attempt_no}`, `{portal_ref}`, `{deduction_amount}`, `{signature}`.

```text
[Refund request]
Konu: Depozito İade Talebi – B/L {bl_no}

Sayın {agency_name} yetkilisi,

{bl_no} numaralı konşimentoya ait {containers} numaralı konteyner(ler) için ödemiş olduğumuz {amount} {currency} tutarındaki depozitonun iadesini rica ederiz. İade talep formu, depozito dekontu, imza sirküleri ve vekaletname ektedir.

Bilgilerinize sunar, iyi çalışmalar dileriz.
{signature}

[Follow-up – sent as a reply in the same thread]
Sayın {agency_name} yetkilisi,

{bl_no} numaralı konşimentoya ait depozito iadesi için {attempt_no}. kez yazıyoruz. Konteynerler boş olarak teslim edildiyse iade sürecini başlatmanızı, edilmediyse bilgi vermenizi rica ederiz. Belgeler tekrar ektedir.

{signature}

[Deduction statement request]
Konu: Depozito Kesinti Dökümü Talebi – B/L {bl_no}

Sayın {agency_name} yetkilisi,

{bl_no} numaralı konşimentoya ait depozito iadesinde {deduction_amount} {currency} tutarında fark oluşmuştur. Kesintinin dökümünü ve dayanak belgelerini iletmenizi rica ederiz.

{signature}

[Batched email – one section per request type]
Konu: Depozito Talepleri – B/L {bl_no}

Sayın {agency_name} yetkilisi,

Aşağıdaki konşimentolara ait depozito iadelerini rica ederiz:
{refund_section}

Aşağıdaki konşimentolarda oluşan farkların kesinti dökümünü rica ederiz:
{statement_section}

Tüm belgeler ektedir.
{signature}
```

In a batched email, `{bl_no}` in the subject lists all B/L numbers; each section line shows B/L number, containers, amount and currency, and an empty section is left out. In the stored template a section is a block `[[refund]] … {refund_section} … [[/refund]]` (likewise `[[statement]]`), removed with its intro line when the section is empty; each line comes from the BATCH\_LINE template. A batch with a single B/L uses the single templates. Follow-ups are sent as replies with the subject "Re: " + the earlier subject; the follow-up subject template is used only when there is no earlier email to reply to (portal agencies). Templates are edited on their own admin page with a live preview.

### Form template placeholders

Agency form templates (`.docx`) may use: `{agency_name}`, `{bl_no}`, `{containers}`, `{container_count}`, `{amount}`, `{currency}`, `{paid_at}`, `{bank_name}`, `{iban}`, `{today}`. Unknown placeholders are reported when the template is uploaded, and the template is refused until they are fixed; loops and conditions are not part of the placeholder set. Amounts and dates are filled in Turkish format. Each download is kept on the B/L as a generated form (timeline: "prefilled form created"). The signed, scanned form is uploaded to the B/L; a newer upload becomes the current form for later requests.

`{bank_name}` / `{iban}` come from the single active bank account in the B/L's currency. If there is none, or more than one, the form is still generated with both fields left blank, and the download shows a warning.

## Email

All mail goes through one shared company mailbox on Yandex (used by staff via Outlook): SMTP to send, IMAP to read, and the app stays invisible to people working in Outlook.

**Outbound**

- Operations selects due items and sends. Per agency setting, requests go one email per B/L or one batched email per agency covering several B/Ls, each B/L's uploaded form attached.
- Two request types share the same flow: refund requests and deduction-statement requests. A batched email has one section per type.
- Every email is shown in a preview before sending; recipients, CC, subject and body are editable. The body stored is the one actually sent, not the template. Templates are Turkish only.
- B/L number(s) always appear in the subject.
- After each SMTP send, the app appends a copy to the IMAP sent folder so it shows in Outlook.
- The app stores the generated `Message-ID`. Follow-ups are sent as replies (`In-Reply-To`/`References`), keeping one thread per request chain. Every request attaches the B/L's refund form, the B/L's deposit receipt and the standing documents.
- Send failures and bounces mark the request as failed and list it under "failed to send"; the request does not count as sent.

**Standing documents**

Agencies require the same supporting set with every request: the signature circular (imza sirküleri) and power of attorney, plus the B/L's own deposit receipt. The circular and power of attorney are uploaded once by an admin as standing documents, apply to all agencies, and have no expiry tracking; a newer upload replaces the old one for future emails. The deposit receipt is taken from the B/L's source payment record. The email preview lists every attachment and lets the user remove one for that send.

**Portal agencies**

- For an agency with `request_channel = PORTAL`, the due list shows the first request as "open on portal" with a link to the portal instead of an email preview.
- After filing on the portal, operations records the request in the app (date, optional portal reference number). It counts as attempt 1 and starts the follow-up clock.
- The agency's first email about it is not in an app-started thread, so operations links it to the B/L (see Match suggestions and Manual link). From then on, follow-ups are sent as replies to that linked email, and its later replies are imported automatically.
- If no email has been linked when a follow-up is due, the follow-up goes as a new email to the agency's recipient list, with the portal reference in the subject.

**Inbound (agency replies)**

The IMAP poller reads new messages of the inbox folder read-only (EXAMINE) and tracks the last read UID per folder, with its UIDVALIDITY, in the database; a message already stored (same Message-ID) is never imported twice. The first poll starts from the date of the first request the app recorded. Messages from our own sender address are skipped. Reading works the same in dry-run and live mode (only sending is held back), so a development install can read a test mailbox. Only replies in a known thread are imported: a message whose `In-Reply-To`/`References` points to a stored sent message, or to a manually linked message, is linked to that message's B/Ls with certainty. Everything else in the mailbox is ignored.

- **Match suggestions:** a new message that is not in a known thread but contains the number of an open B/L in its subject or body is listed under "possible matches" with that B/L. It is linked only when a user accepts it with one click.
- **Manual link:** when an agency answers with a new email that has no recognisable B/L number, a user can search the shared mailbox from the B/L detail (by sender and subject) and link the message by hand.
- **Unprocessed warning:** a linked reply without a recorded reply type after the configured number of business days appears on the dashboard, in the menu badge, in the optional daily unprocessed-reply email and in the weekly summary.

**Replies are read in the app.** The Replies screen shows the full message and its attachments, so the team reads agency replies there instead of in Outlook. The app never interprets the reply. An operations user records the reply type per linked B/L with quick buttons (one reply to a batched email may cover several B/Ls with different answers; one click can apply the same type to all). Attachments (except inline images such as signature logos) are kept with the email, together with the raw `.eml`, and appear on the B/L detail of every linked B/L. A reply can also be recorded on the B/L detail without an email (e.g. read on the agency portal), with a date and an optional note; it counts like an emailed reply. The reply date of an emailed reply is the day it arrived. A reply of type *deduction statement received* lets the user record the deductions right away.

**Daily unprocessed-reply email (optional):** when enabled, a short internal email at the configured time lists the number of unprocessed replies past the warning per agency with a link to the Replies screen (the host PC's name, port 3000). If the PC was off at that time, it is sent once at the next start. It is sent only to the configured internal recipients and only when there is at least one unprocessed reply.

## Payments, deductions and refund reconciliation

Bank statements carry no B/L numbers for incoming refunds, and refunds usually arrive batched, so the app proposes how each refund splits over open B/Ls and an operations user always confirms it.

**Outgoing deposits.** The accountant uploads bank receipts (or, for an offset, the invoice). Several receipts can be dropped at once; each is parsed and placed in a review queue where the accountant checks the prefilled fields and saves. Each payment covers exactly one B/L. Payments without a B/L stay on the dashboard as open work. Entering a record with the same agency, amount and date as an existing one shows a duplicate warning that must be confirmed.

**B/L number from the receipt.** The transfer description of an outgoing payment usually contains the B/L number. The parser searches the description with the agency's B/L number patterns and stores the candidates. The accountant may also type a B/L number hint by hand. When operations creates the B/L, the number is prefilled and must be confirmed. If more than one candidate is found, the user picks one; a payment still yields exactly one B/L.

**B/L creation.** Operations creates B/Ls one at a time from a payment, or in bulk from a table of payments without a B/L: each row is prefilled (agency, amount, currency, B/L number candidate) and B/L numbers and container lists can be typed or pasted from Excel. Rows are saved together after validation; invalid rows stay in the table with their errors. B/L numbers are stored upper-case without spaces (3–40 characters: letters, digits, `-`, `/`) and are unique among active B/Ls across all agencies; a number that does not match the agency's patterns only shows a warning. Container numbers must have the ISO 6346 form (4 letters, 7 digits); a wrong check digit only shows a warning. The B/L number can be edited until the first request is sent; containers can always be edited.

**Incoming refunds.** The accountant enters agency (searchable by bank sender aliases), amount, currency, value date and the mandatory receipt, with the same duplicate warning. Offsets are entered the same way with kind `OFFSET` and the invoice as evidence. Refunds arrive in full; there is no bank-fee tolerance.

**Receipt reading.** All payments and refunds pass through one bank, so its PDF receipt has one known layout. For a text-based PDF receipt the app extracts sender or beneficiary name, amount, currency, date and (outgoing) B/L number candidates, matches the name to an agency through its bank sender aliases, and prefills the form. Every field stays editable and manual entry is always possible. Extraction runs on the host PC. Scanned or photographed receipts are entered manually in v1.

**Deductions.**

- **From a statement (before payment):** when a reply is recorded as *deduction statement received*, operations enters the deductions per B/L with their type and attaches the statement. The B/L's expected amount drops at once, so the later refund matches exactly.
- **From a shortfall (after payment):** during allocation review, the difference is assigned to a B/L with a deduction type, or marked `UNEXPLAINED`. An unexplained deduction keeps the B/L open and adds a deduction-statement request to that agency's block in the due-requests list.

**Disputes.** Operations marks a deduction as disputed with a note, the B/L moves to `DISPUTED`, and it stays open. If the agency later pays the difference, that refund is allocated to the same B/L; if we accept the deduction, the dispute is cleared with a note and the B/L closes.

**Write-off.** When an amount will not be recovered (agency refuses, agency closed, amount too small to pursue), operations proposes a `WRITE_OFF` deduction for the remaining expected amount with a reason. An admin approves or rejects it. On approval the B/L closes; write-offs are shown separately in reports.

**Payment records.** The payment date cannot be in the future; a bank payment's account must be in the payment currency; the evidence file must have been uploaded by the same user and is attached to exactly one record. Uploads are checked against the allowed types and size settings, and the content must match the extension.

**Corrections and voiding.** Mistakes are fixed without deleting anything:

- The accountant corrects the amount, currency, date or agency of an own money record with a reason while it has no confirmed allocation. An active B/L follows the correction (agency, currency, deposit, paid date), and its ledger entry is compensated and re-entered.
- Operations voids a B/L created with wrong data while it has no confirmed allocation; its payment returns to "awaiting B/L" so a correct B/L can be created.
- The accountant voids a duplicate or mistaken payment or refund with a reason, once its B/L (if any) is voided and it has no confirmed allocation.
- Records with confirmed allocations need an admin reversal first.

Voided records disappear from working lists, balances and reports, remain visible in timelines and the audit log, and can be shown with a "show voided" filter.

**Undo.** A user can undo their own recent action within the undo window: a recorded reply type, a deduction from a statement, an email-to-B/L link made by hand or by accepting a match, a form upload, a B/L number or container edit, and (build step 7) a note or an inline field edit. The success message offers "Geri al" for a few seconds, and the B/L timeline offers it on the user's own events for the rest of the window. Undo writes a compensating entry or a set-once flag (reply undone, link unlinked, upload withdrawn; nothing is deleted) and an audit row referencing the original; the timeline shows both. It needs the permission of the original action, takes back several rows of one action together (e.g. a bulk reply), and is refused once the B/L moved on: a link with a recorded reply, a form already sent, an edit changed again, a status changed since. A *not yet returned* reply or a statement deduction that closed the B/L returns the B/L to the status before it. Confirmed allocations, sent emails, money records, write-offs, classifications, disputes and settings cannot be undone this way.

**Allocation suggestions.** Candidates are B/Ls of the same agency and currency, with at least one request sent on or before the value date, still open and not voided. Expected amount per B/L = deposit − recorded deductions − already allocated. The engine returns ranked alternatives:

1. **Exact subset:** combinations of candidates whose expected amounts sum exactly to the refund, oldest-first combinations ranked higher.
2. **FIFO:** fill oldest B/Ls first (by first request date); the last one absorbs the shortfall.

**Review.** Nothing is posted until operations confirms; there is no auto-confirm.

**Example.** Open B/Ls A 3,000, B 2,500, C 1,500 USD (expected 7,000); refund 6,300 USD. No exact subset exists. FIFO suggests A 3,000 + B 2,500 + C 800, difference 700. The user decides which B/L bears the 700 and its type, or marks it unexplained. Had the agency sent a statement for a 700 USD cleaning charge on C beforehand, C's expected amount would be 800 and the exact subset A + B + C would match.

**Edge cases.** Overpayment → remainder stays unallocated on the refund. Reversal → admin only, with reason, audited.

## Reports and exports

Three on-screen views ship in v1; all are computed from ledger entries and request history and exclude voided records.

| Report | Shows |
| --- | --- |
| Aging | Open deposits by agency and currency, bucketed by business days since payment |
| Agency scorecard | Per agency: average business days to refund, average request attempts, deduction rate by type (write-offs separate), open balance |
| B/L timeline | Every event on one B/L in order: payment, uploads, generated forms, requests, replies, deductions, allocations, voids, undos, with actor |

**Exports.** Every table and report has a CSV download of the current view (visible columns, filters and sort) in Turkish Excel format, and a "copy" action that puts the selected rows on the clipboard as tab-separated text for pasting into Excel. Native `.xlsx` export is deferred.

The optional weekly summary email contains open balance per currency, B/Ls waiting longest, and unprocessed replies.

**Report email (operations, on demand).** An operations user sends a brief status report to internal addresses from the Reports screen ("Rapor gönder"):

- **Sections**, any combination: *requested refunds* (requested, still outstanding: B/L, agency, deposit, first and last request date, attempts, last reply); *remaining deposits* (open balance per agency and currency); *collected in a period* (refunds allocated in the date range, with deductions and write-offs); *problems* (open and disputed deductions, failed sends, B/Ls waiting longest).
- **Filters:** agencies, currency, and a date range for the collected section; the other sections show the state of today. Voided records are excluded, as in every report.
- **Format:** a Turkish email with a short summary table per section in the body (template in settings) and the full lists as CSV attachments, one per section, in the export format (UTF-8 with BOM, semicolons, Turkish numbers and dates).
- **Recipients:** internal only. They must belong to one of the internal email domains (setting; the sender's own domain counts), and an address that is on any agency's recipient list is refused, so internal figures never reach an agency. A saved default recipient list (setting) prefills the preview.
- **Sending:** always with a preview (recipients, subject and intro editable), then through the same send job as requests: retries, the sent-folder copy, dry-run outside production (rule 13), the `.eml` kept. Each send is audited with its sections, filters and recipients. Nothing is sent on a schedule; the weekly summary covers that.

## Screens

Desktop-only, dense tables; a row opens its details in a large centered dialog over the full-width list, with previous/next through the list as sorted and filtered (← / →). There is no per-user assignment: operations works from a shared pool, and a B/L being drafted by one user shows a lock badge for others. A user with both roles sees both menus.

**Everywhere**

- **Global search** in the header (shortcut `/` or Ctrl+K): finds B/Ls by B/L number, container number, agency name or amount; pasting several B/L or container numbers lists all matches at once; Enter opens the B/L detail.
- **Keyboard shortcuts:** arrow keys to move between rows, Enter to open the detail dialog, ← / → for the previous or next record in it, Esc to close it, `R` record reply, `N` add note, `/` search, `?` shows the shortcut list.
- **Bulk actions** on every list: select rows, then record the same reply type, prepare sending, add a note or copy. Every bulk action shows a confirmation with the affected B/Ls before it runs.
- **Inline editing** of permitted fields directly in table cells (B/L number before any request is sent, containers, notes, agency contact fields). Money fields and statuses are never inline-editable. Every inline edit goes through `can()`, validation and the audit log, and can be undone within the undo window.
- **Personal table layout:** column choice, order, sort, filters and density are remembered per user and table.
- **Unprocessed replies badge** on the Replies menu item.

| Screen | Role | Contents |
| --- | --- | --- |
| Dashboard | Operations | Top: open balance per currency and collected this month. Three columns with counts that open filtered lists: today's work (due and follow-up requests), pending matches (payments without B/L, refunds to allocate, unprocessed replies, unallocated amounts, write-offs awaiting approval), problem B/Ls (deduction open, disputed) |
| All B/Ls | All (accountant read-only) | One dense table of every B/L: B/L no, agency, status, paid date, deposit, currency, expected amount, collected, attempts, last reply, business days waiting (since payment, while the B/L is open). Filter and sort on every column, "show voided" filter, CSV download and copy, detail panel on the right |
| Due requests | Operations (accountant read-only) | Tabs: due (today and overdue), upcoming, failed to send. Grouped by agency with batch type, channel, B/L count and totals per currency. Rows: select, B/L no, paid date, business days waiting, attempt no, last reply, amount, form status with "download prefilled form" and drag-and-drop upload; a B/L without form cannot be selected. Request type badge. Actions: prepare email, record portal request, record reply |
| B/L detail | Operations | Header: B/L no, agency, status, balance strip (deposit, collected, deductions, remaining). Sections: summary with containers and source payment, timeline, email threads, documents, ledger, notes with @mentions, setting overrides. Actions: download prefilled form, record reply, add deduction from statement, mark dispute, propose write-off, link email from mailbox, void B/L |
| Create B/Ls | Operations (accountant sees the payments awaiting a B/L, read-only) | Table of payments without a B/L, prefilled with agency, amount, currency and B/L number candidates; type or paste B/L numbers and containers; save all valid rows at once |
| Refund allocation | Operations | Left: refunds awaiting allocation. Right: suggestion cards (exact subset, FIFO) with their difference; chosen suggestion opens an editable allocation table with running total and remainder; difference row assigns B/L and type. Confirm only when remainder is zero or left unallocated with a reason |
| Replies | Operations | Tabs: to process, possible matches, processed. Full message with attachments and its linked B/Ls; quick reply-type buttons per B/L and "apply to all"; enter deductions from a statement; save attachments as B/L documents |
| Agencies | Operations | Card: name, bank sender aliases, B/L number patterns (with a test field), one recipient list, batch/single sending, request channel and portal link, form template (admin uploads, shows placeholder check), setting overrides with impact preview, open B/Ls, scorecard summary, notes |
| Accounting | Accountant | New deposit payment (single, or drop several receipts into the review queue), new refund (receipt or invoice mandatory, prefilled from a PDF receipt, duplicate warning). List of own records with status, linked B/L numbers (read-only, copy button), correct and void actions. For dual-role users, saving a payment continues to B/L creation |
| Reports | All (report email: operations) | Aging, agency scorecard, with CSV download; "Rapor gönder" opens the report email preview |
| Settings, users | Admin | As in the Settings section, with impact preview; standing documents upload; write-off approvals; opening-balance form. The admin pages share one "Yönetim" menu in the header |

## Operations and deployment

The app runs from a portable folder on an office desktop PC; other users open it in Chrome or Edge at `http://<computer-name>:3000`. The PC's user and one IT colleague maintain it with a step-by-step `docs/RUNBOOK.md` in the repo. A dedicated always-on host, VPN access or a server in Turkey were reviewed and postponed; the current setup stays for v1.

| Area | Decision |
| --- | --- |
| Host PC | An office Windows 10/11 desktop (x64, 8 GB RAM minimum, 16 GB recommended, 20 GB free disk). Sleep disabled during office hours; Windows Update restarts outside office hours; BitLocker recommended |
| Folder layout | `C:\DepositTracker\app` (replaceable program files) and `C:\DepositTracker\data` (database, uploaded files, logs). The key file sits outside both. USB drives are never used to run the app or hold live data |
| Start | A Windows Task Scheduler task starts the app at system startup, without anyone logging in, and restarts it if it stops. Migrations run automatically on start, after an automatic backup |
| First setup | Unzip the release to `app`, run `create-admin.cmd`, open the app, enter mail server settings, users, agencies (with B/L number patterns and form templates), bank accounts, holidays and standing documents |
| Access | Office network only, plain HTTP on port 3000 by computer name. Windows Firewall allows port 3000 on the private network profile only. No port forwarding; guest Wi-Fi kept separate |
| Outbound network | The PC must reach Yandex SMTP and IMAP; nothing inbound from the internet is needed |
| Updates | Pull-only, admin-approved, from GitHub Releases of the public repository (see Technical decisions → Updates). The app checks daily and shows a new version to admins (header and health page) with its release notes; "Güncelle" downloads the zip, verifies its signature and stages it next to `app`; `start.cmd` applies it at the next start (by default right away: the app restarts and the scheduled task brings it back). The previous `app` folder is kept, and if the health check fails after start, `start.cmd` switches back to it. Manual update (download, `stop.cmd`, replace `app`, `start.cmd`) stays possible. The `data` folder is never touched by an update |
| Backups | Daily at a configurable time during office hours (default 12:30), and at the next start if missed: a consistent SQLite backup plus a copy of the files folder, written locally and copied to a second location. Keep 14 daily and 8 weekly copies. Test a restore monthly |
| Health | `/api/health` endpoint; an admin page shows scheduler status, last IMAP poll and last backup time |
| Runbook contents | First setup, configure mail, add users, add an agency form template, update and roll back, back up, restore from backup, move to another PC, back up and restore the key file, what to do when mail is down |

**Open items before go-live**

- [ ] Create the public GitHub repository (commits show the author's name and email) and the Ed25519 release key; keep the private release key offline, like the mail key file
- [ ] Release 1.0.0 (`pnpm version major`) once this document is implemented
- [ ] Name of the bank and 3–5 sample PDF receipts (incoming and outgoing, including transfer descriptions with B/L numbers) for the receipt parser
- [ ] B/L number formats of each agency, to set up the patterns
- [ ] Blank refund forms of each agency, converted to `.docx` templates with placeholders
- [x] Approve the docx templating library (docxtemplater + pizzip)
- [ ] Rename the host PC from the generic "UserPc" to a unique name (e.g. DEPOZITO-PC; ask IT first if it is domain-joined); sleep and Windows Update settings adjusted
- [ ] Second backup location (shared drive or USB disk)
- [ ] Yandex mailbox: IMAP enabled, app password, sent-folder name
- [ ] Bank accounts per currency, holiday list for 2026–2027, standing documents (signature circular, power of attorney)
- [ ] Review the Turkish email template drafts

## Deferred and next steps

**Deferred beyond v1:** PDF field mapping for agency forms, digital stamp and signature with approval, bulk form printing and QR-based splitting of scanned forms, native `.xlsx` export, keyword-based reply-type suggestions, demurrage/free-time calculation, AI interpretation of agency replies, demurrage-risk alerts, holiday-list reminders, second approval for critical settings, dedicated host PC, remote (VPN) access, server hosting, reading scanned receipts (OCR), Outlook add-in (needs HTTPS).

**Not planned:** accounting software export, deposit tariff tables, container-level return tracking, phone/WhatsApp follow-up logging, Excel import for migration.

**Removed after review:** escalation, snooze, auto-confirm of allocations, bank-fee tolerance.

**Migration:** fewer than 50 open Excel records exist. Each is entered by hand through the admin-only opening-balance form when its next request becomes due, using the `OPENING_BALANCE` ledger type, past request count and last request date; the original deposit receipt is mandatory (it is needed for the request anyway). Until then those records stay in the Excel file. The form (Yönetim → Açılış bakiyesi) creates a B/L without a payment record, attaches the receipt (or, for an offset, the invoice) to the B/L, and records the past requests as one sent request carrying the last attempt number and date; earlier attempts have no row of their own. With no past request the B/L starts as `PAID` (its first request is due at once), otherwise as `REQUESTED`, and follow-ups, replies and allocation continue from there. A follow-up with no earlier email to reply to uses the first-request subject.

- [x] Export this document to the repo as docs/ARCHITECTURE.md
- [ ] Update `CLAUDE.md` to match this version
- [ ] Define the database schema and migrations
- [ ] Write tests for the business-day engine, allocation algorithm and receipt parser first

## Change log

**Oct 31, 2026 — build step 7e (inline editing, keyboard shortcuts), v0.7.4; build step 7 complete**

- Inline editing in the shared table. A column declares an `edit` (when the row's cell may be edited, its text, and the save action). The pencil in the cell, or F2 on the active row, opens the editor; Enter saves and Esc cancels. Saves go through the same server actions as the dialogs, so `can()`, validation, audit and undo apply as usual, and the success message offers "Geri al". Editable fields:
  - All B/Ls: the B/L number while still PAID, and containers.
  - Agencies: To and CC recipients, and notes. These are saved by `updateAgencyContact`, which validates the whole card again.
  - Money fields and statuses stay read-only (rule 11).
- Agency edits (inline or from the card) are now undoable within the undo window. They are refused once the card changed again since. Saving a card without changes reports "Değişiklik yok." and writes no audit row.
- Shortcuts: on the B/L detail, R opens "Yanıt kaydet" and N jumps to the note field. On All B/Ls, N adds a note to the selected B/Ls (or the active one). F2 edits a cell. The `?` list shows them all. Letter shortcuts never fire inside text fields or open dialogs.

**Oct 31, 2026 — build step 7d (notes, mentions, notifications, weekly summary), v0.7.3**

- Notes on B/Ls (operations, `note.add`). They appear on the B/L detail and its timeline. "Not ekle" is also a bulk action on All B/Ls; its confirmation lists the B/Ls, and one bulk note is one action for undo. An `@username` must name an active user, otherwise the note is refused. A note can be undone within the undo window: it stays visible, struck through.
- In-app notifications: a bell in the header shows the unread count, and the *Bildirimler* page lists the user's notifications. Opening one marks it read. Who is notified:
  - *Mention*: the mentioned users.
  - *Correction*: a payment correction that changed a B/L notifies the operations users who worked on that B/L (created it, recorded or sent its requests, recorded its replies, wrote notes). If there are none, all active operations users.
  - *Unprocessed reply*: once the warning has passed, each active operations user, once per reply. The check runs with every mailbox poll.
  - *Write-off*: a proposal notifies every active admin; the decision notifies the proposer.
  - The actor is never notified of their own action. Each kind can be switched off under *Bildirimler*.
- Weekly summary email (off by default): weekday, time and recipients are settings, and the `WEEKLY_SUMMARY` template is editable. It contains open balance per currency, B/Ls waiting longer than the last aging bucket edge (the same rule as the report email), and unprocessed and overdue reply counts. It runs as a recurring job like the daily email: a missed week runs at the next start, and changing the weekday or time moves the pending job. Scheduled jobs read B/Ls without a signed-in user and without draft locks (`allBlsForJob`).

**Oct 31, 2026 — build step 7c (report email), v0.7.2**

- Report email as planned. "Rapor gönder" on the Reports screen (operations only, `report.sendEmail`) picks sections, agencies, a currency and the collected period (defaults to this month so far), then shows the preview. Recipients, CC, subject and intro can be edited there. The section summaries are read-only and follow the intro, then the email signature. The server builds the sections again at send time.
- Recipients are checked on the server (`src/domain/report-email.ts`). Each address must be in a domain from *Rapor e-postası → Şirket içi e-posta alan adları* (exact match) or in the sender address's domain. An address on any agency's To or CC list is always refused. New settings group *Reports* with `reports.internalDomains` (new `domainList` kind) and `reports.defaultRecipients`; the template is the new `REPORT` email template, whose body is the intro (placeholder `{date}`).
- Section contents. *Requested refunds*: open B/Ls with at least one refund request. *Remaining deposits*: open balance per agency and currency, with totals per currency; the CSV lists the B/Ls. *Collected*: confirmed allocations whose refund value date falls in the period, per B/L, with the B/L's deductions and write-off. *Problems*: open and disputed deductions, failed sends, and B/Ls waiting longer than the last aging bucket edge. "Waiting longest" therefore follows `durations.agingBucketEdges` rather than a separate setting.
- The email is an `emails` row without an agency or request rows, plus a `report_emails` row with its sections and filters. It goes through the request send job unchanged: retries, dry-run, `.eml`, sent-folder copy. The CSV attachments are stored as generated documents owned by the email. The audit entry `report.email` holds sections, filters, recipients and subject.
- The Reports screen lists the last ten report emails with their status, so a failed send is visible to everyone.
- A colleague's reply to a report arrives in the shared mailbox like any unknown message, and shows unmatched under Replies.

**Oct 31, 2026 — build step 7b (CSV export and copy), v0.7.1**

- Every shared table has "CSV indir" for the current view (visible data columns in their order, column filters, table search and sort; action columns left out). Every shared table also selects rows, and the selection bar offers "Kopyala" (tab-separated, header row included, rows in the order shown). Cells use the same display text as search and filters.
- The serializer (`src/lib/csv.ts`) is pure and shared: tables export on the client, reports and the 7c email attachments on the server. Text Excel would run as a formula (leading `=`, `+`, `@`, or `-` not followed by a number) gets a leading apostrophe.
- Aging and scorecard download from `/api/reports/<name>`, laid out for Excel: separate amount and B/L-count columns per aging bucket, and an amount and a rate column per deduction type.
- Amount columns in the accountant's payment and refund lists and in refund allocation now show the number with a separate currency column, like All B/Ls, so exported amounts stay numbers in Excel.
- Copying works over plain HTTP: the office LAN is not a secure context, so without the Clipboard API the copy command is used. This also fixes the existing B/L-number copy button.
- The due-requests list is a grouped work list, not a shared table, and has no export. Its B/Ls can be exported from All B/Ls.

**Oct 31, 2026 — build step 7a (dashboard, reports), v0.7.0**

- Dashboard as described under Screens: open balance and collected this month per currency, and three columns of counts that open their lists. A count whose list the viewer may not open is left out. Problem counts open All B/Ls filtered by status (`/bls?status=…`); a table opened with such a filter does not save the user's layout during that visit.
- Reports screen with aging and agency scorecard, visible to all roles (`report.view`). Open balance (aging, scorecard, dashboard) is what is still to be collected: the expected amount plus unexplained or disputed deductions. Aging buckets come from `durations.agingBucketEdges`. Scorecard averages (business days from payment to the last confirmed refund, request attempts) cover closed B/Ls that received a refund; deduction rates by type and write-offs are shares of the deposits of closed B/Ls.
- Refund allocation shows the refunds whose rest was left unallocated with a reason; the dashboard's "unallocated amounts" count opens it.
- Remaining parts of step 7: 7b CSV download and clipboard copy, 7c report email, 7d notes, mentions, notifications and weekly summary, 7e inline editing and remaining keyboard shortcuts.

**Oct 30, 2026 — report email for operations planned**

- New: an on-demand report email that operations sends to internal addresses (Reports and exports → Report email): four selectable sections, agency/currency/date filters, summary tables in the body and CSV attachments, preview before sending, internal domains enforced on the server. New settings group *Reports*. Planned as build step 7c; the later parts of step 7 move to 7d and 7e.

**Oct 30, 2026 — remote updates decided**

- Updates come from GitHub Releases of a public repository, checked daily by the app, started by an admin, verified by signature, applied by `start.cmd` at the next start with automatic rollback (Technical decisions → Updates). Alternatives considered: manual zip only (kept as fallback), fully automatic installs (a bad release would stop daily work unnoticed), installer frameworks (ruled out), building on the PC (needs a toolchain there), remote desktop/VPN (deferred). Built in build step 8 with the portable zip.

**Oct 30, 2026 — build step 6d (opening balances), v0.6.2; build step 6 complete**

- Opening-balance form as described under Migration (admin only; rules 7, 11 and 12 exceptions as stated). No new table: the B/L, its `OPENING_BALANCE` entry, the receipt owned by the B/L and one request row hold the record; the audit row keeps the note (e.g. the Excel line).
- Request attempts count as the highest attempt number sent rather than the number of sent rows (the same for B/Ls created in the app), so a migrated B/L continues with the next number.
- A B/L's deposit receipt is its payment's, or for a migrated B/L its own; requests attach it, and it is renamed "Dekont <B/L>" like the other files.
- Header: the admin pages (settings, templates, holidays, lists, users, write-off approvals, opening balance) moved into one "Yönetim" menu, which carries the write-off badge, because the header no longer fit a desktop screen for users with admin and operations roles.

**Oct 30, 2026 — build step 6c (undo), v0.6.1**

- Undo as described under Undo: one server entry point checks ownership, the window setting, the original action's permission and "not undone yet", then runs the compensation registered for that action. Only the listed actions are registered, so rule 17's exclusions hold by construction.
- Replies, email links and documents gained set-once undo flags; every query of replies or links "in effect" skips undone ones, and the current form skips withdrawn uploads. Linking an unlinked pair again reactivates it (the audit log keeps both steps); an undone accepted match is offered again.
- Statement deductions record the ledger entries they wrote, so their undo compensates exactly those.
- Undo of a status change is a lifecycle rule (new table row): back to the status before the action, only from where the action left the B/L, and only for the moves of a *not yet returned* reply or a settling statement.
- Classifications and disputes are not undoable (they are not in the list); a mistaken one is fixed by an admin reversing the allocation it belongs to, which removes it with the allocation.

**Oct 30, 2026 — deposit receipts may follow later; versioning**

- Rule 12 relaxed for deposit payments (refunds and opening balances unchanged): a bank payment or offset can be saved without its receipt or invoice, and its B/L created. The accountant who entered it (Accounting list) or operations (B/L detail) attaches it later, at any time while the payment is active, also after requests went out; the file then takes the B/L's name and later requests attach it. A replacement goes through a payment correction.
- The due list marks such B/Ls ("Dekont yok"); the email preview lists them and sends only after the user confirms sending without that attachment (the server refuses otherwise).
- Versioning decided: SemVer from `package.json`, starting at 0.6.0 (build step 6); 1.0.0 at go-live. Shown in the header and logged at start; the health page and zip name follow in build step 8.

**Oct 30, 2026 — build step 6b (deductions, disputes, write-offs, statement requests)**

- Deductions from a statement are entered per B/L (B/L detail, or the Replies screen after a *deduction statement received* reply) while it is `REQUESTED` or `AWAITING_RETURN`: one or more lines with a real type (not the system types) and the statement, which is a new upload, a statement already on the B/L, or an attachment of an agency email linked to it. They lower the expected amount and change no status, unless they take the whole deposit (e.g. the agency applied it to one of its invoices): then the B/L is `COLLECTED` without a refund, by rule 1 (classified deductions = deposit), not written off. They can never exceed what is still expected.
- An unexplained shortfall is classified by replacing it with one or more real-type deductions that add up to it exactly (statement optional); they keep the allocation they came with, so a reversal still removes them. With no unexplained deduction left and the balance closed, the B/L moves to `COLLECTED` (rules 1, 4).
- Disputes: operations disputes the unexplained deduction with a note (`DEDUCTION_OPEN` → `DISPUTED`); the flag is set once on the ledger entry. Clearing the dispute means accepting the deduction: it is classified as above with a mandatory note (`DISPUTED` → `COLLECTED`). If the agency pays the difference, the refund is allocated to the disputed B/L for exactly the disputed amount (no partial payment, no new difference on it); the disputed deduction is compensated under that allocation and the B/L is `COLLECTED`. Reversing that allocation enters the disputed deduction again and returns the B/L to `DISPUTED`. Allocations on one B/L are reversed newest first.
- Write-offs live in their own `write_offs` table instead of an `approved_by` column on the ledger: operations proposes one with a reason for what the B/L still lacks (the expected amount plus unexplained or disputed deductions); nothing changes until an admin approves it on the new *Silme onayları* page (menu badge shows waiting proposals). Approval replaces the unexplained deductions by one `WRITE_OFF` deduction and closes any open B/L; it is refused if the B/L changed since the proposal (the admin rejects with a reason and operations proposes again). Rejection changes nothing.
- Deduction-statement requests: a `DEDUCTION_OPEN` B/L with an undisputed unexplained deduction is due for a statement request the statement-request delay after the shortfall was confirmed, then after the statement follow-up interval since the last statement request or a later reply (both overridable like the other timings, upcoming window shared). They appear in the due list with their own badge and the deduction as amount, need no uploaded form, always go by email (also for portal agencies), change no status, and count attempts separately. One new template, `DEDUCTION_STATEMENT`, serves the first request and follow-ups; follow-ups reply in the statement thread. Batch agencies get refund and statement first requests in one email, each in its section; a statement line shows the deduction as its amount.
- Statement files are uploaded with the document kind `DEDUCTION_STATEMENT` and kept on the B/L.

**Oct 29, 2026 — build step 6a (refunds and allocation)**

- Step 6 is built in parts: 6a refunds and allocation, 6b deductions from statements, disputes, write-offs and deduction-statement requests, 6c undo, 6d the opening-balance form.
- Refunds are entered on the Accounting screen (new refund, my refunds) like payments: receipt or invoice mandatory, duplicate warning, correct or void own records only while nothing is allocated. Their status is computed: not allocated, partly allocated, allocated, or remainder left (with the reason operations gave).
- Allocation candidates are B/Ls in `REQUESTED` or `AWAITING_RETURN` of the refund's agency and currency, with a request sent on or before the value date and something left to collect. The review is a page of its own (Refund allocation → a refund): suggestion cards fill an editable split.
- A B/L is refunded in one go: on confirmation, each B/L's amount plus a difference it bears must equal its expected amount. One confirmation has at most one difference row; it becomes a `SHORTFALL` deduction of the chosen type. `UNEXPLAINED` leaves the B/L `DEDUCTION_OPEN`, any other type closes it. `WRITE_OFF` cannot be chosen as a difference (it needs its own admin approval, 6b). Money left over needs a reason.
- An admin reversal compensates the allocation and the difference deduction confirmed with it, returns the B/L to its status before the allocation and reopens the refund's remainder.
- Deduction types are a configurable list like reply types (seed: demurrage/detention, other, and the system types unexplained and write-off).

**Oct 29, 2026 — build step 5 (agency replies)**

- The poller reads the inbox folder (new setting, seed "INBOX") read-only over IMAP, every poll-interval minutes; a development install reads a test mailbox the same way, since reading never changes it and sending stays in dry-run. Messages are imported only when they reply in a known thread or name an open B/L; everything else is not stored.
- Reply types carry a system code. A fourth seed type, *info only / no action* (Bilgi / işlem gerekmez), marks auto-replies and acknowledgements as processed without restarting the follow-up clock.
- Replies are stored in their own `replies` table (one per email and B/L), not on `requests`; an email is processed when every linked active B/L has one. A reply can also be recorded without an email from the B/L detail; replies need at least one sent request on the B/L.
- Follow-ups reply to the latest message of the B/L's thread — our last request or a later linked agency email — and quote it, like Reply all in Outlook.
- A possible match can be dismissed. Accepting a match or linking a mailbox message by hand gives the email its agency.
- The Replies menu badge counts unprocessed replies and turns red once any is past the warning days (seed 1 business day, counted from the day it arrived). The daily email lists only those past the warning.
- Imported files (raw `.eml`, attachments) have no uploader; `documents.uploaded_by` is null for them.
- List details open in a large centered dialog instead of a right-side panel that narrowed the table; previous/next (buttons or ← / →) follow the list's current order. On the Replies screen, the next unprocessed reply opens once the current one is fully processed.
- Histories (B/L timeline, email thread, recorded replies, ledger, documents, the Replies screen) list the newest entry first. Work lists (due requests, payments awaiting a B/L, the receipt review queue) stay oldest first, since the oldest item is the most urgent.
- `AWAITING_RETURN` is shown as "Konteyner dönüşü bekleniyor" (was "İade bekleniyor", which read like waiting for the refund). After a *not yet returned* reply the B/L returns to the due list once the follow-up interval has passed since the reply.

**Oct 25, 2026 — test feedback on build step 4**

- Accountants see the due-requests list and the payments awaiting a B/L read-only; sending, forms, portal records and B/L creation stay with operations.
- A B/L's own files are named after it: the uploaded signed form becomes "İade formu <B/L>.<ext>" and its payment's receipt or invoice "Dekont <B/L>" / "Fatura <B/L>", also when the B/L number is corrected later. Agencies receive these names; the uploaded name stays in the audit log. Generated forms are named "İade formu <B/L>.docx". The name prefixes live in the locale file.
- The `PAID` status is shown as "Depozito yatırıldı" (was "Ödendi", which read like a refund paid to us).
- Follow-ups keep replying in the thread of the earlier request email (confirmed), and now quote it below the new text the way Outlook does on "Reply all": a REPLY\_QUOTE header (Özgün İleti, Kimden, Gönderildi, Kime, Bilgi, Konu; editable template) followed by the earlier email's text, which carries its own quotes, so the whole chain is readable in each follow-up. The quote is part of the editable preview and of the stored body.

**Oct 24, 2026 — build step 4 (B/L screens, forms, requests, email)**

- Routes: `/bls` is the All B/Ls screen, `/bls/new` creates B/Ls, `/bls/<id>` is the B/L detail. The temporary "created B/Ls" tab of step 3 is gone; edit and void live on All B/Ls and the detail.
- Ledger amounts are positive for every type; only compensating entries are negative. Entries left in an old currency by a currency correction must cancel out exactly.
- "Business days waiting" counts business days since payment while the B/L is open.
- A system note such as a confirmed duplicate warning is stored as a flag in the audit row, not as a reason; reasons are user text.
- A `REQUESTED` B/L with no recorded reply becomes due for a follow-up once the follow-up interval has passed since the last request.
- Batched follow-ups reply in the existing thread when all selected B/Ls share it; otherwise one reply is sent per thread.
- Standing documents are attached to every request by default (rule setting, seed on).
- Due lists: a B/L is *upcoming* while at most the "upcoming" number of business days remain before its due date, and *due* from that date on. A request can be sent or recorded only while the B/L is due or upcoming (rule 9). Portal agencies file only the first request on the portal; it is recorded with the filing date (not in the future, not before payment) and counts as attempt 1.
- Request-timing overrides per B/L (admin, on the B/L detail) resolve B/L → agency → global, like `getSetting`.
- Email sending: preparing a request email locks its B/Ls for the drafting user (draft lock timeout setting); others see a lock badge. The server rebuilds the draft when the email is sent, so due state, form, recipients, threading and attachments are checked again; the user can edit recipients, subject and body and remove attachments, but cannot add files. A sender address must be set. Requests count as sent (B/L → REQUESTED, follow-up clock from the send date) only when the send job succeeds; in dry-run the message is stored as `.eml` and counts as sent, with a "dry-run" note on the timeline, but never reaches a mail server.
- The email settings group holds the server, sender, sent folder, poll interval, default CC/BCC, signature and attachment limit (seed: Yandex hosts and ports, sent folder "Sent", 5 minutes, 25 MB); an admin can send a test email. A mail outage banner shows since when SMTP or IMAP is unreachable; a dry-run banner shows outside live mode.
- Agency form templates: an admin uploads the `.docx` on the agency card; templates with unknown placeholders, loops or broken syntax are refused with the offending tags listed. Tags are read from the template's full text, so a placeholder Word splits across formatting runs still works.

**Oct 24, 2026 — form filling decisions**

- Form generation library approved: docxtemplater + pizzip.
- `{bank_name}` / `{iban}` use the single active bank account in the B/L's currency; none or several → fields left blank with a warning on download.

**Oct 22, 2026 — bank accounts only for forms**

- Payments and refunds no longer record which of our bank accounts was used; accounting entries do not ask for one.
- The bank account list stays (admin, Lists) only to fill `{bank_name}` / `{iban}` in agency refund forms.
- Migrations switch foreign keys off around the migration transaction and run `foreign_key_check` afterwards, so table rebuilds work on databases that already hold referencing rows.

**Oct 22, 2026 — build step 3 (payments, B/Ls, corrections)**

- Seed lists: currencies USD and EUR; bank accounts are added by an admin (IBAN checked). v1 assumes two decimal places for every currency.
- Receipt parser stays a stub until real samples arrive; bulk uploads go through a `receipt_queue` table.
- B/L numbers unique among active B/Ls across agencies; container numbers in ISO 6346 form, check digit as a warning; payment dates not in the future.
- Ledger is append-only with compensating entries; entries carry their currency; a payment correction moves its active B/L along.
- Accountants correct and void their own payments; admins may void any (after the B/L is voided).
- The B/L creation screen lists created B/Ls (edit, void) until the All B/Ls screen arrives in step 4.
- Uploads go through `/api/uploads`, which bypasses the proxy (large bodies) and checks the session and `can()` itself; files are served by `/api/files/<id>` to signed-in users.

**Oct 22, 2026 — build step 2 (settings, calendar, agencies)**

- Overridable settings limited to the five request-timing durations; agency overrides are admin-only.
- Reasons are optional for settings, override and holiday changes.
- Settings impact preview moves to step 4; email, template, notification and list settings arrive with their features (steps 4–6).
- Business-day engine conventions documented (n-th business day after; counts after a up to and including b; Istanbul "today").
- B/L number pattern rules documented; holidays can be edited or removed; agencies get an active flag.
- JPEG added next to JPG in the allowed file types.
- `pnpm build` fails if runtime data (data folders, SQLite, key or lock files) appears in the build output.

**Oct 22, 2026 — implementation kickoff**

- Login uses username + password instead of email + password; the app runs only on the office LAN.
- Document moved to `docs/ARCHITECTURE.md`.
- B/L lifecycle transition table written and approved; `DUE` is computed on read and never stored.
- Operations can no longer correct a deposit's amount or currency; only the accountant corrects money records.
- Invariant 7: opening-balance records are entered by an admin as a stated exception.
- Refund status is computed from allocations, not stored.
- Backup time, backup retention and failed-login lockout are settings (Backups and Users groups).
- Stack additions: Node.js 24 LTS (development and portable runtime), `@node-rs/argon2`.
- Build step 1: Cache Components off; locked accounts stay locked until an admin unlocks or resets them; at least one active admin is kept; minimum password length is a setting (seed 8); `sessions` and `user_roles` tables documented; table layout preferences are not audited; logging uses in-process streams.

**Oct 22, 2026 — usability review**

- Added All B/Ls screen and global search.
- Added CSV export and clipboard copy on every table; `.xlsx` deferred.
- Added dual-role continuous payment → B/L flow, bulk receipt upload with review queue, B/L number extraction from receipts with agency patterns, accountant B/L hint, bulk B/L creation.
- Replies are read and processed in the app with quick buttons; added unprocessed-reply badge and optional daily email.
- Added voiding and corrections with reason, admin-approved write-off (`WRITE_OFF` system type), and undo window. New invariants 15–17; invariants 1, 5, 6, 7, 9, 11, 12 adjusted.
- Added per-agency Word form templates with prefilled form download.
- Added keyboard shortcuts, bulk actions, inline editing of permitted fields and per-user table layout.
- Deployment unchanged; phone follow-up logging and migration tooling not planned.