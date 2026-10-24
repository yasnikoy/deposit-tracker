"use client";

import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { SettingKind } from "@/domain/settings/definitions";
import { t, type TranslationKey } from "@/i18n";

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

const toList = (text: string) =>
  text
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter((part) => part !== "");

/** "20, 40, 60" → "0–20, 21–40, 41–60, 60+" */
export function describeBuckets(edges: number[]): string {
  const parts = edges.map((edge, i) => `${i === 0 ? 0 : edges[i - 1] + 1}–${edge}`);
  return [...parts, `${edges.at(-1)}+`].join(", ");
}

/** Editor for one setting value; emits the parsed value (validation happens in the form). */
export function SettingEditor({
  id,
  kind,
  value,
  options,
  secretSet,
  onChange,
}: {
  id: string;
  kind: SettingKind;
  value: unknown;
  /** Choices of a "choice" setting. */
  options?: readonly string[];
  /** Secret settings: whether a value is stored (the value itself is never sent here). */
  secretSet?: boolean;
  onChange: (value: unknown) => void;
}) {
  const initialText = Array.isArray(value) ? value.join(", ") : value === undefined || value === null ? "" : String(value);
  const [text, setText] = useState(initialText);

  switch (kind) {
    case "boolean":
      return <Checkbox id={id} checked={value === true} onCheckedChange={(checked) => onChange(checked === true)} />;

    case "weekdays": {
      const days = Array.isArray(value) ? (value as number[]) : [];
      return (
        <div id={id} className="flex gap-3">
          {WEEKDAYS.map((day) => (
            <label key={day} className="flex items-center gap-1.5">
              <Checkbox
                checked={days.includes(day)}
                onCheckedChange={(checked) =>
                  onChange((checked ? [...days, day] : days.filter((d) => d !== day)).sort((a, b) => a - b))
                }
                aria-label={t(`weekdaysLong.${day}`)}
              />
              {t(`weekdays.${day}`)}
            </label>
          ))}
        </div>
      );
    }

    case "businessDays":
    case "minutes":
    case "count":
    case "megabytes": {
      const unit = kind === "count" ? "" : t(`settings.units.${kind}`);
      return (
        <div className="flex items-center gap-2">
          <Input
            id={id}
            type="number"
            inputMode="numeric"
            className="h-8 w-24"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              onChange(event.target.value.trim() === "" ? Number.NaN : Number(event.target.value));
            }}
          />
          {unit && <span className="text-muted-foreground">{unit}</span>}
        </div>
      );
    }

    case "bucketEdges":
    case "fileTypes":
      return (
        <Input
          id={id}
          className="h-8 w-80"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            const parts = toList(event.target.value);
            onChange(kind === "bucketEdges" ? parts.map(Number) : parts.map((part) => part.replace(/^\./, "").toLowerCase()));
          }}
        />
      );

    case "time":
      return <Input id={id} type="time" className="h-8 w-32" value={String(value ?? "")} onChange={(event) => onChange(event.target.value)} />;

    case "choice":
      return (
        <select
          id={id}
          className="border-input bg-background h-8 w-48 rounded-md border px-2"
          value={String(value ?? "")}
          onChange={(event) => onChange(event.target.value)}
        >
          {(options ?? []).map((option) => (
            <option key={option} value={option}>
              {t(`settings.choices.${option}` as TranslationKey)}
            </option>
          ))}
        </select>
      );

    case "secret":
      return (
        <div className="flex flex-col gap-1">
          <Input
            id={id}
            type="password"
            autoComplete="new-password"
            className="h-8 w-80"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              onChange(event.target.value);
            }}
          />
          <span className="text-muted-foreground text-xs">{secretSet ? t("settings.secretSet") : t("settings.secretNotSet")}</span>
        </div>
      );

    case "emailList":
      return (
        <div className="flex flex-col gap-1">
          <textarea
            id={id}
            rows={2}
            className="border-input bg-background w-96 rounded-md border px-2 py-1 text-sm"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              onChange(toList(event.target.value));
            }}
          />
          <span className="text-muted-foreground text-xs">{t("settings.emailListHint")}</span>
        </div>
      );

    case "longText":
      return (
        <textarea
          id={id}
          rows={4}
          className="border-input bg-background w-96 rounded-md border px-2 py-1 text-sm"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            onChange(event.target.value);
          }}
        />
      );

    case "text":
      return (
        <Input
          id={id}
          className="h-8 w-96"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            onChange(event.target.value);
          }}
        />
      );
  }
}
