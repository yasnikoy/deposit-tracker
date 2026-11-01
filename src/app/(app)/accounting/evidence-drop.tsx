"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FileDrop, uploadErrorText } from "@/components/file-drop";
import type { PaymentKind } from "@/domain/records";
import { t } from "@/i18n";
import { attachOpeningBalanceEvidenceAction } from "../admin/opening-balance/actions";
import { attachPaymentEvidenceAction, attachRefundEvidenceAction } from "./actions";

type Target = { paymentId: number; refundId?: never; blId?: never } | { refundId: number; paymentId?: never; blId?: never } | { blId: number; paymentId?: never; refundId?: never };

/** Attaches the receipt (bank) or invoice (offset) a payment, refund or migrated B/L was saved without (rule 12). */
export function EvidenceDrop({
  paymentId,
  refundId,
  blId,
  kind,
  compact = false,
}: { kind: PaymentKind; compact?: boolean } & Target) {
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
        const result =
          refundId !== undefined
            ? await attachRefundEvidenceAction({ refundId, documentId })
            : blId !== undefined
              ? await attachOpeningBalanceEvidenceAction({ blId, documentId })
              : await attachPaymentEvidenceAction({ paymentId, documentId });
        if (!result.ok) return void toast.error(t(result.error, result.params));
        toast.success(t("payments.evidenceAttached"));
        router.refresh();
      }}
    />
  );
}
