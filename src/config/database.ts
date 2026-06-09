import mongoose from "mongoose";
import { config } from "./index";
import { logger } from "./logger";

/** Connect to MongoDB. Index building is on outside production. */
export async function connectDatabase(): Promise<void> {
  mongoose.set("strictQuery", true);
  mongoose.set("autoIndex", !config.isProd);

  mongoose.connection.on("connected", () => logger.info("MongoDB connected"));
  mongoose.connection.on("disconnected", () => logger.warn("MongoDB disconnected"));
  mongoose.connection.on("error", (err) => logger.error({ err }, "MongoDB error"));

  await mongoose.connect(config.mongoUri, {
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 20,
  });
}

export async function disconnectDatabase(): Promise<void> {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}

export async function pingDatabase(): Promise<boolean> {
  try {
    await mongoose.connection.db?.admin().ping();
    return mongoose.connection.readyState === 1;
  } catch {
    return false;
  }
}
