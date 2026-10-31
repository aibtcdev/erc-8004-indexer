/**
 * On-chain fallback for the badge route: resolves an agent's owner straight
 * from identity-registry-v2 when D1 has not indexed it (yet).
 *
 * Tri-state on purpose — "unknown" must never be reported as "not found":
 *   owner   → registry returned an owner for the id
 *   none    → registry answered and the id is not registered
 *   unknown → timeout / non-2xx / unparsable (caller must not claim absence)
 */

import { IDENTITY_CONTRACT } from "../webhook";
import type { Env } from "../types";

export type RegistryLookup =
  | { state: "owner"; owner: string }
  | { state: "none" }
  | { state: "unknown" };

const HIRO_API = "https://api.hiro.so";
const LOOKUP_TIMEOUT_MS = 3000;
const C32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function c32Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) {
    s = C32[Number(n & 31n)] + s;
    n >>= 5n;
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  return "0".repeat(zeros) + s;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

/** c32check address: "S" + c32(version) + c32(hash160 ‖ sha256d(version‖hash160)[0..4]). */
export async function c32Address(version: number, hash160: Uint8Array): Promise<string> {
  const payload = new Uint8Array(21);
  payload[0] = version;
  payload.set(hash160, 1);
  const checksum = (await sha256(await sha256(payload))).slice(0, 4);
  const body = new Uint8Array(24);
  body.set(hash160);
  body.set(checksum, 20);
  return `S${C32[version]}${c32Encode(body)}`;
}

/**
 * Parse a serialized Clarity `(response (optional principal) _)` as returned by
 * identity-registry-v2 `get-owner`:
 *   0x0709                    → (ok none)
 *   0x070a05<ver><hash160>    → (ok (some standard-principal))
 *   0x070a06<ver><hash160><len><name> → (ok (some contract-principal))
 * Anything else (incl. err) → unknown.
 */
export async function parseOwnerResult(hex: string): Promise<RegistryLookup> {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^([0-9a-f]{2})+$/i.test(h)) return { state: "unknown" };
  if (h === "0709") return { state: "none" };
  const b = hexToBytes(h);
  if (b[0] !== 0x07 || b[1] !== 0x0a) return { state: "unknown" };
  if (b[2] === 0x05 && b.length === 24) {
    return { state: "owner", owner: await c32Address(b[3], b.slice(4, 24)) };
  }
  if (b[2] === 0x06 && b.length >= 24) {
    const nameLen = b[24];
    if (b.length !== 25 + nameLen) return { state: "unknown" };
    const name = new TextDecoder().decode(b.slice(25, 25 + nameLen));
    return { state: "owner", owner: `${await c32Address(b[3], b.slice(4, 24))}.${name}` };
  }
  return { state: "unknown" };
}

export async function lookupRegistryOwner(env: Env, agentId: number): Promise<RegistryLookup> {
  const [contractAddr, contractName] = IDENTITY_CONTRACT.split(".");
  const arg = "0x01" + BigInt(agentId).toString(16).padStart(32, "0");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.HIRO_API_KEY) headers["x-api-key"] = env.HIRO_API_KEY;
  try {
    const res = await fetch(
      `${HIRO_API}/v2/contracts/call-read/${contractAddr}/${contractName}/get-owner`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ sender: contractAddr, arguments: [arg] }),
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      }
    );
    if (!res.ok) return { state: "unknown" };
    const json = (await res.json()) as { okay?: boolean; result?: string };
    if (!json.okay || typeof json.result !== "string") return { state: "unknown" };
    return await parseOwnerResult(json.result);
  } catch {
    return { state: "unknown" };
  }
}
