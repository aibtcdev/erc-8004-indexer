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
 * Parse limit and offset from URL search params.
 * Applies defaults and enforces min/max constraints.
 */
export function parsePagination(searchParams: URLSearchParams): PaginationParams {
  const rawLimit = searchParams.get("limit");
  const rawOffset = searchParams.get("offset");

  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    const parsed = parseInt(rawLimit, 10);
    if (!isNaN(parsed)) {
      limit = Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, parsed));
    }
  }

  let offset = MIN_OFFSET;
  if (rawOffset !== null) {
    const parsed = parseInt(rawOffset, 10);
    if (!isNaN(parsed)) {
      offset = Math.max(MIN_OFFSET, parsed);
    }
  }

  return { limit, offset };
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
