"use client";

import { Download } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toastWithUndo } from "@/components/undo-toast";
import { toast } from "sonner";
import { FileDrop, uploadErrorText } from "@/components/file-drop";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { formatTimestamp } from "@/lib/format";
import type { BlDetail } from "@/server/bl-overview";
import { generateBlFormAction, uploadBlFormAction } from "./actions";

/** Download the prefilled agency form, then upload it once signed and scanned. */
export function FormSection({ blId, form, editable }: { blId: number; form: BlDetail["form"]; editable: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    setBusy(true);
    const result = await generateBlFormAction({ blId });
    setBusy(false);
    if (!result.ok) return void toast.error(t(result.error, result.params));
    if (result.data.bankAccountWarning) toast.warning(t(`forms.bankAccountWarning.${result.data.bankAccountWarning}`));
    // A file download, not a page: a temporary link keeps the user on the B/L.
    const link = document.createElement("a");
    link.href = `/api/files/${result.data.documentId}`;
    link.download = result.data.originalName;
    link.click();
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-3">
      {form.current ? (
        <p>
          {t("forms.currentForm")}{" "}
          <a href={`/api/files/${form.current.id}`} target="_blank" rel="noreferrer" className="underline">
            {form.current.originalName}
          </a>{" "}
          <span className="text-muted-foreground text-xs">({formatTimestamp(form.current.uploadedAt)})</span>
        </p>
      ) : (
        <p className="text-amber-700 dark:text-amber-400">{t("forms.noFormYet")}</p>
      )}
      {editable && (
        <>
          <div>
            <Button size="sm" variant="outline" onClick={download} disabled={busy || !form.templateAvailable}>
              <Download /> {t("forms.download")}
            </Button>
            {!form.templateAvailable && <p className="text-muted-foreground mt-1 text-xs">{t("forms.noTemplateForAgency")}</p>}
          </div>
          <FileDrop
            kind="FORM"
            label={form.current ? t("forms.replaceForm") : t("forms.uploadForm")}
            onUploaded={async ([upload]) => {
              setError(null);
              if (!upload.response.ok) return setError(uploadErrorText(upload.response));
              if (!upload.response.document) return;
              const result = await uploadBlFormAction({ blId, documentId: upload.response.document.id });
              if (!result.ok) return setError(t(result.error, result.params));
              toastWithUndo(t("forms.formUploaded"), result.data, () => router.refresh());
              router.refresh();
            }}
          />
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
        </>
      )}
    </div>
  );
}
