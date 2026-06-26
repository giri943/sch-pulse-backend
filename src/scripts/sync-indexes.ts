/**
 * Build every model's indexes on the live DB.
 *
 * Production runs with autoIndex OFF (deliberate — no surprise index builds on
 * boot), so schema indexes must be created explicitly. This syncs them once:
 * creates anything missing (TTLs, the uptimestats unique key, monitor query
 * indexes, …) and drops indexes no longer in the schema. Idempotent.
 *
 * Run:  npx tsx --env-file=.env src/scripts/sync-indexes.ts
 *
 * Note: if `UptimeStat` fails with a duplicate-key (E11000) error, duplicate
 * hourly buckets exist (because the unique index was never enforced) — dedupe
 * them first, then re-run.
 */
import mongoose from "mongoose";
import { connectDatabase, disconnectDatabase } from "../config/database";

// Register every model so mongoose.modelNames() sees them all.
import "../models/auditLog.model";
import "../models/check.model";
import "../models/incident.model";
import "../models/monitor.model";
import "../models/notificationChannel.model";
import "../models/project.model";
import "../models/projectJoinRequest.model";
import "../models/projectMember.model";
import "../models/recommendationRule.model";
import "../models/role.model";
import "../models/uptimeStat.model";
import "../models/user.model";

(async () => {
  await connectDatabase();
  let failed = 0;
  for (const name of mongoose.modelNames().sort()) {
    try {
      const dropped = await mongoose.model(name).syncIndexes();
      console.log(`✓ ${name.padEnd(20)} in sync${dropped.length ? ` (dropped: ${dropped.join(", ")})` : ""}`);
    } catch (e) {
      failed++;
      console.log(`✗ ${name.padEnd(20)} ${(e as Error).message}`);
    }
  }
  console.log(failed ? `\n${failed} model(s) failed — see above.` : "\nAll indexes synced.");
  await disconnectDatabase();
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
