import { z } from "zod";
import {
  API_ASSERTION_OPERATORS,
  HTTP_METHODS,
  MONITOR_INTERVALS_SEC,
  MONITOR_TYPES,
} from "../utils/constants";

const intervalSchema = z
  .number()
  .refine((v) => (MONITOR_INTERVALS_SEC as readonly number[]).includes(v), {
    message: "Interval must be one of 60, 300, 900, 1800 seconds",
  });

const assertionSchema = z.object({
  jsonPath: z.string().min(1),
  operator: z.enum(API_ASSERTION_OPERATORS),
  value: z.string().optional(),
});

const baseMonitor = z.object({
  name: z.string().trim().min(2).max(120),
  type: z.enum(MONITOR_TYPES),
  url: z.string().url(),
  method: z.enum(HTTP_METHODS).default("GET"),
  timeoutMs: z.number().int().min(1000).max(60000).default(10000),
  expectedStatusCode: z.number().int().min(100).max(599).default(200),
  intervalSec: intervalSchema.default(300),
  headers: z.record(z.string()).optional(),
  body: z.string().max(10000).optional(),
  assertions: z.array(assertionSchema).optional(),
  alertRecipients: z.array(z.string().email()).default([]),
  enabled: z.boolean().default(true),
});

export const createMonitorSchema = baseMonitor.superRefine((val, ctx) => {
  if (val.type !== "api" && val.assertions && val.assertions.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "assertions are only valid for API monitors",
      path: ["assertions"],
    });
  }
});

export const updateMonitorSchema = baseMonitor.partial();
