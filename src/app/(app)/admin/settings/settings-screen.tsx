"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  SETTING_GROUPS,
  settingDefinitions,
  type SettingGroup,
  type SettingKey,
} from "@/domain/settings/definitions";
import { t, type TranslationKey } from "@/i18n";
import { formatTimestamp } from "@/lib/format";
import type { SettingListItem } from "@/server/settings";
import { updateSettingsAction } from "./actions";
import { describeBuckets, SettingEditor } from "./setting-editor";

const labelKey = (key: SettingKey) => `settings.keys.${key}.label` as TranslationKey;
const helpKey = (key: SettingKey) => `settings.keys.${key}.help` as TranslationKey;

export function SettingsScreen({ settings }: { settings: SettingListItem[] }) {
  return (
    <div className="flex gap-6">
      <nav className="sticky top-16 flex h-fit w-48 shrink-0 flex-col gap-1">
        {SETTING_GROUPS.map((group) => (
          <a key={group} href={`#${group}`} className="hover:bg-muted rounded-md px-2 py-1">
            {t(`settings.groups.${group}`)}
          </a>
        ))}
      </nav>
      <div className="flex max-w-4xl flex-1 flex-col gap-4">
        {SETTING_GROUPS.map((group) => {
          const items = settings.filter((s) => settingDefinitions[s.key].group === group);
          // Remount after a save so the form starts from the stored values.
          return <GroupForm key={`${group}:${JSON.stringify(items.map((i) => i.value))}`} group={group} items={items} />;
        })}
      </div>
    </div>
  );
}

function GroupForm({ group, items }: { group: SettingGroup; items: SettingListItem[] }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Record<string, unknown>>(() => Object.fromEntries(items.map((i) => [i.key, i.value])));
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const invalid = items.filter((i) => !settingDefinitions[i.key].schema.safeParse(draft[i.key]).success).map((i) => i.key);
  const changed = items.filter((i) => JSON.stringify(draft[i.key]) !== JSON.stringify(i.value));

  const save = async () => {
    setSaving(true);
    const result = await updateSettingsAction({ changes: changed.map((i) => ({ key: i.key, value: draft[i.key] })), reason });
    setSaving(false);
    if (!result.ok) {
      toast.error(t(result.error, result.params));
      return;
    }
    toast.success(result.data.length ? t("settings.saved", { count: result.data.length }) : t("settings.noChanges"));
    router.refresh();
  };

  return (
    <Card id={group} className="scroll-mt-16">
      <CardHeader>
        <CardTitle>{t(`settings.groups.${group}`)}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {items.map((item) => {
          const kind = settingDefinitions[item.key].kind;
          const value = draft[item.key];
          return (
            <div key={item.key} className="grid grid-cols-[18rem_1fr] items-start gap-x-6 gap-y-1">
              <Label htmlFor={item.key} className="pt-1.5 leading-snug">
                {t(labelKey(item.key))}
              </Label>
              <div className="flex flex-col gap-1">
                <SettingEditor id={item.key} kind={kind} value={value} onChange={(v) => setDraft((d) => ({ ...d, [item.key]: v }))} />
                {invalid.includes(item.key) && (
                  <p role="alert" className="text-destructive text-xs">
                    {t("settings.invalid")}
                  </p>
                )}
                {kind === "bucketEdges" && !invalid.includes(item.key) && (
                  <p className="text-xs">{t("settings.bucketsPreview", { buckets: describeBuckets(value as number[]) })}</p>
                )}
                <p className="text-muted-foreground text-xs">{t(helpKey(item.key))}</p>
                <p className="text-muted-foreground text-xs">
                  {item.changedBy
                    ? t("settings.lastChanged", { who: item.changedBy, at: formatTimestamp(item.changedAt!) })
                    : t("settings.seedValue")}
                </p>
              </div>
            </div>
          );
        })}
        <div className="flex items-center gap-2 border-t pt-4">
          <Input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t("common.reasonOptional")}
            aria-label={t("common.reasonOptional")}
            className="h-8 max-w-md"
          />
          <Button size="sm" className="ml-auto" disabled={saving || changed.length === 0 || invalid.length > 0} onClick={save}>
            {t("settings.save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
