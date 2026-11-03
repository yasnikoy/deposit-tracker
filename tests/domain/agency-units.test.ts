import { describe, expect, it } from "vitest";
import { agencyDetailsMissing, requestRecipients, unitRequired, type AgencyUnitRecipients } from "@/domain/agency";

const unit = (id: number, overrides: Partial<AgencyUnitRecipients> = {}): AgencyUnitRecipients => ({
  id,
  name: `Birim ${id}`,
  active: true,
  toRecipients: [`birim${id}@acente.example`],
  ccRecipients: [],
  ...overrides,
});
const agency = { toRecipients: ["genel@acente.example"], ccRecipients: ["cc@acente.example"] };

describe("agency units", () => {
  it("are required only while the agency has an active unit", () => {
    expect(unitRequired([])).toBe(false);
    expect(unitRequired([unit(1, { active: false })])).toBe(false);
    expect(unitRequired([unit(1, { active: false }), unit(2)])).toBe(true);
  });

  it("route requests to the B/L's unit instead of the agency's list", () => {
    expect(requestRecipients(agency, [unit(1), unit(2)], 2)).toEqual({ ok: true, unitId: 2, to: ["birim2@acente.example"], cc: [] });
  });

  it("leave the agency's list for agencies without active units", () => {
    expect(requestRecipients(agency, [], null)).toEqual({ ok: true, unitId: null, to: agency.toRecipients, cc: agency.ccRecipients });
    // A unit deactivated after the B/L named it: the agency has no active unit, its own list applies.
    expect(requestRecipients(agency, [unit(1, { active: false })], 1)).toEqual({ ok: true, unitId: null, to: agency.toRecipients, cc: agency.ccRecipients });
  });

  it("block a B/L without an active unit of an agency that has units", () => {
    expect(requestRecipients(agency, [unit(1)], null)).toEqual({ ok: false, problem: "UNIT_MISSING" });
    expect(requestRecipients(agency, [unit(1), unit(2, { active: false })], 2)).toEqual({ ok: false, problem: "UNIT_MISSING" });
  });

  it("report missing recipients of the unit or the agency", () => {
    expect(requestRecipients(agency, [unit(1, { toRecipients: [] })], 1)).toEqual({ ok: false, problem: "NO_RECIPIENTS" });
    expect(requestRecipients({ toRecipients: [], ccRecipients: [] }, [], null)).toEqual({ ok: false, problem: "NO_RECIPIENTS" });
  });

  it("leave a card incomplete while an active unit (or, without units, the agency) has no To recipient", () => {
    expect(agencyDetailsMissing({ toRecipients: [] })).toBe(true);
    expect(agencyDetailsMissing({ toRecipients: [], units: [unit(1)] })).toBe(false);
    expect(agencyDetailsMissing({ toRecipients: ["a@b.example"], units: [unit(1), unit(2, { toRecipients: [] })] })).toBe(true);
    expect(agencyDetailsMissing({ toRecipients: [], units: [unit(1, { active: false })] })).toBe(true);
  });
});
