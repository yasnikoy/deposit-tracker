"use client";

import { Download, ExternalLink, Lock, Mail } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { FileDrop, uploadErrorText } from "@/components/file-drop";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";
import { formatBusinessDate, formatTimestamp } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { EmailDraft } from "@/server/email/compose";
import type { DueGroup, DueLists, DueRow, FailedRequest } from "@/server/requests";
import { generateBlFormAction, uploadBlFormAction } from "../bls/actions";
import { prepareEmailsAction, recordPortalRequestAction } from "./actions";
import { EmailPreviewDialog } from "./email-preview-dialog";

export type DueTab = "DUE" | "UPCOMING" | "FAILED";
const TABS: { tab: DueTab; href: string }[] = [
  { tab: "DUE", href: "/requests" },
  { tab: "UPCOMING", href: "/requests?tab=upcoming" },
  { tab: "FAILED", href: "/requests?tab=failed" },
];

/** A row can go into an email when it is an email request, has its form (if required) and nobody else is drafting it. */
const selectable = (row: DueRow, formRequired: boolean) => row.channel === "EMAIL" && (!formRequired || !!row.form) && !row.lockedBy;

/** Due (today and overdue) and upcoming requests, grouped by agency. */
export function DueRequestsScreen({
  tab,
  lists,
  today,
  canRecordPortal,
  canForms,
  canSend,
}: {
  tab: DueTab;
  lists: DueLists;
  today: string;
  canRecordPortal: boolean;
  canForms: boolean;
  canSend: boolean;
}) {
  const router = useRouter();
  const [portalRow, setPortalRow] = useState<DueRow | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [drafts, setDrafts] = useState<EmailDraft[] | null>(null);
  const [preparing, setPreparing] = useState(false);
  const count = (list: DueTab) => (list === "FAILED" ? lists.FAILED.length : lists[list].reduce((n, g) => n + g.rows.length, 0));
  const groups = tab === "FAILED" ? [] : lists[tab];
  // Selection only keeps rows that are still listed and selectable after a refresh.
  const selectableIds = new Set(groups.flatMap((g) => g.rows.filter((r) => selectable(r, lists.formRequired)).map((r) => r.blId)));
  const chosen = [...selected].filter((id) => selectableIds.has(id));

  const toggle = (ids: number[], on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const prepare = async (blIds: number[]) => {
    setPreparing(true);
    const result = await prepareEmailsAction({ blIds });
    setPreparing(false);
    if (!result.ok) return void toast.error(t(result.error, result.params));
    setDrafts(result.data);
  };

  return (
    <div className="flex flex-col gap-4">
      <nav className="flex gap-1 border-b">
        {TABS.map((item) => (
          <Link
            key={item.tab}
            href={item.href}
            aria-current={tab === item.tab ? "page" : undefined}
            className={cn("-mb-px border-b-2 px-3 py-1.5", tab === item.tab ? "border-primary font-medium" : "border-transparent")}
          >
            {t(`requests.tabs.${item.tab}`)} ({count(item.tab)})
          </Link>
        ))}
      </nav>
      {tab !== "FAILED" && (
        <div className="flex items-center gap-3">
          <p className="text-muted-foreground text-xs">
            {canSend && t("requests.selectHint")} {canSend && lists.formRequired && t("requests.formRequiredHint")}
          </p>
          {canSend && (
            <div className="ml-auto flex items-center gap-2">
              {chosen.length > 0 && <span className="text-sm">{t("requests.selectedTotal", { count: chosen.length })}</span>}
              <Button size="sm" onClick={() => prepare(chosen)} disabled={chosen.length === 0 || preparing}>
                <Mail /> {t("requests.prepare")}
              </Button>
            </div>
          )}
        </div>
      )}
      {tab === "FAILED" ? (
        <FailedList failed={lists.FAILED} onRetry={canSend ? (blId) => prepare([blId]) : undefined} />
      ) : (
        <>
          {groups.length === 0 && <p className="text-muted-foreground">{t(`requests.empty.${tab}`)}</p>}
          {groups.map((group) => (
            <AgencyGroup
              key={group.agencyId}
              group={group}
              formRequired={lists.formRequired}
              canRecordPortal={canRecordPortal}
              canForms={canForms}
              selection={canSend ? { selected, toggle } : null}
              onRecordPortal={setPortalRow}
            />
          ))}
        </>
      )}
      {portalRow && <PortalDialog row={portalRow} today={today} onClose={() => setPortalRow(null)} />}
      {drafts && (
        <EmailPreviewDialog
          drafts={drafts}
          onDone={() => {
            setDrafts(null);
            setSelected(new Set());
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function FailedList({ failed, onRetry }: { failed: FailedRequest[]; onRetry?: (blId: number) => void }) {
  if (failed.length === 0) return <p className="text-muted-foreground">{t("requests.empty.FAILED")}</p>;
  return (
    <table className="tabular w-full rounded-md border">
      <thead className="bg-muted/40 text-muted-foreground text-left text-xs">
        <tr>
          <th className="px-3 py-1 font-normal">{t("bls.blNo")}</th>
          <th className="px-3 py-1 font-normal">{t("bls.agency")}</th>
          <th className="px-3 py-1 font-normal">{t("requests.attempt")}</th>
          <th className="px-3 py-1 font-normal">{t("requests.failedAt")}</th>
          <th className="px-3 py-1 font-normal">{t("requests.failureReason")}</th>
          <th className="px-3 py-1 font-normal">{t("common.actions")}</th>
        </tr>
      </thead>
      <tbody>
        {failed.map((item) => (
          <tr key={item.requestId} className="border-t">
            <td className="px-3 py-1.5">
              <Link href={`/bls/${item.blId}`} className="font-mono hover:underline">
                {item.blNo}
              </Link>
            </td>
            <td className="px-3 py-1.5">{item.agencyName}</td>
            <td className="px-3 py-1.5">{item.attemptNo}</td>
            <td className="px-3 py-1.5">{formatTimestamp(item.queuedAt)}</td>
            <td className="text-destructive px-3 py-1.5 text-xs">{item.failureReason}</td>
            <td className="px-3 py-1.5">
              {onRetry && (
                <Button size="sm" variant="outline" onClick={() => onRetry(item.blId)}>
                  {t("requests.retry")}
                </Button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AgencyGroup({
  group,
  formRequired,
  canRecordPortal,
  canForms,
  selection,
  onRecordPortal,
}: {
  group: DueGroup;
  formRequired: boolean;
  canRecordPortal: boolean;
  canForms: boolean;
  selection: { selected: Set<number>; toggle: (ids: number[], on: boolean) => void } | null;
  onRecordPortal: (row: DueRow) => void;
}) {
  const ids = group.rows.filter((row) => selectable(row, formRequired)).map((row) => row.blId);
  const all = ids.length > 0 && ids.every((id) => selection?.selected.has(id));
  const some = ids.some((id) => selection?.selected.has(id));
  return (
    <section aria-label={group.agencyName} className="rounded-md border">
      <header className="bg-muted/40 flex flex-wrap items-center gap-3 border-b px-3 py-2">
        {selection && (
          <Checkbox
            aria-label={`${t("table.selectAll")} – ${group.agencyName}`}
            checked={all ? true : some ? "indeterminate" : false}
            disabled={ids.length === 0}
            onCheckedChange={(checked) => selection.toggle(ids, checked === true)}
          />
        )}
        <h2 className="font-semibold">{group.agencyName}</h2>
        <Badge variant="outline">{group.batchSending ? t("requests.batch") : t("requests.single")}</Badge>
        <span className="text-muted-foreground">{t("requests.blCount", { count: group.rows.length })}</span>
        <span className="tabular ml-auto font-medium">
          {group.totals.map((total) => formatMoney(total.amountMinor, total.currency)).join(" · ")}
        </span>
      </header>
      <table className="tabular w-full">
        <thead className="text-muted-foreground text-left text-xs">
          <tr>
            {selection && <th className="w-8 px-3 py-1" />}
            <th className="px-3 py-1 font-normal">{t("bls.blNo")}</th>
            <th className="px-3 py-1 font-normal">{t("requests.attempt")}</th>
            <th className="px-3 py-1 font-normal">{t("bls.paidAt")}</th>
            <th className="px-3 py-1 font-normal">{t("requests.dueDate")}</th>
            <th className="px-3 py-1 text-right font-normal">{t("bls.daysWaiting")}</th>
            <th className="px-3 py-1 font-normal">{t("bls.lastReply")}</th>
            <th className="px-3 py-1 text-right font-normal">{t("requests.amount")}</th>
            <th className="px-3 py-1 font-normal">{t("requests.form")}</th>
            <th className="px-3 py-1 font-normal">{t("common.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {group.rows.map((row) => (
            <tr key={row.blId} className="border-t" data-testid={`due-row-${row.blNo}`}>
              {selection && (
                <td className="px-3 py-1.5">
                  <Checkbox
                    aria-label={`${t("table.selectRow")} – ${row.blNo}`}
                    checked={selection.selected.has(row.blId)}
                    disabled={!selectable(row, formRequired)}
                    onCheckedChange={(checked) => selection.toggle([row.blId], checked === true)}
                  />
                </td>
              )}
              <td className="px-3 py-1.5">
                <Link href={`/bls/${row.blId}`} className="font-mono hover:underline">
                  {row.blNo}
                </Link>
                {row.lockedBy && (
                  <Badge variant="secondary" className="ml-2" title={t("requests.lockedBy", { user: row.lockedBy })}>
                    <Lock /> {t("requests.lockedBy", { user: row.lockedBy })}
                  </Badge>
                )}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap">
                <Badge variant={row.kind === "FIRST" ? "secondary" : "outline"}>{t(`requests.kinds.${row.kind}`)}</Badge> {row.attemptNo}
              </td>
              <td className="px-3 py-1.5">{formatBusinessDate(row.paidAt)}</td>
              <td className="px-3 py-1.5">{formatBusinessDate(row.dueDate)}</td>
              <td className="px-3 py-1.5 text-right">{row.daysWaiting}</td>
              <td className="px-3 py-1.5">
                {row.lastReply ? (
                  <span className="whitespace-nowrap">
                    {row.lastReply.typeName} <span className="text-muted-foreground text-xs">{formatBusinessDate(row.lastReply.repliedOn)}</span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">{t("common.none")}</span>
                )}
              </td>
              <td className="px-3 py-1.5 text-right whitespace-nowrap">{formatMoney(row.depositMinor, row.currency)}</td>
              <td className="px-3 py-1.5">
                <FormCell row={row} formRequired={formRequired} editable={canForms} />
              </td>
              <td className="px-3 py-1.5">
                {row.channel === "PORTAL" && (
                  <div className="flex items-center gap-2">
                    {group.portalUrl && (
                      <a href={group.portalUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
                        <ExternalLink className="size-3.5" /> {t("requests.openPortal")}
                      </a>
                    )}
                    {canRecordPortal && (
                      <Button size="sm" variant="outline" onClick={() => onRecordPortal(row)} disabled={formRequired && !row.form}>
                        {t("requests.recordPortal")}
                      </Button>
                    )}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** The uploaded form, or a prefilled download plus a drop target for the signed scan. */
function FormCell({ row, formRequired, editable }: { row: DueRow; formRequired: boolean; editable: boolean }) {
  const router = useRouter();
  if (row.form) {
    return (
      <a href={`/api/files/${row.form.id}`} target="_blank" rel="noreferrer" className="underline">
        {row.form.originalName}
      </a>
    );
  }
  if (!editable) return <span className={cn(formRequired && "text-amber-700 dark:text-amber-400")}>{t("requests.noForm")}</span>;

  const download = async () => {
    const result = await generateBlFormAction({ blId: row.blId });
    if (!result.ok) return void toast.error(t(result.error, result.params));
    if (result.data.bankAccountWarning) toast.warning(t(`forms.bankAccountWarning.${result.data.bankAccountWarning}`));
    const link = document.createElement("a");
    link.href = `/api/files/${result.data.documentId}`;
    link.download = result.data.originalName;
    link.click();
  };

  return (
    <div className="flex items-center gap-2">
      <Button size="icon" variant="ghost" className="size-7" onClick={download} aria-label={`${t("forms.download")} – ${row.blNo}`} title={t("forms.download")}>
        <Download />
      </Button>
      <FileDrop
        kind="FORM"
        compact
        label={`${t("forms.uploadForm")} – ${row.blNo}`}
        onUploaded={async ([upload]) => {
          if (!upload.response.ok) return void toast.error(uploadErrorText(upload.response));
          if (!upload.response.document) return;
          const result = await uploadBlFormAction({ blId: row.blId, documentId: upload.response.document.id });
          if (!result.ok) return void toast.error(t(result.error, result.params));
          toast.success(t("forms.formUploaded"));
          router.refresh();
        }}
      />
    </div>
  );
}

function PortalDialog({ row, today, onClose }: { row: DueRow; today: string; onClose: () => void }) {
  const router = useRouter();
  const [requestedOn, setRequestedOn] = useState(today);
  const [portalRef, setPortalRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    const result = await recordPortalRequestAction({ blId: row.blId, requestedOn, portalRef });
    setBusy(false);
    if (!result.ok) return setError(t(result.error, result.params));
    toast.success(t("requests.portalRecorded"));
    onClose();
    router.refresh();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("requests.recordPortalTitle", { bl: row.blNo })}</DialogTitle>
          <DialogDescription>{t("requests.recordPortalText")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="portal-date">{t("requests.requestedOn")}</Label>
            <Input id="portal-date" type="date" max={today} min={row.paidAt} value={requestedOn} onChange={(event) => setRequestedOn(event.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="portal-ref">{t("requests.portalRef")}</Label>
            <Input id="portal-ref" value={portalRef} onChange={(event) => setPortalRef(event.target.value)} />
          </div>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button onClick={save} disabled={busy || !requestedOn}>
            {t("requests.recordPortal")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
