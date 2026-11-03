"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FileDrop, uploadErrorText } from "@/components/file-drop";
import { STANDING_DOCUMENT_SLOTS } from "@/domain/records";
import { t } from "@/i18n";
import { formatTimestamp } from "@/lib/format";
import type { StandingDocument } from "@/server/standing-documents";
import { setStandingDocumentAction } from "./actions";

/**
 * The customer's signature circular and power of attorney, attached to every request for its
 * B/Ls. Without both, those requests cannot be sent (while the rule setting is on).
 */
export function CustomerDocuments({ customerId, documents, editable }: { customerId: number; documents: StandingDocument[]; editable: boolean }) {
  const router = useRouter();
  return (
    <section aria-labelledby="customer-documents" className="flex flex-col gap-3">
      <h3 id="customer-documents" className="text-sm font-medium">
        {t("standing.title")}
      </h3>
      <p className="text-muted-foreground text-xs">{t("standing.hint")}</p>
      {STANDING_DOCUMENT_SLOTS.map((slot) => {
        const current = documents.find((d) => d.slot === slot);
        const label = t(`standing.slots.${slot}`);
        return (
          <div key={slot} className="grid grid-cols-[12rem_1fr] items-start gap-4">
            <div className="flex flex-col gap-1">
              <span className="font-medium">{label}</span>
              {current ? (
                <span className="text-xs">
                  <a href={`/api/files/${current.documentId}`} target="_blank" rel="noreferrer" className="underline">
                    {current.originalName}
                  </a>{" "}
                  <span className="text-muted-foreground">({formatTimestamp(current.uploadedAt)})</span>
                </span>
              ) : (
                <span className="text-xs text-amber-700 dark:text-amber-400">{t("standing.none")}</span>
              )}
            </div>
            {editable && (
              <FileDrop
                kind="STANDING"
                compact
                label={t("standing.upload", { slot: label })}
                onUploaded={async ([upload]) => {
                  if (!upload.response.ok) return void toast.error(uploadErrorText(upload.response));
                  if (!upload.response.document) return;
                  const result = await setStandingDocumentAction({ customerId, slot, documentId: upload.response.document.id });
                  if (!result.ok) return void toast.error(t(result.error, result.params));
                  toast.success(t("standing.saved"));
                  router.refresh();
                }}
              />
            )}
          </div>
        );
      })}
    </section>
  );
}
