import type { Request, Response } from "express";
import { Notification } from "../models/notification.model";

/** The current user's recent notifications + unread count. */
export async function listNotifications(req: Request, res: Response): Promise<void> {
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const [items, unreadCount] = await Promise.all([
    Notification.find({ userId: req.user!.id }).sort({ createdAt: -1 }).limit(limit).lean(),
    Notification.countDocuments({ userId: req.user!.id, read: false }),
  ]);
  res.json({
    items: items.map((n) => ({
      id: String(n._id),
      type: n.type,
      title: n.title,
      body: n.body,
      link: n.link ?? null,
      read: n.read,
      createdAt: (n as { createdAt?: Date }).createdAt ?? null,
    })),
    unreadCount,
  });
}

export async function markRead(req: Request, res: Response): Promise<void> {
  await Notification.updateOne({ _id: req.params.id, userId: req.user!.id }, { read: true });
  res.json({ ok: true });
}

export async function markAllRead(req: Request, res: Response): Promise<void> {
  await Notification.updateMany({ userId: req.user!.id, read: false }, { read: true });
  res.json({ ok: true });
}
