export const DISPLAY_TIME_ZONE = "Asia/Kolkata";
export const DISPLAY_TIME_ZONE_LABEL = "IST";

const DATE_TIME_OPTS: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: DISPLAY_TIME_ZONE,
};

const DATE_OPTS: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: DISPLAY_TIME_ZONE,
};

function toDate(value: Date | string | number): Date | null {
  const d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/** Date + time in IST, e.g. "17 Sept 2026, 02:00 IST". */
export function fmtDateTimeIST(value: Date | string | number): string {
  const d = toDate(value);
  if (!d) return typeof value === "string" ? value : "—";
  return `${d.toLocaleString("en-GB", DATE_TIME_OPTS)} ${DISPLAY_TIME_ZONE_LABEL}`;
}

/** Date only in IST, e.g. "17 Sept 2026". */
export function fmtDateIST(value: Date | string | number): string {
  const d = toDate(value);
  if (!d) return typeof value === "string" ? value : "—";
  return d.toLocaleDateString("en-GB", DATE_OPTS);
}
