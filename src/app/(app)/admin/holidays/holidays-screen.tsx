"use client";

import { MoreHorizontal, Plus, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataTable } from "@/components/data-table/data-table";
import { dataTableColumns } from "@/components/data-table/features";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  addBusinessDays,
  HOLIDAY_KINDS,
  isoWeekday,
  isValidIsoDate,
  type BusinessCalendar,
  type HolidayKind,
} from "@/domain/business-days";
import { t, type TranslationKey } from "@/i18n";
import { formatBusinessDate } from "@/lib/format";
import { parseHolidayLines } from "@/lib/holiday-import";
import type { TableLayout } from "@/lib/schemas/table-layout";
import type { ActionResult } from "@/server/errors";
import type { Holiday } from "@/server/holidays";
import { deleteHolidayAction, saveHolidaysAction, updateHolidayAction } from "./actions";

type DialogState = { kind: "add" } | { kind: "bulk" } | { kind: "edit"; holiday: Holiday } | { kind: "delete"; holiday: Holiday } | null;

const weekdayName = (date: string) => t(`weekdaysLong.${isoWeekday(date)}` as TranslationKey);

export function HolidaysScreen({
  holidays,
  weekendDays,
  halfDaysAreBusinessDays,
  today,
  layout,
}: {
  holidays: Holiday[];
  weekendDays: number[];
  halfDaysAreBusinessDays: boolean;
  today: string;
  layout: TableLayout | null;
}) {
  const router = useRouter();
  const currentYear = Number(today.slice(0, 4));
  const [year, setYear] = useState(currentYear);
  const [dialog, setDialog] = useState<DialogState>(null);
  const close = () => setDialog(null);

  const years = useMemo(
    () => [...new Set([currentYear, currentYear + 1, ...holidays.map((h) => Number(h.date.slice(0, 4)))])].sort(),
    [holidays, currentYear],
  );
  const shown = useMemo(() => holidays.filter((h) => h.date.startsWith(`${year}-`)), [holidays, year]);
  const calendar = useMemo<BusinessCalendar>(
    () => ({ weekendDays, halfDaysAreBusinessDays, holidays: new Map(holidays.map((h) => [h.date, h.kind])) }),
    [holidays, weekendDays, halfDaysAreBusinessDays],
  );

  const finish = (result: ActionResult<unknown>, message: string): boolean => {
    if (!result.ok) {
      toast.error(t(result.error, result.params));
      return false;
    }
    toast.success(message);
    router.refresh();
    return true;
  };

  const columns = useMemo(() => {
    const col = dataTableColumns<Holiday>();
    return col.columns([
      col.accessor("date", {
        meta: { label: "holidays.date", toText: (value) => formatBusinessDate(value as string) },
        sortFn: "basic",
        cell: ({ getValue }) => formatBusinessDate(getValue()),
      }),
      col.accessor((h) => weekdayName(h.date), { id: "weekday", meta: { label: "holidays.weekday" }, enableSorting: false }),
      col.accessor("name", { meta: { label: "holidays.name", filter: "text" }, sortFn: "turkishText" }),
      col.accessor("kind", {
        meta: {
          label: "holidays.kind",
          toText: (value) => t(`holidays.kinds.${value as HolidayKind}`),
          filter: { options: HOLIDAY_KINDS.map((k) => ({ value: k, label: `holidays.kinds.${k}` as const })) },
        },
        filterFn: "oneOf",
        cell: ({ getValue }) => t(`holidays.kinds.${getValue()}`),
      }),
      col.display({
        id: "actions",
        meta: { label: "common.actions", searchable: false },
        enableHiding: false,
        cell: ({ row }) => (
          <div onClick={(event) => event.stopPropagation()}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7" aria-label={t("common.actions")}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setDialog({ kind: "edit", holiday: row.original })}>{t("common.edit")}</DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onSelect={() => setDialog({ kind: "delete", holiday: row.original })}>
                  {t("common.delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      }),
    ]);
  }, []);

  return (
    <div className="flex items-start gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          <Label htmlFor="holiday-year">{t("holidays.year")}</Label>
          <select
            id="holiday-year"
            value={year}
            onChange={(event) => setYear(Number(event.target.value))}
            className="border-input bg-background h-8 rounded-md border px-2"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
        <DataTable
          tableId="holidays"
          data={shown}
          columns={columns}
          getRowId={(h) => String(h.id)}
          initialLayout={layout}
          onOpenRow={(holiday) => setDialog({ kind: "edit", holiday })}
          toolbar={
            <>
              <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "bulk" })}>
                <Upload /> {t("holidays.bulk")}
              </Button>
              <Button size="sm" onClick={() => setDialog({ kind: "add" })}>
                <Plus /> {t("holidays.add")}
              </Button>
            </>
          }
        />
      </div>
      <BusinessDayCalculator calendar={calendar} today={today} />

      {(dialog?.kind === "add" || dialog?.kind === "edit") && (
        <HolidayDialog
          holiday={dialog.kind === "edit" ? dialog.holiday : null}
          onCancel={close}
          onSave={async (values, reason) => {
            const result =
              dialog.kind === "edit"
                ? await updateHolidayAction({ id: dialog.holiday.id, name: values.name, kind: values.kind, reason })
                : await saveHolidaysAction({ holidays: [values], reason });
            if (finish(result, dialog.kind === "edit" ? t("holidays.toast.updated") : savedMessage(result))) close();
          }}
        />
      )}
      {dialog?.kind === "bulk" && (
        <BulkHolidayDialog
          onCancel={close}
          onSave={async (rows, reason) => {
            const result = await saveHolidaysAction({ holidays: rows, reason });
            if (finish(result, savedMessage(result))) close();
          }}
        />
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && close()}
          title={t("common.delete")}
          description={t("holidays.deleteConfirm", { date: formatBusinessDate(dialog.holiday.date), name: dialog.holiday.name })}
          confirmLabel={t("common.delete")}
          destructive
          onConfirm={async () => {
            if (finish(await deleteHolidayAction({ id: dialog.holiday.id }), t("holidays.toast.deleted"))) close();
          }}
        />
      )}
    </div>
  );
}

function savedMessage(result: ActionResult<unknown>): string {
  const data = result.ok ? (result.data as { created: number; updated: number }) : { created: 0, updated: 0 };
  return t("holidays.toast.saved", data);
}

type HolidayValues = { date: string; name: string; kind: HolidayKind };

function HolidayDialog({
  holiday,
  onCancel,
  onSave,
}: {
  holiday: Holiday | null;
  onCancel: () => void;
  onSave: (values: HolidayValues, reason: string) => Promise<void>;
}) {
  const [values, setValues] = useState<HolidayValues>(holiday ?? { date: "", name: "", kind: "FULL" });
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = isValidIsoDate(values.date) && values.name.trim() !== "";

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{holiday ? t("common.edit") : t("holidays.add")}</DialogTitle>
        </DialogHeader>
        <form
          id="holiday-form"
          className="flex flex-col gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            await onSave({ ...values, name: values.name.trim() }, reason);
            setBusy(false);
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="holiday-date">{t("holidays.date")}</Label>
            <Input
              id="holiday-date"
              type="date"
              value={values.date}
              disabled={holiday !== null}
              onChange={(event) => setValues({ ...values, date: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="holiday-name">{t("holidays.name")}</Label>
            <Input id="holiday-name" value={values.name} autoFocus onChange={(event) => setValues({ ...values, name: event.target.value })} />
          </div>
          <fieldset className="flex gap-4">
            <legend className="sr-only">{t("holidays.kind")}</legend>
            {HOLIDAY_KINDS.map((kind) => (
              <label key={kind} className="flex items-center gap-1.5">
                <input type="radio" name="kind" checked={values.kind === kind} onChange={() => setValues({ ...values, kind })} />
                {t(`holidays.kinds.${kind}`)}
              </label>
            ))}
          </fieldset>
          <Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t("common.reasonOptional")} aria-label={t("common.reasonOptional")} />
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="holiday-form" disabled={busy || !valid}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BulkHolidayDialog({
  onCancel,
  onSave,
}: {
  onCancel: () => void;
  onSave: (rows: HolidayValues[], reason: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => parseHolidayLines(text), [text]);
  const canSave = parsed.rows.length > 0 && parsed.errors.length === 0;

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("holidays.bulk")}</DialogTitle>
          <DialogDescription>{t("holidays.bulkHint")}</DialogDescription>
        </DialogHeader>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={10}
          autoFocus
          aria-label={t("holidays.bulk")}
          placeholder={"29.10.2027;Cumhuriyet Bayramı;Tam\n28.10.2027;Cumhuriyet Bayramı arifesi;Yarım"}
          className="border-input bg-background rounded-md border p-2 font-mono text-xs"
        />
        <div className="text-xs">
          {parsed.rows.length > 0 && <p>{t("holidays.bulkRead", { count: parsed.rows.length })}</p>}
          {parsed.errors.map((error) => (
            <p key={error.line} role="alert" className="text-destructive">
              {t("common.line", { line: error.line })}: {t(error.error)}
            </p>
          ))}
        </div>
        <Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t("common.reasonOptional")} aria-label={t("common.reasonOptional")} />
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={busy || !canSave}
            onClick={async () => {
              setBusy(true);
              await onSave(parsed.rows.map(({ date, name, kind }) => ({ date, name, kind })), reason);
              setBusy(false);
            }}
          >
            {t("holidays.saveAll")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Lets admins check the calendar: start date + n business days, with the live settings and holidays. */
function BusinessDayCalculator({ calendar, today }: { calendar: BusinessCalendar; today: string }) {
  const [start, setStart] = useState(today);
  const [days, setDays] = useState("7");
  const n = Number(days);
  const result = isValidIsoDate(start) && Number.isInteger(n) && n >= 0 && n <= 1000 ? addBusinessDays(start, n, calendar) : null;

  return (
    <Card className="w-80 shrink-0">
      <CardHeader>
        <CardTitle>{t("holidays.calculator.title")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="calc-start">{t("holidays.calculator.start")}</Label>
          <Input id="calc-start" type="date" value={start} onChange={(event) => setStart(event.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="calc-days">{t("holidays.calculator.days")}</Label>
          <Input id="calc-days" type="number" min={0} value={days} onChange={(event) => setDays(event.target.value)} />
        </div>
        {result && (
          <p data-testid="calc-result" className="font-medium">
            {t("holidays.calculator.result", { days: n, date: formatBusinessDate(result), weekday: weekdayName(result) })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
