"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ImpactPreview } from "@/components/impact-preview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OVERRIDABLE_SETTING_KEYS, type OverridableSettingKey } from "@/domain/settings/definitions";
import { t, type TranslationKey } from "@/i18n";
import { agencyOverridesSchema, type AgencyOverrides } from "@/lib/schemas/agencies";
import type { ActionResult } from "@/server/errors";
import type { SettingsHypothesis } from "@/server/requests";

const days = (value: number) => `${value} ${t("settings.units.businessDays")}`;

/**
 * Request-timing overrides of an agency or a B/L: an empty field inherits the level above.
 * Admin-only to change; shows the impact on the request lists before saving.
 */
export function OverridesEditor({
  idPrefix,
  title,
  hint,
  values,
  inherited,
  inheritedLabel,
  editable,
  hypothesisOf,
  onSave,
  saveLabel,
  savedMessage,
}: {
  idPrefix: string;
  title: string;
  hint: string;
  values: AgencyOverrides;
  /** The value each field falls back to when left empty. */
  inherited: Record<OverridableSettingKey, number>;
  inheritedLabel: (value: string) => string;
  editable: boolean;
  hypothesisOf: (overrides: AgencyOverrides) => SettingsHypothesis;
  onSave: (overrides: AgencyOverrides, reason: string) => Promise<ActionResult<void>>;
  saveLabel: string;
  savedMessage: string;
}) {
  const router = useRouter();
  const [text, setText] = useState<Record<OverridableSettingKey, string>>(
    () =>
      Object.fromEntries(OVERRIDABLE_SETTING_KEYS.map((key) => [key, values[key] === null ? "" : String(values[key])])) as Record<
        OverridableSettingKey,
        string
      >,
  );
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const overrides = Object.fromEntries(
    OVERRIDABLE_SETTING_KEYS.map((key) => [key, text[key].trim() === "" ? null : Number(text[key])]),
  ) as AgencyOverrides;
  const parsed = agencyOverridesSchema.safeParse(overrides);
  const invalidKeys = new Set(parsed.success ? [] : parsed.error.issues.map((issue) => issue.path[0]));
  const changed = OVERRIDABLE_SETTING_KEYS.some((key) => overrides[key] !== values[key]);

  const save = async () => {
    setSaving(true);
    const result = await onSave(overrides, reason);
    setSaving(false);
    if (!result.ok) return void toast.error(t(result.error, result.params));
    toast.success(savedMessage);
    router.refresh();
  };

  return (
    <section className="flex flex-col gap-3">
      <h3 className="font-semibold">{title}</h3>
      <p className="text-muted-foreground text-xs">{editable ? hint : t("agencies.overridesReadOnly")}</p>
      {OVERRIDABLE_SETTING_KEYS.map((key) => (
        <div key={key} className="grid grid-cols-[1fr_6rem_8rem] items-center gap-2">
          <Label htmlFor={`${idPrefix}-${key}`} className="leading-snug">
            {t(`settings.keys.${key}.label` as TranslationKey)}
          </Label>
          {editable ? (
            <Input
              id={`${idPrefix}-${key}`}
              type="number"
              min={0}
              className="h-8"
              value={text[key]}
              aria-invalid={invalidKeys.has(key)}
              onChange={(event) => setText({ ...text, [key]: event.target.value })}
            />
          ) : (
            <span id={`${idPrefix}-${key}`} className="tabular">
              {values[key] === null ? "—" : days(values[key]!)}
            </span>
          )}
          <span className="text-muted-foreground text-xs">{inheritedLabel(days(inherited[key]))}</span>
        </div>
      ))}
      {editable && (
        <>
          <ImpactPreview hypothesis={changed && parsed.success ? hypothesisOf(overrides) : null} />
          <div className="flex items-center gap-2">
            <Input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={t("common.reasonOptional")}
              aria-label={t("common.reasonOptional")}
              className="h-8"
            />
            <Button size="sm" onClick={save} disabled={saving || !changed || !parsed.success}>
              {saveLabel}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
