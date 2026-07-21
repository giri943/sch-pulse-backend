import type { Response } from "express";
import { logger } from "../config/logger";

/**
 * In-memory Server-Sent Events hub (single-instance). Clients open one long-lived
 * connection to /api/v1/events; mutations call publish(...types) to tell every
 * connected browser which data changed, so they refetch instantly (Jira-style
 * live updates). Push-to-invalidate: we send *what* changed, not the payload.
 *
 * NOTE: this broadcasts only within one Node process. If the backend is ever
 * scaled to multiple instances, put a Redis pub/sub in front of publish().
 */
type EventType = "monitors" | "incidents" | "projects" | "maintenance" | "users" | "me" | "dashboard";

const clients = new Set<Response>();

/** Register an SSE connection; returns an unsubscribe fn. */
export function addClient(res: Response): () => void {
  clients.add(res);
  return () => clients.delete(res);
}

/** Notify every connected client which resource types changed. */
export function publish(...types: EventType[]): void {
  if (!clients.size || !types.length) return;
  const frame = `data: ${JSON.stringify({ types })}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch (err) {
      logger.debug({ err }, "SSE write failed; dropping client");
      clients.delete(res);
    }
  }
}

export function clientCount(): number {
  return clients.size;
}
