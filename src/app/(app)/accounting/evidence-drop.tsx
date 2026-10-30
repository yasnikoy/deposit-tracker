"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FileDrop, uploadErrorText } from "@/components/file-drop";
import type { PaymentKind } from "@/domain/records";
import { t } from "@/i18n";
import { attachPaymentEvidenceAction } from "./actions";

/** Attaches the receipt (bank) or invoice (offset) a payment was saved without (rule 12). */
export function EvidenceDrop({ paymentId, kind, compact = false }: { paymentId: number; kind: PaymentKind; compact?: boolean }) {
  const router = useRouter();
  return (
    <FileDrop
      kind={kind === "BANK" ? "RECEIPT" : "INVOICE"}
      compact={compact}
      label={t(`payments.attachEvidence.${kind}`)}
      onUploaded={async ([upload]) => {
        if (!upload.response.ok) return void toast.error(uploadErrorText(upload.response));
        if (!upload.response.document) return;
        const result = await attachPaymentEvidenceAction({ paymentId, documentId: upload.response.document.id });
        if (!result.ok) return void toast.error(t(result.error, result.params));
        toast.success(t("payments.evidenceAttached"));
        router.refresh();
      }}
    />
  );
}
