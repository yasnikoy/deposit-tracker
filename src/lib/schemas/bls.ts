import { z } from "zod";
import { isValidBlNumber, normalizeBlNumber } from "@/domain/bl-number";
import { checkContainerNumber } from "@/domain/containers";
import type { TranslationKey } from "@/i18n";

const msg = (key: TranslationKey) => key;
const MAX_ROWS = 200;

export const blNumberSchema = z
  .string()
  .transform(normalizeBlNumber)
  .refine(isValidBlNumber, msg("bls.errors.blNo"));

export const containerListSchema = z
  .array(z.string())
  .max(100)
  .transform((list) => list.map((c) => checkContainerNumber(c).value))
  .superRefine((list, ctx) => {
    list.forEach((value, index) => {
      if (!checkContainerNumber(value).formatOk) {
        ctx.addIssue({ code: "custom", path: [index], message: msg("bls.errors.containerFormat") });
      } else if (list.indexOf(value) !== index) {
        ctx.addIssue({ code: "custom", path: [index], message: msg("bls.errors.containerDuplicate") });
      }
    });
  });

export const blRowSchema = z.object({
  paymentId: z.number().int().positive(),
  blNo: blNumberSchema,
  containers: containerListSchema,
});

export type BlRowInput = z.infer<typeof blRowSchema>;

/** Rows are validated one by one on the server; this only bounds the request. */
export const createBlsSchema = z.object({ rows: z.array(z.unknown()).min(1).max(MAX_ROWS) });

export const updateBlSchema = z.object({
  id: z.number().int().positive(),
  blNo: blNumberSchema,
  containers: containerListSchema,
});
