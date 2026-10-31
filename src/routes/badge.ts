/**
 * GET /api/v1/agents/:id/badge
 *
 * Returns an SVG identity badge for a registered ERC-8004 agent.
 * The badge is embeddable in READMEs, profiles, and web pages via a
 * standard <img> tag:
 *
 *   ![Agent](https://erc8004.aibtc.com/api/v1/agents/42/badge)
 *   ![Agent](https://erc8004.aibtc.com/api/v1/agents/42/badge?style=pill)
 *   ![Agent](https://erc8004.aibtc.com/api/v1/agents/42/badge?style=card)
 *
 * ⚠️  Embedding notes:
 *   - <img> embed: static badge only. Browsers strip all scripting from SVGs
 *     loaded via <img> (security baseline since ~2014), so the copy-to-clipboard
 *     buttons are non-functional. Use <img> for GitHub READMEs and profiles.
 *   - <object> or inline <svg>: copy buttons work, but carries XSS risk if the
 *     page CSP is permissive. Only embed via <object>/<svg> on trusted origins.
 *
 * Data source: D1 database (agents + agent_metadata tables). On a D1 miss the
 * route asks identity-registry-v2 (read-only get-owner, 3s timeout) and renders an
 * "indexing" badge if the agent exists; it only reports 404 when the registry
 * confirms the id is unregistered, and 503 when the registry can't be reached.
 *
 * Styles:
 *   standard (default) — 340×64px full-featured badge
 *   pill               — compact auto-width pill (fits in GitHub READMEs)
 *   card               — 380×92px wide card with registered block + metadata count
 *
 * Cache headers:
 *   success   → public, max-age=3600, stale-while-revalidate=86400
 *   indexing  → public, max-age=60 (D1 miss, agent exists on chain)
 *   not found → no-store (registry confirms absence)
 *   error     → no-store (incl. 503 when the registry is unreachable)
 *
 * Cache normalization: the only recognized query parameter is `style`. Unknown
 * parameters (e.g. ?v=123) are ignored by the handler but may create separate
 * edge-cache entries. Configure CF Cache Rules to normalize on `style` only
 * to prevent cache fragmentation from arbitrary query strings.
 */

import { Hono } from "hono";
import type { Env, AppVariables } from "../types";
import { parseAgentId } from "./helpers";
import { queryAgentForBadge } from "../utils/query";
import { lookupRegistryOwner } from "../utils/registry";

export const badgeRoute = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

// ── SVG utilities ─────────────────────────────────────────────────────────────

/**
 * Escape a value for safe embedding inside SVG attribute values and text nodes.
 *
 * Covers all five XML/HTML special characters including single-quote (&#39;),
 * which is required to prevent attribute injection in onclick handlers that
 * delimit strings with single quotes — e.g. onclick="fn('${esc(val)}')".
 * Without escaping ', a malicious agent metadata value could break out of the
 * JS string context and execute arbitrary script when the SVG is embedded via
 * <object> or inline.
 *
 * Note: trunc() is applied before esc() in some callers, which means an HTML
 * entity that spans the truncation boundary will render as a broken & — this is
 * a cosmetic issue only (no security impact), since esc() is always the final
 * transform applied to user-controlled data.
 *
 * Exported for unit testing.
 */
export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function abbrev(addr: string, head = 8, tail = 6): string {
  if (!addr || addr.length <= head + tail + 1) return addr;
  return addr.slice(0, head) + "…" + addr.slice(-tail);
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ── Standard badge (340×64) ───────────────────────────────────────────────────

interface BadgeData {
  agentId: number;
  stxAddress: string;
  btcAddress: string | null;
  displayName: string | null;
  bnsName: string | null;
  registeredAt: number;
  profileUrl: string;
  /** True when the agent was resolved from the on-chain registry because D1 has not indexed it yet. */
  indexing?: boolean;
}

function buildStandardBadge(d: BadgeData): string {
  const W = 340, H = 64;
  const uid = `b${d.agentId}`;
  const title = `ERC-8004 AGENT #${d.agentId}`;
  const nameBase = d.displayName ?? abbrev(d.stxAddress);
  const sub = trunc(d.bnsName ? `${d.bnsName} · ${nameBase}` : nameBase, 64);

  const PILL_W = 72, PILL_H = 16;
  const PILL_X = W - PILL_W - 8;
  const PILL_CX = PILL_X + PILL_W / 2;
  const HDR = 45;
  const ADDR_Y = HDR + 14;

  const copyIcon = (ix: number, iy: number, confirmId: string, val: string) => `
    <g onclick="${uid}cp('${confirmId}','${esc(val)}')" style="cursor:pointer">
      <rect x="${ix}"   y="${iy + 2}" width="5" height="5" rx="0.8"
            fill="#0d0514" stroke="rgba(255,255,255,0.18)" stroke-width="0.6"/>
      <rect x="${ix + 2}" y="${iy}"   width="5" height="5" rx="0.8"
            fill="#0d0514" stroke="rgba(255,255,255,0.32)" stroke-width="0.6"/>
      <text id="${confirmId}" x="${ix + 4.5}" y="${iy + 5.5}"
            font-family="-apple-system,BlinkMacSystemFont,sans-serif"
            font-size="5.5" font-weight="700" fill="#00c97a" text-anchor="middle"></text>
    </g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"
     role="img" aria-label="${esc(title)} — ${esc(nameBase)}">
  <title>${esc(title)} — ${esc(nameBase)}</title>
  <defs>
    <linearGradient id="${uid}bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#0d0514"/>
      <stop offset="100%" stop-color="#08020e"/>
    </linearGradient>
    <linearGradient id="${uid}bar" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#f7931a"/>
      <stop offset="100%" stop-color="#f7931a" stop-opacity="0.35"/>
    </linearGradient>
    <radialGradient id="${uid}glow" cx="0%" cy="0%" r="60%">
      <stop offset="0%"   stop-color="#f7931a" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#f7931a" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="${uid}cl"><rect width="${W}" height="${H}" rx="10"/></clipPath>
  </defs>
  <script type="text/javascript"><![CDATA[
    function ${uid}cp(id,v){if(!navigator.clipboard)return;navigator.clipboard.writeText(v).then(function(){var e=document.getElementById(id);if(!e)return;e.textContent='✓';setTimeout(function(){e.textContent='';},1600);});}
  ]]></script>
  <g clip-path="url(#${uid}cl)">
    <rect width="${W}" height="${H}" fill="url(#${uid}bg)"/>
    <rect width="${W}" height="${H}" fill="url(#${uid}glow)"/>
    <rect x="0" y="0" width="4" height="${H}" fill="url(#${uid}bar)"/>
    <rect width="${W}" height="${H}" rx="10" fill="none"
          stroke="rgba(247,147,26,0.15)" stroke-width="0.8"/>
    <line x1="4" y1="${HDR}" x2="${W}" y2="${HDR}"
          stroke="rgba(255,255,255,0.08)" stroke-width="0.6"/>

    <!-- Row A: icon · title · ERC-8004 pill -->
    <rect x="12" y="7" width="18" height="18" rx="4" fill="rgba(247,147,26,0.15)"/>
    <text x="21" y="20" font-size="11" text-anchor="middle"
          font-family="Apple Color Emoji,Segoe UI Emoji,Noto Color Emoji,serif">🤖</text>
    <text x="36" y="21"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="11" font-weight="700" fill="#eef3ff" letter-spacing="0.2">${esc(title)}</text>
    <rect x="${PILL_X}" y="7" width="${PILL_W}" height="${PILL_H}" rx="5"
          fill="rgba(247,147,26,0.15)" stroke="#f7931a" stroke-width="0.6" stroke-opacity="0.5"/>
    <text x="${PILL_CX}" y="${7 + PILL_H / 2 + 3}"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7" font-weight="800" fill="#f7931a" text-anchor="middle"
          letter-spacing="1.2">ERC-8004</text>

    <!-- Row B: name · verified · profile link -->
    <text x="36" y="37"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="10" font-weight="500" fill="#8ba4c4">${esc(sub)}</text>
    <text x="${W - 82}" y="37" text-anchor="end"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7.5" fill="rgba(125,162,255,0.85)">${d.indexing ? "indexing…" : "✓ on-chain"}</text>
    <a href="${esc(d.profileUrl)}" target="_blank">
      <text x="${W - 8}" y="37"
            font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
            font-size="8" fill="#f7931a" text-anchor="end" opacity="0.9">View Profile →</text>
    </a>

    <!-- Address row: STX left · BTC right -->
    <text x="51" y="${ADDR_Y}"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7" font-weight="700" letter-spacing="0.6" fill="#f7931a">STX</text>
    <text x="69" y="${ADDR_Y}"
          font-family="'SF Mono','Fira Code','Consolas',monospace"
          font-size="9" fill="#8899b4">${esc(abbrev(d.stxAddress))}</text>
    ${copyIcon(153, HDR + 7, `${uid}sc`, d.stxAddress)}
    ${d.btcAddress ? `
    <text x="180" y="${ADDR_Y}"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7" font-weight="700" letter-spacing="0.6" fill="#f7931a">BTC</text>
    <text x="198" y="${ADDR_Y}"
          font-family="'SF Mono','Fira Code','Consolas',monospace"
          font-size="9" fill="#8899b4">${esc(abbrev(d.btcAddress))}</text>
    ${copyIcon(282, HDR + 7, `${uid}bc`, d.btcAddress)}
    ` : ""}
  </g>
</svg>`;
}

// ── Pill badge (compact, auto-width) ─────────────────────────────────────────

function buildPillBadge(d: BadgeData): string {
  const H = 24, LEFT_W = 58;
  const name = d.bnsName
    ? trunc(d.bnsName, 22)
    : d.displayName
    ? trunc(d.displayName, 22)
    : null;

  // 5.8px per digit is a font-metric approximation for the 9px bold sans-serif
  // used by the agent ID. Accurate for IDs up to ~4 digits; for 5+ digit IDs
  // the pill may run slightly wide but remains readable. Capped at 10 digits to
  // prevent runaway widths if the registry ever scales past 9,999,999,999.
  const idDigits = Math.min(String(d.agentId).length, 10);
  const idW = 8 + idDigits * 5.8;
  const nmW = name ? 8 + name.length * 5.3 + 8 : 0;
  const rightW = Math.max(88, Math.ceil(8 + idW + nmW + 56));
  const W = LEFT_W + rightW;

  const RX = LEFT_W + 8;
  const nmX = RX + Math.ceil(idW);
  const chkX = W - 3;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"
     role="img" aria-label="ERC-8004 Agent #${d.agentId}">
  <title>ERC-8004 Agent #${d.agentId}</title>
  <defs><clipPath id="pcl${d.agentId}"><rect width="${W}" height="${H}" rx="12"/></clipPath></defs>
  <g clip-path="url(#pcl${d.agentId})">
    <rect x="0" y="0" width="${LEFT_W}" height="${H}" fill="#090214"/>
    <rect x="${LEFT_W}" y="0" width="${rightW}" height="${H}" fill="#0d0514"/>
    <rect width="${W}" height="${H}" rx="12" fill="none"
          stroke="rgba(247,147,26,0.28)" stroke-width="0.8"/>
    <line x1="${LEFT_W}" y1="5" x2="${LEFT_W}" y2="${H - 5}"
          stroke="rgba(247,147,26,0.20)" stroke-width="0.6"/>
    <text x="9" y="15.5"
          font-family="Apple Color Emoji,Segoe UI Emoji,Noto Color Emoji,serif"
          font-size="9">🤖</text>
    <text x="21" y="15.5"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7.5" font-weight="700" fill="rgba(255,255,255,0.45)">AIBTC</text>
    <text x="${RX}" y="15.5"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="9" font-weight="800" fill="#f7931a">#${d.agentId}</text>
    ${name ? `
    <text x="${nmX}" y="15.5"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7.5" fill="rgba(255,255,255,0.25)">·</text>
    <text x="${nmX + 8}" y="15.5"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7.5" fill="#8ba4c4">${esc(name)}</text>
    ` : ""}
    <a href="${esc(d.profileUrl)}" target="_blank">
      <text x="${chkX}" y="15.5"
            font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
            font-size="7.5" fill="rgba(125,162,255,0.85)" text-anchor="end">${d.indexing ? "…" : "✓"}</text>
    </a>
  </g>
</svg>`;
}

// ── Card badge (380×92) ───────────────────────────────────────────────────────

function buildCardBadge(d: BadgeData & { metadataCount: number }): string {
  const W = 380, H = 92;
  const uid = `c${d.agentId}`;
  const title = `ERC-8004 AGENT #${d.agentId}`;
  const nameBase = d.displayName ?? abbrev(d.stxAddress);
  const sub = trunc(d.bnsName ? `${d.bnsName} · ${nameBase}` : nameBase, 72);

  const PILL_W = 72, PILL_H = 16;
  const PILL_X = W - PILL_W - 8;
  const PILL_CX = PILL_X + PILL_W / 2;
  const HDR = 45;
  const ADDR_Y = HDR + 14;
  const FOOTER_Y = 69;

  const copyIcon = (ix: number, iy: number, confirmId: string, val: string) => `
    <g onclick="${uid}cp('${confirmId}','${esc(val)}')" style="cursor:pointer">
      <rect x="${ix}"   y="${iy + 2}" width="5" height="5" rx="0.8"
            fill="#0d0514" stroke="rgba(255,255,255,0.18)" stroke-width="0.6"/>
      <rect x="${ix + 2}" y="${iy}"   width="5" height="5" rx="0.8"
            fill="#0d0514" stroke="rgba(255,255,255,0.32)" stroke-width="0.6"/>
      <text id="${confirmId}" x="${ix + 4.5}" y="${iy + 5.5}"
            font-family="-apple-system,BlinkMacSystemFont,sans-serif"
            font-size="5.5" font-weight="700" fill="#00c97a" text-anchor="middle"></text>
    </g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"
     role="img" aria-label="${esc(title)} — ${esc(nameBase)}">
  <title>${esc(title)} — ${esc(nameBase)}</title>
  <defs>
    <linearGradient id="${uid}bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#0d0514"/>
      <stop offset="100%" stop-color="#08020e"/>
    </linearGradient>
    <linearGradient id="${uid}bar" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#f7931a"/>
      <stop offset="100%" stop-color="#f7931a" stop-opacity="0.35"/>
    </linearGradient>
    <radialGradient id="${uid}glow" cx="0%" cy="0%" r="60%">
      <stop offset="0%"   stop-color="#f7931a" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#f7931a" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="${uid}cl"><rect width="${W}" height="${H}" rx="10"/></clipPath>
  </defs>
  <script type="text/javascript"><![CDATA[
    function ${uid}cp(id,v){if(!navigator.clipboard)return;navigator.clipboard.writeText(v).then(function(){var e=document.getElementById(id);if(!e)return;e.textContent='✓';setTimeout(function(){e.textContent='';},1600);});}
  ]]></script>
  <g clip-path="url(#${uid}cl)">
    <rect width="${W}" height="${H}" fill="url(#${uid}bg)"/>
    <rect width="${W}" height="${H}" fill="url(#${uid}glow)"/>
    <rect x="0" y="0" width="4" height="${H}" fill="url(#${uid}bar)"/>
    <rect width="${W}" height="${H}" rx="10" fill="none"
          stroke="rgba(247,147,26,0.15)" stroke-width="0.8"/>
    <line x1="4" y1="${HDR}" x2="${W}" y2="${HDR}"
          stroke="rgba(255,255,255,0.08)" stroke-width="0.6"/>
    <line x1="4" y1="${FOOTER_Y}" x2="${W}" y2="${FOOTER_Y}"
          stroke="rgba(255,255,255,0.06)" stroke-width="0.6"/>

    <!-- Row A -->
    <rect x="12" y="7" width="18" height="18" rx="4" fill="rgba(247,147,26,0.15)"/>
    <text x="21" y="20" font-size="11" text-anchor="middle"
          font-family="Apple Color Emoji,Segoe UI Emoji,Noto Color Emoji,serif">🤖</text>
    <text x="36" y="21"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="11" font-weight="700" fill="#eef3ff" letter-spacing="0.2">${esc(title)}</text>
    <rect x="${PILL_X}" y="7" width="${PILL_W}" height="${PILL_H}" rx="5"
          fill="rgba(247,147,26,0.15)" stroke="#f7931a" stroke-width="0.6" stroke-opacity="0.5"/>
    <text x="${PILL_CX}" y="${7 + PILL_H / 2 + 3}"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7" font-weight="800" fill="#f7931a" text-anchor="middle"
          letter-spacing="1.2">ERC-8004</text>

    <!-- Row B -->
    <text x="36" y="37"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="10" font-weight="500" fill="#8ba4c4">${esc(sub)}</text>
    <text x="${W - 82}" y="37" text-anchor="end"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7.5" fill="rgba(125,162,255,0.85)">${d.indexing ? "indexing…" : "✓ on-chain"}</text>
    <a href="${esc(d.profileUrl)}" target="_blank">
      <text x="${W - 8}" y="37"
            font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
            font-size="8" fill="#f7931a" text-anchor="end" opacity="0.9">View Profile →</text>
    </a>

    <!-- Address row -->
    <text x="51" y="${ADDR_Y}"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7" font-weight="700" letter-spacing="0.6" fill="#f7931a">STX</text>
    <text x="69" y="${ADDR_Y}"
          font-family="'SF Mono','Fira Code','Consolas',monospace"
          font-size="9" fill="#8899b4">${esc(abbrev(d.stxAddress))}</text>
    ${copyIcon(153, HDR + 7, `${uid}sc`, d.stxAddress)}
    ${d.btcAddress ? `
    <text x="196" y="${ADDR_Y}"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7" font-weight="700" letter-spacing="0.6" fill="#f7931a">BTC</text>
    <text x="214" y="${ADDR_Y}"
          font-family="'SF Mono','Fira Code','Consolas',monospace"
          font-size="9" fill="#8899b4">${esc(abbrev(d.btcAddress))}</text>
    ${copyIcon(298, HDR + 7, `${uid}bc`, d.btcAddress)}
    ` : ""}

    <!-- Footer: registered block · metadata count -->
    <text x="12" y="82"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7" fill="rgba(255,255,255,0.25)">${d.indexing ? "registered · block pending index" : `registered block ${d.registeredAt.toLocaleString()}`}</text>
    <text x="${W - 8}" y="82"
          font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"
          font-size="7" fill="rgba(255,255,255,0.25)" text-anchor="end">${d.indexing ? "metadata pending" : `${d.metadataCount} metadata key${d.metadataCount === 1 ? "" : "s"}`}</text>
  </g>
</svg>`;
}

// ── Error SVG ─────────────────────────────────────────────────────────────────

function errorSvg(message: string, dim = false): string {
  const color = dim ? "#4a5568" : "#ff4d6a";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="280" height="40" viewBox="0 0 280 40">
  <rect width="280" height="40" rx="6" fill="#050208" stroke="rgba(247,147,26,0.15)" stroke-width="1"/>
  <text x="140" y="25" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12"
        fill="${color}" text-anchor="middle">${esc(message)}</text>
</svg>`;
}

// ── Decode a hex-encoded UTF-8 metadata value ─────────────────────────────────
// Returns null if hex is empty or decoding fails.

function decodeMetaHex(hex: string): string | null {
  if (!hex) return null;
  try {
    return Buffer.from(hex, "hex").toString("utf8") || null;
  } catch {
    return null;
  }
}

// ── SVG response helper ───────────────────────────────────────────────────────

function svgResponse(
  svg: string,
  status: 200 | 400 | 403 | 404 | 503,
  cache: string
): Response {
  return new Response(svg, {
    status,
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": cache,
    },
  });
}

// ── D1 miss: ask the registry before claiming anything ────────────────────────
// A D1 miss only means "not indexed", not "not registered". Resolve against
// identity-registry-v2 so a missing badge always means a missing agent.

async function fallbackFromRegistry(
  env: Env,
  agentId: number,
  style: string
): Promise<Response> {
  const found = await lookupRegistryOwner(env, agentId);
  if (found.state === "none") {
    return svgResponse(errorSvg("agent not found", true), 404, "no-store");
  }
  if (found.state === "unknown") {
    return svgResponse(errorSvg("registry unavailable", true), 503, "no-store");
  }
  const badgeData: BadgeData = {
    agentId,
    stxAddress: found.owner,
    btcAddress: null,
    displayName: null,
    bnsName: null,
    registeredAt: 0,
    profileUrl: `https://aibtc.com/agents/${found.owner}`,
    indexing: true,
  };
  const svg =
    style === "pill"
      ? buildPillBadge(badgeData)
      : style === "card"
      ? buildCardBadge({ ...badgeData, metadataCount: 0 })
      : buildStandardBadge(badgeData);
  // Short TTL: the full badge replaces this as soon as the indexer catches up.
  return svgResponse(svg, 200, "public, max-age=60");
}

// ── Route handler ─────────────────────────────────────────────────────────────

badgeRoute.get("/agents/:id/badge", async (c) => {
  const agentId = parseAgentId(c);
  if (agentId === null) {
    return svgResponse(errorSvg("Invalid agent ID"), 400, "no-store");
  }

  const style = (c.req.query("style") ?? "standard").trim();
  if (!["standard", "pill", "card"].includes(style)) {
    return svgResponse(
      errorSvg("style must be standard | pill | card"),
      400,
      "no-store"
    );
  }

  const data = await queryAgentForBadge(c.env.DB, agentId);
  if (!data) return fallbackFromRegistry(c.env, agentId, style);

  // profileUrl is always server-constructed with a fixed https:// prefix.
  // data.owner is the on-chain STX address (SP… format, verified by the indexer)
  // and is never sourced from agent-supplied metadata, so javascript:/data: injection
  // is not possible here. No scheme validation is required.
  const profileUrl = `https://aibtc.com/agents/${data.owner}`;
  const badgeData: BadgeData = {
    agentId: data.agent_id,
    stxAddress: data.owner,
    btcAddress: decodeMetaHex(data.btc_hex ?? ""),
    displayName: decodeMetaHex(data.name_hex ?? ""),
    bnsName: decodeMetaHex(data.bns_hex ?? ""),
    registeredAt: data.created_at_block,
    profileUrl,
  };

  // metadata_count is fetched by queryAgentForBadge for all styles but only
  // displayed by the card variant. The cost is negligible (single COUNT in the
  // same JOIN), and keeping the query shape consistent simplifies the type surface.
  let svg: string;
  if (style === "pill") {
    svg = buildPillBadge(badgeData);
  } else if (style === "card") {
    svg = buildCardBadge({ ...badgeData, metadataCount: data.metadata_count });
  } else {
    svg = buildStandardBadge(badgeData);
  }

  return svgResponse(svg, 200, "public, max-age=3600, stale-while-revalidate=86400");
});
