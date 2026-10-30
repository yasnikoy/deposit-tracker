"use client";

import { Plus, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toastWithUndo } from "@/components/undo-toast";
import { toast } from "sonner";
import { FileDrop, uploadErrorText } from "@/components/file-drop";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";
import { formatAmount, formatMoney, parseAmountInput } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { DeductionTarget } from "@/server/deductions";
import { classifyDeductionAction, recordStatementDeductionsAction } from "./actions";

export type DeductionTypeOption = { id: number; name: string };
/** A file that can serve as the agency's statement: one already on the B/L or attached to its emails. */
export type StatementOption = { documentId: number; originalName: string };

type Line = { key: number; deductionTypeId: number | null; amount: string };

/**
 * Deductions of one B/L with their real types: from an agency statement before payment
 * (statement mandatory, lowers the expected amount), or replacing an unexplained deduction
 * (lines must add up to it; clearing a dispute needs a note).
 */
export function DeductionDialog({
  bl,
  target,
  deductionTypes,
  statements,
  onCancel,
  onDone,
}: {
  bl: { id: number; blNo: string; currency: string };
  target: DeductionTarget;
  deductionTypes: DeductionTypeOption[];
  statements: StatementOption[];
  onCancel: () => void;
  onDone: () => void;
}) {
  const classify = target.mode === "CLASSIFY";
  const disputed = target.mode === "CLASSIFY" && target.disputed;
  const [lines, setLines] = useState<Line[]>([{ key: 0, deductionTypeId: null, amount: classify ? formatAmount(target.amountMinor) : "" }]);
  const [options, setOptions] = useState(statements);
  const [documentId, setDocumentId] = useState<number | null>(statements.length === 1 && !classify ? statements[0].documentId : null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const money = (minor: number) => formatMoney(minor, bl.currency);
  const parsed = lines.map((l) => parseAmountInput(l.amount));
  const total = parsed.reduce<number>((sum, v) => sum + (v ?? 0), 0);
  const limit = target.mode === "CLASSIFY" ? target.amountMinor : target.expectedMinor;
  const offLimit = classify ? total !== limit : total > limit;
  const update = (key: number, change: Partial<Line>) => setLines((all) => all.map((l) => (l.key === key ? { ...l, ...change } : l)));

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (lines.some((l) => l.deductionTypeId === null) || parsed.some((v) => v === null)) return setError(t("deductions.dialog.linesInvalid"));
    if (!classify && documentId === null) return setError(t("deductions.errors.statementDocument"));
    if (disputed && !note.trim()) return setError(t("deductions.errors.clearNote"));
    const payload = lines.map((l, i) => ({ deductionTypeId: l.deductionTypeId!, amountMinor: parsed[i]! }));
    setBusy(true);
    if (target.mode === "CLASSIFY") {
      const result = await classifyDeductionAction({ entryId: target.entryId, lines: payload, documentId, note });
      setBusy(false);
      if (!result.ok) return setError(t(result.error, result.params));
      toast.success(t("deductions.classified"));
    } else {
      // Statement deductions can be undone within the window.
      const result = await recordStatementDeductionsAction({ blId: bl.id, documentId, lines: payload });
      setBusy(false);
      if (!result.ok) return setError(t(result.error, result.params));
      toastWithUndo(t("deductions.recorded"), result.data, onDone);
    }
    onDone();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={save} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {t(disputed ? "deductions.dialog.clearTitle" : classify ? "deductions.dialog.classifyTitle" : "deductions.dialog.statementTitle", { bl: bl.blNo })}
            </DialogTitle>
            <DialogDescription>
              {target.mode === "CLASSIFY"
                ? t(disputed ? "deductions.dialog.clearHint" : "deductions.dialog.classifyHint", { amount: money(target.amountMinor) })
                : t("deductions.dialog.statementHint", { amount: money(target.expectedMinor) })}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            {lines.map((line, i) => (
              <div key={line.key} className="flex items-center gap-2">
                <select
                  aria-label={`${t("deductions.type")} ${i + 1}`}
                  className="border-input bg-background h-9 flex-1 rounded-md border px-2"
                  value={line.deductionTypeId ?? ""}
                  onChange={(e) => update(line.key, { deductionTypeId: e.target.value ? Number(e.target.value) : null })}
                >
                  <option value="">{t("deductions.chooseType")}</option>
                  {deductionTypes.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
                <Input
                  aria-label={`${t("deductions.amount")} ${i + 1}`}
                  inputMode="decimal"
                  className="h-9 w-36 text-right"
                  value={line.amount}
                  onChange={(e) => update(line.key, { amount: e.target.value })}
                />
                <span className="text-muted-foreground w-10 text-sm">{bl.currency}</span>
                {lines.length > 1 && (
                  <Button type="button" size="icon" variant="ghost" className="size-8" aria-label={t("deductions.dialog.removeLine")} onClick={() => setLines((all) => all.filter((l) => l.key !== line.key))}>
                    <X />
                  </Button>
                )}
              </div>
            ))}
            <div className="flex items-center justify-between">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setLines((all) => [...all, { key: Math.max(...all.map((l) => l.key)) + 1, deductionTypeId: null, amount: "" }])}
              >
                <Plus /> {t("deductions.dialog.addLine")}
              </Button>
              <span className={cn("tabular text-sm", offLimit && total > 0 && "text-amber-700 dark:text-amber-400")}>
                {t("deductions.dialog.total", { amount: money(total) })}
              </span>
            </div>
          </div>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">{t(classify ? "deductions.dialog.statementOptional" : "deductions.dialog.statement")}</legend>
            {options.map((option) => (
              <label key={option.documentId} className="flex items-center gap-2 text-sm">
                <input type="radio" name="statement" checked={documentId === option.documentId} onChange={() => setDocumentId(option.documentId)} />
                <a href={`/api/files/${option.documentId}`} target="_blank" rel="noreferrer" className="underline">
                  {option.originalName}
                </a>
              </label>
            ))}
            {classify && documentId !== null && (
              <Button type="button" size="sm" variant="ghost" className="self-start" onClick={() => setDocumentId(null)}>
                {t("deductions.dialog.noStatement")}
              </Button>
            )}
            <FileDrop
              kind="DEDUCTION_STATEMENT"
              label={t("deductions.dialog.uploadStatement")}
              onUploaded={([upload]) => {
                if (!upload.response.ok) return setError(uploadErrorText(upload.response));
                const doc = upload.response.document;
                if (!doc) return;
                setOptions((all) => [...all, { documentId: doc.id, originalName: doc.originalName }]);
                setDocumentId(doc.id);
              }}
            />
          </fieldset>

          {classify && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="deduction-note">{t(disputed ? "deductions.dialog.clearNote" : "deductions.dialog.note")}</Label>
              <textarea
                id="deduction-note"
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="border-input bg-background rounded-md border px-2 py-1 text-sm"
              />
            </div>
          )}
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
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
