"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";
import type { EmailDraft } from "@/server/email/compose";
import { cancelEmailsAction, queueEmailAction } from "./actions";

const toList = (text: string) =>
  text
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
const mb = (bytes: number) => (bytes / 1024 / 1024).toLocaleString("tr-TR", { maximumFractionDigits: 1 });

/**
 * Every email is shown before sending, one after the other; recipients, subject, body and
 * attachments can be changed for this send. Closing releases the remaining draft locks.
 */
export function EmailPreviewDialog({ drafts, onDone }: { drafts: EmailDraft[]; onDone: () => void }) {
  const [index, setIndex] = useState(0);
  const draft = drafts[index];

  const finish = async (fromIndex: number) => {
    const remaining = drafts.slice(fromIndex).flatMap((d) => d.items.map((i) => i.blId));
    if (remaining.length > 0) await cancelEmailsAction({ blIds: remaining });
    onDone();
  };
  const next = () => (index + 1 < drafts.length ? setIndex(index + 1) : finish(drafts.length));

  return (
    <Dialog open onOpenChange={(open) => !open && finish(index)}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {t("requests.preview")} – {draft.agencyName}
            {drafts.length > 1 && <span className="text-muted-foreground ml-2 text-sm font-normal">{t("requests.previewCount", { index: index + 1, count: drafts.length })}</span>}
          </DialogTitle>
          <DialogDescription>{draft.thread ? t("requests.reply") : null}</DialogDescription>
        </DialogHeader>
        <DraftForm key={index} draft={draft} onSent={next} onSkip={async () => {
          await cancelEmailsAction({ blIds: draft.items.map((i) => i.blId) });
          next();
        }} />
      </DialogContent>
    </Dialog>
  );
}

function DraftForm({ draft, onSent, onSkip }: { draft: EmailDraft; onSent: () => void; onSkip: () => void }) {
  const [to, setTo] = useState(draft.to.join(", "));
  const [cc, setCc] = useState(draft.cc.join(", "));
  const [bcc, setBcc] = useState(draft.bcc.join(", "));
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [kept, setKept] = useState<Set<number>>(() => new Set(draft.attachments.map((a) => a.documentId)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Rule 12: B/Ls whose payment lacks its receipt or invoice go only after an explicit confirmation.
  const [evidenceConfirmed, setEvidenceConfirmed] = useState(false);
  const evidenceMissing = draft.missingEvidence.length > 0;
  // A portal agency's first request: filed on the portal, then its documents go by this email.
  const [portalFiled, setPortalFiled] = useState(false);
  const portalFiling = draft.portalFiling.length > 0;

  const totalBytes = draft.attachments.filter((a) => kept.has(a.documentId)).reduce((sum, a) => sum + a.sizeBytes, 0);
  const tooLarge = totalBytes > draft.maxAttachmentBytes;

  const send = async () => {
    setBusy(true);
    setError(null);
    const result = await queueEmailAction({
      blIds: draft.items.map((i) => i.blId),
      to: toList(to),
      cc: toList(cc),
      bcc: toList(bcc),
      subject,
      body,
      documentIds: [...kept],
      confirmMissingEvidence: evidenceConfirmed,
      confirmPortalFiled: portalFiled,
    });
    setBusy(false);
    if (!result.ok) {
      const field = result.fieldErrors ? Object.values(result.fieldErrors)[0] : undefined;
      return setError(t(field ?? result.error, result.params));
    }
    toast.success(t("requests.queued"));
    onSent();
  };

  const field = (id: string, label: string, value: string, set: (v: string) => void) => (
    <div className="grid grid-cols-[6rem_1fr] items-center gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} className="h-8" value={value} onChange={(event) => set(event.target.value)} />
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-xs">{t("requests.covers")}:</span>
        {draft.items.map((item) => (
          <Badge key={item.blId} variant="outline" className="font-mono">
            {item.blNo} · {t(`requests.kinds.${item.type}.${item.kind}`)} {item.attemptNo}
          </Badge>
        ))}
      </div>
      {field("email-to", t("requests.to"), to, setTo)}
      {field("email-cc", t("requests.cc"), cc, setCc)}
      {field("email-bcc", t("requests.bcc"), bcc, setBcc)}
      {field("email-subject", t("requests.subject"), subject, setSubject)}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email-body">{t("requests.body")}</Label>
        <textarea
          id="email-body"
          rows={12}
          className="border-input bg-background rounded-md border px-2 py-1 text-sm"
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
      </div>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-sm font-medium">{t("requests.attachments")}</legend>
        {draft.attachments.map((attachment) => (
          <label key={attachment.documentId} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={kept.has(attachment.documentId)}
              onCheckedChange={(checked) =>
                setKept((current) => {
                  const nextSet = new Set(current);
                  if (checked) nextSet.add(attachment.documentId);
                  else nextSet.delete(attachment.documentId);
                  return nextSet;
                })
              }
            />
            <a href={`/api/files/${attachment.documentId}`} target="_blank" rel="noreferrer" className="underline">
              {attachment.originalName}
            </a>
            <span className="text-muted-foreground text-xs">
              {attachment.blNo ?? t("standing.title")} · {mb(attachment.sizeBytes)} MB
            </span>
          </label>
        ))}
        <span className={tooLarge ? "text-destructive text-xs" : "text-muted-foreground text-xs"}>
          {t("requests.attachmentsTotal", { size: mb(totalBytes), max: mb(draft.maxAttachmentBytes) })}
        </span>
      </fieldset>
      {portalFiling && (
        <div role="alert" className="flex flex-col gap-2 rounded-md border border-sky-300 bg-sky-50 p-3 text-sm text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100">
          <span>{t("requests.portalFiling", { bls: draft.portalFiling.join(", ") })}</span>
          {draft.portalUrl && (
            <a href={draft.portalUrl} target="_blank" rel="noreferrer" className="underline">
              {t("requests.openPortal")}
            </a>
          )}
          <label className="flex items-center gap-2">
            <Checkbox checked={portalFiled} onCheckedChange={(checked) => setPortalFiled(checked === true)} />
            {t("requests.portalFiledConfirm")}
          </label>
        </div>
      )}
      {evidenceMissing && (
        <div role="alert" className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <span>{t("requests.evidenceWarning", { bls: draft.missingEvidence.join(", ") })}</span>
          <label className="flex items-center gap-2">
            <Checkbox checked={evidenceConfirmed} onCheckedChange={(checked) => setEvidenceConfirmed(checked === true)} />
            {t("requests.evidenceConfirm")}
          </label>
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={onSkip} disabled={busy}>
          {t("requests.skip")}
        </Button>
        <Button onClick={send} disabled={busy || tooLarge || (evidenceMissing && !evidenceConfirmed) || (portalFiling && !portalFiled)}>
          {t("requests.send")}
        </Button>
      </DialogFooter>
    </div>
  );
}
