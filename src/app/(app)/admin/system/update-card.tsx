"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { t } from "@/i18n";
import { formatTimestamp } from "@/lib/format";
import type { UpdateState } from "@/server/updates";
import { checkUpdatesAction, installUpdateAction } from "./actions";

/** Update check and install (ARCHITECTURE → Updates): admins only, signed packages only. */
export function UpdateCard({ version, state, installed, canInstall }: { version: string; state: UpdateState; installed: boolean; canInstall: boolean }) {
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [restarting, setRestarting] = useState<string | null>(state.staged);
  const release = state.available;

  const check = async () => {
    setChecking(true);
    const result = await checkUpdatesAction({});
    setChecking(false);
    if (!result.ok) toast.error(t(result.error, result.params));
    router.refresh();
  };

  const install = async () => {
    toast.info(t("updates.installing"));
    const result = await installUpdateAction({});
    if (!result.ok) return void toast.error(t(result.error, result.params));
    setRestarting(result.data.version);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{t("updates.title")}</CardTitle>
        {installed && (
          <Button size="sm" variant="outline" onClick={check} disabled={checking || !!restarting}>
            {checking ? t("updates.checking") : t("updates.checkNow")}
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        <div>
          {t("updates.current")}: <span className="font-medium">{version}</span>
          {state.checkedAt && (
            <span className="text-muted-foreground">
              {" "}
              · {t("updates.lastCheck")}: {formatTimestamp(state.checkedAt)}
            </span>
          )}
        </div>
        {!installed && <p className="text-muted-foreground">{t("updates.devOnly")}</p>}
        {state.error && <p className="text-destructive">{t("updates.checkFailed", { error: state.error })}</p>}
        {installed && state.checkedAt && !state.error && !release && <p>{t("updates.upToDate")}</p>}
        {restarting && <p className="font-medium">{t("updates.restarting", { version: restarting })}</p>}
        {release && !restarting && (
          <>
            <p className="font-medium">{t("updates.available", { version: release.version })}</p>
            {release.notes && (
              <details>
                <summary className="cursor-pointer">{t("updates.notes")}</summary>
                <pre className="bg-muted mt-1 max-h-64 overflow-auto rounded p-2 text-xs whitespace-pre-wrap">{release.notes}</pre>
              </details>
            )}
            {release.kind === "manual" ? (
              <p>{t("updates.manual", { version: release.version })}</p>
            ) : (
              canInstall && (
                <div>
                  <Button size="sm" onClick={() => setConfirming(true)}>
                    {t("updates.install")}
                  </Button>
                </div>
              )
            )}
            <a href={release.url} target="_blank" rel="noreferrer" className="text-muted-foreground text-xs underline">
              {t("updates.openRelease")}
            </a>
          </>
        )}
        {release && (
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title={t("updates.confirmTitle", { version: release.version })}
            description={t("updates.confirmText")}
            confirmLabel={t("updates.install")}
            onConfirm={install}
          />
        )}
      </CardContent>
    </Card>
  );
}
