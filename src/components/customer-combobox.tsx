"use client";

import { SearchCombobox } from "@/components/search-combobox";
import { t } from "@/i18n";

export type CustomerOption = { id: number; name: string; code: string | null; aliases: string[]; active: boolean };

const searchTextsOf = (c: CustomerOption) => [...c.aliases, ...(c.code ? [c.code] : [])];
const codeHint = (c: CustomerOption) => (c.code ? <div className="text-muted-foreground text-xs">{c.code}</div> : null);
const newCustomerLabel = (name: string) => t("customers.addNew", { name });

/** Customer picker searchable by name, aliases and code; a new customer can be named. */
export function CustomerCombobox(props: {
  id?: string;
  customers: CustomerOption[];
  value: number | null;
  onChange: (customerId: number | null) => void;
  newName?: string | null;
  onNewName?: (name: string | null) => void;
  placeholder: string;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const { customers, ...rest } = props;
  return <SearchCombobox {...rest} items={customers} searchTexts={searchTextsOf} hint={codeHint} newLabel={newCustomerLabel} />;
}
