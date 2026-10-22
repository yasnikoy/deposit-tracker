"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm, useWatch, type FieldErrors, type Resolver } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { REQUEST_CHANNELS, type RequestChannel } from "@/domain/agency";
import { extractBlNumbers } from "@/domain/bl-number";
import { isTranslationKey, t } from "@/i18n";
import { agencyInputSchema, type AgencyInput } from "@/lib/schemas/agencies";
import type { AgencyWithOverrides } from "@/server/agencies";
import { createAgencyAction, updateAgencyAction } from "./actions";

type FormValues = {
  name: string;
  active: boolean;
  toText: string;
  ccText: string;
  aliasesText: string;
  patternsText: string;
  batchSending: boolean;
  requestChannel: RequestChannel;
  portalUrl: string;
  notes: string;
};

// List fields are edited one item per line, so they can be pasted from Excel or Outlook.
const LIST_FIELDS = {
  toRecipients: "toText",
  ccRecipients: "ccText",
  bankSenderAliases: "aliasesText",
  blNumberPatterns: "patternsText",
} as const satisfies Partial<Record<keyof AgencyInput, keyof FormValues>>;

const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

function toInput(values: FormValues) {
  return {
    name: values.name,
    active: values.active,
    toRecipients: lines(values.toText),
    ccRecipients: lines(values.ccText),
    bankSenderAliases: lines(values.aliasesText),
    blNumberPatterns: lines(values.patternsText),
    batchSending: values.batchSending,
    requestChannel: values.requestChannel,
    portalUrl: values.portalUrl,
    notes: values.notes,
  };
}

/** Validates with the shared server schema; list errors name the offending line. */
const resolver: Resolver<FormValues> = async (values) => {
  const parsed = agencyInputSchema.safeParse(toInput(values));
  if (parsed.success) return { values, errors: {} };
  const errors: FieldErrors<FormValues> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0] as keyof AgencyInput;
    const formField = (LIST_FIELDS as Record<string, keyof FormValues>)[field] ?? (field as keyof FormValues);
    if (errors[formField]) continue;
    const text = isTranslationKey(issue.message) ? t(issue.message) : t("errors.validation");
    const line = typeof issue.path[1] === "number" ? ` (${t("common.line", { line: issue.path[1] + 1 })})` : "";
    errors[formField] = { type: "validation", message: text + line };
  }
  return { values: {}, errors };
};

function fromAgency(agency: AgencyWithOverrides | null): FormValues {
  return {
    name: agency?.name ?? "",
    active: agency?.active ?? true,
    toText: agency?.toRecipients.join("\n") ?? "",
    ccText: agency?.ccRecipients.join("\n") ?? "",
    aliasesText: agency?.bankSenderAliases.join("\n") ?? "",
    patternsText: agency?.blNumberPatterns.join("\n") ?? "",
    batchSending: agency?.batchSending ?? false,
    requestChannel: agency?.requestChannel ?? "EMAIL",
    portalUrl: agency?.portalUrl ?? "",
    notes: agency?.notes ?? "",
  };
}

function FieldError({ message }: { message?: string }) {
  return message ? (
    <p role="alert" className="text-destructive text-xs">
      {message}
    </p>
  ) : null;
}

const textareaClass = "border-input bg-background rounded-md border px-2 py-1 font-mono text-xs disabled:opacity-60";

export function AgencyForm({
  agency,
  readOnly,
  onCreated,
}: {
  agency: AgencyWithOverrides | null;
  readOnly: boolean;
  onCreated: (id: number) => void;
}) {
  const router = useRouter();
  const form = useForm<FormValues>({ resolver, defaultValues: fromAgency(agency) });
  const { errors, isSubmitting, isDirty } = form.formState;
  const [channel, patternsText, active, batchSending] = useWatch({
    control: form.control,
    name: ["requestChannel", "patternsText", "active", "batchSending"],
  });
  const [sample, setSample] = useState("");
  const found = sample.trim() ? extractBlNumbers(sample, lines(patternsText)) : null;

  const onSubmit = form.handleSubmit(async (values) => {
    const input = toInput(values);
    if (agency) {
      const result = await updateAgencyAction({ id: agency.id, agency: input });
      if (!result.ok) return void toast.error(t(result.error, result.params));
      toast.success(t("agencies.toast.updated"));
      form.reset(values);
    } else {
      const result = await createAgencyAction(input);
      if (!result.ok) return void toast.error(t(result.error, result.params));
      toast.success(t("agencies.toast.created"));
      onCreated(result.data);
    }
    router.refresh();
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      {readOnly && <p className="text-muted-foreground text-xs">{t("agencies.readOnly")}</p>}
      <fieldset disabled={readOnly || isSubmitting} className="flex flex-col gap-4">
        <div className="flex items-end gap-4">
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="agency-name">{t("agencies.name")}</Label>
            <Input id="agency-name" autoFocus={!agency} {...form.register("name")} />
            <FieldError message={errors.name?.message} />
          </div>
          <label className="flex items-center gap-2 pb-2">
            <Checkbox
              checked={active}
              onCheckedChange={(checked) => form.setValue("active", checked === true, { shouldDirty: true })}
              disabled={readOnly}
            />
            {t("agencies.active")}
          </label>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="agency-channel">{t("agencies.channel")}</Label>
            <select id="agency-channel" className="border-input bg-background h-9 rounded-md border px-2" {...form.register("requestChannel")}>
              {REQUEST_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {t(`agencies.channels.${c}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="agency-portal">{t("agencies.portalUrl")}</Label>
            <Input id="agency-portal" placeholder={channel === "PORTAL" ? "https://" : ""} {...form.register("portalUrl")} />
            <FieldError message={errors.portalUrl?.message} />
          </div>
        </div>

        <label className="flex items-center gap-2">
          <Checkbox
            checked={batchSending}
            onCheckedChange={(checked) => form.setValue("batchSending", checked === true, { shouldDirty: true })}
            disabled={readOnly}
          />
          {t("agencies.batchSending")}
        </label>

        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="agency-to">{t("agencies.toRecipients")}</Label>
            <textarea id="agency-to" rows={3} className={textareaClass} {...form.register("toText")} />
            <FieldError message={errors.toText?.message} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="agency-cc">{t("agencies.ccRecipients")}</Label>
            <textarea id="agency-cc" rows={3} className={textareaClass} {...form.register("ccText")} />
            <FieldError message={errors.ccText?.message} />
          </div>
          <p className="text-muted-foreground col-span-2 -mt-2 text-xs">{t("agencies.recipientsHint")}</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="agency-aliases">{t("agencies.aliases")}</Label>
          <textarea id="agency-aliases" rows={2} className={textareaClass} {...form.register("aliasesText")} />
          <p className="text-muted-foreground text-xs">{t("agencies.aliasesHint")}</p>
          <FieldError message={errors.aliasesText?.message} />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="agency-patterns">{t("agencies.patterns")}</Label>
          <textarea id="agency-patterns" rows={2} className={textareaClass} {...form.register("patternsText")} />
          <p className="text-muted-foreground text-xs">{t("agencies.patternsHint")}</p>
          <FieldError message={errors.patternsText?.message} />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="agency-notes">{t("agencies.notes")}</Label>
          <textarea id="agency-notes" rows={2} className={textareaClass.replace("font-mono text-xs", "text-sm")} {...form.register("notes")} />
        </div>
      </fieldset>

      {/* The pattern test works for every role; it only reads the patterns above. */}
      <div className="bg-muted/40 flex flex-col gap-1.5 rounded-md p-3">
        <Label htmlFor="agency-pattern-test">{t("agencies.patternTest")}</Label>
        <textarea
          id="agency-pattern-test"
          rows={2}
          value={sample}
          onChange={(event) => setSample(event.target.value)}
          placeholder={t("agencies.patternTestPlaceholder")}
          className={textareaClass}
        />
        {found && (
          <p data-testid="pattern-test-result" className="text-xs">
            {found.length ? t("agencies.patternTestFound", { list: found.join(", ") }) : t("agencies.patternTestNone")}
          </p>
        )}
      </div>

      {!readOnly && (
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={isSubmitting || (agency !== null && !isDirty)}>
            {t("common.save")}
          </Button>
        </div>
      )}
    </form>
  );
}
