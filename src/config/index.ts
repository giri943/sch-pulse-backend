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
  COOKIE_DOMAIN: z.string().default("localhost"),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  APP_BASE_URL: z.string().default("http://localhost:3000"),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().default(300),

  SCHEDULER_CRON: z.string().default("*/20 * * * * *"),
  CHECK_CONCURRENCY: z.coerce.number().int().min(1).default(10),

  MAIL_DRIVER: z.enum(["smtp", "ses", "sendgrid", "mailjet", "console"]).default("smtp"),
  MAIL_FROM: z.string().default("alerts@schbang.com"),
  SENDGRID_API_KEY: z.string().optional(),
  MAILJET_API_KEY: z.string().optional(),
  MAILJET_SECRET_KEY: z.string().optional(),
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

  // Google sign-in (restricted to ALLOWED_EMAIL_DOMAIN)
  GOOGLE_CLIENT_ID: z.string().optional(),
  ALLOWED_EMAIL_DOMAIN: z.string().default("schbang.com"),
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
  rateLimit: { windowMs: env.RATE_LIMIT_WINDOW_MS, max: env.RATE_LIMIT_MAX },

  scheduler: { cron: env.SCHEDULER_CRON, concurrency: env.CHECK_CONCURRENCY },

  mail: {
    driver: env.MAIL_DRIVER,
    from: env.MAIL_FROM,
    sendgridApiKey: env.SENDGRID_API_KEY,
    mailjet: { apiKey: env.MAILJET_API_KEY, secretKey: env.MAILJET_SECRET_KEY },
    smtp: {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
    },
  },
  aws: { region: env.AWS_REGION, sesFrom: env.SES_FROM_EMAIL ?? env.MAIL_FROM },
  google: { clientId: env.GOOGLE_CLIENT_ID, allowedDomain: env.ALLOWED_EMAIL_DOMAIN },
} as const;
