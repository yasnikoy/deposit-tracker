"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CustomerCombobox, type CustomerOption } from "@/components/customer-combobox";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";
import { formatMoney } from "@/lib/money";
import type { TransferPreview } from "@/server/transfers";
import { previewTransferAction, transferDepositAction } from "../actions";

/**
 * Moves the B/L's whole deposit to another B/L, when the agency applied it there instead of
 * refunding it: a new B/L (prefilled with this one's customer, file number and unit) or an
 * open one of the same agency and currency, which keeps its own details.
 */
export function TransferDialog({
  bl,
  amountMinor,
  customers,
  units,
  today,
  onCancel,
  onDone,
}: {
  bl: { id: number; blNo: string; currency: string; customerId: number | null; fileNo: string | null; unitId: number | null };
  amountMinor: number;
  customers: CustomerOption[];
  units: { id: number; name: string }[];
  today: string;
  onCancel: () => void;
  onDone: (targetBlId: number, targetBlNo: string) => void;
}) {
  const [targetBlNo, setTargetBlNo] = useState("");
  const [transferredOn, setTransferredOn] = useState(today);
  const [customerId, setCustomerId] = useState<number | null>(bl.customerId);
  const [fileNo, setFileNo] = useState(bl.fileNo ?? "");
  const [unitId, setUnitId] = useState<number | null>(units.some((u) => u.id === bl.unitId) ? bl.unitId : null);
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<TransferPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // What the typed number would do: a new B/L or joining an open one, or why not.
  useEffect(() => {
    const number = targetBlNo.trim();
    if (number.length < 3) return;
    const timer = setTimeout(async () => {
      const result = await previewTransferAction({ sourceBlId: bl.id, targetBlNo: number });
      if (result.ok) {
        setPreview(result.data);
        setPreviewError(null);
      } else {
        setPreview(null);
        setPreviewError(t(result.error, result.params));
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [bl.id, targetBlNo]);
  const ready = targetBlNo.trim().length >= 3 && preview !== null;
  const existing = ready ? preview.existing : null;

  const save = async () => {
    setBusy(true);
    const result = await transferDepositAction({
      sourceBlId: bl.id,
      targetBlNo,
      transferredOn,
      ...(existing ? { customerId: null, fileNo: null, unitId: null } : { customerId, fileNo, unitId }),
      note,
    });
    setBusy(false);
    if (!result.ok) return void toast.error(t(result.error, result.params));
    toast.success(t("transfers.saved", { bl: targetBlNo.trim().toUpperCase() }));
    onDone(result.data.targetBlId, targetBlNo.trim().toUpperCase());
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("transfers.title")}</DialogTitle>
          <DialogDescription>{t("transfers.hint")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            {t("transfers.amount")}: <span className="tabular font-medium">{formatMoney(amountMinor, bl.currency)}</span>
          </p>
          <div className="grid grid-cols-[1fr_10rem] gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="transfer-target">{t("transfers.targetBlNo")}</Label>
              <Input id="transfer-target" className="font-mono uppercase" value={targetBlNo} onChange={(e) => setTargetBlNo(e.target.value)} autoFocus />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="transfer-date">{t("transfers.transferredOn")}</Label>
              <Input id="transfer-date" type="date" max={today} value={transferredOn} onChange={(e) => setTransferredOn(e.target.value)} />
            </div>
          </div>
          {previewError && targetBlNo.trim().length >= 3 && (
            <p role="alert" className="text-destructive text-xs">
              {previewError}
            </p>
          )}
          {ready && !existing && <p className="text-muted-foreground text-xs">{t("transfers.targetNew")}</p>}
          {existing && (
            <p className="text-xs text-sky-800 dark:text-sky-200">
              {t("transfers.targetExisting", {
                bl: existing.blNo,
                before: formatMoney(existing.depositMinor, bl.currency),
                after: formatMoney(existing.depositMinor + amountMinor, bl.currency),
              })}
            </p>
          )}
          {ready && !existing && (
            <div className="grid grid-cols-[1fr_10rem] gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="transfer-customer">{t("bls.customer")}</Label>
                <CustomerCombobox
                  id="transfer-customer"
                  customers={customers.filter((c) => c.active)}
                  value={customerId}
                  onChange={setCustomerId}
                  placeholder={t("openingBalances.customerSearch")}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="transfer-file-no">{t("bls.fileNo")}</Label>
                <Input id="transfer-file-no" className="font-mono uppercase" value={fileNo} onChange={(e) => setFileNo(e.target.value)} />
              </div>
            </div>
          )}
          {ready && !existing && units.length > 0 && (
            <div className="flex w-56 flex-col gap-1.5">
              <Label htmlFor="transfer-unit">{t("bls.unit")}</Label>
              <select
                id="transfer-unit"
                className="border-input bg-background h-9 rounded-md border px-2"
                value={unitId ?? ""}
                onChange={(e) => setUnitId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">{t("bls.unitPick")}</option>
                {units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="transfer-note">
              {t("transfers.note")} <span className="text-muted-foreground font-normal">{t("common.optional")}</span>
            </Label>
            <Input id="transfer-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button onClick={save} disabled={busy || !ready || (!existing && units.length > 0 && unitId === null)}>
            {t("transfers.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
