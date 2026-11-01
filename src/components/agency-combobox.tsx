"use client";

import { SearchCombobox } from "@/components/search-combobox";
import { t } from "@/i18n";

export type AgencyOption = { id: number; name: string; bankSenderAliases: string[]; blNumberPatterns: string[]; active: boolean };

const aliasesOf = (a: AgencyOption) => a.bankSenderAliases;
const aliasHint = (a: AgencyOption) =>
  a.bankSenderAliases.length > 0 ? <div className="text-muted-foreground text-xs">{a.bankSenderAliases.join(" · ")}</div> : null;
const newAgencyLabel = (name: string) => t("agencies.addNew", { name });

/**
 * Agency picker searchable by name and by the sender names the bank prints on receipts.
 * With `onNewName`, a typed name that matches no agency can be chosen as a new agency.
 */
export function AgencyCombobox(props: {
  id?: string;
  agencies: AgencyOption[];
  value: number | null;
  onChange: (agencyId: number | null) => void;
  newName?: string | null;
  onNewName?: (name: string | null) => void;
  placeholder: string;
  invalid?: boolean;
}) {
  const { agencies, ...rest } = props;
  return <SearchCombobox {...rest} items={agencies} searchTexts={aliasesOf} hint={aliasHint} newLabel={newAgencyLabel} />;
}
