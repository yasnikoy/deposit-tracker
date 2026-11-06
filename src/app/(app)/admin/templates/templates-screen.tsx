"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EMAIL_TEMPLATE_PLACEHOLDERS, EMAIL_TEMPLATE_SAMPLES as SAMPLE, renderTemplate, type EmailTemplateKey } from "@/domain/email-templates";
import { t } from "@/i18n";
import type { EmailTemplate } from "@/server/email/templates";
import { updateEmailTemplateAction } from "../settings/actions";

/** Line and summary parts: they have no subject of their own. */
const NO_SUBJECT = new Set<EmailTemplateKey>(["BATCH_LINE", "REPLY_QUOTE", "REPORT_SUMMARY", "REPORT_LINE_REQUESTED", "REPORT_LINE_REMAINING", "REPORT_LINE_TOTAL", "REPORT_LINE_COLLECTED", "REPORT_LINE_TRANSFERRED"]);

function sampleValues(key: EmailTemplateKey, signature: string, lineTemplate: string, bodies: Map<EmailTemplateKey, string>): Record<string, string> {
  if (key === "REPORT_SUMMARY") {
    // Every report section, its lines worded by the saved line templates.
    const line = (lineKey: EmailTemplateKey) => renderTemplate(bodies.get(lineKey) ?? "", SAMPLE);
    return {
      ...SAMPLE,
      requested_lines: line("REPORT_LINE_REQUESTED"),
      remaining_lines: `${line("REPORT_LINE_REMAINING")}\n${line("REPORT_LINE_TOTAL")}`,
      collected_lines: line("REPORT_LINE_COLLECTED"),
      transferred_lines: line("REPORT_LINE_TRANSFERRED"),
      requested_section: "1",
      remaining_section: "1",
      collected_section: "1",
      transferred_section: "1",
      problems_section: "1",
    };
  }
  if (key !== "BATCH") return { ...SAMPLE, signature };
  const lines = [SAMPLE, { ...SAMPLE, bl_no: "MEDU7654321", containers: "TGHU8765432", amount: "1.500,00" }];
  // A statement line shows the unexplained deduction as its amount.
  const statement = { ...SAMPLE, bl_no: "MEDU5555555", containers: "MSCU7777770", amount: SAMPLE.deduction_amount };
  return {
    ...SAMPLE,
    bl_no: "MEDU1234567, MEDU7654321, MEDU5555555",
    refund_section: lines.map((line) => renderTemplate(lineTemplate, line)).join("\n"),
    statement_section: renderTemplate(lineTemplate, statement),
    signature,
  };
}

export function TemplatesScreen({ templates, signature }: { templates: EmailTemplate[]; signature: string }) {
  const lineTemplate = templates.find((tpl) => tpl.key === "BATCH_LINE")?.body ?? "";
  const bodies = new Map(templates.map((tpl) => [tpl.key, tpl.body]));
  return (
    <div className="flex max-w-5xl flex-col gap-4">
      {templates.map((template) => (
        <TemplateCard key={`${template.key}:${template.updatedAt}`} template={template} signature={signature} lineTemplate={lineTemplate} bodies={bodies} />
      ))}
    </div>
  );
}

function TemplateCard({ template, signature, lineTemplate, bodies }: { template: EmailTemplate; signature: string; lineTemplate: string; bodies: Map<EmailTemplateKey, string> }) {
  const router = useRouter();
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const key = template.key;
  const values = sampleValues(key, signature, key === "BATCH_LINE" ? body : lineTemplate, bodies);
  const changed = subject !== template.subject || body !== template.body;

  const save = async () => {
    setSaving(true);
    const result = await updateEmailTemplateAction({ key, subject, body, reason });
    setSaving(false);
    if (!result.ok) return void toast.error(t(result.error, result.params));
    toast.success(t("templates.saved"));
    router.refresh();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(`templates.keys.${key}`)}</CardTitle>
        <p className="text-muted-foreground text-xs">{t(`templates.help.${key}`)}</p>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-3">
          {!NO_SUBJECT.has(key) && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${key}-subject`}>{t("templates.subject")}</Label>
              <Input id={`${key}-subject`} className="h-8" value={subject} onChange={(event) => setSubject(event.target.value)} />
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${key}-body`}>{t("templates.body")}</Label>
            <textarea
              id={`${key}-body`}
              rows={key === "BATCH_LINE" || key.startsWith("REPORT_LINE_") ? 2 : key === "REPLY_QUOTE" ? 9 : 12}
              className="border-input bg-background rounded-md border px-2 py-1 font-mono text-xs"
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </div>
          <p className="text-muted-foreground text-xs">
            {t("templates.placeholders")} {EMAIL_TEMPLATE_PLACEHOLDERS[key].map((p) => `{${p}}`).join(" ")}
          </p>
          {key === "BATCH" && <p className="text-muted-foreground text-xs">{t("templates.sectionsHint")}</p>}
          {key === "REPORT_SUMMARY" && <p className="text-muted-foreground text-xs">{t("templates.reportSectionsHint")}</p>}
          {key === "REPLY_QUOTE" && <p className="text-muted-foreground text-xs">{t("templates.quoteHint")}</p>}
          <div className="flex items-center gap-2">
            <Input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={t("common.reasonOptional")}
              aria-label={t("common.reasonOptional")}
              className="h-8"
            />
            <Button size="sm" onClick={save} disabled={saving || !changed || body.trim() === ""}>
              {t("templates.save")}
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-muted-foreground text-xs">{t("templates.preview")}</span>
          <div className="bg-muted/40 rounded-md border p-3 text-sm whitespace-pre-wrap" data-testid={`template-preview-${key}`}>
            {!NO_SUBJECT.has(key) && <div className="mb-2 font-medium">{renderTemplate(subject, values)}</div>}
            {renderTemplate(body, values)}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
