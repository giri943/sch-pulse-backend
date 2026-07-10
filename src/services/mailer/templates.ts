import type { EmailMessage } from "./index";
import { config } from "../../config";
import { humanizeError } from "../../utils/humanizeError";

interface RecommendationSnap {
  title: string;
  steps: string[];
}

// ── Palette (light, high-deliverability — renders consistently across clients) ──
const BRAND = "#6366f1";
const NAVY = "#172b4d";
const TEXT = "#243044";
const MUTED = "#6b7280";
const BG = "#f4f5f7";
const CARD = "#ffffff";
const BORDER = "#e5e7eb";
const SOFT = "#f8fafc";

const ACCENT = {
  down: "#e5484d",
  up: "#2da44e",
  warn: "#d97706",
  info: BRAND,
} as const;
type Accent = keyof typeof ACCENT;

/** Escape user-controlled text before putting it in HTML (prevents injection). */
function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const monitorLink = (id?: string): string | null => (id && config.appBaseUrl ? `${config.appBaseUrl}/monitors/${id}` : null);

function button(label: string, url?: string | null): string {
  if (!url) return "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 4px"><tr>
    <td style="border-radius:8px;background:${BRAND}">
      <a href="${esc(url)}" style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px">${esc(label)}</a>
    </td></tr></table>`;
}

/** A clean label/value details table; values are escaped here. */
function details(rows: [string, string | null | undefined][]): string {
  const visible = rows.filter(([, v]) => v != null && v !== "");
  if (!visible.length) return "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 4px;border-collapse:collapse">
    ${visible
      .map(
        ([k, v], i) => `<tr>
        <td style="padding:10px 0;${i ? `border-top:1px solid ${BORDER};` : ""}width:36%;color:${MUTED};font-size:13px;vertical-align:top">${esc(k)}</td>
        <td style="padding:10px 0;${i ? `border-top:1px solid ${BORDER};` : ""}color:${TEXT};font-size:13px;font-weight:500;vertical-align:top;word-break:break-word">${esc(v)}</td>
      </tr>`,
      )
      .join("")}
  </table>`;
}

function recsHtml(recs: RecommendationSnap[]): string {
  if (!recs.length) return "";
  return `<div style="margin:18px 0 4px;padding:14px 16px;background:${SOFT};border:1px solid ${BORDER};border-radius:10px">
    <div style="font-size:13px;font-weight:700;color:${NAVY};margin-bottom:8px">Suggested next steps</div>
    ${recs
      .map(
        (r) => `<div style="margin-bottom:10px">
        <div style="font-size:13px;font-weight:600;color:${TEXT}">${esc(r.title)}</div>
        <ul style="margin:4px 0 0;padding-left:18px;color:${MUTED};font-size:13px;line-height:1.5">${r.steps.map((s) => `<li style="margin:2px 0">${esc(s)}</li>`).join("")}</ul>
      </div>`,
      )
      .join("")}
  </div>`;
}

/** The shared email frame. `intro` and `bodyHtml` may contain trusted HTML; escape dynamic values before passing. */
function shell(opts: { accent: Accent; eyebrow: string; title: string; intro?: string; bodyHtml?: string; footerNote?: string }): string {
  const accent = ACCENT[opts.accent];
  const preheader = opts.title;
  return `<!doctype html><html lang="en"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only">
  </head><body style="margin:0;padding:0;background:${BG};-webkit-font-smoothing:antialiased">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${CARD};border:1px solid ${BORDER};border-radius:14px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
        <tr><td style="height:4px;background:${accent};font-size:0;line-height:0">&nbsp;</td></tr>
        <tr><td style="padding:22px 28px 0">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="font-size:15px;font-weight:700;color:${NAVY};letter-spacing:-0.01em"><span style="color:${BRAND}">&#9679;</span>&nbsp;Schbang Pulse</td>
            <td align="right" style="font-size:11px;font-weight:700;color:${accent};text-transform:uppercase;letter-spacing:0.06em">${esc(opts.eyebrow)}</td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:14px 28px 26px">
          <h1 style="margin:6px 0 0;font-size:21px;line-height:1.3;color:${NAVY};font-weight:700;letter-spacing:-0.02em">${esc(opts.title)}</h1>
          ${opts.intro ? `<p style="margin:10px 0 0;font-size:14px;line-height:1.6;color:${TEXT}">${opts.intro}</p>` : ""}
          ${opts.bodyHtml ?? ""}
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid ${BORDER};background:${SOFT}">
          <p style="margin:0;font-size:12px;line-height:1.55;color:${MUTED}">${opts.footerNote ? esc(opts.footerNote) + "<br>" : ""}Sent by Schbang Pulse — automated monitoring. Please don't reply to this message.</p>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Incident: opened
// ─────────────────────────────────────────────────────────────────────────────
export function incidentOpenedEmail(p: {
  to: string[];
  monitorName: string;
  url: string;
  error: string;
  statusCode?: number;
  server?: string | null;
  timestamp: string;
  recommendations: RecommendationSnap[];
  monitorId?: string;
  project?: string;
}): EmailMessage {
  const subject = `[Schbang Pulse] ${p.monitorName} is DOWN`;
  const link = monitorLink(p.monitorId);
  const human = humanizeError({ statusCode: p.statusCode, error: p.error, server: p.server });
  const intro = `We detected that <strong>${esc(p.monitorName)}</strong> stopped responding to our checks. The incident is open and we'll let you know the moment it recovers.`;
  const body =
    details([
      ["Project", p.project],
      ["URL", p.url],
      ["What this means", human],
      ["Error", p.error],
      ["Response code", p.statusCode != null ? String(p.statusCode) : "—"],
      ["Detected at", fmtWhen(p.timestamp)],
    ]) +
    recsHtml(p.recommendations) +
    button("View incident", link);
  return {
    to: p.to,
    subject,
    html: shell({ accent: "down", eyebrow: "Incident · Down", title: `${p.monitorName} is down`, intro, bodyHtml: body, footerNote: footerFor(p.monitorName) }),
    text: textBlock(subject, [
      ["Project", p.project],
      ["URL", p.url],
      ["What this means", human],
      ["Error", p.error],
      ["Response code", p.statusCode != null ? String(p.statusCode) : "—"],
      ["Detected at", fmtWhen(p.timestamp)],
      ["View", link],
    ]),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Incident: resolved
// ─────────────────────────────────────────────────────────────────────────────
export function incidentResolvedEmail(p: {
  to: string[];
  monitorName: string;
  url: string;
  downtime: string;
  recoveredAt: string;
  monitorId?: string;
  project?: string;
}): EmailMessage {
  const subject = `[Schbang Pulse] ${p.monitorName} has recovered`;
  const link = monitorLink(p.monitorId);
  const intro = `<strong>${esc(p.monitorName)}</strong> is responding normally again. The incident is now resolved.`;
  const body =
    details([
      ["Project", p.project],
      ["URL", p.url],
      ["Total downtime", p.downtime],
      ["Recovered at", fmtWhen(p.recoveredAt)],
    ]) + button("View monitor", link);
  return {
    to: p.to,
    subject,
    html: shell({ accent: "up", eyebrow: "Incident · Resolved", title: `${p.monitorName} recovered`, intro, bodyHtml: body, footerNote: footerFor(p.monitorName) }),
    text: textBlock(subject, [
      ["Project", p.project],
      ["URL", p.url],
      ["Total downtime", p.downtime],
      ["Recovered at", fmtWhen(p.recoveredAt)],
      ["View", link],
    ]),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Monitor degraded (a check failed; rechecking shortly)
// ─────────────────────────────────────────────────────────────────────────────
export function monitorDegradedEmail(p: {
  to: string[];
  monitorName: string;
  url: string;
  error: string;
  statusCode?: number;
  server?: string | null;
  timestamp: string;
  monitorId?: string;
  project?: string;
}): EmailMessage {
  const subject = `[Schbang Pulse] ${p.monitorName} is degraded`;
  const link = monitorLink(p.monitorId);
  const human = humanizeError({ statusCode: p.statusCode, error: p.error, server: p.server });
  const intro = `A check for <strong>${esc(p.monitorName)}</strong> just failed. We're re-checking in ~2 minutes to confirm whether it's a brief blip or a real outage — you'll get a follow-up either way.`;
  const body =
    details([
      ["Project", p.project],
      ["URL", p.url],
      ["What this means", human],
      ["Error", p.error],
      ["Response code", p.statusCode != null ? String(p.statusCode) : "—"],
      ["First seen", fmtWhen(p.timestamp)],
    ]) + button("View monitor", link);
  return {
    to: p.to,
    subject,
    html: shell({ accent: "warn", eyebrow: "Degraded", title: `${p.monitorName} is degraded`, intro, bodyHtml: body, footerNote: footerFor(p.monitorName) }),
    text: textBlock(subject, [
      ["Project", p.project],
      ["URL", p.url],
      ["What this means", human],
      ["Error", p.error],
      ["Response code", p.statusCode != null ? String(p.statusCode) : "—"],
      ["First seen", fmtWhen(p.timestamp)],
      ["View", link],
    ]),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Monitor recovered after a degraded blip (no incident / no downtime)
// ─────────────────────────────────────────────────────────────────────────────
export function monitorRecoveredEmail(p: {
  to: string[];
  monitorName: string;
  url: string;
  recoveredAt: string;
  monitorId?: string;
  project?: string;
}): EmailMessage {
  const subject = `[Schbang Pulse] ${p.monitorName} recovered`;
  const link = monitorLink(p.monitorId);
  const intro = `<strong>${esc(p.monitorName)}</strong> is responding normally again after a brief degraded check. No downtime was recorded.`;
  const body =
    details([
      ["Project", p.project],
      ["URL", p.url],
      ["Recovered at", fmtWhen(p.recoveredAt)],
    ]) + button("View monitor", link);
  return {
    to: p.to,
    subject,
    html: shell({ accent: "up", eyebrow: "Recovered", title: `${p.monitorName} recovered`, intro, bodyHtml: body, footerNote: footerFor(p.monitorName) }),
    text: textBlock(subject, [
      ["Project", p.project],
      ["URL", p.url],
      ["Recovered at", fmtWhen(p.recoveredAt)],
      ["View", link],
    ]),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SSL expiry warning
// ─────────────────────────────────────────────────────────────────────────────
export function sslWarningEmail(p: {
  to: string[];
  domain: string;
  expiresAt: string;
  daysRemaining: number;
  monitorId?: string;
  monitorName?: string;
  project?: string;
}): EmailMessage {
  const subject = `[Schbang Pulse] SSL expires in ${p.daysRemaining} day${p.daysRemaining === 1 ? "" : "s"} — ${p.monitorName ?? p.domain}`;
  const link = monitorLink(p.monitorId);
  const intro = `The SSL certificate for <strong>${esc(p.domain)}</strong> expires in <strong>${p.daysRemaining} day${p.daysRemaining === 1 ? "" : "s"}</strong>. Renew it before then to avoid browser security warnings and downtime.`;
  const body =
    details([
      ["Project", p.project],
      ["Monitor", p.monitorName],
      ["Domain", p.domain],
      ["Expires on", fmtDate(p.expiresAt)],
      ["Days remaining", String(p.daysRemaining)],
    ]) + button("View monitor", link);
  return {
    to: p.to,
    subject,
    html: shell({ accent: "warn", eyebrow: "SSL · Expiring", title: `SSL certificate expiring in ${p.daysRemaining} day${p.daysRemaining === 1 ? "" : "s"}`, intro, bodyHtml: body }),
    text: textBlock(subject, [
      ["Domain", p.domain],
      ["Expires on", fmtDate(p.expiresAt)],
      ["Days remaining", String(p.daysRemaining)],
      ["View", link],
    ]),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain registration expiry warning
// ─────────────────────────────────────────────────────────────────────────────
export function domainExpiringEmail(p: {
  to: string[];
  domain: string;
  monitorName: string;
  expiresAt: string;
  daysRemaining: number;
  monitorId?: string;
  project?: string;
}): EmailMessage {
  const subject = `[Schbang Pulse] Domain expires in ${p.daysRemaining} day${p.daysRemaining === 1 ? "" : "s"} — ${p.domain}`;
  const link = monitorLink(p.monitorId);
  const intro = `The domain registration for <strong>${esc(p.domain)}</strong> expires in <strong>${p.daysRemaining} day${p.daysRemaining === 1 ? "" : "s"}</strong>. An expired domain takes the entire site and email offline — and can be lost to another buyer. Renew it with your registrar now.`;
  const body =
    details([
      ["Project", p.project],
      ["Monitor", p.monitorName],
      ["Domain", p.domain],
      ["Registration expires", fmtDate(p.expiresAt)],
      ["Days remaining", String(p.daysRemaining)],
    ]) + button("View monitor", link);
  return {
    to: p.to,
    subject,
    html: shell({ accent: "down", eyebrow: "Domain · Expiring", title: `Domain expiring in ${p.daysRemaining} day${p.daysRemaining === 1 ? "" : "s"}`, intro, bodyHtml: body }),
    text: textBlock(subject, [
      ["Domain", p.domain],
      ["Registration expires", fmtDate(p.expiresAt)],
      ["Days remaining", String(p.daysRemaining)],
      ["View", link],
    ]),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test notification
// ─────────────────────────────────────────────────────────────────────────────
export function testNotificationEmail(p: { to: string[]; monitorName: string; url: string; monitorId?: string }): EmailMessage {
  const subject = `[Schbang Pulse] Test alert — ${p.monitorName}`;
  const link = monitorLink(p.monitorId);
  const intro = `This is a test alert for <strong>${esc(p.monitorName)}</strong>. If it reached your inbox, notifications for this monitor are set up correctly.`;
  const body = details([["Monitor", p.monitorName], ["URL", p.url]]) + button("View monitor", link);
  return {
    to: p.to,
    subject,
    html: shell({ accent: "info", eyebrow: "Test", title: "Notifications are working", intro, bodyHtml: body }),
    text: textBlock(subject, [["Monitor", p.monitorName], ["URL", p.url], ["View", link]]),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Project: join request (to owners)
// ─────────────────────────────────────────────────────────────────────────────
export function projectJoinRequestEmail(p: {
  to: string[];
  projectName: string;
  requesterName: string;
  requesterEmail: string;
  message?: string;
}): EmailMessage {
  const subject = `[Schbang Pulse] ${p.requesterName} requested access to ${p.projectName}`;
  const link = config.appBaseUrl ? `${config.appBaseUrl}/projects` : null;
  const intro = `<strong>${esc(p.requesterName)}</strong> (${esc(p.requesterEmail)}) is requesting access to the <strong>${esc(p.projectName)}</strong> project.`;
  const body =
    details([
      ["Project", p.projectName],
      ["Requested by", `${p.requesterName} (${p.requesterEmail})`],
      ["Message", p.message],
    ]) +
    `<p style="margin:14px 0 0;font-size:13px;color:${MUTED}">Open the project's <strong>Members</strong> tab to approve with a role, or decline.</p>` +
    button("Review request", link);
  return {
    to: p.to,
    subject,
    html: shell({ accent: "info", eyebrow: "Access request", title: "New access request", intro, bodyHtml: body }),
    text: textBlock(subject, [
      ["Project", p.projectName],
      ["Requested by", `${p.requesterName} (${p.requesterEmail})`],
      ["Message", p.message],
      ["Review", link],
    ]),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Project: join decision (to requester)
// ─────────────────────────────────────────────────────────────────────────────
export function projectJoinDecisionEmail(p: {
  to: string[];
  projectName: string;
  accepted: boolean;
  deciderName: string;
  role?: string;
  projectId?: string;
}): EmailMessage {
  const subject = `[Schbang Pulse] Your request to join ${p.projectName} was ${p.accepted ? "approved" : "declined"}`;
  const link = p.accepted && config.appBaseUrl ? `${config.appBaseUrl}/projects/${p.projectId ?? ""}` : config.appBaseUrl ? `${config.appBaseUrl}/projects` : null;
  const intro = p.accepted
    ? `<strong>${esc(p.deciderName)}</strong> approved your request to join <strong>${esc(p.projectName)}</strong> as <strong>${esc(p.role ?? "member")}</strong>. Its monitors now appear on your dashboard.`
    : `<strong>${esc(p.deciderName)}</strong> declined your request to join <strong>${esc(p.projectName)}</strong>. Reach out to a project owner if you think you still need access.`;
  const body = p.accepted ? button("Open project", link) : "";
  return {
    to: p.to,
    subject,
    html: shell({ accent: p.accepted ? "up" : "info", eyebrow: p.accepted ? "Access granted" : "Access declined", title: p.accepted ? "Request approved" : "Request declined", intro, bodyHtml: body }),
    text: textBlock(subject, [["Project", p.projectName], ["Decision", p.accepted ? `Approved as ${p.role ?? "member"}` : "Declined"], ["By", p.deciderName], ["Open", p.accepted ? link : null]]),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Monitor: someone joined
// ─────────────────────────────────────────────────────────────────────────────
export function monitorJoinedEmail(p: { to: string[]; monitorName: string; url: string; joinerName: string; monitorId?: string }): EmailMessage {
  const subject = `[Schbang Pulse] ${p.joinerName} joined ${p.monitorName}`;
  const link = monitorLink(p.monitorId);
  const intro = `<strong>${esc(p.joinerName)}</strong> joined monitoring for <strong>${esc(p.monitorName)}</strong>. They'll now receive its alerts and see it on their dashboard.`;
  const body = details([["Monitor", p.monitorName], ["URL", p.url], ["Joined by", p.joinerName]]) + button("View monitor", link);
  return {
    to: p.to,
    subject,
    html: shell({ accent: "info", eyebrow: "Monitor · Member", title: "New member joined", intro, bodyHtml: body }),
    text: textBlock(subject, [["Monitor", p.monitorName], ["URL", p.url], ["Joined by", p.joinerName], ["View", link]]),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Project ownership transferred (e.g. previous owner's account was deleted)
// ─────────────────────────────────────────────────────────────────────────────
export function projectOwnershipEmail(p: {
  to: string[];
  ownerName: string;
  formerOwnerName: string;
  byName: string;
  projects: string[];
}): EmailMessage {
  const many = p.projects.length > 1;
  const subject = `[Schbang Pulse] You're now the owner of ${many ? `${p.projects.length} projects` : p.projects[0]}`;
  const link = config.appBaseUrl ? `${config.appBaseUrl}/projects` : null;
  const intro = `${esc(p.byName)} removed <strong>${esc(p.formerOwnerName)}</strong>'s account and transferred their project ownership to you. You're now responsible for the ${many ? "projects" : "project"} below — its monitors, members and alerts.`;
  const body = details([[many ? "Projects" : "Project", p.projects.join(", ")], ["New owner", p.ownerName]]) + button("Open projects", link);
  return {
    to: p.to,
    subject,
    html: shell({ accent: "info", eyebrow: "Ownership transferred", title: many ? "You're now a project owner" : `You now own ${p.projects[0]}`, intro, bodyHtml: body }),
    text: textBlock(subject, [["Projects", p.projects.join(", ")], ["Transferred by", p.byName], ["Open", link]]),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// New user invite (admin created the account)
// ─────────────────────────────────────────────────────────────────────────────
export function userInviteEmail(p: {
  to: string[];
  name: string;
  email: string;
  roleName: string;
  inviterName: string;
  setupUrl: string;
}): EmailMessage {
  const subject = "[Schbang Pulse] You've been added — set up your account";
  const intro = `<strong>${esc(p.inviterName)}</strong> created a Schbang Pulse account for you. Pulse is Schbang's uptime &amp; health monitoring for client websites, APIs, SSL certificates and domains. Set your password to get started — or just sign in with your Schbang Google account.`;
  const body =
    details([
      ["Email", p.email],
      ["Role", p.roleName],
    ]) +
    button("Set your password", p.setupUrl) +
    (config.appBaseUrl
      ? `<p style="margin:14px 0 0;font-size:13px;color:${MUTED};line-height:1.55">Prefer Google? Sign in at <a href="${esc(config.appBaseUrl)}" style="color:${BRAND}">${esc(config.appBaseUrl)}</a> with your Schbang account — no password needed.</p>`
      : "");
  return {
    to: p.to,
    subject,
    html: shell({
      accent: "info",
      eyebrow: "Welcome",
      title: "Welcome to Schbang Pulse",
      intro,
      bodyHtml: body,
      footerNote: 'This invite link expires in 7 days. If it lapses, use "Forgot password" on the sign-in page to get a new one.',
    }),
    text: textBlock(subject, [
      ["Email", p.email],
      ["Role", p.roleName],
      ["Invited by", p.inviterName],
      ["Set your password", p.setupUrl],
    ]),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Password reset
// ─────────────────────────────────────────────────────────────────────────────
export function passwordResetEmail(p: { to: string[]; resetUrl: string }): EmailMessage {
  const subject = "[Schbang Pulse] Reset your password";
  const intro = `We received a request to reset your Schbang Pulse password. Click the button below to choose a new one. This link expires in <strong>1 hour</strong>.`;
  const body =
    button("Reset password", p.resetUrl) +
    `<p style="margin:16px 0 0;font-size:12px;color:${MUTED};line-height:1.55">If the button doesn't work, copy and paste this link:<br>
      <span style="word-break:break-all;color:${BRAND}">${esc(p.resetUrl)}</span></p>`;
  return {
    to: p.to,
    subject,
    html: shell({ accent: "info", eyebrow: "Security", title: "Reset your password", intro, bodyHtml: body, footerNote: "If you didn't request this, you can safely ignore this email — your password won't change." }),
    text: `Reset your Schbang Pulse password:\n${p.resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Monitoring period: ending soon
// ─────────────────────────────────────────────────────────────────────────────
export function monitorExpiringEmail(p: {
  to: string[];
  monitorName: string;
  url: string;
  daysRemaining: number;
  expiresAt: string;
  monitorId?: string;
}): EmailMessage {
  const subject = `[Schbang Pulse] Monitoring ends in ${p.daysRemaining} day${p.daysRemaining === 1 ? "" : "s"} — ${p.monitorName}`;
  const link = monitorLink(p.monitorId);
  const intro = `The monitoring period for <strong>${esc(p.monitorName)}</strong> ends in <strong>${p.daysRemaining} day${p.daysRemaining === 1 ? "" : "s"}</strong>. Extend it to keep tracking this service — otherwise the monitor is archived, then permanently deleted 7 days later.`;
  const body = details([["Monitor", p.monitorName], ["URL", p.url], ["Ends on", fmtDate(p.expiresAt)]]) + button("Extend monitoring", link);
  return {
    to: p.to,
    subject,
    html: shell({ accent: "warn", eyebrow: "Monitoring · Ending", title: `Monitoring ends in ${p.daysRemaining} day${p.daysRemaining === 1 ? "" : "s"}`, intro, bodyHtml: body }),
    text: textBlock(subject, [["Monitor", p.monitorName], ["URL", p.url], ["Ends on", fmtDate(p.expiresAt)], ["Extend", link]]),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Monitoring period: ended
// ─────────────────────────────────────────────────────────────────────────────
export function monitorExpiredEmail(p: { to: string[]; monitorName: string; url: string; monitorId?: string }): EmailMessage {
  const subject = `[Schbang Pulse] Monitoring ended — ${p.monitorName}`;
  const link = monitorLink(p.monitorId);
  const intro = `The monitoring period for <strong>${esc(p.monitorName)}</strong> has ended, so checks have stopped and the monitor is archived. It will be <strong>permanently deleted in 7 days</strong> — restore it before then if this wasn't intended.`;
  const body = details([["Monitor", p.monitorName], ["URL", p.url]]) + button("Restore monitor", link);
  return {
    to: p.to,
    subject,
    html: shell({ accent: "warn", eyebrow: "Monitoring · Ended", title: "Monitoring ended", intro, bodyHtml: body }),
    text: textBlock(subject, [["Monitor", p.monitorName], ["URL", p.url], ["Restore", link]]),
  };
}

// ── helpers ──

function footerFor(monitorName: string): string {
  return `You're receiving this because you're a recipient for "${monitorName}".`;
}

/** Format an ISO timestamp as a readable date-time. */
function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Format an ISO date as a readable date. */
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** Plain-text body for non-HTML clients. */
function textBlock(subject: string, rows: [string, string | null | undefined][]): string {
  const lines = rows.filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}: ${v}`);
  return `${subject}\n\n${lines.join("\n")}`;
}

/** Format seconds as a human downtime string. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
