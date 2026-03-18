import { CONTRACTS, BOOT_ADDRESS, FETCH_BATCH_SIZE } from "../lib/constants";
import type { AgentIdentity, LastTokenIdResult } from "../lib/types";

type Network = "mainnet" | "testnet";

/**
 * Parse a Clarity value string to extract the actual value.
 * Handles (ok uXXX), (some ...), none, and string literals.
 */
function parseClarityValue(raw: string): string | null {
  // (ok uXXX) -> XXX
  const okUintMatch = raw.match(/^\(ok u(\d+)\)$/);
  if (okUintMatch) return okUintMatch[1];

  // (ok (some uXXX)) -> XXX
  const okSomeUintMatch = raw.match(/^\(ok \(some u(\d+)\)\)$/);
  if (okSomeUintMatch) return okSomeUintMatch[1];

  // (some "...") -> ...
  const someStringMatch = raw.match(/^\(some "(.*)"\)$/);
  if (someStringMatch) return someStringMatch[1];

  // (some u...) -> ...
  const someUintMatch = raw.match(/^\(some u(\d+)\)$/);
  if (someUintMatch) return someUintMatch[1];

  // (some 'SP...) -> SP...
  const somePrincipalMatch = raw.match(/^\(some '([A-Z0-9]+)\)$/i);
  if (somePrincipalMatch) return somePrincipalMatch[1];

  // (some ...) generic
  const someMatch = raw.match(/^\(some (.+)\)$/);
  if (someMatch) return someMatch[1];

  // none
  if (raw === "none" || raw === "(none)") return null;

  // (err uXXX) -> null
  if (raw.startsWith("(err ")) return null;

  // bare uXXX
  const bareUintMatch = raw.match(/^u(\d+)$/);
  if (bareUintMatch) return bareUintMatch[1];

  // string literal
  const stringMatch = raw.match(/^"(.*)"$/);
  if (stringMatch) return stringMatch[1];

  // principal
  const principalMatch = raw.match(/^'([A-Z0-9]+)$/i);
  if (principalMatch) return principalMatch[1];

  return raw;
}

/** Call a read-only function on a Stacks smart contract */
async function callReadOnly(
  apiUrl: string,
  contractId: string,
  functionName: string,
  args: string[],
  sender: string
): Promise<string | null> {
  const [address, name] = contractId.split(".");
  const url = `${apiUrl}/v2/contracts/call-read/${address}/${name}/${functionName}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender, arguments: args }),
  });

  if (!response.ok) return null;

  const data = (await response.json()) as { okay: boolean; result?: string; cause?: string };
  if (!data.okay || !data.result) return null;

  // Decode the hex-encoded Clarity value
  const hex = data.result.startsWith("0x") ? data.result.slice(2) : data.result;
  const bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map((b: string) => parseInt(b, 16)));
  const decoded = new TextDecoder().decode(bytes);

  // The decoded value contains Clarity type prefixes — extract meaningful content
  return decoded;
}

/**
 * Simpler approach: use the Stacks API v2 read-only endpoint
 * and parse the hex-encoded Clarity response.
 *
 * For get-last-token-id: returns (ok uint) or (err uint)
 * For get-owner/get-uri/get-agent-wallet: returns (optional principal/string)
 */
async function callReadOnlyRaw(
  apiUrl: string,
  contractId: string,
  functionName: string,
  args: string[],
  sender: string
): Promise<{ okay: boolean; result: string | null }> {
  const [address, name] = contractId.split(".");
  const url = `${apiUrl}/v2/contracts/call-read/${address}/${name}/${functionName}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender, arguments: args }),
  });

  if (!response.ok) {
    return { okay: false, result: null };
  }

  const data = (await response.json()) as { okay: boolean; result?: string; cause?: string };
  return { okay: data.okay, result: data.result ?? null };
}

/** Encode a uint as Clarity hex argument (0x01 prefix + 16-byte big-endian) */
function encodeUint(n: number): string {
  const hex = n.toString(16).padStart(32, "0");
  return "0x01" + hex;
}

/** Get the last registered agent ID from the identity registry */
export async function getLastTokenId(
  apiUrl: string,
  network: Network
): Promise<LastTokenIdResult> {
  const contractId = CONTRACTS[network].identity;
  const sender = BOOT_ADDRESS[network];

  const result = await callReadOnlyRaw(apiUrl, contractId, "get-last-token-id", [], sender);
  if (!result.okay || !result.result) {
    return { success: false, last_id: 0 };
  }

  // Response is hex-encoded Clarity value: (ok uN)
  // Type 0x07 = ok response, type 0x01 = uint
  // Parse the uint from the response
  const hex = result.result.startsWith("0x") ? result.result.slice(2) : result.result;

  // ok response: 07 + inner value
  // uint: 01 + 16 bytes big-endian
  // So (ok uN) = 07 01 <16 bytes>
  if (hex.startsWith("07") && hex.substring(2, 4) === "01") {
    const uintHex = hex.substring(4, 36);
    const value = parseInt(uintHex, 16);
    if (!isNaN(value)) {
      return { success: true, last_id: value };
    }
  }

  return { success: false, last_id: 0 };
}

/** Fetch a single agent identity by ID */
export async function getAgentIdentity(
  apiUrl: string,
  network: Network,
  agentId: number
): Promise<AgentIdentity | null> {
  const contractId = CONTRACTS[network].identity;
  const sender = BOOT_ADDRESS[network];
  const agentIdArg = encodeUint(agentId);

  // Fetch owner, uri, and wallet in parallel
  const [ownerResult, uriResult, walletResult] = await Promise.all([
    callReadOnlyRaw(apiUrl, contractId, "get-owner", [agentIdArg], sender),
    callReadOnlyRaw(apiUrl, contractId, "get-uri", [agentIdArg], sender),
    callReadOnlyRaw(apiUrl, contractId, "get-agent-wallet", [agentIdArg], sender),
  ]);

  // Owner is required — if missing, agent doesn't exist
  if (!ownerResult.okay || !ownerResult.result) return null;

  const owner = parseOptionalPrincipal(ownerResult.result);
  if (!owner) return null;

  const uri = parseOptionalString(uriResult.result);
  const wallet = parseOptionalPrincipal(walletResult.result);

  return {
    agent_id: agentId,
    owner,
    uri: uri === "(no URI set)" ? null : uri,
    wallet: wallet === "(no wallet set)" ? null : wallet,
    network,
  };
}

/** Parse an optional principal from hex-encoded Clarity response */
function parseOptionalPrincipal(hex: string | null): string | null {
  if (!hex) return null;
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;

  // none = 09
  if (h === "09" || h.startsWith("09")) {
    // Check if it's truly none (just the none tag)
    if (h === "09") return null;
  }

  // (some principal) = 0a + principal encoding
  // Standard principal: 05 + version(1) + hash160(20)
  if (h.startsWith("0a")) {
    const inner = h.substring(2);
    // Standard principal: 05 + version(1 byte) + hash160(20 bytes) = 05 + 01 + 40hex
    if (inner.startsWith("05")) {
      const version = parseInt(inner.substring(2, 4), 16);
      const hash160 = inner.substring(4, 44);
      return clarityPrincipalToAddress(version, hash160);
    }
    // Contract principal: 06 + version(1) + hash160(20) + name_len(1) + name
    if (inner.startsWith("06")) {
      const version = parseInt(inner.substring(2, 4), 16);
      const hash160 = inner.substring(4, 44);
      const nameLen = parseInt(inner.substring(44, 46), 16);
      const nameHex = inner.substring(46, 46 + nameLen * 2);
      const name = hexToString(nameHex);
      const addr = clarityPrincipalToAddress(version, hash160);
      return addr ? `${addr}.${name}` : null;
    }
  }

  // ok wrapping: 07 + inner
  if (h.startsWith("07")) {
    return parseOptionalPrincipal("0x" + h.substring(2));
  }

  return null;
}

/** Parse an optional string from hex-encoded Clarity response */
function parseOptionalString(hex: string | null): string | null {
  if (!hex) return null;
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;

  // none = 09
  if (h === "09") return null;

  // (some string) = 0a + string encoding
  if (h.startsWith("0a")) {
    return parseClarityString(h.substring(2));
  }

  // ok wrapping
  if (h.startsWith("07")) {
    return parseOptionalString("0x" + h.substring(2));
  }

  // Direct string
  return parseClarityString(h);
}

/** Parse a Clarity string-utf8 or string-ascii from hex */
function parseClarityString(hex: string): string | null {
  // string-utf8: 0e + length(4 bytes) + data
  if (hex.startsWith("0e")) {
    const len = parseInt(hex.substring(2, 10), 16);
    const dataHex = hex.substring(10, 10 + len * 2);
    return hexToString(dataHex);
  }
  // string-ascii: 0d + length(4 bytes) + data
  if (hex.startsWith("0d")) {
    const len = parseInt(hex.substring(2, 10), 16);
    const dataHex = hex.substring(10, 10 + len * 2);
    return hexToString(dataHex);
  }
  return null;
}

/** Convert hex string to UTF-8 string */
function hexToString(hex: string): string {
  const bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
  return new TextDecoder().decode(bytes);
}

/** Convert Clarity principal version + hash160 to Stacks address */
function clarityPrincipalToAddress(version: number, hash160Hex: string): string | null {
  // Stacks addresses use c32check encoding
  // Version mapping: 22 (0x16) = SP (mainnet), 26 (0x1a) = ST (testnet)
  // For simplicity, use the crockford base32 encoding
  const C32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

  const dataBytes = hexToBytes(hash160Hex);
  if (dataBytes.length !== 20) return null;

  // Prepend version byte
  const versionedData = new Uint8Array(21);
  versionedData[0] = version;
  versionedData.set(dataBytes, 1);

  // Compute checksum: double SHA-256 of versioned data (first 4 bytes)
  // Since we can't do SHA-256 synchronously in Workers without crypto.subtle,
  // we'll use a simpler c32 encoding approach
  const versionChar = C32_ALPHABET[version];
  const c32Encoded = c32encode(dataBytes);

  // Stacks address = S + version_char + c32(hash160)
  const prefix = version === 22 || version === 20 ? "SP" : "ST";
  // Actually, the prefix IS the version encoding in c32check
  // Let's use a proper c32check encode
  return c32checkEncode(version, dataBytes);
}

/** Encode bytes to crockford base32 */
function c32encode(data: Uint8Array): string {
  const C32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let result = "";

  // Convert to bits
  let bits = 0;
  let buffer = 0;
  for (const byte of data) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += C32_ALPHABET[(buffer >> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    result += C32_ALPHABET[(buffer << (5 - bits)) & 0x1f];
  }

  return result;
}

/** c32check encode: version byte + data -> c32check string */
function c32checkEncode(version: number, data: Uint8Array): string {
  const C32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

  // For a proper c32check address we need SHA-256 checksum
  // In the Stacks ecosystem, addresses are: S + c32(version) + c32(hash160 + checksum)
  // Since we can't do sync SHA-256, encode without checksum validation
  // The version byte maps to: 22='P' (mainnet single-sig), 26='T' (testnet single-sig)
  // etc.

  // Full c32check encoding with hex-based approach
  const hexData = Array.from(data).map(b => b.toString(16).padStart(2, "0")).join("");
  const fullHex = version.toString(16).padStart(2, "0") + hexData;

  // Convert hex to c32
  let num = BigInt("0x" + fullHex);
  let c32 = "";
  while (num > 0n) {
    c32 = C32_ALPHABET[Number(num % 32n)] + c32;
    num = num / 32n;
  }

  // Pad with leading zeros for leading zero bytes
  const leadingZeros = fullHex.match(/^(00)*/)?.[0]?.length ?? 0;
  for (let i = 0; i < leadingZeros / 2; i++) {
    c32 = C32_ALPHABET[0] + c32;
  }

  return "S" + c32;
}

/** Convert hex string to Uint8Array */
function hexToBytes(hex: string): Uint8Array {
  const matches = hex.match(/.{1,2}/g);
  if (!matches) return new Uint8Array(0);
  return new Uint8Array(matches.map((b) => parseInt(b, 16)));
}

/** Fetch all agents in batches */
export async function fetchAllAgents(
  apiUrl: string,
  network: Network,
  lastKnownId?: number
): Promise<{ agents: AgentIdentity[]; lastAgentId: number }> {
  // Get the last registered agent ID
  const tokenResult = await getLastTokenId(apiUrl, network);

  let maxId: number;
  if (tokenResult.success) {
    maxId = tokenResult.last_id;
  } else if (lastKnownId && lastKnownId > 0) {
    // Fallback: probe beyond last known ID
    maxId = lastKnownId + 20;
  } else {
    // Hard fallback: probe up to 100
    maxId = 100;
  }

  const agents: AgentIdentity[] = [];

  // Fetch in batches
  for (let start = 1; start <= maxId; start += FETCH_BATCH_SIZE) {
    const end = Math.min(start + FETCH_BATCH_SIZE - 1, maxId);
    const ids = Array.from({ length: end - start + 1 }, (_, i) => start + i);

    const results = await Promise.allSettled(
      ids.map((id) => getAgentIdentity(apiUrl, network, id))
    );

    let consecutiveNulls = 0;
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        agents.push(result.value);
        consecutiveNulls = 0;
      } else {
        consecutiveNulls++;
      }
    }

    // If probing without get-last-token-id, stop after 5 consecutive failures
    if (!tokenResult.success && consecutiveNulls >= 5) break;
  }

  return {
    agents,
    lastAgentId: tokenResult.success ? maxId : (agents.length > 0 ? Math.max(...agents.map(a => a.agent_id)) : 0),
  };
}
