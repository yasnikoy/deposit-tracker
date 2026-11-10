# Container Deposit Refund Tracker — UI structure and conventions

Nov 2, 2026 (after the third UI review) · updated Nov 10, 2026 (Replies screen removed, archived emails, feedback, guide page)

This document fixes how the interface is put together: where things live, which page
patterns exist, which shared components build them, and the visual and wording rules.
`docs/ARCHITECTURE.md` stays the source of truth for *what* each screen does
(ARCHITECTURE → Screens) and for the business rules; this document covers *how* the
screens look and behave.

**Keeping to it.** New screens and changes reuse the patterns and components below. A change
that needs a new pattern, a new component kind, a new colour or a new term is a decision:
ask first, then update this document in the same change (and the ARCHITECTURE change log).
If the code and this document disagree, stop and ask which one is right.

## 1. Principles

- **Faster than Excel.** Dense tables, keyboard first, few clicks; nothing decorative.
- **One way to do a thing.** The same kind of content looks and works the same on every
  screen (tables, forms, dialogs, status chips, amounts, empty states).
- **Fewer elements, fewer steps.** No duplicate headings, no repeated values, no controls a
  user cannot use. Read-only information that is always empty is not shown.
- **One clear primary action per screen or card.**
- **Plain, consistent Turkish.** One term per concept (section 10); all strings in
  `src/i18n/tr.json`.
- **The server decides.** Hiding a control is cosmetic; every action is checked by `can()`.
- Desktop only (Chrome / Edge), from about 1280 px wide. No mobile layout.

## 2. App shell

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ Depozito Takip v0.x  Panel Muhasebe Talepler İade dağıtımı … ⚙ Ayarlar  [Ara… /] 🔔 👤 │  header (sticky)
├───────────────────────────────────────────────────────────────────────────────┤
│ Deneme modu: e-postalar kaydedilir ama gönderilmez.                           │  banners (dry-run, mail outage)
├───────────────────────────────────────────────────────────────────────────────┤
│ Page title                                                                    │
│ …page content, full width…                                                    │
└───────────────────────────────────────────────────────────────────────────────┘
```

- **Header** (`src/components/app-shell/app-header.tsx`): app name and version, the work
  menu, *Ayarlar*, global search (`/` or Ctrl+K), notifications bell with unread count, user
  menu (roles, *Şifre değiştir*, *Klavye kısayolları*, *İlk adımlar*, *Hata bildir / öneri gönder*,
  *Çıkış yap*). The header wraps to a
  second line instead of overflowing; the search box shrinks first.
- **Badges in the menu**: count on *Silme onayları* (write-offs awaiting approval); the bell
  shows unread notifications.
- **Banners** under the header: dry-run mode (outside production) and mail-server outage
  (amber, with since when). Nothing else uses a full-width banner.

### Navigation map

Menu items are defined once in `src/app/(app)/layout.tsx` and shown only when the user's
roles allow them. A user with several roles sees the union.

| Menu item | Route | Shown to | Page type (section 3) |
| --- | --- | --- | --- |
| Panel | `/` | everyone | Dashboard |
| Muhasebe | `/accounting?tab=payments\|refunds\|entries` | accountant | Entry page with tabs |
| Talepler | `/requests`, `?tab=upcoming`, `?tab=failed` | operations (accountant reads) | Grouped work list |
| İade dağıtımı | `/allocations`, review at `/allocations/[id]` | operations | List page → review page |
| B/L'ler | `/bls`, detail at `/bls/[id]` | everyone with B/L access | List page → detail page |
| B/L oluştur | `/bls/new` | operations (accountant reads) | Editable grid |
| Raporlar | `/reports` | everyone with report access | Report page |
| Silme onayları | `/admin/write-offs` | admin | List page |
| Açılış bakiyesi | `/admin/opening-balance` | admin | Entry page |
| Ayarlar | `/settings` and the pages below | everyone | Settings area |
| Bildirimler | `/notifications` (bell) | everyone | Simple list |
| İlk adımlar | `/getting-started` (user menu; opened once at the first visit) | everyone | Guide page |

**Settings area** (`settings-frame.tsx`): a side menu grouped *Kişisel* (Kişisel ayarlar),
*Genel* (Acenteler, Müşteriler) and *Yönetim* (Uygulama ayarları, E-posta şablonları,
Tatiller, Listeler, Kullanıcılar, Sistem durumu, Geri bildirimler). Each user sees only the items their roles
allow. Work screens never go into the settings area, and settings never go into the top menu.

## 3. Page patterns

Every page starts the same way:

1. **Title** — `h1` (`text-lg font-semibold`), the same words as its menu item.
2. **Hint** (optional) — one short line, `text-muted-foreground text-sm`. Details belong next
   to the field or column they explain, not in an intro paragraph.
3. **Tabs** (optional) — see below.
4. **Content** in one of the patterns below. The primary action sits top right (toolbar of
   the table, or the header row) or bottom right of a form.

**Tabs.** Underlined tab bar (`border-b`, active tab `border-b-2 border-primary font-medium`),
with the count in brackets where it helps: *Zamanı gelen (10)*. Page-level tabs are links
with `?tab=` so that the dashboard and bookmarks can open them; old tab names keep working
through a mapping (see `accounting/page.tsx`). Tabs inside a page that hold unsaved input
(Uygulama ayarları) are buttons, and hidden tabs stay mounted so the input survives.
Each tab is one subject: never split "enter X" and "list of X" into separate tabs.

### 3.1 List page

A `DataTable` (section 4) over the full width. A row opens its record: in the **detail dialog**
(`DetailDialog`, large and centered over the list, ← / → for previous and next as sorted and
filtered), or on its own page when the record is a workspace (B/L detail, allocation review).
Toolbar left: table search, *Filtre*, *Sütunlar*, *CSV indir*; right: screen toggles
(e.g. *Sadece benimkiler*, *İptal edilenleri göster*) and the primary *Yeni …* button.
Examples: B/L'ler, İade dağıtımı, Acenteler, Müşteriler, Kullanıcılar, Silme onayları.

### 3.2 Entry page

Form in a `Card` (`max-w-2xl`) with a `CardTitle` naming the form, then the list of entered
records below it under an `h2` (*Kayıtlı ödemeler*, *Kayıtlı iadeler*). A queue of items to
work through sits **beside** the form (`w-80` column): *İnceleme kuyruğu* on Muhasebe →
Ödemeler. After saving, the form resets for the next record (or, for dual-role users, the
payment continues to B/L creation). Examples: Muhasebe (Ödemeler, İadeler), Açılış bakiyesi.

### 3.3 Grouped work list

One section per agency (bordered block: header with select-all, agency name, send-mode badge,
B/L count, totals per currency), each holding a plain table. **All groups share fixed column
widths** (`table-fixed` with a `colgroup`) so their columns line up. Selection across groups
feeds one primary action at the top right (*E-posta hazırla*). Example: Talepler.

### 3.4 Detail page

Header row: identifier in monospace, status chip, agency; actions on the right (*B/L'yi
düzenle*, *B/L'yi iptal et* in red). Under it the balance strip (Depozito, Tahsil edilen,
Kesintiler, Kalan). Then cards in a two-column grid (`xl:grid-cols-2`), ordered work and money
first: Özet, Açıklama, İade talep formu, E-postalar ve yanıtlar, Kesintiler ve silme, İade
dağıtımları, Hesap hareketleri; then Belgeler, B/L ayar istisnaları (only for admins or when
one is set) and Zaman çizelgesi. Each card has one title and its own actions inside it.
Example: B/L detail (`/bls/[id]`); the row panel on B/L'ler shows the same key facts compactly.

### 3.5 Settings page

Inside the settings area. Lists use the list pattern; Uygulama ayarları shows one section at a
time from tabs, each section a card with its own *Değişiklikleri kaydet* and optional reason
field; timing changes show the impact preview before saving.

### 3.6 Dashboard

A row of balance cards, then cards of counts (*Bugünün işleri*, *Eşleştirme bekleyenler*,
*Sorunlu B/L'ler*); each count is a link to the filtered list. Zero is shown muted, an alert
count in red. Cards appear only for the roles they concern.

### 3.7 Editable grid

A plain table with inputs per row for bulk entry, Excel paste filling rows downwards, errors
and warnings under the row's input, and one save button bottom right that names what it saves
and how many (*B/L numarası girilen satırları kaydet (3)*). Example: B/L oluştur.

### 3.8 Guide page

Title and hint, then one bordered card per role the user holds (in the `xl:grid-cols-2` grid,
`max-w-5xl`), titled with the role name, holding a numbered list of steps: each step a link
(the step's title, to its screen) and one muted line saying what to do there. Only the core
workflow, never every function. Text lives in `tr.json` like any other. Example: İlk adımlar
(`/getting-started`), which the dashboard opens once at a user's first visit.

## 4. Shared components (reuse, do not re-create)

| Need | Component | Notes |
| --- | --- | --- |
| Any list of records | `components/data-table/data-table.tsx` | Search, sort, filters, per-user layout, keyboard navigation, selection + bulk bar, inline edit, CSV and clipboard export. Props: `onOpenRow`, `toolbar`, `bulkActions`, `shortcuts`, `emptyText`, `hiddenByDefault`, `initialFilters`. Columns via `dataTableColumns()` with `meta.label`, `filter`, `align`, `toText`, `edit` |
| Record details over a list | `DetailDialog` + `detailNavigation` | Previous/next through the visible rows |
| Confirm an action | `ConfirmDialog` | `items` lists the affected records; `requireReason` for voids and other irreversible steps; `destructive` for red confirm |
| Success with undo | `toastWithUndo` | 10 s "Geri al"; the B/L timeline offers undo for the rest of the window |
| Upload | `FileDrop` | Click or drop; `multiple`, `compact`, `queue`; its label says what to drop |
| Pick agency / customer | `AgencyCombobox`, `CustomerCombobox` (on `SearchCombobox`) | Search by name, aliases, code; can name a new one |
| B/L status | `BlStatusBadge` | The only way to show a B/L status |
| Copy a value | `CopyButton` | |
| Field / action message | `FieldMessage` | Shows a translation key |
| Delete an unused agency/customer | `DeleteRecord` | Admin only, with reason |
| Timing overrides | `OverridesEditor` + `ImpactPreview` | Agency card and B/L detail |
| No access | `Forbidden` | |
| Primitives | `components/ui/*` (shadcn: button, badge, card, dialog, input, label, checkbox, alert, dropdown-menu, sonner) | Extend variants there instead of styling ad hoc |

Dialogs (`components/ui/dialog.tsx`) focus their first field **without selecting its text**.

## 5. Tables

- Built with `DataTable`, never a hand-made table, except the grouped work list (3.3), the
  editable grid (3.7), reports and small read-only lists inside cards.
- Column header = the field's term (section 10). Numbers and amounts right-aligned
  (`align: "end"`), tabular figures.
- Identifiers (B/L, container, file number) in monospace.
- Wide tables hide rarely needed columns with `hiddenByDefault`; the row panel or detail shows
  them. CSV export follows the visible columns.
- Long text: first line, truncated, full text in `title` and in the detail.
- Row actions: clicking the row opens the record. A `…` menu column only for extra actions
  that do not fit the detail (e.g. Kullanıcılar).
- Inline editing only for permitted, non-money, non-status fields; saved with undo.
- Voided rows: hidden by default, shown muted and struck through with the toggle.
- Empty: `emptyText` says why it is empty and, when someone else must act, who (*Henüz müşteri
  yok. Müşterileri yönetici ekler.*); filtered to nothing: *Kayıt bulunamadı.*

## 6. Forms

- Label above the field; help text under it (`text-muted-foreground text-xs`); validation
  message under that (`FieldMessage`).
- Optional fields: label followed by the grey hint `{t("common.optional")}` →
  *(isteğe bağlı)*; never written into the label text itself.
- Field order follows how the user reads the source document (e.g. receipt: type, file, agency,
  amount, currency, date, B/L number). Tab order = visual order; one Tab stop per radio group.
- Sensible defaults: today for a new payment date; carried-over agency, currency etc. in
  consecutive entry. Exception: historical entry (Açılış bakiyesi) leaves the date empty on
  purpose so it is never wrong by default.
- Primary button bottom right, named for what it does (*Ödemeyi kaydet*, *Açılış bakiyesini
  kaydet*); disabled while busy or when there is nothing to save. Long cards keep the save row
  visible (sticky).
- Warnings that may be overridden (duplicate, B/L number not on the receipt) ask for a
  confirmation; they never block silently.
- Ctrl+Enter saves multi-line text where it is the only field (Açıklama).

## 7. Dialogs, confirmations, feedback

- **Detail dialog** for a record from a list; **confirm dialog** before any bulk action, void,
  delete or irreversible step, listing the affected records; voids require a reason.
- Footer: secondary (*İptal*, ghost) left of the primary; destructive primary in red.
- **Toasts** (sonner): success short and specific (*2 B/L oluşturuldu.*); with undo where the
  action can be undone; errors show the server's message key.
- **Loading**: buttons disable while busy; no spinners over whole pages.
- **Destructive actions** (*iptal et*, *sil*, *pasifleştir*) use red text or a red confirm,
  never the same look as a neutral button next to them.

## 8. Visual language

### Status chips (`Badge`)

One scheme everywhere; add a new status to this table before using it.

| Colour (variant) | Meaning | Used for |
| --- | --- | --- |
| outline | normal course | *Depozito yatırıldı*, *Talep edildi*, *Konteyner dönüşü bekleniyor*, *Aktif*, open refunds, *B/L bekliyor* (payment), send-mode badges |
| warning (amber) | someone has to act | *Talep zamanı*, *Kesinti açık*, *Muhasebe kaydı bekliyor*, write-off *Onay bekliyor*, missing receipt on a due request, *Birim seçilmedi* (a B/L of an agency with units names none) |
| destructive (red) | problem or voided | *İtirazlı*, *İptal*, locked user, agency *Bilgi eksik*, backup problems |
| secondary (grey) | closed, inactive or informational | *Tahsil edildi*, *Aktarıldı*, *Pasif*, *Dağıtıldı*, write-off approved/rejected, roles, dry-run marks, lock badge |

Variants live in `components/ui/badge.tsx`; B/L statuses map in `bl-status-badge.tsx`.
Amber text (`text-amber-700`) is for inline hints (missing receipt, warnings under a field).

### Amounts, dates, empty values

- **Amounts:** in text, cards, grouped lists and dialogs: amount and currency together,
  `formatMoney` → *3.000,00 USD*. In `DataTable` lists: amount column (`formatAmount`) plus a
  separate *Para birimi* column right after the amounts, so currency can be filtered, sorted
  and exported. Never an amount without its currency on screen.
- **Dates:** business dates `DD.MM.YYYY`; timestamps `DD.MM.YYYY HH:mm` (Europe/Istanbul).
- **Empty value:** *—* (`common.none`), muted. A zero count stays *0*.
- **File sizes:** `formatBytes` (KB under 1 MB).

### Layout and type

- Page padding and gaps from Tailwind steps (`gap-4` between blocks, `gap-1.5` label–field).
- Cards: `Card` with `CardTitle`; one title per card, no heading repeated inside.
- Forms `max-w-2xl`; settings `max-w-4xl`; lists full width.
- Text sizes: page title `text-lg`, card/section titles `font-semibold`, body `text-sm`,
  help and meta `text-xs` muted.
- Icons: lucide, only where they add meaning (upload, download, external link, settings,
  bell); every icon-only button has an `aria-label` and `title`.

## 9. Keyboard and focus

- Global: `/` or Ctrl+K search, `?` shortcut list.
- Lists: ↑ / ↓ move, Home / End jump, Enter opens, Space selects, F2 edits the cell, letter
  shortcuts per screen (`R` record reply, `N` description).
- Detail dialog: ← / → previous / next (outside form fields), Esc closes.
- Dialogs focus the first field without selecting text.
- Tab order follows the visual order; drop zones and radio groups take one Tab stop.

## 10. Wording

- Page title = menu label. Buttons are verbs naming the result (*Ödemeyi kaydet*, *E-posta
  hazırla*, *Kalanı silmeyi öner*). Counts in brackets.
- Never mention technical names (IDs, statuses in English) in the UI.

| Concept | Term | Not |
| --- | --- | --- |
| Refund request | *iade talebi*; numbered *2. iade talebi* | *Takip 2*, *Talep no* |
| Deduction breakdown request | *döküm talebi* | |
| Send mode | *B/L başına e-posta* / *Toplu e-posta* | *Tekil / Toplu* |
| Free text on a B/L | *Açıklama* | *Not* |
| Writing off a remaining amount | *silme*, *Kalanı silmeyi öner* | *Silme öner* alone |
| Void | *iptal et* (with reason) | *sil* (delete is only for unused agencies/customers) |
| Allocation of a refund | *dağıtım*, *İade dağıtımı* | *eşleştirme* for allocations |
| Free text on a deposit (payment or opening balance); it starts the B/L's description | *Açıklama* | *Kaynak*, *Not* |
| An agency's office with its own recipients (e.g. per port) | *Birim*, *Mersin birimi* | *Liman*, *Şube* |
| Sending a sent request email again (not a new request) | *Yeniden gönder*; the copy is a *Yeniden gönderim* (grey badge) | *Tekrar talep*, *Takip* |
| A refund request made by phone or from another mailbox, recorded afterwards | *Uygulama dışı talep*, *Uygulama dışı talebi kaydet* | *Manuel durum*, *Elle talep* |
| Moving a B/L's deposit to another B/L (agency applied it there) | *Depozitoyu aktar*, *Depozito aktarımı*; closed: *Aktarıldı* | *Virman*, *Mahsup* |
| A user's bug report or feature request to the admins | *Hata bildir / öneri gönder*; kinds *Hata*, *Öneri*; the admin list *Geri bildirimler* | *Destek talebi*, *Ticket* |
| An email dragged from Outlook onto a B/L, kept with it | *arşivlenen e-posta*; drop zone *Outlook'tan e-posta bırakın*; *Outlook'ta aç* | *Yanıt içe aktar*, *Eşleştir* |
| Optional | *(isteğe bağlı)* grey hint | in the label text |

## 11. Checklist for a UI change

1. Which page pattern (section 3) does it belong to? Use it as it is.
2. Built from the shared components (section 4)? No hand-made table, dialog or picker.
3. Strings in `tr.json`, terms from section 10, page title = menu label.
4. Status chips, amounts, dates and empty values as in section 8.
5. Tab order, focus and shortcuts as in section 9; icon buttons labelled.
6. Permission checked on the server; the control hidden for users who cannot use it.
7. Nothing duplicated (headings, values, actions) and no read-only empty clutter.
8. e2e tests updated; ARCHITECTURE → Screens and this document updated if anything here changed.
