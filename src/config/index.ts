import { z } from "zod";

/** Environment is validated once at boot — the process refuses to start if invalid. */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  MONGODB_URI: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(8),
  JWT_REFRESH_SECRET: z.string().min(8),
  ACCESS_TOKEN_TTL: z.string().default("15m"),
  REFRESH_TOKEN_TTL: z.string().default("7d"),
  // Leave unset for cross-domain deploys (Vercel frontend + Render backend) — the
  // refresh cookie then lives on the backend host. Only set for shared parent domains.
  COOKIE_DOMAIN: z.string().optional(),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  APP_BASE_URL: z.string().default("http://localhost:3000"),
  // Extra emails (comma-separated) always granted Super Admin, on top of the built-in list.
  SUPER_ADMIN_EMAILS: z.string().default(""),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().default(300),
  // Pretty, human-readable single-line logs (default). Set to "false" to emit
  // raw JSON instead — useful only if a log aggregator (Datadog/ELK) ingests them.
  LOG_PRETTY: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),

  SCHEDULER_CRON: z.string().default("*/20 * * * * *"),
  CHECK_CONCURRENCY: z.coerce.number().int().min(1).default(10),
  // Set to "false" to run this instance as API-only (no monitoring/lifecycle
  // crons). Use for a local/second instance so it doesn't double-check the same
  // sites as production (which doubles load on rate-limiting WAFs).
  SCHEDULER_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),

  MAIL_DRIVER: z.enum(["smtp", "ses", "sendgrid", "mailjet", "brevo", "console"]).default("smtp"),
  MAIL_FROM: z.string().default("alerts@schbang.com"),
  // Google Chat transport. "console" logs the payload instead of posting to the
  // webhook — mirror of MAIL_DRIVER=console, for local testing without pinging a real space.
  CHAT_DRIVER: z.enum(["google_chat", "console"]).default("google_chat"),
  SENDGRID_API_KEY: z.string().optional(),
  MAILJET_API_KEY: z.string().optional(),
  MAILJET_SECRET_KEY: z.string().optional(),
  BREVO_API_KEY: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),

  AWS_REGION: z.string().default("ap-south-1"),
  SES_FROM_EMAIL: z.string().email().optional(),
  // S3 for uploaded proof/attachments. Credentials come from the standard
  // AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY env vars (read by the SDK). If
  // S3_BUCKET is unset, uploads are simply disabled (feature degrades cleanly).
  S3_BUCKET: z.string().optional(),
  // Optional CDN (e.g. CloudFront) in front of the bucket for READING files.
  // When set, uploaded assets are served as `${CDN_URL}/${key}` (no signing).
  CDN_URL: z.string().url().optional(),

  // Google sign-in (restricted to ALLOWED_EMAIL_DOMAIN)
  GOOGLE_CLIENT_ID: z.string().optional(),
  ALLOWED_EMAIL_DOMAIN: z.string().default("schbang.com"),

  // Email/password login is OFF by default — the app is Google-only, which
  // removes the credential-stuffing/brute-force/reset-abuse surface. Set to
  // "true" as a break-glass measure (e.g. a Google Workspace outage).
  AUTH_PASSWORD_LOGIN_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),

  // SSRF guard: by default, monitor/SSL/domain probes refuse to connect to
  // private/loopback/link-local/metadata addresses. Set to "true" only if you
  // intentionally monitor internal hosts on a trusted network.
  ALLOW_PRIVATE_MONITOR_TARGETS: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("❌ Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}
const env = parsed.data;

// Guard against shipping placeholder/weak JWT secrets. Hard-fail in production.
const WEAK = [env.JWT_ACCESS_SECRET, env.JWT_REFRESH_SECRET].some(
  (s) => s.length < 32 || /change-?me/i.test(s),
);
if (WEAK) {
  const msg =
    "⚠️  Weak/default JWT secret detected. Use long random values for JWT_ACCESS_SECRET / JWT_REFRESH_SECRET (>=32 chars).";
  if (env.NODE_ENV === "production") {
    // eslint-disable-next-line no-console
    console.error(msg + " Refusing to start in production.");
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.warn(msg);
}

export const config = {
  env: env.NODE_ENV,
  isProd: env.NODE_ENV === "production",
  port: env.PORT,
  mongoUri: env.MONGODB_URI,
  jwt: {
    accessSecret: env.JWT_ACCESS_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET,
    accessTtl: env.ACCESS_TOKEN_TTL,
    refreshTtl: env.REFRESH_TOKEN_TTL,
  },
  cookieDomain: env.COOKIE_DOMAIN,
  corsOrigins: env.CORS_ORIGINS.split(",").map((s) => s.trim()),
  appBaseUrl: env.APP_BASE_URL,
  superAdminEmails: env.SUPER_ADMIN_EMAILS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  rateLimit: { windowMs: env.RATE_LIMIT_WINDOW_MS, max: env.RATE_LIMIT_MAX },
  logPretty: env.LOG_PRETTY,

  scheduler: { cron: env.SCHEDULER_CRON, concurrency: env.CHECK_CONCURRENCY, enabled: env.SCHEDULER_ENABLED },

  mail: {
    driver: env.MAIL_DRIVER,
    from: env.MAIL_FROM,
    sendgridApiKey: env.SENDGRID_API_KEY,
    brevoApiKey: env.BREVO_API_KEY,
    mailjet: { apiKey: env.MAILJET_API_KEY, secretKey: env.MAILJET_SECRET_KEY },
    smtp: {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
    },
  },
  chat: { driver: env.CHAT_DRIVER },
  aws: { region: env.AWS_REGION, sesFrom: env.SES_FROM_EMAIL ?? env.MAIL_FROM },
  s3: { bucket: env.S3_BUCKET, cdnUrl: env.CDN_URL?.replace(/\/$/, "") },
  google: { clientId: env.GOOGLE_CLIENT_ID, allowedDomain: env.ALLOWED_EMAIL_DOMAIN },
  // Password login: always on in dev (test any account without Google), plus the
  // break-glass flag for prod. In prod it stays off unless explicitly enabled.
  auth: { passwordLoginEnabled: env.AUTH_PASSWORD_LOGIN_ENABLED || env.NODE_ENV !== "production" },
  allowPrivateMonitorTargets: env.ALLOW_PRIVATE_MONITOR_TARGETS,
} as const;
