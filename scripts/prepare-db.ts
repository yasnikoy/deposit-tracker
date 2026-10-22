/** Applies pending migrations (after an automatic backup) and loads missing seed settings. */
import { prepareDatabase } from "@/server/startup";

prepareDatabase().then(
  () => {
    console.log("Database is up to date.");
    process.exit(0);
  },
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
