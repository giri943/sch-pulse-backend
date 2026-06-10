/**
 * Idempotent seed + migration:
 *  - system roles (Super Admin, Member) with permissions
 *  - first super-admin user
 *  - baseline recommendation rules
 *  - migrate legacy users (string role) and monitors (no owner / old alertRecipients)
 * Run: npm run seed
 */
import { logger } from "../config/logger";
import { connectDatabase, disconnectDatabase } from "../config/database";
import { User } from "../models/user.model";
import { Monitor } from "../models/monitor.model";
import { Role, SUPER_ADMIN_ROLE, MEMBER_ROLE } from "../models/role.model";
import { RecommendationRule } from "../models/recommendationRule.model";
import { ALL_PERMISSIONS, MEMBER_PERMISSIONS } from "../utils/permissions";
import { hashPassword } from "../utils/password";

const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@schbang.com";
const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!";

const RULES = [
  { name: "HTTP 502 Bad Gateway", matchType: "statusCode", matchValue: "502", category: "infra", title: "Upstream returned 502", steps: ["Check PM2 process status", "Check Node application logs", "Check Nginx upstream config"], priority: 10 },
  { name: "HTTP 524 Timeout", matchType: "statusCode", matchValue: "524", category: "db", title: "Origin timed out (524)", steps: ["Inspect slow database queries", "Check CPU usage", "Look for long-running requests"], priority: 10 },
  { name: "SSL Expired", matchType: "errorContains", matchValue: "certificate has expired", category: "ssl", title: "TLS certificate expired", steps: ["Check Certbot status", "Renew the certificate", "Reload the web server"], priority: 5 },
  { name: "DNS Failure", matchType: "errorContains", matchValue: "ENOTFOUND", category: "dns", title: "DNS resolution failed", steps: ["Check Route53 records", "Verify DNS records & propagation", "Check domain registration"], priority: 5 },
  { name: "Connection Refused", matchType: "errorContains", matchValue: "ECONNREFUSED", category: "infra", title: "Connection refused", steps: ["Verify the service is running", "Check the port & firewall/security group", "Check the load balancer target health"], priority: 20 },
  { name: "Request Timeout", matchType: "errorContains", matchValue: "ETIMEDOUT", category: "infra", title: "Request timed out", steps: ["Check origin server load/CPU", "Check network path & security groups", "Increase timeout or investigate slow upstream"], priority: 20 },
] as const;

async function main(): Promise<void> {
  await connectDatabase();

  // 1) System roles
  const superRole = await Role.findOneAndUpdate(
    { name: SUPER_ADMIN_ROLE },
    { name: SUPER_ADMIN_ROLE, description: "Full access to everything", permissions: ALL_PERMISSIONS, isSystem: true },
    { upsert: true, new: true },
  );
  const memberRole = await Role.findOneAndUpdate(
    { name: MEMBER_ROLE },
    { name: MEMBER_ROLE, description: "Create & manage own / tagged monitors", permissions: MEMBER_PERMISSIONS, isSystem: true },
    { upsert: true, new: true },
  );
  logger.info("✅ System roles ready (Super Admin, Member)");

  // 2) Super-admin user
  const admin = await User.findOne({ email: adminEmail });
  if (!admin) {
    await User.create({
      name: "Pulse Admin",
      email: adminEmail,
      role: superRole!._id,
      authProvider: "local",
      passwordHash: await hashPassword(adminPassword),
    });
    logger.info(`✅ Created super admin: ${adminEmail}`);
  } else {
    logger.info(`Super admin already exists: ${adminEmail}`);
  }
  const adminUser = await User.findOne({ email: adminEmail });

  // 3) Migrate legacy users whose role is a string enum (admin/manager/viewer)
  const legacy = await User.find({}).lean();
  for (const u of legacy) {
    const r = u.role as unknown;
    if (typeof r === "string" || !r) {
      const roleId = r === "admin" ? superRole!._id : memberRole!._id;
      await User.updateOne({ _id: u._id }, { role: roleId });
      logger.info(`  migrated user ${u.email} -> ${r === "admin" ? "Super Admin" : "Member"}`);
    }
  }

  // 4) Migrate monitors: assign owner + convert alertRecipients -> extraAlertEmails
  if (adminUser) {
    await Monitor.updateMany({ createdBy: { $exists: false } }, { createdBy: adminUser._id });
  }
  const rawMonitors = await Monitor.collection.find({ alertRecipients: { $exists: true } }).toArray();
  for (const m of rawMonitors) {
    await Monitor.collection.updateOne(
      { _id: m._id },
      { $set: { extraAlertEmails: m.alertRecipients ?? [] }, $unset: { alertRecipients: "" } },
    );
  }
  if (rawMonitors.length) logger.info(`  migrated ${rawMonitors.length} monitor(s) alertRecipients -> extraAlertEmails`);

  // 5) Recommendation rules
  for (const rule of RULES) {
    await RecommendationRule.updateOne(
      { matchType: rule.matchType, matchValue: rule.matchValue },
      { $setOnInsert: rule },
      { upsert: true },
    );
  }
  logger.info(`✅ Seeded ${RULES.length} recommendation rules`);

  await disconnectDatabase();
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "Seed failed");
  process.exit(1);
});
