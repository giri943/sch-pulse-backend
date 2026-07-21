import { Router, type Request, type Response } from "express";
import { authenticate } from "../middlewares/auth";
import { addClient } from "../services/realtime";

const router = Router();

/**
 * SSE stream of "what changed" events. Authenticated (Bearer, via the fetch
 * stream reader on the client). Sends a heartbeat comment so proxies/browsers
 * keep the connection open.
 */
router.get("/", authenticate, (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // tell nginx not to buffer the stream
  res.flushHeaders?.();
  res.write(": connected\n\n");

  const unsubscribe = addClient(res);
  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* connection gone; cleanup runs on close */
    }
  }, 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

export default router;
