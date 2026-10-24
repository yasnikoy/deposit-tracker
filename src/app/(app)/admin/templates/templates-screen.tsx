"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EMAIL_TEMPLATE_PLACEHOLDERS, renderTemplate, type EmailTemplateKey } from "@/domain/email-templates";
import { t } from "@/i18n";
import type { EmailTemplate } from "@/server/email/templates";
import { updateEmailTemplateAction } from "../settings/actions";

// Sample values for the live preview only; real emails take them from the B/L.
const SAMPLE: Record<string, string> = {
  agency_name: "Örnek Denizcilik",
  bl_no: "MEDU1234567",
  containers: "MSCU1234565, CSQU3054383",
  amount: "3.000,00",
  currency: "USD",
  attempt_no: "2",
  portal_ref: "PRT-1001",
  deduction_amount: "700,00",
};

function sampleValues(key: EmailTemplateKey, signature: string, lineTemplate: string): Record<string, string> {
  if (key !== "BATCH") return { ...SAMPLE, signature };
  const lines = [SAMPLE, { ...SAMPLE, bl_no: "MEDU7654321", containers: "TGHU8765432", amount: "1.500,00" }];
  return {
    ...SAMPLE,
    bl_no: "MEDU1234567, MEDU7654321",
    refund_section: lines.map((line) => renderTemplate(lineTemplate, line)).join("\n"),
    statement_section: "",
    signature,
  };
}

export function TemplatesScreen({ templates, signature }: { templates: EmailTemplate[]; signature: string }) {
  const lineTemplate = templates.find((tpl) => tpl.key === "BATCH_LINE")?.body ?? "";
  return (
    <div className="flex max-w-5xl flex-col gap-4">
      {templates.map((template) => (
        <TemplateCard key={`${template.key}:${template.updatedAt}`} template={template} signature={signature} lineTemplate={lineTemplate} />
      ))}
    </div>
  );
}

function TemplateCard({ template, signature, lineTemplate }: { template: EmailTemplate; signature: string; lineTemplate: string }) {
  const router = useRouter();
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const key = template.key;
  const values = sampleValues(key, signature, key === "BATCH_LINE" ? body : lineTemplate);
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
          {key !== "BATCH_LINE" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${key}-subject`}>{t("templates.subject")}</Label>
              <Input id={`${key}-subject`} className="h-8" value={subject} onChange={(event) => setSubject(event.target.value)} />
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${key}-body`}>{t("templates.body")}</Label>
            <textarea
              id={`${key}-body`}
              rows={key === "BATCH_LINE" ? 2 : 12}
              className="border-input bg-background rounded-md border px-2 py-1 font-mono text-xs"
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </div>
          <p className="text-muted-foreground text-xs">
            {t("templates.placeholders")} {EMAIL_TEMPLATE_PLACEHOLDERS[key].map((p) => `{${p}}`).join(" ")}
          </p>
          {key === "BATCH" && <p className="text-muted-foreground text-xs">{t("templates.sectionsHint")}</p>}
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
            {key !== "BATCH_LINE" && <div className="mb-2 font-medium">{renderTemplate(subject, values)}</div>}
            {renderTemplate(body, values)}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
