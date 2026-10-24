"use client";

import { OverridesEditor } from "@/components/overrides-editor";
import type { OverridableSettingKey } from "@/domain/settings/definitions";
import { t } from "@/i18n";
import type { AgencyOverrides } from "@/lib/schemas/agencies";
import type { AgencyWithOverrides } from "@/server/agencies";
import { updateAgencyOverridesAction } from "./actions";

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
  return (
    <div className="border-t pt-4">
      <OverridesEditor
        idPrefix="override"
        title={t("agencies.overrides")}
        hint={t("agencies.overridesHint")}
        values={agency.overrides}
        inherited={globals as Record<OverridableSettingKey, number>}
        inheritedLabel={(value) => t("agencies.globalValue", { value })}
        editable={editable}
        hypothesisOf={(overrides) => ({ agency: { agencyId: agency.id, overrides } })}
        onSave={(overrides, reason) => updateAgencyOverridesAction({ agencyId: agency.id, overrides, reason })}
        saveLabel={t("agencies.saveOverrides")}
        savedMessage={t("agencies.toast.overrides")}
      />
    </div>
  );
}
