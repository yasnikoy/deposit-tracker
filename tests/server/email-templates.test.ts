import { expect, it } from "vitest";
import { ForbiddenError } from "@/server/errors";
import { getEmailTemplate, resetEmailTemplate, updateEmailTemplate } from "@/server/email/templates";
import { createTestDb, makeUser } from "../support/db";

it("an admin resets an edited template to the release's wording; it counts as unedited again", async () => {
  const db = createTestDb();
  const admin = await makeUser(db, "admin", ["ADMIN"]);
  const ops = await makeUser(db, "ops", ["OPERATIONS"]);
  const seeded = getEmailTemplate(db, "FOLLOW_UP");
  expect(() => resetEmailTemplate(db, admin, { key: "FOLLOW_UP", reason: null })).toThrow(expect.objectContaining({ messageKey: "settings.noChanges" }));

  updateEmailTemplate(db, admin, { key: "FOLLOW_UP", subject: "Kendi konumuz", body: "Kendi metnimiz", reason: null });
  expect(() => resetEmailTemplate(db, ops, { key: "FOLLOW_UP", reason: null })).toThrow(ForbiddenError);
  expect(resetEmailTemplate(db, admin, { key: "FOLLOW_UP", reason: "Bozuldu" })).toEqual({ subject: seeded.subject, body: seeded.body });
  expect(getEmailTemplate(db, "FOLLOW_UP")).toMatchObject({ subject: seeded.subject, body: seeded.body, updatedBy: null });
});
