import mongoose from "mongoose";
import { logger } from "../config/logger";

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

/**
 * Build every model's indexes on the live DB. Production runs with autoIndex off,
 * so this is how schema indexes (TTLs, unique keys, query indexes) get created.
 * Runs on boot — idempotent: it only does work when an index definition changed.
 * Non-fatal: a single model's failure (e.g. a duplicate-key on a new unique
 * index) is logged but never blocks startup.
 */
export async function syncAllIndexes(): Promise<void> {
  let failed = 0;
  for (const name of mongoose.modelNames().sort()) {
    try {
      await mongoose.model(name).syncIndexes();
    } catch (err) {
      failed++;
      logger.error({ model: name, err }, "Index sync failed");
    }
  }
  logger.info({ models: mongoose.modelNames().length, failed }, "Indexes synced");
}
