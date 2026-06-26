import { RecommendationRule } from "../../models/recommendationRule.model";
import { logger } from "../../config/logger";

export interface RecommendationSnapshot {
  title: string;
  category: string;
  steps: string[];
}

/**
 * Rule-based (no AI). Matches enabled rules against a failure's status code and
 * error text, ordered by priority. Rules live in the DB and can be extended at
 * runtime without a deploy.
 */
export async function getRecommendations(input: {
  statusCode?: number;
  error?: string | null;
  category?: string;
}): Promise<RecommendationSnapshot[]> {
  const or: Record<string, unknown>[] = [];
  if (input.statusCode) or.push({ matchType: "statusCode", matchValue: String(input.statusCode) });
  if (input.category) or.push({ matchType: "category", matchValue: input.category });

  try {
    // The two rule queries are independent — run them together.
    const [direct, errorRules] = await Promise.all([
      or.length ? RecommendationRule.find({ enabled: true, $or: or }).sort({ priority: 1 }).lean() : Promise.resolve([]),
      input.error ? RecommendationRule.find({ enabled: true, matchType: "errorContains" }).lean() : Promise.resolve([]),
    ]);

    let errorMatches: RecommendationSnapshot[] = [];
    if (input.error) {
      const lowered = input.error.toLowerCase();
      errorMatches = errorRules
        .filter((r) => lowered.includes(r.matchValue.toLowerCase()))
        .map((r) => ({ title: r.title, category: r.category, steps: r.steps }));
    }

    const all = [
      ...direct.map((r) => ({ title: r.title, category: r.category, steps: r.steps })),
      ...errorMatches,
    ];
    const seen = new Set<string>();
    return all.filter((r) => (seen.has(r.title) ? false : (seen.add(r.title), true)));
  } catch (err) {
    logger.error({ err }, "Failed to resolve recommendations");
    return [];
  }
}
