/**
 * ERC-8004 event types derived from on-chain print events.
 *
 * Each event uses a discriminated union on the `notification` field,
 * which matches the string emitted by the Clarity contract (e.g.
 * "identity-registry/Registered"). The `payload` field contains the
 * event-specific data decoded from the Clarity repr string.
 *
 * WAD/i128 fields are typed as `string` to match how they are decoded
 * from Clarity repr (plain integer strings that may exceed Number.MAX_SAFE_INTEGER).
 * uint128 fields are also typed as `string` for consistency.
 */

// ============================================================
// identity-registry-v2 events
// ============================================================

/**
 * Emitted when a new agent identity is registered.
 * Notification: "identity-registry/Registered"
 */
export interface RegisteredEvent {
  notification: "identity-registry/Registered";
  payload: {
    /** uint128 — newly assigned agent ID */
    "agent-id": string;
    /** Stacks principal — initial owner */
    owner: string;
    /** UTF-8 token URI (may be empty string) */
    "token-uri": string;
    /** uint128 — number of metadata entries set during register-full */
    "metadata-count": string;
  };
}

/**
 * Emitted when a metadata key is set or updated for an agent.
 * Notification: "identity-registry/MetadataSet"
 */
export interface MetadataSetEvent {
  notification: "identity-registry/MetadataSet";
  payload: {
    /** uint128 */
    "agent-id": string;
    /** UTF-8 metadata key */
    key: string;
    /** uint128 — byte length of the stored value */
    "value-len": string;
  };
}

/**
 * Emitted when an agent's token URI is updated via set-agent-uri.
 * Notification: "identity-registry/UriUpdated"
 */
export interface UriUpdatedEvent {
  notification: "identity-registry/UriUpdated";
  payload: {
    /** uint128 */
    "agent-id": string;
    /** New UTF-8 URI */
    "new-uri": string;
  };
}

/**
 * Emitted when an approval-for-all is granted or revoked.
 * Notification: "identity-registry/ApprovalForAll"
 */
export interface ApprovalForAllEvent {
  notification: "identity-registry/ApprovalForAll";
  payload: {
    /** uint128 */
    "agent-id": string;
    /** Stacks principal — the approved/revoked operator */
    operator: string;
    /** true = approved, false = revoked */
    approved: boolean;
  };
}

/**
 * Emitted when an agent NFT is transferred.
 * Notification: "identity-registry/Transfer"
 */
export interface TransferEvent {
  notification: "identity-registry/Transfer";
  payload: {
    /** uint128 — token ID (same as agent ID) */
    "token-id": string;
    /** Stacks principal — previous owner */
    sender: string;
    /** Stacks principal — new owner */
    recipient: string;
  };
}

// ============================================================
// reputation-registry-v2 events
// ============================================================

/**
 * Emitted when new feedback is submitted for an agent.
 * Notification: "reputation-registry/NewFeedback"
 */
export interface NewFeedbackEvent {
  notification: "reputation-registry/NewFeedback";
  payload: {
    /** uint128 */
    "agent-id": string;
    /** Stacks principal — feedback giver */
    client: string;
    /** uint128 — per-client feedback index */
    index: string;
    /** int128 as string — raw feedback value */
    value: string;
    /** uint128 as string — decimal precision of raw value */
    "value-decimals": string;
    tag1: string;
    tag2: string;
    endpoint: string;
    "feedback-uri": string;
    /** hex-encoded 32-byte hash */
    "feedback-hash": string;
  };
}

/**
 * Emitted when a feedback entry is revoked by the original submitter.
 * Notification: "reputation-registry/FeedbackRevoked"
 */
export interface FeedbackRevokedEvent {
  notification: "reputation-registry/FeedbackRevoked";
  payload: {
    /** uint128 */
    "agent-id": string;
    /** Stacks principal */
    client: string;
    /** uint128 — the index being revoked */
    index: string;
  };
}

/**
 * Emitted when an agent appends a response to a feedback entry.
 * Notification: "reputation-registry/ResponseAppended"
 */
export interface ResponseAppendedEvent {
  notification: "reputation-registry/ResponseAppended";
  payload: {
    /** uint128 */
    "agent-id": string;
    /** Stacks principal — original feedback giver */
    client: string;
    /** uint128 — feedback index being responded to */
    index: string;
    /** Stacks principal — the responder (agent owner or delegate) */
    responder: string;
    "response-uri": string;
    /** hex-encoded 32-byte hash */
    "response-hash": string;
  };
}

/**
 * Emitted when an agent approves a client for signed feedback.
 * Notification: "reputation-registry/ClientApproved"
 */
export interface ClientApprovedEvent {
  notification: "reputation-registry/ClientApproved";
  payload: {
    /** uint128 */
    "agent-id": string;
    /** Stacks principal */
    client: string;
    /** uint128 as string — maximum feedback index this client may submit */
    "index-limit": string;
  };
}

// ============================================================
// validation-registry-v2 events
// ============================================================

/**
 * Emitted when an agent submits a validation request to a validator.
 * Notification: "validation-registry/ValidationRequest"
 */
export interface ValidationRequestEvent {
  notification: "validation-registry/ValidationRequest";
  payload: {
    /** Stacks principal — the validator being requested */
    validator: string;
    /** uint128 */
    "agent-id": string;
    /** hex-encoded 32-byte hash — primary key for this request */
    "request-hash": string;
    "request-uri": string;
  };
}

/**
 * Emitted when a validator submits a response to a validation request.
 * Notification: "validation-registry/ValidationResponse"
 */
export interface ValidationResponseEvent {
  notification: "validation-registry/ValidationResponse";
  payload: {
    /** hex-encoded 32-byte hash — matches the original request */
    "request-hash": string;
    /** uint128 as string — response score/enum */
    response: string;
    /** UTF-8 tag categorizing the validation */
    tag: string;
    "response-uri": string;
    /** hex-encoded 32-byte hash */
    "response-hash": string;
  };
}

// ============================================================
// Union type
// ============================================================

/**
 * Discriminated union of all ERC-8004 event types.
 * Discriminated on the `notification` field.
 */
export type Erc8004Event =
  | RegisteredEvent
  | MetadataSetEvent
  | UriUpdatedEvent
  | ApprovalForAllEvent
  | TransferEvent
  | NewFeedbackEvent
  | FeedbackRevokedEvent
  | ResponseAppendedEvent
  | ClientApprovedEvent
  | ValidationRequestEvent
  | ValidationResponseEvent;

/**
 * All valid ERC-8004 notification strings.
 * Useful for runtime matching against the `notification` field.
 */
export type Erc8004Notification = Erc8004Event["notification"];

export const ERC8004_NOTIFICATIONS: readonly Erc8004Notification[] = [
  "identity-registry/Registered",
  "identity-registry/MetadataSet",
  "identity-registry/UriUpdated",
  "identity-registry/ApprovalForAll",
  "identity-registry/Transfer",
  "reputation-registry/NewFeedback",
  "reputation-registry/FeedbackRevoked",
  "reputation-registry/ResponseAppended",
  "reputation-registry/ClientApproved",
  "validation-registry/ValidationRequest",
  "validation-registry/ValidationResponse",
] as const;
