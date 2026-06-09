import type { Request, Response } from "express";
import { RecommendationRule } from "../models/recommendationRule.model";
import { ApiError } from "../utils/ApiError";
import { paginate, pageParams } from "../utils/response";
import { skip } from "../utils/query";

export async function listRules(req: Request, res: Response): Promise<void> {
  const { page, limit } = pageParams(req.query);
  const [data, total] = await Promise.all([
    RecommendationRule.find({}).sort({ priority: 1 }).skip(skip(page, limit)).limit(limit).lean(),
    RecommendationRule.countDocuments({}),
  ]);
  res.json(paginate(data, total, page, limit));
}

export async function createRule(req: Request, res: Response): Promise<void> {
  res.status(201).json(await RecommendationRule.create(req.body));
}

export async function updateRule(req: Request, res: Response): Promise<void> {
  const rule = await RecommendationRule.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  }).lean();
  if (!rule) throw ApiError.notFound("Rule not found");
  res.json(rule);
}

export async function deleteRule(req: Request, res: Response): Promise<void> {
  const deleted = await RecommendationRule.findByIdAndDelete(req.params.id).lean();
  if (!deleted) throw ApiError.notFound("Rule not found");
  res.status(204).send();
}
