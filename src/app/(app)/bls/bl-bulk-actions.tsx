"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { releaseHoldAction } from "./actions";
import { HoldDialog } from "./[id]/hold-dialog";
import { ArchiveEmailDialog, RecordReplyDialog, RecordRequestDialog, UnitDialog } from "./bl-work-dialogs";

/** A selected B/L, as both Talepler and B/L'ler know it. */
export type BulkBl = { id: number; blNo: string; agencyId: number; held: boolean };

/** What the bulk actions need from the server; null on a page where the user can do none. */
export type BulkOptions = {
  replyTypes: { id: number; name: string }[];
  holdReasons: { id: number; name: string }[];
  /** Active units per agency, for agencies that have them. */
  units: Record<number, { id: number; name: string }[]>;
  today: string;
  can: { recordReply: boolean; recordRequest: boolean; hold: boolean; setUnit: boolean; archive: boolean };
};

type Dialog = "reply" | "request" | "hold" | "release" | "unit" | "archive";

/**
 * The B/L detail's everyday actions on the selected rows: an agency's reply or status news often
 * covers several B/Ls in one email. Each opens its dialog listing the B/Ls (rule 11); the server
 * checks every B/L and saves all or none.
 */
export function BlBulkActions({ bls, options, onDone }: { bls: BulkBl[]; options: BulkOptions; onDone: () => void }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const { can } = options;
  const none = bls.length === 0;
  const agencyId = !none && bls.every((b) => b.agencyId === bls[0].agencyId) ? bls[0].agencyId : null;
  const units = agencyId === null ? [] : (options.units[agencyId] ?? []);
  const close = () => setDialog(null);
  const finish = () => {
    setDialog(null);
    onDone();
    router.refresh();
  };

  return (
    <>
      {can.recordReply && (
        <Button size="sm" variant="outline" disabled={none} onClick={() => setDialog("reply")}>
          {t("blReplies.record")}
        </Button>
      )}
      {can.recordRequest && (
        <Button size="sm" variant="outline" disabled={none} onClick={() => setDialog("request")}>
          {t("blReplies.recordRequest")}
        </Button>
      )}
      {can.hold && (
        <Button size="sm" variant="outline" disabled={none} onClick={() => setDialog("hold")}>
          {t("holds.action")}
        </Button>
      )}
      {can.hold && !none && bls.every((b) => b.held) && (
        <Button size="sm" variant="outline" onClick={() => setDialog("release")}>
          {t("holds.release")}
        </Button>
      )}
      {can.setUnit && Object.keys(options.units).length > 0 && (
        <Button size="sm" variant="outline" disabled={units.length === 0} title={units.length === 0 ? t("bulk.unitOneAgency") : undefined} onClick={() => setDialog("unit")}>
          {t("bulk.unit")}
        </Button>
      )}
      {can.archive && (
        <Button size="sm" variant="outline" disabled={agencyId === null} title={agencyId === null && !none ? t("bulk.archiveOneAgency") : undefined} onClick={() => setDialog("archive")}>
          {t("bulk.archive")}
        </Button>
      )}

      {dialog === "reply" && <RecordReplyDialog bls={bls} replyTypes={options.replyTypes} today={options.today} onCancel={close} onDone={finish} />}
      {dialog === "request" && <RecordRequestDialog bls={bls} today={options.today} onCancel={close} onDone={finish} />}
      {dialog === "hold" && <HoldDialog bls={bls} reasons={options.holdReasons} today={options.today} onCancel={close} onDone={finish} />}
      {dialog === "unit" && <UnitDialog bls={bls} units={units} onCancel={close} onDone={finish} />}
      {dialog === "archive" && <ArchiveEmailDialog bls={bls} onRecordReply={can.recordReply ? () => setDialog("reply") : null} onCancel={close} onDone={finish} />}
      {dialog === "release" && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && close()}
          title={t("holds.release")}
          description={t("bulk.releaseConfirm")}
          items={bls.map((b) => b.blNo)}
          confirmLabel={t("holds.release")}
          onConfirm={async () => {
            const result = await releaseHoldAction({ blIds: bls.map((b) => b.id) });
            if (!result.ok) return void toast.error(t(result.error, result.params));
            toast.success(t("holds.released"));
            finish();
          }}
        />
      )}
    </>
  );
}
