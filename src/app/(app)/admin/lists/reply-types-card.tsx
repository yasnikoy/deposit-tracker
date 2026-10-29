"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isTranslationKey, t } from "@/i18n";
import { replyTypeInputSchema } from "@/lib/schemas/lists";
import type { ActionResult } from "@/server/errors";
import type { ReplyType } from "@/server/lists";
import { saveReplyTypeAction } from "./actions";

/** Reply types for recording agency answers; the system ones can only be renamed and reordered. */
export function ReplyTypesCard({ replyTypes, onDone }: { replyTypes: ReplyType[]; onDone: (result: ActionResult<unknown>) => boolean }) {
  const [editing, setEditing] = useState<{ type: ReplyType | null } | null>(null);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center">
        <CardTitle>{t("lists.replyTypes")}</CardTitle>
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => setEditing({ type: null })}>
          <Plus /> {t("lists.addReplyType")}
        </Button>
      </CardHeader>
      <CardContent>
        <p className="text-muted-foreground mb-2 text-xs">{t("lists.replyTypesHint")}</p>
        <table className="w-full">
          <tbody>
            {replyTypes.map((type) => (
              <tr key={type.id} className="hover:bg-muted cursor-pointer border-t" onClick={() => setEditing({ type })}>
                <td className="py-1">{type.name}</td>
                <td className="text-muted-foreground py-1 text-xs">{type.code ? t(`lists.replyTypeEffects.${type.code}`) : t("lists.customReplyType")}</td>
                <td className="text-muted-foreground py-1 text-right text-xs">{type.active ? t("lists.active") : t("lists.inactive")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
      {editing && (
        <ReplyTypeDialog
          type={editing.type}
          nextSortOrder={replyTypes.length}
          onCancel={() => setEditing(null)}
          onDone={(result) => {
            const ok = onDone(result);
            if (ok) setEditing(null);
            return ok;
          }}
        />
      )}
    </Card>
  );
}

function ReplyTypeDialog({
  type,
  nextSortOrder,
  onCancel,
  onDone,
}: {
  type: ReplyType | null;
  nextSortOrder: number;
  onCancel: () => void;
  onDone: (result: ActionResult<unknown>) => boolean;
}) {
  const [values, setValues] = useState({ name: type?.name ?? "", active: type?.active ?? true, sortOrder: type?.sortOrder ?? nextSortOrder });
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const input = { ...(type ? { id: type.id } : {}), ...values, reason: "" };
    const parsed = replyTypeInputSchema.safeParse(input);
    if (!parsed.success) {
      const key = parsed.error.issues[0]?.message;
      return setError(key && isTranslationKey(key) ? t(key) : t("errors.validation"));
    }
    const result = await saveReplyTypeAction(input);
    if (!onDone(result) && !result.ok) setError(t(result.error, result.params));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{type ? type.name : t("lists.addReplyType")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reply-type-name">{t("lists.replyTypeName")}</Label>
            <Input id="reply-type-name" value={values.name} onChange={(e) => setValues({ ...values, name: e.target.value })} autoFocus />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reply-type-order">{t("lists.sortOrder")}</Label>
            <Input
              id="reply-type-order"
              type="number"
              min={0}
              className="w-24"
              value={values.sortOrder}
              onChange={(e) => setValues({ ...values, sortOrder: Number(e.target.value) })}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={values.active} disabled={!!type?.code} onCheckedChange={(checked) => setValues({ ...values, active: checked === true })} />
            {t("lists.active")}
          </label>
          {type?.code && <p className="text-muted-foreground text-xs">{t(`lists.replyTypeEffects.${type.code}`)}</p>}
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button onClick={save}>{t("common.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
