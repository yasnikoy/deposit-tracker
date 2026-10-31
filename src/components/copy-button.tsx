"use client";

import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { copyText } from "@/lib/clipboard";

export function CopyButton({ value }: { value: string }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-6"
      aria-label={`${t("common.copy")}: ${value}`}
      onClick={async (event) => {
        event.stopPropagation();
        await copyText(value);
        toast.success(t("common.copied"));
      }}
    >
      <Copy className="size-3.5" />
    </Button>
  );
}
