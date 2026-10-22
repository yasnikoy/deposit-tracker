declare module "pino-roll" {
  import type { DestinationStream } from "pino";

  type Options = {
    file: string | (() => string);
    size?: string | number;
    frequency?: "daily" | "hourly" | number;
    extension?: string;
    symlink?: boolean;
    limit?: { count?: number; removeOtherLogFiles?: boolean };
    dateFormat?: string;
    mkdir?: boolean;
  };

  export default function roll(options: Options): Promise<DestinationStream>;
}
