/** Cloudflare Worker environment bindings */
export interface Env {
  DB: D1Database;
  LOGS?: {
    info: (appId: string, msg: string, context?: Record<string, unknown>) => Promise<void>;
    warn: (appId: string, msg: string, context?: Record<string, unknown>) => Promise<void>;
    error: (appId: string, msg: string, context?: Record<string, unknown>) => Promise<void>;
  };
  ENVIRONMENT: string;
  STACKS_NETWORK: "mainnet" | "testnet";
  STACKS_API_URL: string;
  ADMIN_API_KEY?: string;
}

/** Agent identity record from the on-chain registry */
export interface AgentIdentity {
  agent_id: number;
  owner: string;
  uri: string | null;
  wallet: string | null;
  network: string;
}

/** Agent row as stored in D1 */
export interface AgentRow {
  agent_id: number;
  owner: string;
  uri: string | null;
  wallet: string | null;
  network: string;
  indexed_at: string;
  updated_at: string;
}

/** Index metadata row */
export interface IndexMetaRow {
  key: string;
  value: string;
  updated_at: string;
}

/** Raw Clarity value response from Stacks API */
export interface ClarityValueResponse {
  okay: boolean;
  result?: string;
  cause?: string;
}

/** Parsed response from get-last-token-id */
export interface LastTokenIdResult {
  success: boolean;
  last_id: number;
}

/** Index run summary */
export interface IndexRunSummary {
  last_agent_id: number;
  agents_indexed: number;
  agents_updated: number;
  agents_new: number;
  duration_ms: number;
  network: string;
  timestamp: string;
}
