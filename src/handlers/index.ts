/**
 * Event router — parses a Clarity repr string from a contract_log operation,
 * extracts the notification discriminant and payload fields, and dispatches
 * to the correct handler.
 *
 * Clarity repr format (decode_clarity_values=true):
 *   Outer tuple: {notification: "registry/EventName", payload: {...}}
 *   uint128:     u123          → string "123" (strip leading "u")
 *   int128:      -123 or 123   → string as-is
 *   bool:        true | false  → boolean
 *   principal:   SP... or 'SP... → string (strip leading quote)
 *   buffer:      0xABCD        → string "ABCD" (strip "0x")
 *   string-utf8: "hello"       → string "hello" (strip surrounding quotes)
 */
import type { Logger } from "../types";
import type { Erc8004Event, Erc8004Notification } from "../types/events";
import { ERC8004_NOTIFICATIONS } from "../types/events";
import {
  handleRegistered,
  handleMetadataSet,
  handleUriUpdated,
  handleApprovalForAll,
  handleTransfer,
} from "./identity";
import {
  handleClientApproved,
  handleNewFeedback,
  handleFeedbackRevoked,
  handleResponseAppended,
} from "./reputation";
import {
  handleValidationRequest,
  handleValidationResponse,
} from "./validation";

// ============================================================
// Clarity repr parser
// ============================================================

/**
 * Token types produced by the lexer.
 */
type Token =
  | { type: "lbrace" }
  | { type: "rbrace" }
  | { type: "colon" }
  | { type: "comma" }
  | { type: "string"; value: string }
  | { type: "atom"; value: string };

/**
 * Lex a Clarity repr string into tokens.
 * Handles nested tuples, quoted strings, and bare atoms.
 */
function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") {
      i++;
      continue;
    }
    if (ch === "{") {
      tokens.push({ type: "lbrace" });
      i++;
    } else if (ch === "}") {
      tokens.push({ type: "rbrace" });
      i++;
    } else if (ch === ":") {
      tokens.push({ type: "colon" });
      i++;
    } else if (ch === ",") {
      tokens.push({ type: "comma" });
      i++;
    } else if (ch === '"') {
      // Quoted string — scan until closing unescaped quote
      let j = i + 1;
      while (j < input.length && input[j] !== '"') {
        if (input[j] === "\\") j++; // skip escaped char
        j++;
      }
      tokens.push({ type: "string", value: input.slice(i + 1, j) });
      i = j + 1;
    } else {
      // Bare atom: identifier, uint (u123), int (-123), bool, principal
      let j = i;
      while (
        j < input.length &&
        input[j] !== " " &&
        input[j] !== "{" &&
        input[j] !== "}" &&
        input[j] !== ":" &&
        input[j] !== ","
      ) {
        j++;
      }
      tokens.push({ type: "atom", value: input.slice(i, j) });
      i = j;
    }
  }
  return tokens;
}

/**
 * Parse state — wraps the token array with a position cursor.
 */
interface ParseState {
  tokens: Token[];
  pos: number;
}

function peek(s: ParseState): Token | undefined {
  return s.tokens[s.pos];
}

function consume(s: ParseState): Token {
  const t = s.tokens[s.pos];
  s.pos++;
  return t;
}

/**
 * Parse a Clarity value from token stream.
 * Returns a JS value: string, number, boolean, or Record<string, unknown>.
 */
function parseValue(s: ParseState): unknown {
  const t = peek(s);
  if (!t) throw new Error("Unexpected end of repr");

  if (t.type === "lbrace") {
    return parseTuple(s);
  }

  if (t.type === "string") {
    consume(s);
    return t.value; // already stripped of quotes
  }

  if (t.type === "atom") {
    consume(s);
    const v = t.value;

    // uint: u123
    if (v.startsWith("u") && /^u\d+$/.test(v)) {
      return v.slice(1); // return as string to preserve uint128 range
    }

    // bool
    if (v === "true") return true;
    if (v === "false") return false;

    // buffer: 0xABCD → strip 0x
    if (v.startsWith("0x")) return v.slice(2);

    // principal: 'SP... → strip leading quote
    if (v.startsWith("'")) return v.slice(1);

    // int or other bare token — return as string
    return v;
  }

  throw new Error(`Unexpected token type: ${t.type}`);
}

/**
 * Parse a Clarity tuple { key: value, ... } from token stream.
 */
function parseTuple(s: ParseState): Record<string, unknown> {
  const lbrace = consume(s);
  if (lbrace.type !== "lbrace") {
    throw new Error(`Expected '{', got ${lbrace.type}`);
  }

  const result: Record<string, unknown> = {};

  while (true) {
    const t = peek(s);
    if (!t) throw new Error("Unterminated tuple");
    if (t.type === "rbrace") {
      consume(s);
      break;
    }

    // Key: bare atom or quoted string
    const keyTok = consume(s);
    let key: string;
    if (keyTok.type === "atom") {
      key = keyTok.value;
    } else if (keyTok.type === "string") {
      key = keyTok.value;
    } else {
      throw new Error(`Expected key, got ${keyTok.type}`);
    }

    // Colon
    const colon = consume(s);
    if (colon.type !== "colon") {
      throw new Error(`Expected ':', got ${colon.type} after key "${key}"`);
    }

    // Value
    const value = parseValue(s);
    result[key] = value;

    // Optional comma
    const next = peek(s);
    if (next && next.type === "comma") {
      consume(s);
    }
  }

  return result;
}

/**
 * Parse a Clarity repr string into a plain JS object.
 * The top-level value must be a tuple.
 */
export function parseRepr(repr: string): Record<string, unknown> {
  const tokens = lex(repr);
  const state: ParseState = { tokens, pos: 0 };
  const result = parseValue(state);
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("Repr did not parse to an object");
  }
  return result as Record<string, unknown>;
}

// ============================================================
// Event builder — turns a parsed object into a typed Erc8004Event
// ============================================================

function isErc8004Notification(n: unknown): n is Erc8004Notification {
  return (
    typeof n === "string" &&
    (ERC8004_NOTIFICATIONS as readonly string[]).includes(n)
  );
}

/**
 * Convert a parsed repr object into a typed Erc8004Event.
 * Returns null if the notification is not a known ERC-8004 event.
 */
function buildEvent(parsed: Record<string, unknown>): Erc8004Event | null {
  const notification = parsed["notification"];
  const payload = parsed["payload"];

  if (!isErc8004Notification(notification)) return null;
  if (typeof payload !== "object" || payload === null) return null;

  // TypeScript discriminated union — safe cast after notification check
  return { notification, payload } as Erc8004Event;
}

// ============================================================
// Router
// ============================================================

/**
 * Route a single contract_log repr value to the appropriate handler.
 *
 * @param db            D1 database binding
 * @param reprValue     Decoded Clarity repr string from the contract_log operation
 * @param blockHeight   Block index from the chainhook payload
 * @param txHash        Transaction hash from the chainhook payload
 * @param logger        Request-scoped logger
 * @returns             true if a known event was handled, false if unknown/skipped
 */
export async function routeEvent(
  db: D1Database,
  reprValue: string,
  blockHeight: number,
  txHash: string,
  logger: Logger
): Promise<boolean> {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseRepr(reprValue);
  } catch (err) {
    logger.warn("routeEvent: failed to parse repr", {
      repr: reprValue,
      error: String(err),
    });
    return false;
  }

  const event = buildEvent(parsed);
  if (!event) {
    logger.debug("routeEvent: unknown notification, skipping", {
      notification: parsed["notification"],
    });
    return false;
  }

  switch (event.notification) {
    case "identity-registry/Registered":
      await handleRegistered(db, event, blockHeight, txHash, logger);
      break;
    case "identity-registry/MetadataSet":
      await handleMetadataSet(db, event, blockHeight, txHash, logger);
      break;
    case "identity-registry/UriUpdated":
      await handleUriUpdated(db, event, blockHeight, txHash, logger);
      break;
    case "identity-registry/ApprovalForAll":
      await handleApprovalForAll(db, event, blockHeight, txHash, logger);
      break;
    case "identity-registry/Transfer":
      await handleTransfer(db, event, blockHeight, txHash, logger);
      break;
    case "reputation-registry/ClientApproved":
      await handleClientApproved(db, event, blockHeight, txHash, logger);
      break;
    case "reputation-registry/NewFeedback":
      await handleNewFeedback(db, event, blockHeight, txHash, logger);
      break;
    case "reputation-registry/FeedbackRevoked":
      await handleFeedbackRevoked(db, event, blockHeight, txHash, logger);
      break;
    case "reputation-registry/ResponseAppended":
      await handleResponseAppended(db, event, blockHeight, txHash, logger);
      break;
    case "validation-registry/ValidationRequest":
      await handleValidationRequest(db, event, blockHeight, txHash, logger);
      break;
    case "validation-registry/ValidationResponse":
      await handleValidationResponse(db, event, blockHeight, txHash, logger);
      break;
    default: {
      // Exhaustive check — TypeScript will error here if a case is missing
      const _exhaustive: never = event;
      logger.warn("routeEvent: unhandled notification", { event: _exhaustive });
      return false;
    }
  }

  return true;
}
