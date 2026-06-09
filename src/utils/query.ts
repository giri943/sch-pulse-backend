/** Parse a `sort` string (e.g. "-createdAt,name") into a Mongoose sort object. */
export function parseSort(sort?: string): Record<string, 1 | -1> {
  if (!sort) return { createdAt: -1 };
  const result: Record<string, 1 | -1> = {};
  for (const field of sort.split(",")) {
    const t = field.trim();
    if (!t) continue;
    if (t.startsWith("-")) result[t.slice(1)] = -1;
    else result[t] = 1;
  }
  return Object.keys(result).length ? result : { createdAt: -1 };
}

export const skip = (page: number, limit: number): number => (page - 1) * limit;
