import { z } from "zod";

const columnId = z.string().max(64);

/** Per-user table layout, stored in user_preferences under `table:<tableId>`. */
export const tableLayoutSchema = z.object({
  columnVisibility: z.record(columnId, z.boolean()).default({}),
  columnOrder: z.array(columnId).max(100).default([]),
  sorting: z.array(z.object({ id: columnId, desc: z.boolean() })).max(10).default([]),
  columnFilters: z
    .array(z.object({ id: columnId, value: z.union([z.string().max(200), z.number(), z.boolean()]) }))
    .max(100)
    .default([]),
  density: z.enum(["compact", "comfortable"]).default("compact"),
  showFilters: z.boolean().default(false),
});

export type TableLayout = z.infer<typeof tableLayoutSchema>;

export const DEFAULT_TABLE_LAYOUT: TableLayout = tableLayoutSchema.parse({});

export const tableIdSchema = z.string().regex(/^[a-z0-9-]{1,64}$/);

export const saveTableLayoutSchema = z.object({ tableId: tableIdSchema, layout: tableLayoutSchema });
