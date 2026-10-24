"use client";

import { Download, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { FileDrop, uploadErrorText } from "@/components/file-drop";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";
import { formatBusinessDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { DueGroup, DueLists, DueRow } from "@/server/requests";
import { generateBlFormAction, uploadBlFormAction } from "../bls/actions";
import { recordPortalRequestAction } from "./actions";

export type DueTab = "DUE" | "UPCOMING";

/** Due (today and overdue) and upcoming requests, grouped by agency. */
export function DueRequestsScreen({
  tab,
  lists,
  today,
  canRecordPortal,
  canForms,
}: {
  tab: DueTab;
  lists: DueLists;
  today: string;
  canRecordPortal: boolean;
  canForms: boolean;
}) {
  const [portalRow, setPortalRow] = useState<DueRow | null>(null);
  const count = (list: DueTab) => lists[list].reduce((n, g) => n + g.rows.length, 0);
  const groups = lists[tab];

  return (
    <div className="flex flex-col gap-4">
      <nav className="flex gap-1 border-b">
        {(["DUE", "UPCOMING"] as const).map((item) => (
          <Link
            key={item}
            href={item === "DUE" ? "/requests" : "/requests?tab=upcoming"}
            aria-current={tab === item ? "page" : undefined}
            className={cn("-mb-px border-b-2 px-3 py-1.5", tab === item ? "border-primary font-medium" : "border-transparent")}
          >
            {t(`requests.tabs.${item}`)} ({count(item)})
          </Link>
        ))}
      </nav>
      {lists.formRequired && <p className="text-muted-foreground text-xs">{t("requests.formRequiredHint")}</p>}
      {groups.length === 0 && <p className="text-muted-foreground">{t(`requests.empty.${tab}`)}</p>}
      {groups.map((group) => (
        <AgencyGroup
          key={group.agencyId}
          group={group}
          formRequired={lists.formRequired}
          canRecordPortal={canRecordPortal}
          canForms={canForms}
          onRecordPortal={setPortalRow}
        />
      ))}
      {portalRow && <PortalDialog row={portalRow} today={today} onClose={() => setPortalRow(null)} />}
    </div>
  );
}

function AgencyGroup({
  group,
  formRequired,
  canRecordPortal,
  canForms,
  onRecordPortal,
}: {
  group: DueGroup;
  formRequired: boolean;
  canRecordPortal: boolean;
  canForms: boolean;
  onRecordPortal: (row: DueRow) => void;
}) {
  return (
    <section aria-label={group.agencyName} className="rounded-md border">
      <header className="bg-muted/40 flex flex-wrap items-center gap-3 border-b px-3 py-2">
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
            <th className="px-3 py-1 font-normal">{t("bls.blNo")}</th>
            <th className="px-3 py-1 font-normal">{t("requests.attempt")}</th>
            <th className="px-3 py-1 font-normal">{t("bls.paidAt")}</th>
            <th className="px-3 py-1 font-normal">{t("requests.dueDate")}</th>
            <th className="px-3 py-1 text-right font-normal">{t("bls.daysWaiting")}</th>
            <th className="px-3 py-1 text-right font-normal">{t("requests.amount")}</th>
            <th className="px-3 py-1 font-normal">{t("requests.form")}</th>
            <th className="px-3 py-1 font-normal">{t("common.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {group.rows.map((row) => (
            <tr key={row.blId} className="border-t" data-testid={`due-row-${row.blNo}`}>
              <td className="px-3 py-1.5">
                <Link href={`/bls/${row.blId}`} className="font-mono hover:underline">
                  {row.blNo}
                </Link>
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap">
                <Badge variant={row.kind === "FIRST" ? "secondary" : "outline"}>{t(`requests.kinds.${row.kind}`)}</Badge> {row.attemptNo}
              </td>
              <td className="px-3 py-1.5">{formatBusinessDate(row.paidAt)}</td>
              <td className="px-3 py-1.5">{formatBusinessDate(row.dueDate)}</td>
              <td className="px-3 py-1.5 text-right">{row.daysWaiting}</td>
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
