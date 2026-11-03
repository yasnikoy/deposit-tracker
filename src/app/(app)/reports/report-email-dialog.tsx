"use client";

import { Mail } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { REPORT_SECTIONS, type ReportSection } from "@/domain/report-email";
import { t } from "@/i18n";
import type { ReportDraft } from "@/server/report-email";
import { queueReportAction, reportDraftAction } from "./actions";

const toList = (text: string) =>
  text
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);

type Props = {
  agencies: { id: number; name: string }[];
  currencies: string[];
  /** Default period of the collected section: this month so far. */
  period: { from: string; to: string };
};

/** "Rapor gönder": choose sections and filters, then preview and send to internal addresses. */
export function ReportEmailButton(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Mail /> {t("reports.email.send")}
      </Button>
      {open && <ReportEmailDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

function ReportEmailDialog({ agencies, currencies, period, onClose }: Props & { onClose: () => void }) {
  const router = useRouter();
  const [sections, setSections] = useState<ReportSection[]>([...REPORT_SECTIONS]);
  const [agencyIds, setAgencyIds] = useState<number[]>([]);
  const [currency, setCurrency] = useState("");
  const [from, setFrom] = useState(period.from);
  const [to, setTo] = useState(period.to);
  // Requests sent today, by default: what went out from the office that day.
  const [requestedFrom, setRequestedFrom] = useState(period.to);
  const [requestedTo, setRequestedTo] = useState(period.to);
  const [draft, setDraft] = useState<ReportDraft | null>(null);
  const [recipients, setRecipients] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [intro, setIntro] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const collected = sections.includes("COLLECTED");
  const requested = sections.includes("REQUESTED");
  const request = () => ({
    sections,
    filters: {
      agencyIds,
      currency: currency || null,
      requestedFrom: requested ? requestedFrom || null : null,
      requestedTo: requested ? requestedTo || null : null,
      collectedFrom: collected ? from || null : null,
      collectedTo: collected ? to || null : null,
    },
  });
  const toggle = <T,>(list: T[], item: T, on: boolean) => (on ? [...list, item] : list.filter((x) => x !== item));

  const preview = async () => {
    setBusy(true);
    setError(null);
    const result = await reportDraftAction(request());
    setBusy(false);
    if (!result.ok) return setError(t(result.error, result.params));
    setDraft(result.data);
    setRecipients(result.data.to.join(", "));
    setSubject(result.data.subject);
    setIntro(result.data.intro);
  };

  const send = async () => {
    setBusy(true);
    setError(null);
    const result = await queueReportAction({ ...request(), to: toList(recipients), cc: toList(cc), subject, intro });
    setBusy(false);
    if (!result.ok) {
      const field = result.fieldErrors ? Object.values(result.fieldErrors)[0] : undefined;
      return setError(t(field ?? result.error, result.params));
    }
    toast.success(t("reports.email.queued"));
    onClose();
    router.refresh();
  };

  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("reports.email.title")}</DialogTitle>
          <DialogDescription>{t("reports.email.hint")}</DialogDescription>
        </DialogHeader>

        {!draft ? (
          <div className="flex flex-col gap-4">
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">{t("reports.email.sectionsLabel")}</legend>
              {REPORT_SECTIONS.map((section) => (
                <label key={section} className="flex items-start gap-2 text-sm">
                  <Checkbox checked={sections.includes(section)} onCheckedChange={(checked) => setSections((s) => toggle(s, section, checked === true))} className="mt-0.5" />
                  <span>
                    {t(`reports.email.sections.${section}`)}
                    <span className="text-muted-foreground block text-xs">{t(`reports.email.sectionHints.${section}`)}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            {(requested || collected) && (
              <div className="flex flex-col gap-1">
                {requested && (
                  <PeriodFields id="report-requested" label={`${t("reports.email.sections.REQUESTED")} · ${t("reports.email.requestedPeriod")}`} from={requestedFrom} to={requestedTo} onFrom={setRequestedFrom} onTo={setRequestedTo} />
                )}
                {collected && (
                  <PeriodFields id="report" label={`${t("reports.email.sections.COLLECTED")} · ${t("reports.email.collectedPeriod")}`} from={from} to={to} onFrom={setFrom} onTo={setTo} />
                )}
                <span className="text-muted-foreground text-xs">{t("reports.email.periodHint")}</span>
              </div>
            )}

            <div className="flex items-center gap-2">
              <Label htmlFor="report-currency">{t("reports.email.currency")}</Label>
              <select id="report-currency" className="border-input bg-background h-8 rounded-md border px-2" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                <option value="">{t("reports.email.allCurrencies")}</option>
                {currencies.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </div>

            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 text-sm font-medium">{t("reports.email.agencies")}</legend>
              <span className="text-muted-foreground text-xs">{t("reports.email.agenciesHint")}</span>
              <div className="grid max-h-40 grid-cols-2 gap-1 overflow-auto rounded-md border p-2">
                {agencies.map((agency) => (
                  <label key={agency.id} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={agencyIds.includes(agency.id)} onCheckedChange={(checked) => setAgencyIds((ids) => toggle(ids, agency.id, checked === true))} />
                    {agency.name}
                  </label>
                ))}
              </div>
            </fieldset>

            {error && <p className="text-destructive text-sm">{error}</p>}
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button onClick={preview} disabled={busy || sections.length === 0}>
                {t("reports.email.preview")}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {[
              { id: "report-recipients", label: t("reports.email.recipients"), value: recipients, set: setRecipients },
              { id: "report-cc", label: t("reports.email.cc"), value: cc, set: setCc },
              { id: "report-subject", label: t("reports.email.subject"), value: subject, set: setSubject },
            ].map((f) => (
              <div key={f.id} className="grid grid-cols-[6rem_1fr] items-center gap-2">
                <Label htmlFor={f.id}>{f.label}</Label>
                <Input id={f.id} className="h-8" value={f.value} onChange={(e) => f.set(e.target.value)} />
              </div>
            ))}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="report-intro">{t("reports.email.intro")}</Label>
              <textarea id="report-intro" rows={5} className="border-input bg-background rounded-md border px-2 py-1 text-sm" value={intro} onChange={(e) => setIntro(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">{t("reports.email.summary")}</span>
              <pre className="bg-muted rounded-md p-2 font-sans text-sm whitespace-pre-wrap" data-testid="report-summary">
                {draft.summary}
              </pre>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">{t("reports.email.attachments")}</span>
              <ul className="text-sm">
                {draft.attachments.map((a) => (
                  <li key={a.fileName}>
                    {a.fileName} <span className="text-muted-foreground text-xs">({t("reports.email.rows", { count: a.rows })})</span>
                  </li>
                ))}
              </ul>
            </div>
            {error && <p className="text-destructive text-sm">{error}</p>}
            <DialogFooter>
              <Button variant="ghost" onClick={() => setDraft(null)} disabled={busy}>
                {t("reports.email.back")}
              </Button>
              <Button onClick={send} disabled={busy}>
                {t("reports.email.sendNow")}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A from–to date pair of one section. */
function PeriodFields({ id, label, from, to, onFrom, onTo }: { id: string; label: string; from: string; to: string; onFrom: (v: string) => void; onTo: (v: string) => void }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-2">
      <span className="w-64 text-sm">{label}</span>
      <Label htmlFor={`${id}-from`}>{t("reports.email.from")}</Label>
      <Input id={`${id}-from`} type="date" className="h-8 w-40" value={from} onChange={(e) => onFrom(e.target.value)} />
      <Label htmlFor={`${id}-to`}>{t("reports.email.to")}</Label>
      <Input id={`${id}-to`} type="date" className="h-8 w-40" value={to} onChange={(e) => onTo(e.target.value)} />
    </div>
  );
}
