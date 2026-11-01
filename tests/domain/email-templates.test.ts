import { describe, expect, it } from "vitest";
import { EMAIL_TEMPLATE_PLACEHOLDERS, EMAIL_TEMPLATE_SAMPLES, renderTemplate, templatePlaceholders } from "@/domain/email-templates";

describe("renderTemplate", () => {
  it("fills placeholders and leaves unknown ones visible, so the preview shows them", () => {
    expect(renderTemplate("B/L {bl_no} – {amount} {currency} {imza}", { bl_no: "MEDU1", amount: "3.000,00", currency: "USD" })).toBe(
      "B/L MEDU1 – 3.000,00 USD {imza}",
    );
  });

  it("keeps a section block only when its section has content", () => {
    const body = [
      "Sayın {agency_name},",
      "",
      "[[refund]]",
      "İadesini rica ettiğimiz B/L'ler:",
      "{refund_section}",
      "[[/refund]]",
      "[[statement]]",
      "Kesinti dökümü istediğimiz B/L'ler:",
      "{statement_section}",
      "[[/statement]]",
      "Saygılarımızla",
    ].join("\n");
    expect(renderTemplate(body, { agency_name: "MSC", refund_section: "• MEDU1\n• MEDU2", statement_section: "" })).toBe(
      ["Sayın MSC,", "", "İadesini rica ettiğimiz B/L'ler:", "• MEDU1\n• MEDU2", "Saygılarımızla"].join("\n"),
    );
  });

  it("does not let filled-in values inject placeholders", () => {
    expect(renderTemplate("{a} {b}", { a: "{b}", b: "x" })).toBe("{b} x");
  });
});

describe("templatePlaceholders", () => {
  it("lists the placeholders a template uses, once each", () => {
    expect(templatePlaceholders("Konu {bl_no} {bl_no} [[refund]]{refund_section}[[/refund]]")).toEqual(["bl_no", "refund_section"]);
  });
});

describe("preview samples", () => {
  it("cover every placeholder a template may use, so the settings preview shows no raw {name}", () => {
    // The signature comes from its setting; the batch sections are built from BATCH_LINE.
    const builtElsewhere = new Set(["signature", "refund_section", "statement_section"]);
    const missing = Object.values(EMAIL_TEMPLATE_PLACEHOLDERS)
      .flat()
      .filter((name) => !builtElsewhere.has(name) && !(name in EMAIL_TEMPLATE_SAMPLES));
    expect([...new Set(missing)]).toEqual([]);
  });
});
