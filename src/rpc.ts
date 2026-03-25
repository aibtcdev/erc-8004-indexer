import { WorkerEntrypoint } from "cloudflare:workers";
import { VERSION } from "./version";
import type { Env } from "./types";

/**
 * IndexerRPC — WorkerEntrypoint for service bindings from other workers.
 * Other workers bind via:
 *   { "binding": "INDEXER", "service": "erc-8004-indexer", "entrypoint": "IndexerRPC" }
 * And call: env.INDEXER.getStatus()
 */
export class IndexerRPC extends WorkerEntrypoint<Env> {
  /**
   * Returns indexer status and version.
   * Extended in later phases with query methods (getAgent, getSummary, etc.)
   */
  async getStatus(): Promise<{ status: string; version: string }> {
    return {
      status: "ok",
      version: VERSION,
    };
  }
}
