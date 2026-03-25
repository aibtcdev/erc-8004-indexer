/**
 * LogsRPC interface (from worker-logs service)
 * Defined locally since worker-logs isn't a published package
 */
export interface LogsRPC {
  info(
    appId: string,
    message: string,
    context?: Record<string, unknown>
  ): Promise<void>;
  warn(
    appId: string,
    message: string,
    context?: Record<string, unknown>
  ): Promise<void>;
  error(
    appId: string,
    message: string,
    context?: Record<string, unknown>
  ): Promise<void>;
  debug(
    appId: string,
    message: string,
    context?: Record<string, unknown>
  ): Promise<void>;
}

/**
 * Logger interface for request-scoped logging
 */
export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
}

/**
 * Environment bindings for Cloudflare Worker (matches wrangler.jsonc)
 */
export interface Env {
  // D1 database — event storage
  DB: D1Database;
  // KV namespace — indexer state and chainhook IDs
  INDEXER_KV: KVNamespace;
  // Service binding to worker-logs RPC, typed loosely to avoid complex Service<> generics
  LOGS?: unknown;
  // Deployment environment identifier
  ENVIRONMENT?: string;
  // Admin token for lens management endpoints (POST /lenses, PUT /lenses/:lens)
  ADMIN_TOKEN?: string;
}

/**
 * Variables stored in Hono context by middleware
 */
export interface AppVariables {
  requestId: string;
  logger: Logger;
}

// Re-export domain types from the types/ subdirectory.
// Consumers can import from either 'src/types' or 'src/types/index'.
export * from "./types/index";
