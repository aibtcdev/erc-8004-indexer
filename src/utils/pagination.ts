/**
 * Shared pagination helpers for ERC-8004 Indexer query API.
 *
 * All list endpoints use limit/offset pagination.
 * Default limit: 50. Maximum limit: 200. Minimum limit: 1.
 * Default offset: 0. Minimum offset: 0.
 *
 * Response envelope for list endpoints:
 *   { data: T[], pagination: { limit, offset, total } }
 */

export interface PaginationParams {
  limit: number;
  offset: number;
}

export interface PaginationMeta {
  limit: number;
  offset: number;
  total: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: PaginationMeta;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MIN_LIMIT = 1;
const MIN_OFFSET = 0;

/**
 * Parse limit and offset from query parameters.
 * Accepts either a plain record (from Hono's c.req.query()) or URLSearchParams.
 * Applies defaults and enforces min/max constraints.
 */
export function parsePagination(
  params: Record<string, string | undefined> | URLSearchParams
): PaginationParams {
  const rawLimit = params instanceof URLSearchParams
    ? params.get("limit")
    : params.limit;
  const rawOffset = params instanceof URLSearchParams
    ? params.get("offset")
    : params.offset;

  let limit = DEFAULT_LIMIT;
  if (rawLimit != null) {
    const parsed = parseInt(rawLimit, 10);
    if (!isNaN(parsed)) {
      limit = Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, parsed));
    }
  }

  let offset = MIN_OFFSET;
  if (rawOffset != null) {
    const parsed = parseInt(rawOffset, 10);
    if (!isNaN(parsed)) {
      offset = Math.max(MIN_OFFSET, parsed);
    }
  }

  return { limit, offset };
}

/**
 * Clamp raw numeric limit/offset values to valid pagination bounds.
 * Useful for RPC methods that receive numbers directly (not query strings).
 */
export function clampPagination(params: {
  limit?: number;
  offset?: number;
}): PaginationParams {
  return {
    limit: Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, params.limit ?? DEFAULT_LIMIT)),
    offset: Math.max(MIN_OFFSET, params.offset ?? MIN_OFFSET),
  };
}

/**
 * Build a standard paginated response envelope.
 */
export function paginatedResponse<T>(
  data: T[],
  total: number,
  limit: number,
  offset: number
): PaginatedResponse<T> {
  return {
    data,
    pagination: { limit, offset, total },
  };
}
