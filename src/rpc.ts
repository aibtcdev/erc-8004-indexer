import { WorkerEntrypoint } from "cloudflare:workers";
import { VERSION } from "./version";
import type { Env } from "./types";
import type { AgentRow, FeedbackRow, ValidationRequestRow, LensRow } from "./types/db";
import {
  queryAgentById,
  queryFeedbackSummary,
  queryFeedback,
  queryValidationSummary,
  queryValidations,
  queryStats,
  querySyncState,
  queryLenses,
  queryLensByName,
  type FeedbackSummary,
  type FeedbackFilters,
  type ValidationSummary,
  type GlobalStats,
} from "./utils/query";
import { paginatedResponse, type PaginatedResponse } from "./utils/pagination";
import { runLensPipeline, type LensPipelineResult } from "./lenses/pipeline";
import { mergeLensConfig } from "./lenses/defaults";

/**
 * IndexerRPC — WorkerEntrypoint for service bindings from other workers.
 * Other workers bind via:
 *   { "binding": "INDEXER", "service": "erc-8004-indexer", "entrypoint": "IndexerRPC" }
 * And call: env.INDEXER.getStatus()
 */
export class IndexerRPC extends WorkerEntrypoint<Env> {
  /**
   * Returns indexer health, version, sync state, and global stats.
   */
  async getStatus(): Promise<{
    status: string;
    version: string;
    sync_state: Awaited<ReturnType<typeof querySyncState>>;
    stats: GlobalStats;
  }> {
    const [syncState, stats] = await Promise.all([
      querySyncState(this.env.DB),
      queryStats(this.env.DB),
    ]);
    return {
      status: "ok",
      version: VERSION,
      sync_state: syncState,
      stats,
    };
  }

  /**
   * Returns global counts of agents, feedback, and validations.
   */
  async getStats(): Promise<GlobalStats> {
    return queryStats(this.env.DB);
  }

  /**
   * Returns a single agent by ID, or null if not found.
   */
  async getAgent(agentId: number): Promise<AgentRow | null> {
    return queryAgentById(this.env.DB, agentId);
  }

  /**
   * Returns aggregated feedback summary for an agent.
   * Optional filters: client, tag1, tag2.
   */
  async getSummary(
    agentId: number,
    filters?: FeedbackFilters
  ): Promise<{ agent_id: number } & FeedbackSummary> {
    const summary = await queryFeedbackSummary(this.env.DB, agentId, filters);
    return { agent_id: agentId, ...summary };
  }

  /**
   * Returns paginated feedback list for an agent.
   * Optional filters: client, tag1, tag2. Default limit=50, max=200.
   */
  async getFeedback(
    agentId: number,
    params: { limit?: number; offset?: number } & FeedbackFilters = {}
  ): Promise<PaginatedResponse<FeedbackRow>> {
    const limit = Math.max(1, Math.min(200, params.limit ?? 50));
    const offset = Math.max(0, params.offset ?? 0);
    const { rows, total } = await queryFeedback(this.env.DB, agentId, {
      limit,
      offset,
      client: params.client,
      tag1: params.tag1,
      tag2: params.tag2,
    });
    return paginatedResponse(rows, total, limit, offset);
  }

  /**
   * Returns validation summary (total/pending/responded) for an agent.
   */
  async getValidationSummary(
    agentId: number
  ): Promise<{ agent_id: number } & ValidationSummary> {
    const summary = await queryValidationSummary(this.env.DB, agentId);
    return { agent_id: agentId, ...summary };
  }

  /**
   * Returns paginated validation requests for an agent.
   * Optional filter: has_response (true/false). Default limit=50, max=200.
   */
  async getValidations(
    agentId: number,
    params: {
      limit?: number;
      offset?: number;
      has_response?: boolean;
    } = {}
  ): Promise<PaginatedResponse<ValidationRequestRow>> {
    const limit = Math.max(1, Math.min(200, params.limit ?? 50));
    const offset = Math.max(0, params.offset ?? 0);
    const { rows, total } = await queryValidations(this.env.DB, agentId, {
      limit,
      offset,
      has_response: params.has_response,
    });
    return paginatedResponse(rows, total, limit, offset);
  }

  /**
   * Returns a list of all registered lenses.
   */
  async listLenses(): Promise<LensRow[]> {
    return queryLenses(this.env.DB);
  }

  /**
   * Returns a single lens by name, or null if not found.
   */
  async getLensByName(name: string): Promise<LensRow | null> {
    return queryLensByName(this.env.DB, name);
  }

  /**
   * Returns the full pipeline result (score + transparency metadata) for an agent
   * through a named lens.
   *
   * @param agentId      Agent to score.
   * @param lensName     Name of the registered lens to apply.
   * @param currentBlock Current block height for decay/rate calculations.
   *                     Defaults to 999999999 (treat all feedback as recent).
   */
  async getLensSummary(
    agentId: number,
    lensName: string,
    currentBlock = 999999999
  ): Promise<LensPipelineResult | null> {
    const row = await queryLensByName(this.env.DB, lensName);
    if (!row) return null;
    let config;
    try {
      config = mergeLensConfig(JSON.parse(row.config));
    } catch {
      config = mergeLensConfig({});
    }
    return runLensPipeline(this.env.DB, agentId, lensName, config, currentBlock);
  }

  /**
   * Returns just the score for an agent through a named lens.
   *
   * @param agentId      Agent to score.
   * @param lensName     Name of the registered lens to apply.
   * @param currentBlock Current block height. Defaults to 999999999.
   */
  async getLensScore(
    agentId: number,
    lensName: string,
    currentBlock = 999999999
  ): Promise<{ agent_id: number; lens_name: string; score: string } | null> {
    const result = await this.getLensSummary(agentId, lensName, currentBlock);
    if (!result) return null;
    return {
      agent_id: result.agent_id,
      lens_name: result.lens_name,
      score: result.score,
    };
  }
}

// Re-export query types so consumers don't need to import from utils/query directly
export type { FeedbackSummary, FeedbackFilters, ValidationSummary, GlobalStats };
export type { LensPipelineResult };
