import type { EmailMessage } from "./index";

interface RecommendationSnap {
  title: string;
  steps: string[];
}

function shell(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="font-family:system-ui,Segoe UI,Arial,sans-serif;background:#0b0e14;color:#e6e9ef;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#11151d;border:1px solid #1e2530;border-radius:12px;padding:24px">
  <h2 style="margin:0 0 16px">${title}</h2>${bodyHtml}
  <p style="color:#6b7280;font-size:12px;margin-top:24px">Schbang Pulse · automated monitoring alert</p>
  </div></body></html>`;
}

function recsHtml(recs: RecommendationSnap[]): string {
  if (!recs.length) return "";
  return `<div style="margin-top:16px;padding:12px;background:#0f141c;border-radius:8px">
    <strong>Suggested checks:</strong>${recs
      .map((r) => `<div style="margin-top:8px"><b>${r.title}</b><ul>${r.steps.map((s) => `<li>${s}</li>`).join("")}</ul></div>`)
      .join("")}</div>`;
}

export function incidentOpenedEmail(p: {
  to: string[];
  monitorName: string;
  url: string;
  error: string;
  statusCode?: number;
  timestamp: string;
  recommendations: RecommendationSnap[];
}): EmailMessage {
  const subject = `[DOWN] ${p.monitorName}`;
  const rows = `<p><b>URL:</b> ${p.url}</p><p><b>Error:</b> ${p.error}</p><p><b>Response code:</b> ${p.statusCode ?? "—"}</p><p><b>Detected at:</b> ${p.timestamp}</p>`;
  return {
    to: p.to,
    subject,
    html: shell(`🔴 ${p.monitorName} is DOWN`, rows + recsHtml(p.recommendations)),
    text: `${subject}\nURL: ${p.url}\nError: ${p.error}\nCode: ${p.statusCode ?? "-"}\nAt: ${p.timestamp}`,
  };
}

export function incidentResolvedEmail(p: {
  to: string[];
  monitorName: string;
  url: string;
  downtime: string;
  recoveredAt: string;
}): EmailMessage {
  const subject = `[RECOVERED] ${p.monitorName}`;
  const rows = `<p><b>URL:</b> ${p.url}</p><p><b>Downtime duration:</b> ${p.downtime}</p><p><b>Recovered at:</b> ${p.recoveredAt}</p>`;
  return {
    to: p.to,
    subject,
    html: shell(`🟢 ${p.monitorName} has RECOVERED`, rows),
    text: `${subject}\nURL: ${p.url}\nDowntime: ${p.downtime}\nRecovered: ${p.recoveredAt}`,
  };
}

export function sslWarningEmail(p: {
  to: string[];
  domain: string;
  expiresAt: string;
  daysRemaining: number;
}): EmailMessage {
  const subject = `[SSL EXPIRY WARNING] ${p.domain}`;
  const rows = `<p><b>Domain:</b> ${p.domain}</p><p><b>Expiry date:</b> ${p.expiresAt}</p><p><b>Remaining days:</b> ${p.daysRemaining}</p>`;
  return {
    to: p.to,
    subject,
    html: shell(`⚠️ SSL certificate expiring in ${p.daysRemaining} days`, rows),
    text: `${subject}\nDomain: ${p.domain}\nExpires: ${p.expiresAt}\nDays left: ${p.daysRemaining}`,
  };
}

export function domainExpiringEmail(p: {
  to: string[];
  domain: string;
  monitorName: string;
  expiresAt: string;
  daysRemaining: number;
}): EmailMessage {
  const subject = `[DOMAIN EXPIRY WARNING] ${p.domain} — ${p.daysRemaining} day(s) left`;
  const rows = `<p><b>Domain:</b> ${p.domain}</p><p><b>Monitor:</b> ${p.monitorName}</p>
    <p><b>Registration expires:</b> ${new Date(p.expiresAt).toDateString()} (${p.daysRemaining} day(s))</p>
    <p>Renew the domain with your registrar before it lapses — an expired domain takes the site offline
    and can be lost.</p>`;
  return {
    to: p.to,
    subject,
    html: shell(`🌐 Domain expiring in ${p.daysRemaining} days`, rows),
    text: `${subject}\nDomain: ${p.domain}\nExpires: ${new Date(p.expiresAt).toDateString()}\nDays left: ${p.daysRemaining}`,
  };
}

export function testNotificationEmail(p: {
  to: string[];
  monitorName: string;
  url: string;
}): EmailMessage {
  const subject = `[TEST] ${p.monitorName} — Schbang Pulse`;
  const rows = `<p>This is a <b>test notification</b> for <b>${p.monitorName}</b> (${p.url}).</p>
    <p>If you received this email, alerts for this monitor are configured correctly. ✅</p>`;
  return {
    to: p.to,
    subject,
    html: shell(`🔔 Test notification`, rows),
    text: `${subject}\nThis is a test notification for ${p.monitorName} (${p.url}). Alerts are configured correctly.`,
  };
}

export function projectJoinRequestEmail(p: {
  to: string[];
  projectName: string;
  requesterName: string;
  requesterEmail: string;
  message?: string;
}): EmailMessage {
  const subject = `[ACCESS REQUEST] ${p.requesterName} wants to join ${p.projectName}`;
  const rows = `<p><b>${p.requesterName}</b> (${p.requesterEmail}) has requested access to the project
    <b>${p.projectName}</b>.</p>${p.message ? `<p style="color:#6b7280">“${p.message}”</p>` : ""}
    <p>Review it in Schbang Pulse → the project's <b>Members</b> tab to approve or decline.</p>`;
  return {
    to: p.to,
    subject,
    html: shell("👥 New access request", rows),
    text: `${subject}\n${p.requesterName} (${p.requesterEmail}) requested access to ${p.projectName}.${p.message ? `\nMessage: ${p.message}` : ""}`,
  };
}

export function projectJoinDecisionEmail(p: {
  to: string[];
  projectName: string;
  accepted: boolean;
  deciderName: string;
  role?: string;
}): EmailMessage {
  const subject = `[${p.accepted ? "ACCESS GRANTED" : "ACCESS DECLINED"}] ${p.projectName}`;
  const rows = p.accepted
    ? `<p><b>${p.deciderName}</b> accepted your request to join <b>${p.projectName}</b> as <b>${p.role}</b>.</p>
       <p>You can now see this project's monitors on your dashboard.</p>`
    : `<p><b>${p.deciderName}</b> declined your request to join <b>${p.projectName}</b>.</p>`;
  return {
    to: p.to,
    subject,
    html: shell(p.accepted ? "✅ Request accepted" : "🚫 Request declined", rows),
    text: `${subject}\n${p.deciderName} ${p.accepted ? `accepted your request to join ${p.projectName} as ${p.role}` : `declined your request to join ${p.projectName}`}.`,
  };
}

export function monitorJoinedEmail(p: {
  to: string[];
  monitorName: string;
  url: string;
  joinerName: string;
}): EmailMessage {
  const subject = `[MONITOR JOINED] ${p.monitorName}`;
  const rows = `<p><b>${p.joinerName}</b> joined monitoring for <b>${p.monitorName}</b> (${p.url}).</p>
    <p>They'll now receive this monitor's alerts and see it on their dashboard.</p>`;
  return {
    to: p.to,
    subject,
    html: shell("👥 New member joined a monitor", rows),
    text: `${subject}\n${p.joinerName} joined monitoring for ${p.monitorName} (${p.url}).`,
  };
}

export function passwordResetEmail(p: { to: string[]; resetUrl: string }): EmailMessage {
  const subject = "Reset your Schbang Pulse password";
  const rows = `<p>We received a request to reset your password.</p>
    <p><a href="${p.resetUrl}" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;margin-top:8px">Reset password</a></p>
    <p style="color:#6b7280;font-size:12px;margin-top:16px">This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>
    <p style="color:#6b7280;font-size:12px;word-break:break-all">${p.resetUrl}</p>`;
  return {
    to: p.to,
    subject,
    html: shell("🔑 Password reset", rows),
    text: `Reset your Schbang Pulse password:\n${p.resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`,
  };
}

export function monitorExpiringEmail(p: {
  to: string[];
  monitorName: string;
  url: string;
  daysRemaining: number;
  expiresAt: string;
}): EmailMessage {
  const subject = `[MONITORING ENDING] ${p.monitorName} — ${p.daysRemaining} day(s) left`;
  const rows = `<p><b>${p.monitorName}</b> (${p.url})</p>
    <p>The monitoring period ends in <b>${p.daysRemaining} day(s)</b> on ${new Date(p.expiresAt).toDateString()}.</p>
    <p>To keep monitoring this service, <b>extend the period</b> from the monitor's page. If it is not
    extended, the monitor will be removed and permanently deleted 7 days later.</p>`;
  return {
    to: p.to,
    subject,
    html: shell(`⏳ Monitoring ending soon`, rows),
    text: `${subject}\n${p.monitorName} (${p.url}) monitoring ends in ${p.daysRemaining} day(s) on ${new Date(p.expiresAt).toDateString()}. Extend to keep monitoring.`,
  };
}

export function monitorExpiredEmail(p: { to: string[]; monitorName: string; url: string }): EmailMessage {
  const subject = `[MONITORING ENDED] ${p.monitorName}`;
  const rows = `<p><b>${p.monitorName}</b> (${p.url})</p>
    <p>The monitoring period has ended, so monitoring has stopped and the monitor has been archived.</p>
    <p>It will be <b>permanently deleted in 7 days</b>. Restore it before then if this was unintended.</p>`;
  return {
    to: p.to,
    subject,
    html: shell(`🗑️ Monitoring ended`, rows),
    text: `${subject}\n${p.monitorName} (${p.url}) monitoring ended and was archived. Permanent deletion in 7 days unless restored.`,
  };
}

/** Format seconds as a human downtime string. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
