/**
 * Seed the SOP library from the consolidated Server-Maintenance scope
 * (Starter/Cadila + NRB Bearings SOWs). The library is reusable — frequencies
 * here are sensible DEFAULTS; each project overrides per its contract (e.g. NRB
 * runs backups daily, restore test monthly). Idempotent: upserts by name.
 * Run: npm run seed:sops
 */
import { logger } from "../config/logger";
import { connectDatabase, disconnectDatabase } from "../config/database";
import { SopTemplate } from "../models/sopTemplate.model";
import type { SopFrequency } from "../utils/constants";

type Seed = { name: string; category: string; description: string; steps: string[]; defaultFrequency: SopFrequency };

const SOPS: Seed[] = [
  // ── Infrastructure ────────────────────────────────────────────────────────
  { name: "EC2 instance health check", category: "Infrastructure", defaultFrequency: "weekly",
    description: "Verify all AWS EC2 servers are running, reachable, and within healthy CPU/memory/disk thresholds.",
    steps: ["Confirm each EC2 instance is running & reachable", "Review CPU / memory / disk against thresholds", "Attach proof: CloudWatch dashboard screenshot"] },
  { name: "Server resource optimization", category: "Infrastructure", defaultFrequency: "monthly",
    description: "Review CPU/memory/disk utilisation trends; right-size instances and clear unused volumes where needed.",
    steps: ["Review utilisation trends", "Right-size instances / clear unused volumes", "Attach proof: optimisation note + before/after metrics"] },

  // ── Monitoring ────────────────────────────────────────────────────────────
  { name: "Uptime & health verification", category: "Monitoring", defaultFrequency: "weekly",
    description: "Confirm the site/app is up and healthy against the uptime target; log any outage and its duration.",
    steps: ["Confirm uptime against target", "Log any outages + durations", "Attach proof: uptime report / monitor export"] },
  { name: "Log monitoring (automated)", category: "Monitoring", defaultFrequency: "daily",
    description: "Automated error-pattern detection across application/system logs; triage flagged anomalies as needed.",
    steps: ["Confirm automated log detection is running", "Triage any flagged anomalies", "Attach proof: log summary / alert"] },
  { name: "Log review & error triage", category: "Monitoring", defaultFrequency: "weekly",
    description: "Manual review of application/system logs; flag recurring errors and resolve or raise tickets.",
    steps: ["Review logs for recurring errors", "Resolve or raise tickets", "Attach proof: log review note + tickets"] },
  { name: "CloudWatch metrics review", category: "Monitoring", defaultFrequency: "monthly",
    description: "Confirm monitoring metrics are being collected and alarms are configured correctly.",
    steps: ["Confirm metrics are being collected", "Verify alarms are configured", "Attach proof: metrics config screenshot"] },
  { name: "Critical alert config check", category: "Monitoring", defaultFrequency: "monthly",
    description: "Verify downtime and high CPU/memory alerts are active and routing to the right people.",
    steps: ["Verify downtime + resource alerts are active", "Confirm routing / recipients", "Attach proof: alert config screenshot"] },

  // ── Backup & DR ───────────────────────────────────────────────────────────
  { name: "Database backup verification", category: "Backup", defaultFrequency: "weekly",
    description: "Confirm scheduled DB backups completed successfully and are stored correctly; investigate any failure alert. (Tighter contracts run this daily with 30-day retention.)",
    steps: ["Confirm the backup job succeeded", "Verify backup is stored / retained correctly", "Attach proof: backup success log / alert"] },
  { name: "Full server snapshot (EBS)", category: "Backup", defaultFrequency: "weekly",
    description: "Take EBS snapshots of staging and production environments; confirm retention window.",
    steps: ["Trigger/verify EBS snapshot for staging + production", "Confirm retention window", "Attach proof: snapshot confirmation screenshot"] },
  { name: "Off-site backup (DR copy)", category: "Backup", defaultFrequency: "monthly",
    description: "Copy a full backup to a separate S3 bucket/region for disaster recovery.",
    steps: ["Copy full backup to off-site bucket/region", "Verify the copy's integrity", "Attach proof: off-site backup confirmation"] },
  { name: "Backup restore test", category: "Backup", defaultFrequency: "quarterly",
    description: "Perform a test restore from backup to confirm backups are actually usable and data integrity holds. (Tighter contracts run this monthly.)",
    steps: ["Restore a backup to a test target", "Verify data integrity / recoverability", "Attach proof: restore test log + outcome note"] },
  { name: "Disaster recovery (DR) drill", category: "Disaster Recovery", defaultFrequency: "quarterly",
    description: "Simulate a failure scenario, measure actual RTO against the target, and document results.",
    steps: ["Simulate a failure scenario", "Measure actual RTO vs target", "Attach proof: DR drill report"] },

  // ── Security ──────────────────────────────────────────────────────────────
  { name: "SSL certificate expiry check", category: "Security", defaultFrequency: "monthly",
    description: "Confirm SSL certificates are valid and not expiring within 30 days; manage/flag renewals early.",
    steps: ["List certificates + expiry dates", "Flag/renew anything within 30 days", "Attach proof: cert status screenshot / expiry list"] },
  { name: "Security patch assessment & application", category: "Security", defaultFrequency: "monthly",
    description: "Review OS/package security patches; apply critical ones (tighter contracts: within 48 hrs) and note any deferred patches.",
    steps: ["Check for OS/package security updates", "Apply critical patches; note deferred", "Attach proof: patch log / changelog entry"] },
  { name: "Secrets Manager security review", category: "Security", defaultFrequency: "monthly",
    description: "Audit AWS Secrets Manager entries, rotation status, and access permissions.",
    steps: ["Review Secrets Manager entries + rotation status", "Check access permissions", "Attach proof: review checklist screenshot"] },

  // ── Database ──────────────────────────────────────────────────────────────
  { name: "Database performance assessment", category: "Database", defaultFrequency: "monthly",
    description: "Review slow queries, index health, and connection load; recommend fixes.",
    steps: ["Review slow queries + index health", "Check connection load", "Attach proof: DB metrics report"] },

  // ── Reporting & Cost ──────────────────────────────────────────────────────
  { name: "Infrastructure health report", category: "Reporting", defaultFrequency: "monthly",
    description: "Compile uptime %, incident log (P1–P4), resource trends, deployments, patches and AWS cost into the monthly client report.",
    steps: ["Compile uptime, incidents, trends, deployments, patches, cost", "Generate the monthly client report", "Attach proof: the report PDF"] },
  { name: "Infrastructure cost review", category: "Cost", defaultFrequency: "quarterly",
    description: "Analyse AWS spend month-over-month; produce optimisation recommendations.",
    steps: ["Analyse AWS spend month-over-month", "Produce optimisation recommendations", "Attach proof: cost review note"] },

  // ── RESTRICTED — authorization-gated ──────────────────────────────────────
  { name: "[RESTRICTED] Black-box pentest (Strix)", category: "Security (Restricted)", defaultFrequency: "quarterly",
    description: "AUTHORIZATION-GATED — do NOT attach to a project unless that client's contract explicitly authorizes VAPT / security testing (out of scope for NRB & Cadila without a signed amendment). Runs an automated black-box scan against an authorised live URL; findings stay internal-review-only before anything reaches the client.",
    steps: ["Confirm a signed authorization exists for this client", "Run the authorised black-box scan", "Keep findings internal-review-only", "Attach proof: Strix findings report"] },
];

async function main(): Promise<void> {
  await connectDatabase();
  let created = 0;
  let updated = 0;
  for (const s of SOPS) {
    const existing = await SopTemplate.findOne({ name: s.name }).lean();
    await SopTemplate.updateOne(
      { name: s.name },
      { $set: { category: s.category, description: s.description, steps: s.steps, defaultFrequency: s.defaultFrequency }, $setOnInsert: { archived: false } },
      { upsert: true },
    );
    if (existing) updated += 1;
    else created += 1;
  }
  logger.info(`SOP library seeded: ${created} created, ${updated} updated (${SOPS.length} total)`);
  await disconnectDatabase();
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "SOP seed failed");
  process.exit(1);
});
