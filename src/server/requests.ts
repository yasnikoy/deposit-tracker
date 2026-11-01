import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { blBalance } from "@/domain/balances";
import { InvalidTransitionError, nextStatus, type StoredBlStatus } from "@/domain/bl-lifecycle";
import { businessDaysBetween, istanbulToday, type BusinessCalendar, type IsoDate } from "@/domain/business-days";
import { dueState, statementDueState, type DueList, type DueState, type RequestDurations, type StatementDurations } from "@/domain/due-requests";
import type { RequestChannel } from "@/domain/agency";
import type { RequestType } from "@/domain/records";
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
import { openUnexplained } from "./deductions";
import { DomainError } from "./errors";
import { activeLockers } from "./draft-locks";
import { currentBlForm } from "./forms";
import { replyHistory } from "./reply-history";
import { lacksPaymentEvidence } from "./payments";
import { getSetting } from "./settings";
import { customerScope } from "./preferences";

/** Every request-timing duration, resolved: B/L override → agency override → global. */
export type TimingDurations = RequestDurations & StatementDurations;

const TIMING_KEYS = {
  firstRequestDueDays: "durations.firstRequestDueDays",
  upcomingDays: "durations.upcomingDays",
  followUpDays: "durations.followUpDays",
  statementRequestDays: "durations.statementRequestDays",
  statementFollowUpDays: "durations.statementFollowUpDays",
} as const satisfies Record<keyof TimingDurations, OverridableSettingKey>;

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

/** Successful requests of one type per B/L, the last request date, and whether a send is in progress. */
export function requestStats(db: DbOrTx, blIds: number[], type: RequestType): Map<number, RequestStats> {
  const stats = new Map<number, RequestStats>();
  if (blIds.length === 0) return stats;
  const rows = db
    .select({ blId: requests.blId, sendStatus: requests.sendStatus, requestedOn: requests.requestedOn, attemptNo: requests.attemptNo })
    .from(requests)
    .where(and(inArray(requests.blId, blIds), eq(requests.type, type)))
    .all();
  for (const row of rows) {
    const s = stats.get(row.blId) ?? { attempts: 0, lastRequestOn: null, sending: false };
    if (row.sendStatus === "SENT") {
      // The highest attempt sent: an opening balance brings earlier attempts in one row.
      s.attempts = Math.max(s.attempts, row.attemptNo);
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
  const globals = Object.fromEntries(Object.entries(TIMING_KEYS).map(([field, key]) => [field, global(key)])) as TimingDurations;

  return (bl: BlRow, agency: AgencyRow): TimingDurations => {
    const fields = Object.keys(TIMING_KEYS) as (keyof TimingDurations)[];
    return Object.fromEntries(
      fields.map((field) => {
        const key = TIMING_KEYS[field];
        const agencyValue =
          hypothesis.agency?.agencyId === agency.id ? hypothesis.agency.overrides[key] : agency[agencyOverrideFields[key]];
        const blValue = hypothesis.bl?.blId === bl.id ? hypothesis.bl.overrides[key] : bl[agencyOverrideFields[key]];
        return [field, resolveSetting({ global: globals[field], agency: agencyValue, bl: blValue })];
      }),
    ) as TimingDurations;
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

export type DueEntry = {
  bl: BlRow;
  agency: AgencyRow;
  /** A refund request, or a deduction-statement request for an unexplained deduction. */
  state: DueState;
  calendar: BusinessCalendar;
  lastReply: { typeName: string; repliedOn: string } | null;
  /** Statement requests: the unexplained deduction asked about. */
  unexplainedMinor: number | null;
};

/**
 * The due state of every active B/L that can take a request (or of the given ones): refund
 * requests until the refund arrives, then statement requests while an unexplained deduction
 * is open and not disputed.
 */
export function dueEntries(db: DbOrTx, now: Date, hypothesis: SettingsHypothesis = {}, onlyBlIds?: number[]): DueEntry[] {
  const calendar = calendarUnder(db, hypothesis);
  const timing = timingResolver(db, hypothesis);
  const today = istanbulToday(now);
  const rows = db
    .select({ bl: billsOfLading, agency: agencies })
    .from(billsOfLading)
    .innerJoin(agencies, eq(agencies.id, billsOfLading.agencyId))
    .where(
      and(
        isNull(billsOfLading.voidedAt),
        inArray(billsOfLading.status, ["PAID", "REQUESTED", "AWAITING_RETURN", "DEDUCTION_OPEN"]),
        onlyBlIds ? inArray(billsOfLading.id, onlyBlIds) : undefined,
      ),
    )
    .all();
  const ids = rows.map((r) => r.bl.id);
  const refundStats = requestStats(db, ids, "REFUND");
  const statementStats = requestStats(db, ids, "DEDUCTION_STATEMENT");
  const history = replyHistory(db, ids);
  const none: RequestStats = { attempts: 0, lastRequestOn: null, sending: false };
  const entries: DueEntry[] = [];
  for (const { bl, agency } of rows) {
    const durations = timing(bl, agency);
    const lastReplyOn = history.get(bl.id)?.lastAnswerOn ?? null;
    let state: DueState | null;
    let unexplainedMinor: number | null = null;
    if (bl.status === "DEDUCTION_OPEN") {
      const open = openUnexplained(db, bl.id).find((e) => !e.disputed);
      const since = open ? istanbulToday(new Date(open.createdAt)) : null;
      const s = statementStats.get(bl.id) ?? none;
      unexplainedMinor = open?.amountMinor ?? null;
      state = statementDueState(
        {
          unexplainedSince: since,
          durations,
          attempts: s.attempts,
          // Requests about an earlier deduction (before a reversal) do not count for this one.
          lastRequestOn: since && s.lastRequestOn && s.lastRequestOn >= since ? s.lastRequestOn : null,
          lastReplyOn,
          sending: s.sending,
        },
        today,
        calendar,
      );
    } else {
      const s = refundStats.get(bl.id) ?? none;
      state = dueState(
        {
          status: bl.status as StoredBlStatus,
          voided: false,
          paidAt: bl.paidAt,
          durations,
          attempts: s.attempts,
          lastRequestOn: s.lastRequestOn,
          lastReplyOn,
          sending: s.sending,
        },
        today,
        calendar,
      );
    }
    if (state) entries.push({ bl, agency, state, calendar, lastReply: history.get(bl.id)?.last ?? null, unexplainedMinor });
  }
  return entries;
}

export type DueRow = {
  blId: number;
  blNo: string;
  paidAt: string;
  currency: string;
  /** The deposit for a refund request, the unexplained deduction for a statement request. */
  amountMinor: number;
  daysWaiting: number;
  type: RequestType;
  kind: DueState["kind"];
  attemptNo: number;
  dueDate: string;
  /** The first request of a portal agency is filed on the portal; follow-ups go by email. */
  channel: RequestChannel;
  form: { id: number; originalName: string } | null;
  /** Refund requests need the uploaded form when the rule setting is on; statement requests do not. */
  needsForm: boolean;
  /** The payment has no receipt or invoice yet; sending warns (rule 12). */
  evidenceMissing: boolean;
  /** Another user is drafting a request email for this B/L. */
  lockedBy: string | null;
  /** The last recorded agency reply. */
  lastReply: { typeName: string; repliedOn: string } | null;
};

export type DueGroup = {
  agencyId: number;
  agencyName: string;
  batchSending: boolean;
  portalUrl: string | null;
  rows: DueRow[];
  totals: { currency: string; amountMinor: number }[];
};

export type FailedRequest = {
  requestId: number;
  blId: number;
  blNo: string;
  agencyName: string;
  type: RequestType;
  attemptNo: number;
  failureReason: string | null;
  queuedAt: string;
};

export type DueLists = Record<DueList, DueGroup[]> & { FAILED: FailedRequest[]; formRequired: boolean };

/** The due-requests screen: due (today and overdue) and upcoming, grouped by agency, oldest first. */
export function listDueRequests(db: DbOrTx, actor: AuthUser, now: Date = new Date()): DueLists {
  authorize(actor, "request.view");
  const today = istanbulToday(now);
  const inScope = customerScope(db, actor);
  const entries = dueEntries(db, now).filter((e) => inScope(e.bl.customerId));
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

  const lockers = activeLockers(db, actor, now);
  const lists: DueLists = {
    DUE: [],
    UPCOMING: [],
    FAILED: failedRequests(db),
    formRequired: getSetting("rules.blockSendingWithoutForm", {}, db),
  };
  for (const list of ["DUE", "UPCOMING"] as const) {
    const groups = new Map<number, DueGroup>();
    const inList = entries
      .filter((e) => e.state.list === list)
      .sort((a, b) => a.state.dueDate.localeCompare(b.state.dueDate) || a.bl.paidAt.localeCompare(b.bl.paidAt) || a.bl.id - b.bl.id);
    for (const { bl, agency, state, calendar, lastReply, unexplainedMinor } of inList) {
      const group = groups.get(agency.id) ?? {
        agencyId: agency.id,
        agencyName: agency.name,
        batchSending: agency.batchSending,
        portalUrl: agency.portalUrl,
        rows: [],
        totals: [],
      };
      const form = currentBlForm(db, bl.id);
      const amountMinor =
        unexplainedMinor ??
        blBalance(
          ledger.filter((l) => l.blId === bl.id),
          bl.currency,
        ).depositMinor;
      group.rows.push({
        blId: bl.id,
        blNo: bl.blNo,
        paidAt: bl.paidAt,
        currency: bl.currency,
        amountMinor,
        daysWaiting: Math.max(0, businessDaysBetween(bl.paidAt, today, calendar)),
        type: state.type,
        kind: state.kind,
        attemptNo: state.attemptNo,
        dueDate: state.dueDate,
        // Portal agencies file only the first refund request on the portal; the rest goes by email.
        channel: agency.requestChannel === "PORTAL" && state.type === "REFUND" && state.kind === "FIRST" ? "PORTAL" : "EMAIL",
        form: form ? { id: form.id, originalName: form.originalName } : null,
        needsForm: state.type === "REFUND" && lists.formRequired,
        evidenceMissing: lacksPaymentEvidence(db, bl),
        lockedBy: lockers.get(bl.id) ?? null,
        lastReply,
      });
      const total = group.totals.find((t) => t.currency === bl.currency);
      if (total) total.amountMinor += amountMinor;
      else group.totals.push({ currency: bl.currency, amountMinor });
      groups.set(agency.id, group);
    }
    lists[list] = [...groups.values()];
  }
  return lists;
}

/** Sends that failed after their retries and have not been sent again since. */
export function failedRequests(db: DbOrTx): FailedRequest[] {
  const rows = db
    .select({ request: requests, blNo: billsOfLading.blNo, agencyName: agencies.name })
    .from(requests)
    .innerJoin(billsOfLading, eq(billsOfLading.id, requests.blId))
    .innerJoin(agencies, eq(agencies.id, billsOfLading.agencyId))
    .where(isNull(billsOfLading.voidedAt))
    .all();
  return rows
    .filter(
      ({ request }) =>
        request.sendStatus === "FAILED" &&
        !rows.some(
          ({ request: other }) =>
            other.blId === request.blId && other.type === request.type && other.attemptNo === request.attemptNo && other.sendStatus !== "FAILED",
        ) &&
        // Only the latest failure per attempt.
        !rows.some(
          ({ request: other }) =>
            other.blId === request.blId && other.type === request.type && other.attemptNo === request.attemptNo && other.id > request.id,
        ),
    )
    .map(({ request, blNo, agencyName }) => ({
      requestId: request.id,
      blId: request.blId,
      blNo,
      agencyName,
      type: request.type,
      attemptNo: request.attemptNo,
      failureReason: request.failureReason,
      queuedAt: request.createdAt,
    }));
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
  return dueEntries(db, now, {}, [blId])[0]?.state ?? null;
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
    if (!state || state.type !== "REFUND" || state.kind !== "FIRST" || state.list === null) throw new DomainError("requests.errors.notDue");
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
