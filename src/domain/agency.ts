export const REQUEST_CHANNELS = ["EMAIL", "PORTAL"] as const;
export type RequestChannel = (typeof REQUEST_CHANNELS)[number];
