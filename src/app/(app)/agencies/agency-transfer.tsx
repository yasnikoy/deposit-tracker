"use client";

import { Download, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { istanbulToday } from "@/domain/business-days";
import { t } from "@/i18n";
import {
  AGENCY_EXPORT_FORMAT,
  AGENCY_EXPORT_VERSION,
  agencyCard,
  agencyExportFileSchema,
  type AgencyExportFile,
  type AgencyInput,
} from "@/lib/schemas/agencies";
import type { AgencyListItem } from "@/server/agencies";
import { importAgenciesAction } from "./actions";

/** Downloads the selected agency cards as a JSON file to import in another installation. */
export function ExportAgenciesButton({ agencies }: { agencies: AgencyListItem[] }) {
  const exportFile = () => {
    const file: AgencyExportFile = {
      format: AGENCY_EXPORT_FORMAT,
      version: AGENCY_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      agencies: agencies.map(agencyCard),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${t("agencies.transfer.fileName")}-${istanbulToday()}.json`;
    link.click();
    URL.revokeObjectURL(url);
    toast.success(t("agencies.transfer.exported", { count: agencies.length }));
  };
  return (
    <Button size="sm" variant="outline" onClick={exportFile}>
      <Download /> {t("agencies.transfer.export")}
    </Button>
  );
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Reads an export file and, after a confirmation listing them, adds the agencies not here yet. */
export function ImportAgenciesButton({ existing }: { existing: AgencyListItem[] }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ agencies: AgencyInput[]; added: string[]; skipped: string[] } | null>(null);

  const read = async (file: File) => {
    let parsed: ReturnType<typeof agencyExportFileSchema.safeParse>;
    try {
      parsed = agencyExportFileSchema.safeParse(JSON.parse(await file.text()));
    } catch {
      return void toast.error(t("agencies.transfer.invalidFile"));
    }
    if (!parsed.success) return void toast.error(t("agencies.transfer.invalidFile"));
    const added: string[] = [];
    const skipped: string[] = [];
    for (const agency of parsed.data.agencies) {
      if (existing.some((a) => sameName(a.name, agency.name)) || added.some((name) => sameName(name, agency.name))) skipped.push(agency.name);
      else added.push(agency.name);
    }
    if (added.length === 0) return void toast.info(t("agencies.transfer.nothingNew"));
    setPending({ agencies: parsed.data.agencies, added, skipped });
  };

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => input.current?.click()}>
        <Upload /> {t("agencies.transfer.import")}
      </Button>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void read(file);
        }}
      />
      {pending && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setPending(null)}
          title={t("agencies.transfer.confirmTitle", { count: pending.added.length })}
          description={
            pending.skipped.length > 0
              ? t("agencies.transfer.confirmSkipped", { names: pending.skipped.join(", ") })
              : t("agencies.transfer.confirmHint")
          }
          items={pending.added}
          confirmLabel={t("agencies.transfer.confirm")}
          onConfirm={async () => {
            const result = await importAgenciesAction({ agencies: pending.agencies });
            if (!result.ok) return void toast.error(t(result.error, result.params));
            toast.success(t("agencies.transfer.imported", { count: result.data.created.length }));
            setPending(null);
            router.refresh();
          }}
        />
      )}
    </>
  );
}
