"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { FileDrop, uploadErrorText } from "@/components/file-drop";
import { FORM_PLACEHOLDERS } from "@/domain/forms";
import { t } from "@/i18n";
import type { AgencyListItem } from "@/server/agencies";
import { setAgencyFormTemplateAction } from "./actions";

/** The agency's Word form: admins upload it; placeholders are checked on upload. */
export function FormTemplateCard({ agency, editable }: { agency: AgencyListItem; editable: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-semibold">{t("forms.templateTitle")}</h3>
      {agency.formTemplateDocumentId ? (
        <a href={`/api/files/${agency.formTemplateDocumentId}`} className="underline">
          {agency.formTemplateName}
        </a>
      ) : (
        <p className="text-muted-foreground">{t("forms.noTemplateYet")}</p>
      )}
      {editable && (
        <>
          <FileDrop
            kind="FORM_TEMPLATE"
            label={agency.formTemplateDocumentId ? t("forms.replaceTemplate") : t("forms.uploadTemplate")}
            onUploaded={async ([upload]) => {
              setError(null);
              if (!upload.response.ok) return setError(uploadErrorText(upload.response));
              if (!upload.response.document) return;
              const result = await setAgencyFormTemplateAction({ agencyId: agency.id, documentId: upload.response.document.id });
              if (!result.ok) return setError(t(result.error, result.params));
              toast.success(t("forms.templateSaved"));
              router.refresh();
            }}
          />
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <p className="text-muted-foreground text-xs">
            {t("forms.placeholderHelp")} {FORM_PLACEHOLDERS.map((p) => `{${p}}`).join(" ")}
          </p>
        </>
      )}
    </section>
  );
}
