import { describe, expect, it } from "vitest";
import { renderTemplate, templatePlaceholders } from "@/domain/email-templates";

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
