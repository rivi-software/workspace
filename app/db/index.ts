import { drizzle } from "drizzle-orm/d1";

// oxlint-disable-next-line unicorn/prefer-export-from -- re-exporting namespace avoids oxc/no-barrel-file threshold
import * as schema from "./schema";

export type Database = ReturnType<typeof createDb>;

export const createDb = (d1: D1Database) => drizzle(d1, { schema });

export { schema };
