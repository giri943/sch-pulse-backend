/**
 * One-time migration: change the TTL on the `checks` collection to 14 days.
 *
 * Mongoose only creates missing indexes — it won't change `expireAfterSeconds`
 * on an existing one. This applies the new TTL via collMod and reports before/
 * after. Safe to run repeatedly (idempotent).
 *
 * Run:  npx tsx --env-file=.env src/scripts/migrate-checks-ttl.ts
 */
import mongoose from "mongoose";
import { connectDatabase, disconnectDatabase } from "../config/database";
import { Check } from "../models/check.model";

const TTL_DAYS = 14;
const TTL_SECONDS = 60 * 60 * 24 * TTL_DAYS;

(async () => {
  await connectDatabase();
  const db = mongoose.connection.db!;
  const coll = db.collection("checks");

  const before = await coll.estimatedDocumentCount();
  const idx = (await coll.indexes()).find((i) => i.key?.checkedAt === 1 && i.expireAfterSeconds != null);
  console.log(`checks: ~${before} docs · current TTL: ${idx ? `${idx.expireAfterSeconds}s (${(idx.expireAfterSeconds! / 86400).toFixed(0)}d)` : "none"}`);

  if (idx && idx.expireAfterSeconds === TTL_SECONDS) {
    console.log(`✓ TTL already ${TTL_DAYS} days — nothing to do.`);
  } else {
    await db.command({ collMod: "checks", index: { keyPattern: { checkedAt: 1 }, expireAfterSeconds: TTL_SECONDS } });
    console.log(`✓ TTL set to ${TTL_DAYS} days (${TTL_SECONDS}s). MongoDB will purge older docs on its next TTL sweep (~60s).`);
  }

  // Confirm and surface roughly how much will expire.
  const cutoff = new Date(Date.now() - TTL_SECONDS * 1000);
  const stale = await coll.countDocuments({ checkedAt: { $lt: cutoff } });
  console.log(`Docs older than ${TTL_DAYS}d (eligible for deletion): ${stale}`);

  void Check; // ensure the model/collection is registered
  await disconnectDatabase();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
