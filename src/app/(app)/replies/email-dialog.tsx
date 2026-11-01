"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DetailDialog } from "@/components/detail-dialog";
import { toastWithUndo } from "@/components/undo-toast";
import { t } from "@/i18n";
import type { ReplyDetail } from "@/server/replies";
import { DeductionDialog, type DeductionTypeOption } from "../bls/deduction-dialog";
import { acceptSuggestionAction, dismissSuggestionAction, recordEmailRepliesAction, replyDetailAction } from "./actions";
import { ReplyDetailView, type ReplyTypeOption } from "./replies-screen";

type Link = ReplyDetail["links"][number];

/**
 * One email of a B/L opened in place (from the B/L detail): the message, and for an incoming one
 * the quick reply-type buttons, suggestions and deductions, as on the Replies screen.
 */
export function EmailDialog({
  emailId,
  replyTypes,
  deductionTypes,
  canRecord,
  canLink,
  canRecordDeduction,
  onClose,
}: {
  emailId: number;
  replyTypes: ReplyTypeOption[];
  deductionTypes: DeductionTypeOption[];
  canRecord: boolean;
  canLink: boolean;
  canRecordDeduction: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [detail, setDetail] = useState<ReplyDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [deducting, setDeducting] = useState<Link | null>(null);
  const [applyAll, setApplyAll] = useState<ReplyTypeOption | null>(null);

  const load = useCallback(async () => {
    const result = await replyDetailAction({ emailId });
    if (!result.ok) {
      toast.error(t(result.error, result.params));
      return onClose();
    }
    setDetail(result.data);
  }, [emailId, onClose]);

  useEffect(() => {
    let live = true;
    replyDetailAction({ emailId }).then((result) => {
      if (!live) return;
      if (!result.ok) {
        toast.error(t(result.error, result.params));
        return onClose();
      }
      setDetail(result.data);
    });
    return () => {
      live = false;
    };
  }, [emailId, onClose]);

  const changed = async () => {
    router.refresh();
    await load();
  };

  const record = async (blIds: number[], replyTypeId: number) => {
    setBusy(true);
    const result = await recordEmailRepliesAction({ items: blIds.map((blId) => ({ emailId, blId })), replyTypeId });
    setBusy(false);
    if (!result.ok) return void toast.error(t(result.error, result.params));
    toastWithUndo(t("replies.recorded", { count: result.data.length }), result.data, () => void changed());
    await changed();
  };

  const suggestion = async (action: "accept" | "dismiss", blId: number) => {
    setBusy(true);
    const result = action === "accept" ? await acceptSuggestionAction({ emailId, blId }) : await dismissSuggestionAction({ emailId, blId });
    setBusy(false);
    if (!result.ok) return void toast.error(t(result.error, result.params));
    toast.success(t(action === "accept" ? "replies.linked" : "replies.dismissed"));
    await changed();
  };

  const incoming = detail?.email.direction === "IN";
  const pending = detail ? detail.links.filter((l) => !l.reply && !l.voided) : [];

  return (
    <>
      <DetailDialog title={detail ? detail.email.subject || t("replies.noSubject") : t("common.loading")} navigation={null} onClose={onClose}>
        {detail ? (
          <ReplyDetailView
            detail={detail}
            replyTypes={replyTypes}
            canRecord={canRecord && incoming}
            canLink={canLink && incoming}
            canRecordDeduction={canRecordDeduction}
            onDeductions={setDeducting}
            busy={busy}
            onRecord={(blId, replyTypeId) => void record([blId], replyTypeId)}
            onApplyToAll={setApplyAll}
            onSuggestion={(action, blId) => void suggestion(action, blId)}
          />
        ) : (
          <p className="text-muted-foreground">{t("common.loading")}</p>
        )}
      </DetailDialog>

      {deducting?.deductionTarget && detail && (
        <DeductionDialog
          bl={{ id: deducting.blId, blNo: deducting.blNo, currency: deducting.currency }}
          target={deducting.deductionTarget}
          deductionTypes={deductionTypes}
          statements={detail.attachments.map((a) => ({ documentId: a.documentId, originalName: a.originalName }))}
          onCancel={() => setDeducting(null)}
          onDone={() => {
            setDeducting(null);
            void changed();
          }}
        />
      )}

      {applyAll && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setApplyAll(null)}
          title={t("replies.confirmTitle", { type: applyAll.name })}
          description={t("replies.confirmDescription", { count: pending.length })}
          items={pending.map((l) => l.blNo)}
          confirmLabel={t("replies.confirmRecord")}
          onConfirm={async () => {
            await record(
              pending.map((l) => l.blId),
              applyAll.id,
            );
            setApplyAll(null);
          }}
        />
      )}
    </>
  );
}
