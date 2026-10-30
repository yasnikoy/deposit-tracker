"use client";

import { Paperclip } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { toastWithUndo } from "@/components/undo-toast";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataTable } from "@/components/data-table/data-table";
import { dataTableColumns } from "@/components/data-table/features";
import { DetailDialog, detailNavigation } from "@/components/detail-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ReplyTypeCode } from "@/domain/replies";
import { t } from "@/i18n";
import { formatBusinessDate, formatTimestamp } from "@/lib/format";
import type { TableLayout } from "@/lib/schemas/table-layout";
import { cn } from "@/lib/utils";
import type { ReplyDetail, ReplyListRow, ReplyLists } from "@/server/replies";
import { DeductionDialog, type DeductionTypeOption } from "../bls/deduction-dialog";
import { acceptSuggestionAction, dismissSuggestionAction, recordEmailRepliesAction, replyDetailAction } from "./actions";

export type ReplyTab = keyof ReplyLists;
export type ReplyTypeOption = { id: number; name: string; code: ReplyTypeCode | null };

const TABS: { tab: ReplyTab; href: string }[] = [
  { tab: "TO_PROCESS", href: "/replies" },
  { tab: "MATCHES", href: "/replies?tab=matches" },
  { tab: "PROCESSED", href: "/replies?tab=processed" },
];

const col = dataTableColumns<ReplyListRow>();
const columns = col.columns([
  col.accessor("receivedAt", {
    meta: { label: "replies.receivedAt", toText: (v) => formatTimestamp(v as string) },
    sortFn: "basic",
    cell: ({ row }) => (
      <span className="inline-flex items-center gap-2 whitespace-nowrap">
        {formatTimestamp(row.original.receivedAt)}
        {row.original.overdue && <Badge variant="destructive">{t("replies.overdue")}</Badge>}
      </span>
    ),
  }),
  col.accessor((r) => r.agencyName ?? "", { id: "agency", meta: { label: "replies.agency", filter: "text" }, sortFn: "turkishText" }),
  col.accessor("from", { meta: { label: "replies.from", filter: "text" }, sortFn: "turkishText" }),
  col.accessor("subject", {
    meta: { label: "replies.subject", filter: "text" },
    sortFn: "turkishText",
    cell: ({ row }) => (
      <span className="inline-flex items-center gap-1">
        {row.original.subject || t("replies.noSubject")}
        {row.original.attachments > 0 && <Paperclip className="text-muted-foreground size-3.5" aria-label={t("replies.hasAttachments")} />}
      </span>
    ),
  }),
  col.accessor((r) => r.blNos.join(", "), {
    id: "bls",
    meta: { label: "replies.bls", filter: "text" },
    cell: ({ getValue }) => <span className="font-mono text-xs">{getValue()}</span>,
  }),
]);

type BulkConfirm = { replyType: ReplyTypeOption; items: { emailId: number; blId: number; blNo: string }[]; clear?: () => void };

/** Agency replies are read here instead of Outlook; operations records the reply type per B/L. */
export function RepliesScreen({
  tab,
  lists,
  initialDetail,
  replyTypes,
  layout,
  canRecord,
  canLink,
  deductionTypes,
  canRecordDeduction,
}: {
  tab: ReplyTab;
  lists: ReplyLists;
  /** An email to show right away, when the page was opened for it. */
  initialDetail: ReplyDetail | null;
  replyTypes: ReplyTypeOption[];
  layout: TableLayout | null;
  canRecord: boolean;
  canLink: boolean;
  deductionTypes: DeductionTypeOption[];
  canRecordDeduction: boolean;
}) {
  const router = useRouter();
  const rows = lists[tab];
  // The linked B/L whose deductions from this email's statement are being entered.
  const [deducting, setDeducting] = useState<ReplyDetail["links"][number] | null>(null);
  const [openId, setOpenId] = useState<number | null>(initialDetail?.email.id ?? null);
  const [detail, setDetail] = useState<ReplyDetail | null>(initialDetail);
  // The table's order when the email was opened, for previous/next.
  const [order, setOrder] = useState<string[]>(() => rows.map((r) => String(r.emailId)));
  const [confirm, setConfirm] = useState<BulkConfirm | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (emailId: number) => {
    const result = await replyDetailAction({ emailId });
    if (!result.ok) return void toast.error(t(result.error, result.params));
    setDetail(result.data);
  }, []);

  const open = (emailId: number | null) => {
    setOpenId(emailId);
    setDetail(null);
    if (emailId !== null) void load(emailId);
  };

  const refresh = async () => {
    router.refresh();
    if (openId !== null) await load(openId);
  };

  /** The next email in the opened order that still waits for a reply type (wrapping around). */
  const nextPending = (current: number): number | null => {
    const index = order.indexOf(String(current));
    const candidates = [...order.slice(index + 1), ...order.slice(0, Math.max(0, index))];
    const id = candidates.find((c) => lists.TO_PROCESS.some((r) => String(r.emailId) === c && r.emailId !== current));
    return id === undefined ? null : Number(id);
  };

  const record = async (items: { emailId: number; blId: number }[], replyTypeId: number) => {
    setBusy(true);
    const result = await recordEmailRepliesAction({ items, replyTypeId });
    setBusy(false);
    if (!result.ok) return void toast.error(t(result.error, result.params));
    toastWithUndo(t("replies.recorded", { count: result.data.length }), result.data, () => void refresh());
    router.refresh();
    if (openId === null) return;
    const fresh = await replyDetailAction({ emailId: openId });
    if (!fresh.ok) return void toast.error(t(fresh.error, fresh.params));
    // Once this email is fully processed, the next unprocessed one opens.
    if (tab === "TO_PROCESS" && fresh.data.links.every((l) => l.reply || l.voided)) {
      const next = nextPending(openId);
      if (next !== null) return open(next);
      toast.success(t("replies.allProcessed"));
      return open(null);
    }
    setDetail(fresh.data);
  };

  const suggestion = async (action: "accept" | "dismiss", emailId: number, blId: number) => {
    setBusy(true);
    if (action === "accept") {
      const result = await acceptSuggestionAction({ emailId, blId });
      setBusy(false);
      if (!result.ok) return void toast.error(t(result.error, result.params));
      toastWithUndo(t("replies.linked"), result.data, () => void refresh());
    } else {
      const result = await dismissSuggestionAction({ emailId, blId });
      setBusy(false);
      if (!result.ok) return void toast.error(t(result.error, result.params));
      toast.success(t("replies.dismissed"));
    }
    await refresh();
  };

  return (
    <div className="flex flex-col gap-3">
      <nav className="flex gap-1 border-b">
        {TABS.map((item) => (
          <Link
            key={item.tab}
            href={item.href}
            aria-current={tab === item.tab ? "page" : undefined}
            className={cn("-mb-px border-b-2 px-3 py-1.5", tab === item.tab ? "border-primary font-medium" : "border-transparent")}
          >
            {t(`replies.tabs.${item.tab}`)} ({lists[item.tab].length})
          </Link>
        ))}
      </nav>
      <p className="text-muted-foreground text-sm">{t(`replies.hints.${tab}`)}</p>

      <div>
        <DataTable
          key={tab}
          tableId="replies"
          data={rows}
          columns={columns}
          getRowId={(r) => String(r.emailId)}
          initialLayout={layout}
          onOpenRow={(r, visible) => {
            setOrder(visible.map((v) => String(v.emailId)));
            open(r.emailId);
          }}
          rowClassName={(r) => (r.emailId === openId ? "bg-muted" : undefined)}
          bulkActions={
            tab === "TO_PROCESS" && canRecord
              ? (selected, clear) => (
                  <BulkReplyButtons
                    replyTypes={replyTypes}
                    disabled={busy}
                    onChoose={(replyType) =>
                      setConfirm({ replyType, items: selected.flatMap((r) => r.pending.map((p) => ({ emailId: r.emailId, ...p }))), clear })
                    }
                  />
                )
              : undefined
          }
        />
        {rows.length === 0 && <p className="text-muted-foreground mt-2">{t(`replies.empty.${tab}`)}</p>}
      </div>
      {openId !== null && (
        <DetailDialog
          title={detail?.email.subject || t("replies.noSubject")}
          navigation={detailNavigation(order, String(openId), (id) => open(Number(id)))}
          onClose={() => open(null)}
        >
          {detail && detail.email.id === openId ? (
            <ReplyDetailView
              detail={detail}
              replyTypes={replyTypes}
              canRecord={canRecord}
              canLink={canLink}
              canRecordDeduction={canRecordDeduction}
              onDeductions={setDeducting}
              busy={busy}
              onRecord={(blId, replyTypeId) => record([{ emailId: detail.email.id, blId }], replyTypeId)}
              onApplyToAll={(replyType) =>
                setConfirm({
                  replyType,
                  items: detail.links.filter((l) => !l.reply && !l.voided).map((l) => ({ emailId: detail.email.id, blId: l.blId, blNo: l.blNo })),
                })
              }
              onSuggestion={(action, blId) => suggestion(action, detail.email.id, blId)}
            />
          ) : (
            <p className="text-muted-foreground">{t("common.loading")}</p>
          )}
        </DetailDialog>
      )}

      {deducting?.deductionTarget && detail && (
        <DeductionDialog
          bl={{ id: deducting.blId, blNo: deducting.blNo, currency: deducting.currency }}
          target={deducting.deductionTarget}
          deductionTypes={deductionTypes}
          statements={detail.attachments.map((a) => ({ documentId: a.documentId, originalName: a.originalName }))}
          onCancel={() => setDeducting(null)}
          onDone={() => {
            setDeducting(null);
            void refresh();
          }}
        />
      )}

      {confirm && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirm(null)}
          title={t("replies.confirmTitle", { type: confirm.replyType.name })}
          description={t("replies.confirmDescription", { count: confirm.items.length })}
          items={confirm.items.map((i) => i.blNo)}
          confirmLabel={t("replies.confirmRecord")}
          onConfirm={async () => {
            await record(
              confirm.items.map(({ emailId, blId }) => ({ emailId, blId })),
              confirm.replyType.id,
            );
            confirm.clear?.();
            setConfirm(null);
          }}
        />
      )}
    </div>
  );
}

function BulkReplyButtons({
  replyTypes,
  disabled,
  onChoose,
}: {
  replyTypes: ReplyTypeOption[];
  disabled: boolean;
  onChoose: (replyType: ReplyTypeOption) => void;
}) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-sm">{t("replies.bulkRecord")}</span>
      {replyTypes.map((type) => (
        <Button key={type.id} size="sm" variant="outline" disabled={disabled} onClick={() => onChoose(type)}>
          {type.name}
        </Button>
      ))}
    </span>
  );
}

function ReplyDetailView({
  detail,
  replyTypes,
  canRecord,
  canLink,
  canRecordDeduction,
  onDeductions,
  busy,
  onRecord,
  onApplyToAll,
  onSuggestion,
}: {
  detail: ReplyDetail;
  replyTypes: ReplyTypeOption[];
  canRecord: boolean;
  canLink: boolean;
  canRecordDeduction: boolean;
  /** After a "deduction statement received" reply: enter the deductions from the statement. */
  onDeductions: (link: ReplyDetail["links"][number]) => void;
  busy: boolean;
  onRecord: (blId: number, replyTypeId: number) => void;
  onApplyToAll: (replyType: ReplyTypeOption) => void;
  onSuggestion: (action: "accept" | "dismiss", blId: number) => void;
}) {
  const { email, attachments, links, suggestions } = detail;
  const pending = links.filter((l) => !l.reply && !l.voided);

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
        <dt className="text-muted-foreground">{t("replies.from")}</dt>
        <dd className="break-all">{email.fromAddress}</dd>
        <dt className="text-muted-foreground">{t("replies.to")}</dt>
        <dd className="break-all">{email.to.join("; ")}</dd>
        {email.cc.length > 0 && (
          <>
            <dt className="text-muted-foreground">{t("replies.cc")}</dt>
            <dd className="break-all">{email.cc.join("; ")}</dd>
          </>
        )}
        <dt className="text-muted-foreground">{t("replies.receivedAt")}</dt>
        <dd>{email.receivedAt ? formatTimestamp(email.receivedAt) : ""}</dd>
        {email.agencyName && (
          <>
            <dt className="text-muted-foreground">{t("replies.agency")}</dt>
            <dd>{email.agencyName}</dd>
          </>
        )}
      </dl>

      {links.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">{t("replies.linkedBls")}</h3>
          <ul className="flex flex-col gap-2">
            {links.map((link) => (
              <li key={link.blId} className={cn("rounded-md border p-2", link.voided && "text-muted-foreground line-through")}>
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/bls/${link.blId}`} className="font-mono underline">
                    {link.blNo}
                  </Link>
                  <span className="text-muted-foreground text-xs">{t(`replies.linkedBy.${link.linkedBy}`)}</span>
                  {link.reply && (
                    <Badge variant="secondary" className="ml-auto">
                      {link.reply.typeName} · {formatBusinessDate(link.reply.repliedOn)} · {link.reply.byName}
                    </Badge>
                  )}
                  {link.deductionTarget && !link.voided && canRecordDeduction && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => onDeductions(link)}>
                      {t(link.deductionTarget.mode === "STATEMENT" ? "deductions.addFromStatement" : "deductions.classify")}
                    </Button>
                  )}
                </div>
                {!link.reply && !link.voided && canRecord && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {replyTypes.map((type) => (
                      <Button key={type.id} size="sm" variant="outline" disabled={busy} onClick={() => onRecord(link.blId, type.id)}>
                        {type.name}
                      </Button>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {pending.length > 1 && canRecord && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-sm">{t("replies.applyToAll")}</span>
              {replyTypes.map((type) => (
                <Button key={type.id} size="sm" variant="secondary" disabled={busy} onClick={() => onApplyToAll(type)}>
                  {type.name}
                </Button>
              ))}
            </div>
          )}
        </section>
      )}

      {suggestions.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">{t("replies.suggestions")}</h3>
          <p className="text-muted-foreground text-xs">{t("replies.suggestionsHint")}</p>
          <ul className="flex flex-col gap-2">
            {suggestions.map((s) => (
              <li key={s.blId} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                <Link href={`/bls/${s.blId}`} className="font-mono underline">
                  {s.blNo}
                </Link>
                <span className="text-sm">{s.agencyName}</span>
                {canLink && (
                  <span className="ml-auto flex gap-1">
                    <Button size="sm" disabled={busy} onClick={() => onSuggestion("accept", s.blId)}>
                      {t("replies.accept")}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => onSuggestion("dismiss", s.blId)}>
                      {t("replies.dismiss")}
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(attachments.length > 0 || email.rawDocumentId) && (
        <section className="flex flex-col gap-1">
          <h3 className="font-medium">{t("replies.attachments")}</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {attachments.map((a) => (
              <li key={a.documentId}>
                <a href={`/api/files/${a.documentId}`} target="_blank" rel="noreferrer" className="underline">
                  {a.originalName}
                </a>
              </li>
            ))}
            {email.rawDocumentId && (
              <li>
                <a href={`/api/files/${email.rawDocumentId}`} className="text-muted-foreground underline">
                  {t("replies.downloadEml")}
                </a>
              </li>
            )}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-1">
        <h3 className="font-medium">{t("replies.message")}</h3>
        <pre className="bg-muted max-h-[32rem] overflow-auto rounded-md p-3 font-sans text-sm whitespace-pre-wrap">{email.bodyText || t("replies.noText")}</pre>
      </section>
    </div>
  );
}
