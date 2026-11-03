import { z } from "zod";
import { isValidBlNumber, normalizeBlNumber } from "@/domain/bl-number";
import { checkContainerNumber } from "@/domain/containers";
import type { TranslationKey } from "@/i18n";
import { isValidFileNo, normalizeFileNo } from "@/domain/file-number";

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

/** Our internal file number, e.g. "T26-90815". */
/** Our file number, 26-12345 (a leading "T" from transfer descriptions is dropped); empty means none. */
/** The customer of a B/L, or null to clear it. */
export const setBlCustomerSchema = z.object({ blId: z.number().int().positive(), customerId: z.number().int().positive().nullable() });

export const fileNoSchema = z
  .string()
  .max(30, msg("bls.errors.fileNo"))
  .transform((value) => normalizeFileNo(value) || null)
  .refine((value) => value === null || isValidFileNo(value), msg("bls.errors.fileNo"));

export const blRowSchema = z.object({
  paymentId: z.number().int().positive(),
  blNo: blNumberSchema,
  // Optional: without them, the payment's receipt suggests both (file number, customer alias).
  customerId: z.number().int().positive().nullable().optional(),
  fileNo: fileNoSchema.nullable().optional(),
});

export type BlRowInput = z.infer<typeof blRowSchema>;

/** Rows are validated one by one on the server; this only bounds the request. */
export const createBlsSchema = z.object({ rows: z.array(z.unknown()).min(1).max(MAX_ROWS) });

/** A B/L edit: only the fields sent change. */
export const updateBlSchema = z.object({
  id: z.number().int().positive(),
  blNo: blNumberSchema.optional(),
  containers: containerListSchema.optional(),
  fileNo: fileNoSchema.nullable().optional(),
});

/** Header search; a pasted column of numbers may be long. */
export const blSearchSchema = z.object({ query: z.string().max(20_000) });

export const generateFormSchema = z.object({ blId: z.number().int().positive() });

export const uploadFormSchema = z.object({
  blId: z.number().int().positive(),
  documentId: z.number().int().positive(),
});
