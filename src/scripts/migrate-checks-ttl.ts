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
  // Find a single-field { checkedAt: 1 } index, if any.
  const idx = (await coll.indexes()).find(
    (i) => i.key && (i.key as Record<string, unknown>).checkedAt === 1 && Object.keys(i.key).length === 1,
  );
  console.log(
    `checks: ~${before} docs · current { checkedAt } TTL: ${
      idx ? (idx.expireAfterSeconds != null ? `${(idx.expireAfterSeconds / 86400).toFixed(0)}d` : "index exists, no TTL") : "no index"
    }`,
  );

  if (!idx) {
    // The index never existed (autoIndex is off in prod) — create it with the TTL.
    await coll.createIndex({ checkedAt: 1 }, { expireAfterSeconds: TTL_SECONDS });
    console.log(`✓ Created { checkedAt } TTL index (${TTL_DAYS} days).`);
  } else if (idx.expireAfterSeconds === TTL_SECONDS) {
    console.log(`✓ TTL already ${TTL_DAYS} days — nothing to do.`);
  } else if (idx.expireAfterSeconds != null) {
    await db.command({ collMod: "checks", index: { keyPattern: { checkedAt: 1 }, expireAfterSeconds: TTL_SECONDS } });
    console.log(`✓ Updated TTL to ${TTL_DAYS} days.`);
  } else {
    // A non-TTL { checkedAt } index exists — recreate it as a TTL index.
    await coll.dropIndex(idx.name!);
    await coll.createIndex({ checkedAt: 1 }, { expireAfterSeconds: TTL_SECONDS });
    console.log(`✓ Recreated { checkedAt } as a ${TTL_DAYS}-day TTL index.`);
  }
  console.log("MongoDB purges expired docs on its next TTL sweep (~60s).");

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
