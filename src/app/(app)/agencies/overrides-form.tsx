"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OVERRIDABLE_SETTING_KEYS, type OverridableSettingKey } from "@/domain/settings/definitions";
import { t, type TranslationKey } from "@/i18n";
import { agencyOverridesSchema, type AgencyOverrides } from "@/lib/schemas/agencies";
import type { AgencyWithOverrides } from "@/server/agencies";
import { updateAgencyOverridesAction } from "./actions";

const days = (value: number) => `${value} ${t("settings.units.businessDays")}`;

/** Per-agency setting overrides: empty inherits the global value. Admin-only to change. */
export function OverridesForm({
  agency,
  globals,
  editable,
}: {
  agency: AgencyWithOverrides;
  globals: AgencyOverrides;
  editable: boolean;
}) {
  const router = useRouter();
  const [text, setText] = useState<Record<OverridableSettingKey, string>>(
    () =>
      Object.fromEntries(
        OVERRIDABLE_SETTING_KEYS.map((key) => [key, agency.overrides[key] === null ? "" : String(agency.overrides[key])]),
      ) as Record<OverridableSettingKey, string>,
  );
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const overrides = Object.fromEntries(
    OVERRIDABLE_SETTING_KEYS.map((key) => [key, text[key].trim() === "" ? null : Number(text[key])]),
  ) as AgencyOverrides;
  const parsed = agencyOverridesSchema.safeParse(overrides);
  const invalidKeys = new Set(parsed.success ? [] : parsed.error.issues.map((issue) => issue.path[0]));
  const changed = OVERRIDABLE_SETTING_KEYS.some((key) => overrides[key] !== agency.overrides[key]);

  const save = async () => {
    setSaving(true);
    const result = await updateAgencyOverridesAction({ agencyId: agency.id, overrides, reason });
    setSaving(false);
    if (!result.ok) return void toast.error(t(result.error, result.params));
    toast.success(t("agencies.toast.overrides"));
    router.refresh();
  };

  return (
    <section className="flex flex-col gap-3 border-t pt-4">
      <h3 className="font-semibold">{t("agencies.overrides")}</h3>
      <p className="text-muted-foreground text-xs">{editable ? t("agencies.overridesHint") : t("agencies.overridesReadOnly")}</p>
      {OVERRIDABLE_SETTING_KEYS.map((key) => (
        <div key={key} className="grid grid-cols-[1fr_6rem_8rem] items-center gap-2">
          <Label htmlFor={`override-${key}`} className="leading-snug">
            {t(`settings.keys.${key}.label` as TranslationKey)}
          </Label>
          {editable ? (
            <Input
              id={`override-${key}`}
              type="number"
              min={0}
              className="h-8"
              value={text[key]}
              aria-invalid={invalidKeys.has(key)}
              onChange={(event) => setText({ ...text, [key]: event.target.value })}
            />
          ) : (
            <span id={`override-${key}`} className="tabular">
              {agency.overrides[key] === null ? "—" : days(agency.overrides[key]!)}
            </span>
          )}
          <span className="text-muted-foreground text-xs">{t("agencies.globalValue", { value: days(globals[key]!) })}</span>
        </div>
      ))}
      {editable && (
        <div className="flex items-center gap-2">
          <Input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t("common.reasonOptional")}
            aria-label={t("common.reasonOptional")}
            className="h-8"
          />
          <Button size="sm" onClick={save} disabled={saving || !changed || !parsed.success}>
            {t("agencies.saveOverrides")}
          </Button>
        </div>
      )}
    </section>
  );
}
