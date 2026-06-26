/**
 * Centralized application error (matches the reference projects' ApiError).
 * Throw `new ApiError(404, "Not found")` anywhere; the error middleware turns it
 * into a consistent HTTP response. Static helpers cover the common cases.
 */
export class ApiError extends Error {
  statusCode: number;
  code: string;
  details?: unknown;
  isOperational: boolean;

  constructor(statusCode: number, message: string, code = "ERROR", details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace?.(this, this.constructor);
  }

  static badRequest(message = "Bad request", details?: unknown) {
    return new ApiError(400, message, "BAD_REQUEST", details);
  }
  static unauthorized(message = "Unauthorized") {
    return new ApiError(401, message, "UNAUTHORIZED");
  }
  static forbidden(message = "Forbidden") {
    return new ApiError(403, message, "FORBIDDEN");
  }
  static notFound(message = "Resource not found") {
    return new ApiError(404, message, "NOT_FOUND");
  }
  static conflict(message = "Conflict", details?: unknown) {
    return new ApiError(409, message, "CONFLICT", details);
  }
  static validation(details: unknown, message?: string) {
    // Prefer the first specific field/form error so the UI can show a real message
    // (e.g. "Password must be at least 8 characters") instead of "Validation failed".
    return new ApiError(400, message ?? firstZodMessage(details) ?? "Validation failed", "VALIDATION_ERROR", details);
  }
}

/** Pull the first concrete message out of a Zod `flatten()` payload. */
function firstZodMessage(details: unknown): string | undefined {
  const d = details as { fieldErrors?: Record<string, string[]>; formErrors?: string[] } | undefined;
  const field = d?.fieldErrors && Object.values(d.fieldErrors).flat().find(Boolean);
  return field || d?.formErrors?.find(Boolean) || undefined;
}
