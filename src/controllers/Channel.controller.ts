import type { Request, Response } from "express";
import { NotificationChannel } from "../models/notificationChannel.model";
import { Monitor } from "../models/monitor.model";
import { ApiError } from "../utils/ApiError";
import { writeAudit } from "../utils/audit";
import { postGoogleChat } from "../services/channels";

const serialize = (c: { _id: unknown; name: string; type: string; webhookUrl: string; enabled: boolean }) => ({
  id: String(c._id),
  name: c.name,
  type: c.type,
  webhookUrl: c.webhookUrl,
  enabled: c.enabled,
});

export async function listChannels(_req: Request, res: Response): Promise<void> {
  const channels = await NotificationChannel.find({}).sort({ createdAt: -1 }).lean();
  res.json(channels.map(serialize));
}

export async function createChannel(req: Request, res: Response): Promise<void> {
  const channel = await NotificationChannel.create({
    name: req.body.name,
    type: req.body.type ?? "google_chat",
    webhookUrl: req.body.webhookUrl,
    enabled: req.body.enabled ?? true,
    createdBy: req.user!.id,
  });
  await writeAudit(req, "channel.create", { targetType: "channel", targetId: channel.id });
  res.status(201).json(serialize(channel));
}

export async function updateChannel(req: Request, res: Response): Promise<void> {
  const channel = await NotificationChannel.findByIdAndUpdate(req.params.id, req.body, { new: true }).lean();
  if (!channel) throw ApiError.notFound("Channel not found");
  await writeAudit(req, "channel.update", { targetType: "channel", targetId: req.params.id });
  res.json(serialize(channel));
}

export async function deleteChannel(req: Request, res: Response): Promise<void> {
  const channel = await NotificationChannel.findByIdAndDelete(req.params.id).lean();
  if (!channel) throw ApiError.notFound("Channel not found");
  // Detach from any monitors referencing it.
  await Monitor.updateMany({ channels: channel._id }, { $pull: { channels: channel._id } });
  await writeAudit(req, "channel.delete", { targetType: "channel", targetId: req.params.id });
  res.status(204).send();
}

export async function testChannel(req: Request, res: Response): Promise<void> {
  const channel = await NotificationChannel.findById(req.params.id).lean();
  if (!channel) throw ApiError.notFound("Channel not found");
  if (channel.type === "google_chat") {
    await postGoogleChat(channel.webhookUrl, `✅ Test message from Schbang Pulse — "${channel.name}" is configured correctly.`);
  }
  res.json({ message: "Test message sent" });
}
