import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import { config } from "../config";
import * as schema from "./schema";

const sql = neon(config.databaseUrl);
export const db = drizzle(sql, { schema });
