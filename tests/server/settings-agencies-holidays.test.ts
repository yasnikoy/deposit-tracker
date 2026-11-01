import { and, eq, getTableColumns } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { addBusinessDays } from "@/domain/business-days";
import { settingDefinitions, OVERRIDABLE_SETTING_KEYS } from "@/domain/settings/definitions";
import { AGENCY_EXPORT_FORMAT, AGENCY_EXPORT_VERSION, agencyCard, agencyExportFileSchema, agencyInputSchema, importAgenciesSchema } from "@/lib/schemas/agencies";
import { createAgency, importAgencies, listAgencies, updateAgency, updateAgencyOverrides } from "@/server/agencies";
import type { AuthUser } from "@/server/auth/types";
import { loadCalendar } from "@/server/calendar";
import type { Db } from "@/server/db/client";
import { agencies, auditLog, settingsHistory } from "@/server/db/schema";
import { ForbiddenError } from "@/server/errors";
import { deleteHoliday, listHolidays, saveHolidays } from "@/server/holidays";
import { getSecretSetting, getSetting, listSettings, updateSettings } from "@/server/settings";
import { createTestDb, makeUser } from "../support/db";

let db: Db;
let admin: AuthUser;
let ops: AuthUser;
let accountant: AuthUser;

beforeEach(async () => {
  db = createTestDb();
  admin = await makeUser(db, "admin", ["ADMIN"]);
  ops = await makeUser(db, "ops", ["OPERATIONS"]);
  accountant = await makeUser(db, "acc", ["ACCOUNTANT"]);
});

const agencyInput = (overrides: Record<string, unknown> = {}) =>
  agencyInputSchema.parse({
    name: "MSC Türkiye",
    active: true,
    toRecipients: ["iade@msc.example"],
    ccRecipients: [],
    bankSenderAliases: ["MSC GEMICILIK A.S."],
    blNumberPatterns: [String.raw`MEDU\d{7}`],
    batchSending: true,
    requestChannel: "EMAIL",
    portalUrl: "",
    notes: "",
    ...overrides,
  });

describe("settings", () => {
  it("updates only changed values, with history, audit and optional reason", () => {
    const changed = updateSettings(db, admin, {
      changes: [
        { key: "durations.firstRequestDueDays", value: 10 },
        { key: "durations.followUpDays", value: 5 }, // unchanged
      ],
      reason: "Acenteler daha geç iade ediyor",
    });
    expect(changed).toEqual(["durations.firstRequestDueDays"]);
    expect(getSetting("durations.firstRequestDueDays", {}, db)).toBe(10);

    const history = db.select().from(settingsHistory).where(eq(settingsHistory.key, "durations.firstRequestDueDays")).all();
    expect(history.at(-1)).toMatchObject({ oldValue: 7, newValue: 10, changedBy: admin.id, reason: "Acenteler daha geç iade ediyor" });
    const audit = db.select().from(auditLog).where(eq(auditLog.action, "settings.update")).all();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ roleUsed: "ADMIN", before: 7, after: 10 });

    const listed = listSettings(db, admin).find((s) => s.key === "durations.firstRequestDueDays");
    expect(listed).toMatchObject({ value: 10, changedBy: "ADMIN" });
  });

  it("rejects invalid values and changes nothing", () => {
    expect(() =>
      updateSettings(db, admin, {
        changes: [
          { key: "durations.firstRequestDueDays", value: 12 },
          { key: "calendar.weekendDays", value: [1, 2, 3, 4, 5, 6, 7] },
        ],
      }),
    ).toThrow();
    expect(getSetting("durations.firstRequestDueDays", {}, db)).toBe(7);
  });

  it("stores the mail password encrypted and never shows or logs it", () => {
    expect(listSettings(db, admin).find((s) => s.key === "email.password")).toMatchObject({ value: "", secretSet: false });
    updateSettings(db, admin, { changes: [{ key: "email.password", value: "yandex-uygulama-sifresi" }] });

    const stored = getSetting("email.password", {}, db);
    expect(stored).toMatch(/^v1:/);
    expect(getSecretSetting("email.password", db)).toBe("yandex-uygulama-sifresi");
    expect(listSettings(db, admin).find((s) => s.key === "email.password")).toMatchObject({ value: "", secretSet: true });
    const logged = JSON.stringify([db.select().from(settingsHistory).all(), db.select().from(auditLog).all()]);
    expect(logged).not.toContain("yandex-uygulama-sifresi");
    expect(logged).not.toContain(stored);

    // An empty field keeps the stored password.
    expect(updateSettings(db, admin, { changes: [{ key: "email.password", value: "" }] })).toEqual([]);
    expect(getSecretSetting("email.password", db)).toBe("yandex-uygulama-sifresi");
  });

  it("is admin-only", () => {
    expect(() => updateSettings(db, ops, { changes: [{ key: "rules.undoWindowMinutes", value: 5 }] })).toThrow(ForbiddenError);
    expect(() => listSettings(db, ops)).toThrow(ForbiddenError);
  });
});

describe("agencies and overrides", () => {
  it("operations creates and edits agencies; everyone can view them", () => {
    const id = createAgency(db, ops, agencyInput());
    updateAgency(db, ops, { id, agency: agencyInput({ batchSending: false, notes: "Portal yok" }) });
    expect(listAgencies(db, accountant)[0]).toMatchObject({ name: "MSC Türkiye", batchSending: false, notes: "Portal yok" });
    expect(() => createAgency(db, accountant, agencyInput({ name: "Other" }))).toThrow(ForbiddenError);

    const audit = db.select().from(auditLog).where(and(eq(auditLog.entityType, "agency"), eq(auditLog.entityId, String(id)))).all();
    expect(audit.map((a) => [a.action, a.roleUsed])).toEqual([
      ["agency.create", "OPERATIONS"],
      ["agency.update", "OPERATIONS"],
    ]);
  });

  it("rejects duplicate names case-insensitively", () => {
    createAgency(db, ops, agencyInput());
    expect(() => createAgency(db, ops, agencyInput({ name: "msc türkiye" }))).toThrow(
      expect.objectContaining({ messageKey: "agencies.errors.nameTaken" }),
    );
  });

  it("requires a portal URL for portal agencies and valid patterns and e-mails", () => {
    expect(agencyInputSchema.safeParse({ ...agencyInput(), requestChannel: "PORTAL", portalUrl: "" }).success).toBe(false);
    expect(agencyInputSchema.safeParse({ ...agencyInput(), blNumberPatterns: ["(A+)+"] }).success).toBe(false);
    expect(agencyInputSchema.safeParse({ ...agencyInput(), toRecipients: ["not-an-email"] }).success).toBe(false);
  });

  it("resolves agency overrides; null inherits; only admins change them", () => {
    const id = createAgency(db, ops, agencyInput());
    const none = Object.fromEntries(OVERRIDABLE_SETTING_KEYS.map((k) => [k, null])) as never;
    expect(() => updateAgencyOverrides(db, ops, { agencyId: id, overrides: none, reason: null })).toThrow(ForbiddenError);

    updateAgencyOverrides(db, admin, {
      agencyId: id,
      overrides: { ...(none as object), "durations.firstRequestDueDays": 3, "durations.upcomingDays": 0 } as never,
      reason: "Bu acente hızlı",
    });
    expect(getSetting("durations.firstRequestDueDays", { agencyId: id }, db)).toBe(3);
    expect(getSetting("durations.upcomingDays", { agencyId: id }, db)).toBe(0);
    expect(getSetting("durations.followUpDays", { agencyId: id }, db)).toBe(5);
    expect(getSetting("durations.firstRequestDueDays", {}, db)).toBe(7);
    // Non-overridable settings ignore the agency.
    expect(getSetting("rules.undoWindowMinutes", { agencyId: id }, db)).toBe(10);
    expect(listAgencies(db, ops)[0].overrides["durations.firstRequestDueDays"]).toBe(3);
  });

  it("keeps the override column map in sync with the setting registry", () => {
    const sqlNames = Object.values(getTableColumns(agencies)).map((column) => column.name);
    for (const key of OVERRIDABLE_SETTING_KEYS) {
      expect(sqlNames, key).toContain((settingDefinitions[key] as { agencyColumn: string }).agencyColumn);
    }
  });
});

describe("agency export and import", () => {
  it("carries the cards to another installation, adds only new names and audits each one", async () => {
    createAgency(db, ops, agencyInput());
    createAgency(db, ops, agencyInput({ name: "Akkon", toRecipients: [], batchSending: false, blNumberPatterns: [String.raw`AKK[A-Z]{2}\d{8}`], notes: "Portal yok" }));
    // What the Agencies screen writes to the file, read back as the other installation reads it.
    const exported = JSON.parse(
      JSON.stringify({ format: AGENCY_EXPORT_FORMAT, version: AGENCY_EXPORT_VERSION, exportedAt: "2026-11-01T10:00:00Z", agencies: listAgencies(db, ops).map(agencyCard) }),
    );
    const file = agencyExportFileSchema.parse(exported);

    const office = createTestDb();
    const officeOps = await makeUser(office, "ops", ["OPERATIONS"]);
    createAgency(office, officeOps, agencyInput({ name: "msc türkiye", toRecipients: ["kayitli@msc.example"] }));
    const officeAcc = await makeUser(office, "acc", ["ACCOUNTANT"]);
    const importInput = importAgenciesSchema.parse({ agencies: exported.agencies });
    expect(() => importAgencies(office, officeAcc, importInput)).toThrow(ForbiddenError);

    expect(importAgencies(office, officeOps, importInput)).toEqual({ created: ["Akkon"], skipped: ["MSC Türkiye"] });
    const akkon = listAgencies(office, officeOps).find((a) => a.name === "Akkon")!;
    expect(agencyCard(akkon)).toEqual(file.agencies.find((a) => a.name === "Akkon"));
    // The agency already there is left as it was.
    expect(listAgencies(office, officeOps).find((a) => a.name === "msc türkiye")!.toRecipients).toEqual(["kayitli@msc.example"]);
    expect(office.select().from(auditLog).where(eq(auditLog.action, "agency.create")).all()).toHaveLength(2);

    expect(agencyExportFileSchema.safeParse({ ...exported, format: "other" }).success).toBe(false);
  });
});

describe("holidays and the calendar", () => {
  it("adds, updates and deletes holidays, and the calendar follows", () => {
    expect(
      saveHolidays(db, admin, {
        holidays: [
          { date: "2026-10-28", name: "Cumhuriyet Bayramı arifesi", kind: "HALF" },
          { date: "2026-10-29", name: "Cumhuriyet Bayramı", kind: "FULL" },
        ],
        reason: null,
      }),
    ).toEqual({ created: 2, updated: 0 });
    expect(addBusinessDays("2026-10-22", 7, loadCalendar(db))).toBe("2026-11-04");

    updateSettings(db, admin, { changes: [{ key: "calendar.halfDaysAreBusinessDays", value: true }] });
    expect(addBusinessDays("2026-10-22", 7, loadCalendar(db))).toBe("2026-11-03");

    expect(
      saveHolidays(db, admin, { holidays: [{ date: "2026-10-29", name: "Cumhuriyet Bayramı", kind: "FULL" }], reason: null }),
    ).toEqual({ created: 0, updated: 0 });
    const [eve] = listHolidays(db, admin);
    deleteHoliday(db, admin, { id: eve.id, reason: "yanlış girildi" });
    expect(listHolidays(db, admin).map((h) => h.date)).toEqual(["2026-10-29"]);
    expect(db.select().from(auditLog).where(eq(auditLog.action, "holiday.delete")).get()).toMatchObject({
      reason: "yanlış girildi",
      before: { date: "2026-10-28", name: "Cumhuriyet Bayramı arifesi", kind: "HALF" },
    });
  });

  it("is admin-only", () => {
    expect(() => listHolidays(db, ops)).toThrow(ForbiddenError);
  });
});
