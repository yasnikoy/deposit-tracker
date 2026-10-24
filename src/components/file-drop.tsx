"use client";

import { Upload } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { isTranslationKey, t, type TranslationParams } from "@/i18n";
import { cn } from "@/lib/utils";

export type UploadResponse =
  | {
      ok: true;
      queueItemId?: number;
      document?: { id: number; originalName: string };
      prefill?: {
        agencyIds: number[];
        amountMinor: number | null;
        currency: string | null;
        paidAt: string | null;
        blCandidates: string[];
      };
      parser?: string;
    }
  | { ok: false; error: string; params?: TranslationParams };

async function uploadOne(file: File, kind: string, queue: boolean): Promise<UploadResponse> {
  const body = new FormData();
  body.set("file", file);
  body.set("kind", kind);
  body.set("queue", queue ? "1" : "0");
  try {
    const response = await fetch("/api/uploads", { method: "POST", body });
    return (await response.json()) as UploadResponse;
  } catch {
    return { ok: false, error: "files.errors.upload" };
  }
}

export function uploadErrorText(response: Extract<UploadResponse, { ok: false }>): string {
  return isTranslationKey(response.error) ? t(response.error, response.params) : t("files.errors.upload");
}

/** Drop zone (or click to choose) that uploads each file to /api/uploads. */
export function FileDrop({
  kind,
  multiple = false,
  queue = false,
  label,
  compact = false,
  onUploaded,
}: {
  kind: "RECEIPT" | "INVOICE" | "FORM" | "FORM_TEMPLATE" | "STANDING";
  multiple?: boolean;
  queue?: boolean;
  label: string;
  /** One-line drop target for table cells. */
  compact?: boolean;
  onUploaded: (results: { file: File; response: UploadResponse }[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  const handle = async (files: File[]) => {
    if (files.length === 0) return;
    setBusy(true);
    const results = [];
    for (const file of multiple ? files : files.slice(0, 1)) results.push({ file, response: await uploadOne(file, kind, queue) });
    setBusy(false);
    if (input.current) input.current.value = "";
    onUploaded(results);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void handle([...event.dataTransfer.files]);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => input.current?.click()}
      onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && input.current?.click()}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={cn(
        "text-muted-foreground flex cursor-pointer items-center rounded-md border-2 border-dashed text-center",
        compact ? "gap-1 px-2 py-0.5 text-xs" : "flex-col gap-2 p-6",
        dragging && "border-primary bg-muted",
      )}
    >
      <Upload className={compact ? "size-3.5" : "size-5"} />
      <span>{busy ? t("files.uploading") : label}</span>
      <input
        ref={input}
        type="file"
        multiple={multiple}
        className="sr-only"
        aria-label={label}
        onChange={(event) => void handle([...(event.target.files ?? [])])}
      />
    </div>
  );
}
