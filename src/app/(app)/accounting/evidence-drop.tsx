"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FileDrop, uploadErrorText } from "@/components/file-drop";
import type { PaymentKind } from "@/domain/records";
import { t } from "@/i18n";
import { attachPaymentEvidenceAction, attachRefundEvidenceAction } from "./actions";

/** Attaches the receipt (bank) or invoice (offset) a payment or refund was saved without (rule 12). */
export function EvidenceDrop({
  paymentId,
  refundId,
  kind,
  compact = false,
}: { kind: PaymentKind; compact?: boolean } & ({ paymentId: number; refundId?: never } | { refundId: number; paymentId?: never })) {
  const router = useRouter();
  return (
    <FileDrop
      kind={kind === "BANK" ? "RECEIPT" : "INVOICE"}
      compact={compact}
      label={t(`payments.attachEvidence.${kind}`)}
      onUploaded={async ([upload]) => {
        if (!upload.response.ok) return void toast.error(uploadErrorText(upload.response));
        if (!upload.response.document) return;
        const documentId = upload.response.document.id;
        const result = refundId !== undefined ? await attachRefundEvidenceAction({ refundId, documentId }) : await attachPaymentEvidenceAction({ paymentId, documentId });
        if (!result.ok) return void toast.error(t(result.error, result.params));
        toast.success(t("payments.evidenceAttached"));
        router.refresh();
      }}
    />
  );
}
