"use client";

import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CustomerCombobox, type CustomerOption } from "@/components/customer-combobox";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";
import { formatMoney, parseAmountInput } from "@/lib/money";
import type { TransferPreview } from "@/server/transfers";
import { previewTransferAction, transferDepositAction } from "../actions";

type Source = { id: number; blNo: string; amountMinor: number };
type Defaults = { customerId: number | null; fileNo: string | null; unitId: number | null };
type Row = { key: number; blNo: string; amountText: string; customerId: number | null; fileNo: string; unitId: number | null; preview: TransferPreview | null; error: string | null };

/**
 * Moves whole deposits to other B/Ls, when the agency applied them there instead of refunding
 * them: one B/L to one target or split over several (*Hedef ekle*), or several B/Ls (bulk, from
 * All B/Ls) to one target. A target is a new B/L (prefilled with the first source's customer,
 * file number and unit) or an open one of the same agency and currency, which keeps its own details.
 */
export function TransferDialog({
  sources,
  currency,
  defaults,
  customers,
  units,
  today,
  onCancel,
  onDone,
}: {
  sources: Source[];
  currency: string;
  defaults: Defaults;
  customers: CustomerOption[];
  units: { id: number; name: string }[];
  today: string;
  onCancel: () => void;
  onDone: (targets: { blId: number; blNo: string }[]) => void;
}) {
  const sourceBlIds = sources.map((s) => s.id);
  const totalMinor = sources.reduce((sum, s) => sum + s.amountMinor, 0);
  const newRow = (key: number): Row => ({
    key,
    blNo: "",
    amountText: "",
    customerId: defaults.customerId,
    fileNo: defaults.fileNo ?? "",
    unitId: units.some((u) => u.id === defaults.unitId) ? defaults.unitId : null,
    preview: null,
    error: null,
  });
  const [rows, setRows] = useState<Row[]>([newRow(0)]);
  const [transferredOn, setTransferredOn] = useState(today);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const update = (key: number, patch: Partial<Row>) => setRows((all) => all.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const split = rows.length > 1;
  // One target takes the whole; a split names each part, and they must add up.
  const amounts = rows.map((r) => (split ? parseAmountInput(r.amountText) : totalMinor));
  const remaining = totalMinor - amounts.reduce<number>((sum, a) => sum + (a ?? 0), 0);
  const ready =
    rows.every((r) => r.blNo.trim().length >= 3 && r.preview !== null && (r.preview.existing || units.length === 0 || r.unitId !== null)) &&
    (!split || (amounts.every((a) => a !== null && a > 0) && remaining === 0));

  const save = async () => {
    setBusy(true);
    const result = await transferDepositAction({
      sourceBlIds,
      targets: rows.map((r, i) => ({
        blNo: r.blNo,
        amountMinor: split ? amounts[i] : null,
        ...(r.preview?.existing ? { customerId: null, fileNo: null, unitId: null } : { customerId: r.customerId, fileNo: r.fileNo || null, unitId: r.unitId }),
      })),
      transferredOn,
      note,
    });
    setBusy(false);
    if (!result.ok) return void toast.error(t(result.error, result.params));
    const names = result.data.targets.map((x) => x.blNo).join(", ");
    toast.success(sources.length > 1 ? t("transfers.bulkSaved", { count: sources.length, bl: names }) : t("transfers.saved", { bl: names }));
    onDone(result.data.targets);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("transfers.title")}</DialogTitle>
          <DialogDescription>{sources.length > 1 ? t("transfers.bulkHint") : t("transfers.hint")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {sources.length > 1 && (
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">{t("transfers.sources")}</span>
              {/* Every bulk action lists the affected B/Ls before it runs. */}
              <ul className="max-h-32 overflow-auto font-mono text-xs">
                {sources.map((s) => (
                  <li key={s.id}>
                    {s.blNo} · <span className="tabular">{formatMoney(s.amountMinor, currency)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex items-end justify-between gap-3">
            <p className="text-sm">
              {t("transfers.amount")}: <span className="tabular font-medium">{formatMoney(totalMinor, currency)}</span>
            </p>
            <div className="flex w-40 flex-col gap-1.5">
              <Label htmlFor="transfer-date">{t("transfers.transferredOn")}</Label>
              <Input id="transfer-date" type="date" max={today} value={transferredOn} onChange={(e) => setTransferredOn(e.target.value)} />
            </div>
          </div>
          {rows.map((row, i) => (
            <TargetRow
              key={row.key}
              index={i}
              row={row}
              split={split}
              amountMinor={amounts[i] ?? 0}
              sourceBlIds={sourceBlIds}
              currency={currency}
              customers={customers}
              units={units}
              onChange={(patch) => update(row.key, patch)}
              onRemove={split ? () => setRows((all) => all.filter((r) => r.key !== row.key)) : undefined}
            />
          ))}
          {sources.length === 1 && (
            <div className="flex items-center justify-between">
              <Button type="button" size="sm" variant="outline" onClick={() => setRows((all) => [...all, newRow(Math.max(...all.map((r) => r.key)) + 1)])}>
                <Plus /> {t("transfers.addTarget")}
              </Button>
              {split && (
                <span className={remaining === 0 ? "text-muted-foreground text-xs" : "text-xs text-amber-700 dark:text-amber-400"}>
                  {t("transfers.splitRemaining", { amount: formatMoney(remaining, currency) })}
                </span>
              )}
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
          <Button onClick={save} disabled={busy || !ready}>
            {t("transfers.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One target: its number (checked as typed: new B/L or an open one to join), its part in a split, and a new B/L's details. */
function TargetRow({
  index,
  row,
  split,
  amountMinor,
  sourceBlIds,
  currency,
  customers,
  units,
  onChange,
  onRemove,
}: {
  index: number;
  row: Row;
  split: boolean;
  amountMinor: number;
  sourceBlIds: number[];
  currency: string;
  customers: CustomerOption[];
  units: { id: number; name: string }[];
  onChange: (patch: Partial<Row>) => void;
  onRemove?: () => void;
}) {
  const number = row.blNo.trim();
  const sourcesKey = sourceBlIds.join(",");
  // What the typed number would do: a new B/L or joining an open one, or why not.
  useEffect(() => {
    if (number.length < 3) return;
    const timer = setTimeout(async () => {
      const result = await previewTransferAction({ sourceBlIds: sourcesKey.split(",").map(Number), targetBlNo: number });
      onChange(result.ok ? { preview: result.data, error: null } : { preview: null, error: t(result.error, result.params) });
    }, 300);
    return () => clearTimeout(timer);
    // onChange is a new function each render; the preview depends only on the number and the sources.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [number, sourcesKey]);
  const ready = number.length >= 3 && row.preview !== null;
  const existing = ready ? row.preview!.existing : null;
  const id = (name: string) => `transfer-${name}-${index}`;

  return (
    <div className={split ? "flex flex-col gap-2 rounded-md border p-3" : "flex flex-col gap-2"}>
      <div className="flex items-end gap-3">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor={id("target")}>{t("transfers.targetBlNo")}</Label>
          <Input
            id={id("target")}
            className="font-mono uppercase"
            value={row.blNo}
            onChange={(e) => onChange({ blNo: e.target.value, preview: null, error: null })}
            autoFocus={index === 0}
          />
        </div>
        {split && (
          <div className="flex w-36 flex-col gap-1.5">
            <Label htmlFor={id("amount")}>{t("transfers.targetAmount")}</Label>
            <Input id={id("amount")} className="tabular text-right" inputMode="decimal" value={row.amountText} onChange={(e) => onChange({ amountText: e.target.value })} />
          </div>
        )}
        {onRemove && (
          <Button type="button" size="icon" variant="ghost" aria-label={t("transfers.removeTarget")} onClick={onRemove}>
            <X />
          </Button>
        )}
      </div>
      {row.error && number.length >= 3 && (
        <p role="alert" className="text-destructive text-xs">
          {row.error}
        </p>
      )}
      {ready && !existing && <p className="text-muted-foreground text-xs">{t("transfers.targetNew")}</p>}
      {existing && (
        <p className="text-xs text-sky-800 dark:text-sky-200">
          {t("transfers.targetExisting", {
            bl: existing.blNo,
            before: formatMoney(existing.depositMinor, currency),
            after: formatMoney(existing.depositMinor + amountMinor, currency),
          })}
        </p>
      )}
      {ready && !existing && (
        <div className="grid grid-cols-[1fr_10rem] gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={id("customer")}>{t("bls.customer")}</Label>
            <CustomerCombobox
              id={id("customer")}
              customers={customers.filter((c) => c.active)}
              value={row.customerId}
              onChange={(customerId) => onChange({ customerId })}
              placeholder={t("openingBalances.customerSearch")}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={id("file-no")}>{t("bls.fileNo")}</Label>
            <Input id={id("file-no")} className="font-mono uppercase" value={row.fileNo} onChange={(e) => onChange({ fileNo: e.target.value })} />
          </div>
        </div>
      )}
      {ready && !existing && units.length > 0 && (
        <div className="flex w-56 flex-col gap-1.5">
          <Label htmlFor={id("unit")}>{t("bls.unit")}</Label>
          <select
            id={id("unit")}
            className="border-input bg-background h-9 rounded-md border px-2"
            value={row.unitId ?? ""}
            onChange={(e) => onChange({ unitId: e.target.value ? Number(e.target.value) : null })}
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
    </div>
  );
}
