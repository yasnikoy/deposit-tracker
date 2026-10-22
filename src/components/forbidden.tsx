import { Alert, AlertDescription } from "@/components/ui/alert";
import { t } from "@/i18n";

export function Forbidden() {
  return (
    <Alert variant="destructive" className="max-w-lg">
      <AlertDescription>{t("errors.forbidden")}</AlertDescription>
    </Alert>
  );
}
