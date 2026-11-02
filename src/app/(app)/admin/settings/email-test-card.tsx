"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";
import { sendTestEmailAction } from "./actions";

/** Sends one message with the saved email settings (dry-run outside production). */
export function EmailTestCard() {
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);

  const send = async () => {
    setBusy(true);
    const result = await sendTestEmailAction({ to });
    setBusy(false);
    if (!result.ok) return void toast.error(t(result.error, result.params));
    toast.success(result.data.dryRun ? t("emailSettings.testDryRun") : t("emailSettings.testSent"));
  };

  return (
    <Card id="email-test" className="scroll-mt-28">
      <CardHeader>
        <CardTitle>{t("emailSettings.testTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-end gap-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email-test-to">{t("emailSettings.testTo")}</Label>
            <Input id="email-test-to" type="email" className="h-8 w-80" value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
          <Button size="sm" onClick={send} disabled={busy || to.trim() === ""}>
            {t("emailSettings.testSend")}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">{t("emailSettings.saveFirst")}</p>
      </CardContent>
    </Card>
  );
}
