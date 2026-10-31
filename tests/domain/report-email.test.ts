import { describe, expect, it } from "vitest";
import { refusedRecipients } from "@/domain/report-email";

const rules = {
  internalDomains: ["firma.com.tr", "lojistik.firma.com.tr"],
  senderAddress: "depozito@firmagrup.com",
  agencyAddresses: ["iade@hapag.example", "Muhasebe@firma.com.tr"],
};

describe("report email recipients", () => {
  it("accepts internal domains and the sender's own domain, case-insensitively", () => {
    expect(refusedRecipients(["ali@firma.com.tr", "VELI@Lojistik.Firma.com.tr", "ayse@firmagrup.com"], rules)).toEqual({ external: [], agency: [] });
  });

  it("refuses other domains, including look-alike subdomains and suffixes", () => {
    expect(refusedRecipients(["a@gmail.com", "b@sub.firma.com.tr", "c@evilfirma.com.tr"], rules)).toEqual({
      external: ["a@gmail.com", "b@sub.firma.com.tr", "c@evilfirma.com.tr"],
      agency: [],
    });
  });

  it("refuses an address on any agency's recipient list, even inside an internal domain", () => {
    expect(refusedRecipients(["muhasebe@FIRMA.com.tr", "iade@hapag.example"], rules)).toEqual({
      external: ["iade@hapag.example"],
      agency: ["muhasebe@FIRMA.com.tr", "iade@hapag.example"],
    });
  });

  it("without a sender address only the internal domains count", () => {
    expect(refusedRecipients(["ayse@firmagrup.com"], { ...rules, senderAddress: "" }).external).toEqual(["ayse@firmagrup.com"]);
  });
});
