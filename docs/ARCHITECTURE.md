# Container Deposit Refund Tracker — Architecture

Oct 20, 2026 · updated Oct 24, 2026 (see Change log)

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
- **Secrets:** SMTP/IMAP credentials stored encrypted; the encryption key lives in a key file outside the data folder, never in the database or in backups; a copy is kept offline in a safe place.
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
| Jobs | In-process scheduler with a `jobs` table (run\_at, attempts, status). Send jobs retry 3 times with backoff, then mark the request failed. IMAP polling runs on the poll-interval setting. On start, overdue jobs run once to catch up |
| Mail outage | If SMTP or IMAP is unreachable, a banner on every screen shows since when; queued sends wait and retry; nothing is lost |
| Receipt parsing | pdfjs-dist text extraction plus one parser module for the bank's layout, covered by tests with real sample receipts. Extracts name, amount, currency, date and, for outgoing payments, B/L number candidates from the transfer description |
| Form generation | Agency form templates are `.docx` files with placeholders, filled server-side by docxtemplater + pizzip (approved Oct 24, 2026) |
| Exports | CSV generated without extra dependencies: UTF-8 with BOM, semicolon separator, Turkish number and date formats, so Turkish Excel opens it directly. Clipboard copy uses tab-separated values |
| Exact-subset search | Backtracking over candidates sorted oldest first, pruned by remaining amount; capped at the 30 oldest candidates and 500 ms. When the cap is hit, the screen says the search was incomplete |
| Testing | Vitest for unit and domain tests; Playwright for a small set of end-to-end flows (create B/L, send request, allocate refund, bulk reply) |
| Logging | pino structured logs to daily rotating files in the data folder, kept 30 days; streams run in-process (no worker-thread transports) so the standalone build is self-contained |
| Rendering | Next.js Cache Components are off: every screen is session-bound and shows live data, so pages render dynamically on each request |
| Packaging | pnpm for development. `pnpm build:portable` produces one zip: a portable Node.js runtime, the Next.js standalone build with prebuilt native modules for Windows x64, and start/stop/backup/create-admin `.cmd` scripts |

## Roles and permissions

Money enters the system through the accountant role; money is attributed to B/Ls through the operations role. A user may hold both roles; every action is logged under the person who did it and the role used.

| Role | Can do | Cannot do |
| --- | --- | --- |
| Accountant | Open outgoing deposit payment records by uploading bank receipts (one or many at once) or, for offsets, the invoice. Enter incoming refunds and offsets. Correct or void own money records with a reason while they have no confirmed allocation. Optionally note a B/L number on a payment as a hint. | Create or edit B/Ls (sees linked B/L numbers read-only, with a copy button), allocate refunds, record deductions. |
| Operations | Create B/Ls from payment records (one at a time or in bulk), edit B/Ls and containers, void a B/L created with wrong data while it has no confirmed allocation, write notes with @mentions, generate and upload forms, send requests, record portal requests, record agency replies (also in bulk), record deductions, allocate refunds, mark disputes, undo own recent actions. | Create or correct money records, including a deposit's amount or currency (the accountant corrects the payment record and the B/L follows). |
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
| `REQUESTED` / `AWAITING_RETURN` | `DEDUCTION_OPEN` | Confirmed allocation leaves a shortfall marked `UNEXPLAINED` |
| `DEDUCTION_OPEN` | `COLLECTED` | Every `UNEXPLAINED` deduction replaced by a real type, and the balance closes |
| `DEDUCTION_OPEN` | `DISPUTED` | A deduction is marked disputed |
| `DISPUTED` | `COLLECTED` | Difference paid (allocated) or dispute cleared with a note, and the balance closes |
| any open status | `COLLECTED` | Admin approves a `WRITE_OFF` deduction that closes the balance |
| `COLLECTED` / `DEDUCTION_OPEN` / `DISPUTED` | status before the allocation | Admin reverses a confirmed allocation; status is recomputed from the remaining history |

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
12. Every bank payment and bank refund record requires an uploaded bank receipt; every offset record requires the uploaded invoice; every opening-balance record requires the original deposit receipt.
13. A deposit's amount or currency cannot change while it has a confirmed allocation.
14. A refund request cannot be sent or recorded for a B/L without an uploaded form (when the corresponding rule setting is on), and a B/L being drafted by one user is locked for others.
15. Records are never deleted. Payments, refunds and B/Ls can only be voided, with a reason, and only while they have no confirmed allocation; voiding a payment requires its B/L to be voided first.
16. A write-off requires an admin approval and a reason.
17. Undo creates compensating entries, never deletes rows, and never applies to confirmed allocations, sent emails, money records, write-offs or settings.

## Data model

The B/L is the central entity; money moves are ledger rows; emails relate to B/Ls many-to-many. Nullable override columns on `agencies` and `bills_of_lading` mean "inherit from the level above". Voidable tables carry `voided_at`, `voided_by` and `void_reason`.

| Table | Purpose | Key fields |
| --- | --- | --- |
| `agencies` | Shipping lines / agencies | name (unique, case-insensitive), active, email recipients (one to/cc list for all request types), bank sender aliases, bl\_number\_patterns (list of regular expressions), form\_template\_file\_id, batch\_sending (bool), request\_channel (EMAIL, PORTAL), portal\_url, nullable setting overrides, notes |
| `deposit_payments` | Outgoing deposit, opened by accountant from a receipt or invoice | agency\_id, amount, currency, paid\_at, kind (BANK, OFFSET), evidence\_file\_id, extracted\_fields (json), extracted\_bl\_numbers (json list), bl\_no\_hint (accountant note), void fields |
| `bills_of_lading` | One deposit per B/L, created from a deposit payment | bl\_no, deposit\_payment\_id (unique among non-voided; null only for migrated records), agency\_id, currency, deposit\_amount, paid\_at, status, locked\_by, locked\_at, nullable setting overrides, void fields |
| `containers` | Containers under a B/L | bl\_id, container\_no, type |
| `ledger_entries` | Every money movement on a B/L (B/L level only); append-only: a correction writes a compensating entry (negated amount, `compensates_entry_id`) plus a new entry, and an entry can be compensated once. Amounts are positive for every type (payments, deductions and allocations alike); only compensating entries are negative | bl\_id, type (PAYMENT, OFFSET, DEDUCTION, REFUND\_ALLOCATION, OPENING\_BALANCE), amount (signed), currency, deduction\_type\_id, deduction\_source (STATEMENT, SHORTFALL, WRITE\_OFF), disputed (bool), dispute\_note, approved\_by (write-offs), amount, date, source refs, compensates\_entry\_id (undo) |
| `refunds` | Incoming money entered by accountant | agency\_id, amount, currency, value\_date, kind (BANK, OFFSET), evidence\_file\_id, unallocated\_reason, void fields. Status is computed from confirmed allocations, never stored: `OPEN`, `PARTIALLY_ALLOCATED`, `ALLOCATED`, or remainder left unallocated with a reason |
| `refund_allocations` | Split of a refund over B/Ls | refund\_id, bl\_id, amount, state (CONFIRMED, REVERSED), confirmed\_by, reason |
| `requests` | Each request cycle | bl\_id, type (REFUND, DEDUCTION\_STATEMENT), channel (EMAIL, PORTAL), email\_id (null for portal), portal\_ref, requested\_at, reply\_type\_id, replied\_at, attempt\_no, send\_status |
| `emails` | Sent messages and in-thread replies | direction, message\_id, in\_reply\_to, thread\_key, from, to, cc, subject, body as sent, sent\_at, raw\_file\_id, processed\_at |
| `email_bl_links` | Many-to-many emails and B/Ls | email\_id, bl\_id, linked\_by (THREAD, SUGGESTION, MANUAL) |
| `documents` | Uploaded and generated files, stored under the data folder as `files/YYYY/MM/<uuid>.<ext>` | owner type/id (null until attached), kind (FORM, FORM\_TEMPLATE, GENERATED\_FORM, RECEIPT, INVOICE, DEDUCTION\_STATEMENT, STANDING, OTHER), original name, stored path, MIME type, size, SHA-256, uploaded\_by |
| `receipt_queue` | Review queue for bulk receipt upload | document\_id, extracted fields, created\_by, resolution (SAVED, DISCARDED), payment\_id |
| `notes` | Team notes on a B/L | bl\_id, author\_id, body, mentioned user ids, created\_at |
| `notifications` | In-app notifications | user\_id, kind (MENTION, CORRECTION, UNPROCESSED\_REPLY, WRITE\_OFF\_APPROVAL, ...), entity, read\_at |
| `user_preferences` | Per-user UI state (not audited) | user\_id, key (e.g. table id), value (json: columns, order, sort, filters, density) |
| `settings` / `settings_history` | Typed global settings and their change log | key, value (json), type, validation, old/new value, changed\_by |
| `holidays` | Business-day calendar | date (unique), name, kind (FULL, HALF) |
| `email_templates` | Turkish templates with sections for batched emails | key, subject, body with placeholders and section blocks |
| `deduction_types`, `reply_types`, `bank_accounts`, `currencies` | Configurable lists | name, active, sort order |
| `users`, `user_roles`, `audit_log` | Users with one or more roles; every state change | username (unique, case-insensitive), display name, password hash, must\_change\_password, active, failed\_login\_count, locked\_at; user\_id + role; actor, role used, action, entity, before/after, reason, undo\_of, at |
| `sessions` | Login sessions | id (SHA-256 of the cookie token), user\_id, created\_at, last\_seen\_at, revoked\_at |

`UNEXPLAINED` and `WRITE_OFF` are system deduction types: they can be relabelled but never deleted, and `UNEXPLAINED` can be replaced by a real type. Allocation suggestions are computed on screen and not stored; only confirmed allocations become rows. Seed reply types: *container not yet returned*, *approved, payment to follow*, *deduction statement received*.

## Settings system

Every duration, threshold, template and list is editable in a Turkish settings panel; code reads values only through `getSetting(key, { agencyId?, blId? })`.

**Resolution:** B/L override → agency override → global setting. A null override inherits. Initial values come from a seed file loaded at install, not from code.

**Dates are computed, not stored.** Due dates are derived on read from events + current settings, so a settings change applies to all open B/Ls immediately. There are no manual date overrides in v1.

**Business-day engine:** one module, `addBusinessDays(date, n)` / `businessDaysBetween(a, b)`, driven by the weekend-days setting and the `holidays` table. `addBusinessDays(d, n)` is the n-th business day after `d` (`n = 0` returns `d`); `businessDaysBetween(a, b)` counts business days after `a` up to and including `b` (negative when `b` is earlier), so the two are inverses. Half days (arife) count as business days only when the calendar setting says so. "Today" is the Europe/Istanbul date. Every duration declares its day type; v1 uses business days for all app reminders. Calendar days are reserved for any future demurrage logic.

**Impact preview:** before saving a change, the panel shows how many B/Ls move into or out of each list (e.g. "14 B/Ls become due today"). Built in step 4 together with the due-requests list.

**Overrides:** only the request-timing durations are overridable per agency and per B/L: first request due, "upcoming" window, follow-up interval, statement request delay, statement follow-up interval. All other settings are global. Agency overrides are set by an admin. A reason can be given with any settings, override or holiday change (optional) and is stored in the audit log and settings history.

| Group | Settings |
| --- | --- |
| Calendar | Weekend days; holiday list (date, name, full/half day); whether half days (arife) count as business days; bulk holiday entry per year |
| Durations (business days) | Days after payment until first refund request is due; days in advance a B/L shows as "upcoming"; days between follow-ups after "not yet returned"; days after an unexplained deduction until the statement request is due; days between statement-request follow-ups; days before an unprocessed agency reply raises a warning; aging report bucket edges |
| Notifications | In-app notifications always on; which events notify (unprocessed reply, correction, mention, write-off approval); daily unprocessed-reply email on/off, time and recipients; weekly summary email on/off, its weekday, time and recipients |
| Email server | SMTP/IMAP host, port, encryption, user, encrypted app password; sent-folder name; IMAP poll interval; sender display name; default CC/BCC; signature; max attachment size; send-test button |
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
| Reply types | Container not yet returned; Approved, payment to follow; Deduction statement received |
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
| Duplicate-record warning | On |
| Daily backup time | 12:30 |
| Backup copies kept | 14 daily / 8 weekly |

### Email template drafts (Turkish)

Starting texts; editable in settings. Placeholders: `{agency_name}`, `{bl_no}`, `{containers}`, `{amount}`, `{currency}`, `{attempt_no}`, `{portal_ref}`, `{deduction_amount}`, `{signature}`.

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

In a batched email, `{bl_no}` in the subject lists all B/L numbers; each section line shows B/L number, containers, amount and currency, and an empty section is left out.

### Form template placeholders

Agency form templates (`.docx`) may use: `{agency_name}`, `{bl_no}`, `{containers}`, `{container_count}`, `{amount}`, `{currency}`, `{paid_at}`, `{bank_name}`, `{iban}`, `{today}`. Unknown placeholders are reported when the template is uploaded.

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

The IMAP poller reads new messages read-only and tracks processed UIDs in the database. Only replies in a known thread are imported: a message whose `In-Reply-To`/`References` points to a stored sent message, or to a manually linked message, is linked to that message's B/Ls with certainty. Everything else in the mailbox is ignored.

- **Match suggestions:** a new message that is not in a known thread but contains the number of an open B/L in its subject or body is listed under "possible matches" with that B/L. It is linked only when a user accepts it with one click.
- **Manual link:** when an agency answers with a new email that has no recognisable B/L number, a user can search the shared mailbox from the B/L detail (by sender and subject) and link the message by hand.
- **Unprocessed warning:** a linked reply without a recorded reply type after the configured number of business days appears on the dashboard, in the menu badge, in the optional daily unprocessed-reply email and in the weekly summary.

**Replies are read in the app.** The Replies screen shows the full message and its attachments, so the team reads agency replies there instead of in Outlook. The app never interprets the reply. An operations user records the reply type per linked B/L with quick buttons (one reply to a batched email may cover several B/Ls with different answers; one click can apply the same type to all). Attachments are saved as documents on the linked B/Ls. A reply of type *deduction statement received* lets the user record the deductions right away.

**Daily unprocessed-reply email (optional):** when enabled, a short internal email at the configured time lists the number of unprocessed replies per agency with a link to the Replies screen. It is sent only to the configured internal recipients and only when there is at least one unprocessed reply.

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

**Undo.** A user can undo their own recent action within the undo window: a recorded reply type, a deduction from a statement or shortfall assignment before confirmation, an email-to-B/L link, a note, a form upload, a container edit or an inline field edit. Undo writes a compensating entry and an audit row referencing the original. Confirmed allocations, sent emails, money records, write-offs and settings cannot be undone this way.

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

## Screens

Desktop-only, dense tables with a wide right-side detail panel. There is no per-user assignment: operations works from a shared pool, and a B/L being drafted by one user shows a lock badge for others. A user with both roles sees both menus.

**Everywhere**

- **Global search** in the header (shortcut `/` or Ctrl+K): finds B/Ls by B/L number, container number, agency name or amount; pasting several B/L or container numbers lists all matches at once; Enter opens the B/L detail.
- **Keyboard shortcuts:** arrow keys to move between rows, Enter to open detail, Esc to close the panel, `R` record reply, `N` add note, `/` search, `?` shows the shortcut list.
- **Bulk actions** on every list: select rows, then record the same reply type, prepare sending, add a note or copy. Every bulk action shows a confirmation with the affected B/Ls before it runs.
- **Inline editing** of permitted fields directly in table cells (B/L number before any request is sent, containers, notes, agency contact fields). Money fields and statuses are never inline-editable. Every inline edit goes through `can()`, validation and the audit log, and can be undone within the undo window.
- **Personal table layout:** column choice, order, sort, filters and density are remembered per user and table.
- **Unprocessed replies badge** on the Replies menu item.

| Screen | Role | Contents |
| --- | --- | --- |
| Dashboard | Operations | Top: open balance per currency and collected this month. Three columns with counts that open filtered lists: today's work (due and follow-up requests), pending matches (payments without B/L, refunds to allocate, unprocessed replies, unallocated amounts, write-offs awaiting approval), problem B/Ls (deduction open, disputed) |
| All B/Ls | All (accountant read-only) | One dense table of every B/L: B/L no, agency, status, paid date, deposit, currency, expected amount, collected, attempts, last reply, business days waiting (since payment, while the B/L is open). Filter and sort on every column, "show voided" filter, CSV download and copy, detail panel on the right |
| Due requests | Operations | Tabs: due (today and overdue), upcoming, failed to send. Grouped by agency with batch type, channel, B/L count and totals per currency. Rows: select, B/L no, paid date, business days waiting, attempt no, last reply, amount, form status with "download prefilled form" and drag-and-drop upload; a B/L without form cannot be selected. Request type badge. Actions: prepare email, record portal request, record reply |
| B/L detail | Operations | Header: B/L no, agency, status, balance strip (deposit, collected, deductions, remaining). Sections: summary with containers and source payment, timeline, email threads, documents, ledger, notes with @mentions, setting overrides. Actions: download prefilled form, record reply, add deduction from statement, mark dispute, propose write-off, link email from mailbox, void B/L |
| Create B/Ls | Operations | Table of payments without a B/L, prefilled with agency, amount, currency and B/L number candidates; type or paste B/L numbers and containers; save all valid rows at once |
| Refund allocation | Operations | Left: refunds awaiting allocation. Right: suggestion cards (exact subset, FIFO) with their difference; chosen suggestion opens an editable allocation table with running total and remainder; difference row assigns B/L and type. Confirm only when remainder is zero or left unallocated with a reason |
| Replies | Operations | Tabs: to process, possible matches, processed. Full message with attachments and its linked B/Ls; quick reply-type buttons per B/L and "apply to all"; enter deductions from a statement; save attachments as B/L documents |
| Agencies | Operations | Card: name, bank sender aliases, B/L number patterns (with a test field), one recipient list, batch/single sending, request channel and portal link, form template (admin uploads, shows placeholder check), setting overrides with impact preview, open B/Ls, scorecard summary, notes |
| Accounting | Accountant | New deposit payment (single, or drop several receipts into the review queue), new refund (receipt or invoice mandatory, prefilled from a PDF receipt, duplicate warning). List of own records with status, linked B/L numbers (read-only, copy button), correct and void actions. For dual-role users, saving a payment continues to B/L creation |
| Reports | All | Aging, agency scorecard, with CSV download |
| Settings, users | Admin | As in the Settings section, with impact preview; standing documents upload; write-off approvals |

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
| Updates | Download the new release zip, run `stop.cmd`, replace the `app` folder (keeping the previous one for rollback), run `start.cmd`. The `data` folder is never touched by an update |
| Backups | Daily at a configurable time during office hours (default 12:30), and at the next start if missed: a consistent SQLite backup plus a copy of the files folder, written locally and copied to a second location. Keep 14 daily and 8 weekly copies. Test a restore monthly |
| Health | `/api/health` endpoint; an admin page shows scheduler status, last IMAP poll and last backup time |
| Runbook contents | First setup, configure mail, add users, add an agency form template, update and roll back, back up, restore from backup, move to another PC, back up and restore the key file, what to do when mail is down |

**Open items before go-live**

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

**Migration:** fewer than 50 open Excel records exist. Each is entered by hand through the admin-only opening-balance form when its next request becomes due, using the `OPENING_BALANCE` ledger type, past request count and last request date; the original deposit receipt is mandatory (it is needed for the request anyway). Until then those records stay in the Excel file.

- [x] Export this document to the repo as docs/ARCHITECTURE.md
- [ ] Update `CLAUDE.md` to match this version
- [ ] Define the database schema and migrations
- [ ] Write tests for the business-day engine, allocation algorithm and receipt parser first

## Change log

**Oct 24, 2026 — build step 4 (B/L screens, forms, requests, email)**

- Routes: `/bls` is the All B/Ls screen, `/bls/new` creates B/Ls, `/bls/<id>` is the B/L detail. The temporary "created B/Ls" tab of step 3 is gone; edit and void live on All B/Ls and the detail.
- Ledger amounts are positive for every type; only compensating entries are negative. Entries left in an old currency by a currency correction must cancel out exactly.
- "Business days waiting" counts business days since payment while the B/L is open.
- A system note such as a confirmed duplicate warning is stored as a flag in the audit row, not as a reason; reasons are user text.
- A `REQUESTED` B/L with no recorded reply becomes due for a follow-up once the follow-up interval has passed since the last request.
- Batched follow-ups reply in the existing thread when all selected B/Ls share it; otherwise one reply is sent per thread.
- Standing documents are attached to every request by default (rule setting, seed on).

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