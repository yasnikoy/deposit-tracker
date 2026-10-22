/**
 * Creates an admin user from the command line (first setup, or recovery when
 * no admin can log in). Usage: create-admin [username] [display name]
 * Missing values are asked for; the password is never echoed.
 */
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { z } from "zod";
import { t, isTranslationKey } from "@/i18n";
import { displayNameSchema, passwordSchema, usernameSchema } from "@/lib/schemas/users";
import { getDb } from "@/server/db/client";
import { DomainError } from "@/server/errors";
import { prepareDatabase } from "@/server/startup";
import { createUser, minPasswordLength } from "@/server/users";

function message(error: unknown, params?: Record<string, number>): string {
  if (error instanceof DomainError) return t(error.messageKey, error.params);
  if (error instanceof z.ZodError) {
    const key = error.issues[0]?.message ?? "";
    return isTranslationKey(key) ? t(key, params) : key;
  }
  return error instanceof Error ? error.message : String(error);
}

// readline echoes typed characters to its output; muting that stream hides the password.
let muted = false;
const output = new Writable({
  write(chunk, encoding, callback) {
    if (!muted) process.stdout.write(chunk, encoding);
    callback();
  },
});

/** Reads answers line by line; the iterator buffers input, so piped answers are not lost. */
function prompter(lines: AsyncIterator<string>) {
  return async (question: string, hidden = false): Promise<string> => {
    process.stdout.write(question);
    muted = hidden;
    try {
      const next = await lines.next();
      if (next.done) throw new Error("input ended before all answers were given");
      return next.value;
    } finally {
      muted = false;
      if (hidden) process.stdout.write("\n");
    }
  };
}

async function askValid<T>(ask: () => Promise<string>, schema: z.ZodType<T>, params?: Record<string, number>) {
  for (;;) {
    const parsed = schema.safeParse(await ask());
    if (parsed.success) return parsed.data;
    console.error(`  ${message(parsed.error, params)}`);
  }
}

async function main() {
  await prepareDatabase();
  const db = getDb();
  const minLength = minPasswordLength(db);
  const rl = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY });
  const ask = prompter(rl[Symbol.asyncIterator]());
  const [argUsername, ...argName] = process.argv.slice(2);

  try {
    const username = argUsername
      ? usernameSchema.parse(argUsername)
      : await askValid(() => ask(`${t("users.username")}: `), usernameSchema);
    const displayName = argName.length
      ? displayNameSchema.parse(argName.join(" "))
      : await askValid(() => ask(`${t("users.displayName")}: `), displayNameSchema);

    let password: string;
    for (;;) {
      password = await askValid(() => ask(`${t("auth.login.password")}: `, true), passwordSchema(minLength), {
        min: minLength,
      });
      if ((await ask(`${t("auth.changePassword.confirm")}: `, true)) === password) break;
      console.error(`  ${t("auth.changePassword.mismatch")}`);
    }

    // Created as a system action; the person running the script chose the password, so no forced change.
    const id = await createUser(db, null, { username, displayName, roles: ["ADMIN"], password, mustChangePassword: false });
    console.log(`OK: ${username} (id ${id}) — ${t("roles.ADMIN")}`);
  } finally {
    rl.close();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`HATA: ${message(error, { min: 0 })}`);
    process.exit(1);
  },
);
