"use client";

import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { FileDrop, uploadErrorText } from "@/components/file-drop";
import { toastWithUndo } from "@/components/undo-toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";
import { recordReplyWithoutEmailAction, setBlUnitAction } from "./actions";
import { recordOutsideRequestAction } from "../requests/actions";

/** A B/L one of these dialogs acts on; the number is shown when several are selected. */
export type AffectedBl = { id: number; blNo?: string };

/**
 * The B/Ls a bulk action touches, listed before it runs (rule 11). Nothing for one B/L: on its
 * detail it is the page itself.
 */
export function AffectedBlList({ bls }: { bls: AffectedBl[] }) {
  if (bls.length < 2) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium">{t("bulk.affected", { count: bls.length })}</span>
      <ul className="bg-muted max-h-32 overflow-auto rounded-md px-3 py-1.5 font-mono text-xs">
        {bls.map((b) => (
          <li key={b.id}>{b.blNo}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A reply that did not come by email (e.g. read on the agency portal); it counts like one.
 * Date and note first, then one click on the reply type saves it. One reply often covers several
 * B/Ls, so the lists record it on the selected rows at once.
 */
export function RecordReplyDialog({
  bls,
  replyTypes,
  today,
  onCancel,
  onDone,
}: {
  bls: AffectedBl[];
  replyTypes: { id: number; name: string }[];
  today: string;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [repliedOn, setRepliedOn] = useState(today);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (replyTypeId: number) => {
    setBusy(true);
    const result = await recordReplyWithoutEmailAction({ blIds: bls.map((b) => b.id), replyTypeId, repliedOn, note });
    setBusy(false);
    if (!result.ok) return setError(t(result.error, result.params));
    toastWithUndo(t("blReplies.recorded"), result.data, onDone);
    onDone();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <div className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("blReplies.record")}</DialogTitle>
            <DialogDescription>{t("blReplies.recordHint")}</DialogDescription>
          </DialogHeader>
          <AffectedBlList bls={bls} />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reply-date">{t("blReplies.date")}</Label>
            <Input id="reply-date" type="date" value={repliedOn} max={today} onChange={(event) => setRepliedOn(event.target.value)} className="w-44" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reply-note">{t("blReplies.note")}</Label>
            <textarea
              id="reply-note"
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={t("blReplies.notePlaceholder")}
              className="border-input bg-background rounded-md border px-2 py-1 text-sm"
            />
          </div>
          <div role="group" aria-labelledby="reply-types" className="flex flex-col gap-1.5">
            <span id="reply-types" className="text-sm font-medium">
              {t("blReplies.type")} <span className="text-muted-foreground font-normal">{t("blReplies.typeSaves")}</span>
            </span>
            <div className="flex flex-wrap gap-2">
              {replyTypes.map((type) => (
                <Button key={type.id} type="button" variant="outline" size="sm" disabled={busy} onClick={() => save(type.id)}>
                  {type.name}
                </Button>
              ))}
            </div>
          </div>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
              {t("common.cancel")}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A refund request made outside the app (by phone, another mailbox); it counts like a sent one. */
export function RecordRequestDialog({ bls, today, onCancel, onDone }: { bls: AffectedBl[]; today: string; onCancel: () => void; onDone: () => void }) {
  const [requestedOn, setRequestedOn] = useState(today);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const result = await recordOutsideRequestAction({ blIds: bls.map((b) => b.id), requestedOn, note });
    setBusy(false);
    if (!result.ok) return setError(t(result.error, result.params));
    toast.success(t("blReplies.requestRecorded"));
    onDone();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <form onSubmit={save} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("blReplies.recordRequest")}</DialogTitle>
            <DialogDescription>{t("blReplies.recordRequestHint")}</DialogDescription>
          </DialogHeader>
          <AffectedBlList bls={bls} />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="request-date">{t("blReplies.requestDate")}</Label>
            <Input id="request-date" type="date" value={requestedOn} max={today} onChange={(event) => setRequestedOn(event.target.value)} className="w-44" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="request-note">
              {t("blReplies.note")} <span className="text-muted-foreground font-normal">{t("common.optional")}</span>
            </Label>
            <textarea
              id="request-note"
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={t("blReplies.requestNotePlaceholder")}
              className="border-input bg-background rounded-md border px-2 py-1 text-sm"
            />
          </div>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {t("blReplies.saveRequest")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Birim seç: the unit the selected B/Ls' requests go to, from their agency's active units. */
export function UnitDialog({
  bls,
  units,
  onCancel,
  onDone,
}: {
  bls: AffectedBl[];
  units: { id: number; name: string }[];
  onCancel: () => void;
  onDone: () => void;
}) {
  const [unitId, setUnitId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (unitId === null) return;
    setBusy(true);
    const result = await setBlUnitAction({ blIds: bls.map((b) => b.id), unitId });
    setBusy(false);
    if (!result.ok) return setError(t(result.error, result.params));
    toast.success(t("bulk.unitSaved"));
    onDone();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <form onSubmit={save} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("bulk.unit")}</DialogTitle>
            <DialogDescription>{t("bulk.unitHint")}</DialogDescription>
          </DialogHeader>
          <AffectedBlList bls={bls} />
          <div className="flex w-56 flex-col gap-1.5">
            <Label htmlFor="bulk-unit">{t("bls.unit")}</Label>
            <select
              id="bulk-unit"
              className="border-input bg-background h-9 rounded-md border px-2"
              value={unitId ?? ""}
              onChange={(event) => setUnitId(event.target.value ? Number(event.target.value) : null)}
              autoFocus
            >
              <option value="">{t("bls.unitPick")}</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy || unitId === null}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * E-posta arşivle: one email from Outlook dropped once and archived on every selected B/L (an
 * agency often answers for several in one email). Afterwards the reply it brings can be recorded
 * on the same B/Ls; the app never reads it for them (rule 10).
 */
export function ArchiveEmailDialog({
  bls,
  onRecordReply,
  onCancel,
  onDone,
}: {
  bls: AffectedBl[];
  /** Offered once the email is archived; null when the user cannot record replies. */
  onRecordReply: (() => void) | null;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [archived, setArchived] = useState(false);

  return (
    <Dialog open onOpenChange={(open) => !open && (archived ? onDone() : onCancel())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("bulk.archive")}</DialogTitle>
          <DialogDescription>{t("bulk.archiveHint")}</DialogDescription>
        </DialogHeader>
        <AffectedBlList bls={bls} />
        {archived ? (
          <p className="text-sm">{t("bulk.archiveThenReply")}</p>
        ) : (
          <div className="flex flex-col gap-1">
            <FileDrop
              kind="EMAIL"
              blIds={bls.map((b) => b.id)}
              multiple
              accept=".eml,.msg"
              label={t("archive.drop")}
              onUploaded={(results) => {
                const auditIds = results.flatMap((r) => (r.response.ok ? (r.response.auditIds ?? []) : []));
                for (const r of results) if (!r.response.ok) toast.error(`${r.file.name}: ${uploadErrorText(r.response)}`);
                if (auditIds.length > 0) {
                  toastWithUndo(t("archive.saved"), auditIds, onDone);
                  setArchived(true);
                }
              }}
            />
            <span className="text-muted-foreground text-xs">{t("archive.hint")}</span>
          </div>
        )}
        <DialogFooter>
          {archived ? (
            <>
              <Button type="button" variant="ghost" onClick={onDone}>
                {t("common.close")}
              </Button>
              {onRecordReply && (
                <Button type="button" onClick={onRecordReply}>
                  {t("blReplies.record")}
                </Button>
              )}
            </>
          ) : (
            <Button type="button" variant="ghost" onClick={onCancel}>
              {t("common.cancel")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
