import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { blBalance } from "@/domain/balances";
import { InvalidTransitionError, nextStatus, type StoredBlStatus } from "@/domain/bl-lifecycle";
import { businessDaysBetween, istanbulToday, type BusinessCalendar, type IsoDate } from "@/domain/business-days";
import { dueState, type DueList, type DueState, type RequestDurations } from "@/domain/due-requests";
import type { RequestChannel } from "@/domain/agency";
import { parseSettingValue, type OverridableSettingKey, type SettingKey } from "@/domain/settings/definitions";
import { resolveSetting } from "@/domain/settings/resolve";
import type { AgencyOverrides } from "@/lib/schemas/agencies";
import { agencyOverrideFields } from "./agency-overrides";
import { writeAudit } from "./audit";
import { authorize } from "./auth/can";
import type { AuthUser } from "./auth/types";
import { loadCalendar } from "./calendar";
import type { Db, DbOrTx } from "./db/client";
import { agencies, billsOfLading, ledgerEntries, requests } from "./db/schema";
import { DomainError } from "./errors";
import { currentBlForm } from "./forms";
import { getSetting } from "./settings";

const TIMING_KEYS = {
  firstRequestDueDays: "durations.firstRequestDueDays",
  upcomingDays: "durations.upcomingDays",
  followUpDays: "durations.followUpDays",
} as const satisfies Record<keyof RequestDurations, OverridableSettingKey>;

/**
 * A change not yet saved, for the impact preview: new global values, or new overrides of
 * one agency or one B/L. Without it, the stored settings apply.
 */
export type SettingsHypothesis = {
  settings?: Partial<Record<SettingKey, unknown>>;
  agency?: { agencyId: number; overrides: AgencyOverrides };
  bl?: { blId: number; overrides: AgencyOverrides };
};

export type RequestStats = { attempts: number; lastRequestOn: IsoDate | null; sending: boolean };

/** Successful refund requests per B/L, the last request date, and whether a send is in progress. */
export function refundRequestStats(db: DbOrTx, blIds: number[]): Map<number, RequestStats> {
  const stats = new Map<number, RequestStats>();
  if (blIds.length === 0) return stats;
  const rows = db
    .select({ blId: requests.blId, sendStatus: requests.sendStatus, requestedOn: requests.requestedOn })
    .from(requests)
    .where(and(inArray(requests.blId, blIds), eq(requests.type, "REFUND")))
    .all();
  for (const row of rows) {
    const s = stats.get(row.blId) ?? { attempts: 0, lastRequestOn: null, sending: false };
    if (row.sendStatus === "SENT") {
      s.attempts++;
      if (!s.lastRequestOn || row.requestedOn! > s.lastRequestOn) s.lastRequestOn = row.requestedOn;
    }
    if (row.sendStatus === "QUEUED") s.sending = true;
    stats.set(row.blId, s);
  }
  return stats;
}

type BlRow = typeof billsOfLading.$inferSelect;
type AgencyRow = typeof agencies.$inferSelect;

/** Resolves request timing for many B/Ls at once (B/L → agency → global), optionally under a hypothesis. */
export function timingResolver(db: DbOrTx, hypothesis: SettingsHypothesis = {}) {
  const global = (key: OverridableSettingKey): number =>
    hypothesis.settings && key in hypothesis.settings
      ? (parseSettingValue(key, hypothesis.settings[key]) as number)
      : getSetting(key, {}, db);
  const globals = Object.fromEntries(Object.entries(TIMING_KEYS).map(([field, key]) => [field, global(key)])) as RequestDurations;

  return (bl: BlRow, agency: AgencyRow): RequestDurations => {
    const fields = Object.keys(TIMING_KEYS) as (keyof RequestDurations)[];
    return Object.fromEntries(
      fields.map((field) => {
        const key = TIMING_KEYS[field];
        const agencyValue =
          hypothesis.agency?.agencyId === agency.id ? hypothesis.agency.overrides[key] : agency[agencyOverrideFields[key]];
        const blValue = hypothesis.bl?.blId === bl.id ? hypothesis.bl.overrides[key] : bl[agencyOverrideFields[key]];
        return [field, resolveSetting({ global: globals[field], agency: agencyValue, bl: blValue })];
      }),
    ) as RequestDurations;
  };
}

function calendarUnder(db: DbOrTx, hypothesis: SettingsHypothesis): BusinessCalendar {
  const calendar = loadCalendar(db);
  const s = hypothesis.settings ?? {};
  return {
    ...calendar,
    weekendDays: "calendar.weekendDays" in s ? parseSettingValue("calendar.weekendDays", s["calendar.weekendDays"]) : calendar.weekendDays,
    halfDaysAreBusinessDays:
      "calendar.halfDaysAreBusinessDays" in s
        ? parseSettingValue("calendar.halfDaysAreBusinessDays", s["calendar.halfDaysAreBusinessDays"])
        : calendar.halfDaysAreBusinessDays,
  };
}

type DueEntry = { bl: BlRow; agency: AgencyRow; state: DueState; stats: RequestStats; calendar: BusinessCalendar };

/** The due state of every active B/L that can take a refund request. */
function dueEntries(db: DbOrTx, now: Date, hypothesis: SettingsHypothesis = {}): DueEntry[] {
  const calendar = calendarUnder(db, hypothesis);
  const timing = timingResolver(db, hypothesis);
  const today = istanbulToday(now);
  const rows = db
    .select({ bl: billsOfLading, agency: agencies })
    .from(billsOfLading)
    .innerJoin(agencies, eq(agencies.id, billsOfLading.agencyId))
    .where(and(isNull(billsOfLading.voidedAt), inArray(billsOfLading.status, ["PAID", "REQUESTED", "AWAITING_RETURN"])))
    .all();
  const stats = refundRequestStats(
    db,
    rows.map((r) => r.bl.id),
  );
  const entries: DueEntry[] = [];
  for (const { bl, agency } of rows) {
    const s = stats.get(bl.id) ?? { attempts: 0, lastRequestOn: null, sending: false };
    const state = dueState(
      {
        status: bl.status as StoredBlStatus,
        voided: false,
        paidAt: bl.paidAt,
        durations: timing(bl, agency),
        attempts: s.attempts,
        lastRequestOn: s.lastRequestOn,
        // Replies are recorded from build step 5 on.
        lastReplyOn: null,
        sending: s.sending,
      },
      today,
      calendar,
    );
    if (state) entries.push({ bl, agency, state, stats: s, calendar });
  }
  return entries;
}

export type DueRow = {
  blId: number;
  blNo: string;
  paidAt: string;
  currency: string;
  depositMinor: number;
  daysWaiting: number;
  kind: DueState["kind"];
  attemptNo: number;
  dueDate: string;
  /** The first request of a portal agency is filed on the portal; follow-ups go by email. */
  channel: RequestChannel;
  form: { id: number; originalName: string } | null;
};

export type DueGroup = {
  agencyId: number;
  agencyName: string;
  batchSending: boolean;
  portalUrl: string | null;
  rows: DueRow[];
  totals: { currency: string; amountMinor: number }[];
};

export type DueLists = Record<DueList, DueGroup[]> & { formRequired: boolean };

/** The due-requests screen: due (today and overdue) and upcoming, grouped by agency, oldest first. */
export function listDueRequests(db: DbOrTx, actor: AuthUser, now: Date = new Date()): DueLists {
  authorize(actor, "request.view");
  const today = istanbulToday(now);
  const entries = dueEntries(db, now);
  const ledger = entries.length
    ? db
        .select()
        .from(ledgerEntries)
        .where(
          inArray(
            ledgerEntries.blId,
            entries.map((e) => e.bl.id),
          ),
        )
        .all()
    : [];

  const lists: DueLists = { DUE: [], UPCOMING: [], formRequired: getSetting("rules.blockSendingWithoutForm", {}, db) };
  for (const list of ["DUE", "UPCOMING"] as const) {
    const groups = new Map<number, DueGroup>();
    const inList = entries
      .filter((e) => e.state.list === list)
      .sort((a, b) => a.state.dueDate.localeCompare(b.state.dueDate) || a.bl.paidAt.localeCompare(b.bl.paidAt) || a.bl.id - b.bl.id);
    for (const { bl, agency, state, calendar } of inList) {
      const group = groups.get(agency.id) ?? {
        agencyId: agency.id,
        agencyName: agency.name,
        batchSending: agency.batchSending,
        portalUrl: agency.portalUrl,
        rows: [],
        totals: [],
      };
      const form = currentBlForm(db, bl.id);
      const depositMinor = blBalance(
        ledger.filter((l) => l.blId === bl.id),
        bl.currency,
      ).depositMinor;
      group.rows.push({
        blId: bl.id,
        blNo: bl.blNo,
        paidAt: bl.paidAt,
        currency: bl.currency,
        depositMinor,
        daysWaiting: Math.max(0, businessDaysBetween(bl.paidAt, today, calendar)),
        kind: state.kind,
        attemptNo: state.attemptNo,
        dueDate: state.dueDate,
        channel: agency.requestChannel === "PORTAL" && state.kind === "FIRST" ? "PORTAL" : "EMAIL",
        form: form ? { id: form.id, originalName: form.originalName } : null,
      });
      const total = group.totals.find((t) => t.currency === bl.currency);
      if (total) total.amountMinor += depositMinor;
      else group.totals.push({ currency: bl.currency, amountMinor: depositMinor });
      groups.set(agency.id, group);
    }
    lists[list] = [...groups.values()];
  }
  return lists;
}

export type ListImpact = { before: number; after: number; entering: number; leaving: number };
export type DueImpact = Record<DueList, ListImpact>;

/** Impact preview: how many B/Ls move into or out of the due and upcoming lists if a change is saved. */
export function previewDueImpact(db: DbOrTx, actor: AuthUser, hypothesis: SettingsHypothesis, now: Date = new Date()): DueImpact {
  if (hypothesis.settings) authorize(actor, "settings.update");
  if (hypothesis.agency) authorize(actor, "agency.updateOverrides");
  if (hypothesis.bl) authorize(actor, "bl.updateOverrides");
  const listOf = (entries: DueEntry[]) => new Map(entries.map((e) => [e.bl.id, e.state.list]));
  const before = listOf(dueEntries(db, now));
  const after = listOf(dueEntries(db, now, hypothesis));
  const ids = new Set([...before.keys(), ...after.keys()]);
  const impact = (list: DueList): ListImpact => {
    let entering = 0;
    let leaving = 0;
    for (const id of ids) {
      const was = before.get(id) === list;
      const is = after.get(id) === list;
      if (is && !was) entering++;
      if (was && !is) leaving++;
    }
    return {
      before: [...before.values()].filter((l) => l === list).length,
      after: [...after.values()].filter((l) => l === list).length,
      entering,
      leaving,
    };
  };
  return { DUE: impact("DUE"), UPCOMING: impact("UPCOMING") };
}

/** The current due state of one B/L, or null when no request can be made. */
export function blDueState(db: DbOrTx, blId: number, now: Date = new Date()): DueState | null {
  return dueEntries(db, now).find((e) => e.bl.id === blId)?.state ?? null;
}

/**
 * Operations records a first request filed on an agency portal (attempt 1). It counts like a
 * sent email: the B/L moves to REQUESTED and the follow-up clock starts from the filing date.
 */
export function recordPortalRequest(
  db: Db,
  actor: AuthUser,
  input: { blId: number; requestedOn: IsoDate; portalRef: string | null },
  now: Date = new Date(),
): number {
  const roleUsed = authorize(actor, "request.recordPortal");
  return db.transaction((tx) => {
    const bl = tx.select().from(billsOfLading).where(eq(billsOfLading.id, input.blId)).get();
    if (!bl) throw new DomainError("errors.notFound");
    if (bl.voidedAt) throw new DomainError("bls.errors.voided");
    const agency = tx.select().from(agencies).where(eq(agencies.id, bl.agencyId)).get()!;
    if (agency.requestChannel !== "PORTAL") throw new DomainError("requests.errors.notPortal");
    const state = blDueState(tx, bl.id, now);
    if (!state || state.kind !== "FIRST" || state.list === null) throw new DomainError("requests.errors.notDue");
    if (input.requestedOn > istanbulToday(now)) throw new DomainError("requests.errors.futureDate");
    if (input.requestedOn < bl.paidAt) throw new DomainError("requests.errors.beforePayment");
    if (getSetting("rules.blockSendingWithoutForm", {}, tx) && !currentBlForm(tx, bl.id)) {
      throw new DomainError("requests.errors.formMissing", { bl: bl.blNo });
    }

    let status: StoredBlStatus;
    try {
      status = nextStatus(bl.status as StoredBlStatus, "REFUND_REQUEST_SENT");
    } catch (error) {
      if (error instanceof InvalidTransitionError) throw new DomainError("requests.errors.notDue");
      throw error;
    }
    const at = now.toISOString();
    const request = tx
      .insert(requests)
      .values({
        blId: bl.id,
        type: "REFUND",
        channel: "PORTAL",
        attemptNo: state.attemptNo,
        sendStatus: "SENT",
        requestedOn: input.requestedOn,
        sentAt: at,
        portalRef: input.portalRef,
        createdBy: actor.id,
        createdAt: at,
      })
      .returning()
      .get();
    tx.update(billsOfLading).set({ status, updatedAt: at }).where(eq(billsOfLading.id, bl.id)).run();
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "request.portal",
        entityType: "bill_of_lading",
        entityId: bl.id,
        before: { status: bl.status },
        after: { status, requestId: request.id, attemptNo: request.attemptNo, requestedOn: input.requestedOn, portalRef: input.portalRef },
      },
      now,
    );
    return request.id;
  });
}

/** Admin-only: request-timing overrides for one B/L; null inherits the agency, then the global value. */
export function updateBlOverrides(
  db: Db,
  actor: AuthUser,
  input: { blId: number; overrides: AgencyOverrides; reason: string | null },
  now: Date = new Date(),
): void {
  const roleUsed = authorize(actor, "bl.updateOverrides");
  db.transaction((tx) => {
    const bl = tx.select().from(billsOfLading).where(eq(billsOfLading.id, input.blId)).get();
    if (!bl) throw new DomainError("errors.notFound");
    if (bl.voidedAt) throw new DomainError("bls.errors.voided");
    const fields = Object.entries(agencyOverrideFields) as [OverridableSettingKey, keyof AgencyRow & keyof BlRow][];
    const before = Object.fromEntries(fields.map(([key, field]) => [key, bl[field]]));
    tx.update(billsOfLading)
      .set({ ...Object.fromEntries(fields.map(([key, field]) => [field, input.overrides[key]])), updatedAt: now.toISOString() })
      .where(eq(billsOfLading.id, bl.id))
      .run();
    writeAudit(
      tx,
      {
        actorUserId: actor.id,
        roleUsed,
        action: "bl.overrides",
        entityType: "bill_of_lading",
        entityId: bl.id,
        before,
        after: input.overrides,
        reason: input.reason,
      },
      now,
    );
  });
}
