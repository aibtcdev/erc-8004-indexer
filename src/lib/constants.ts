/** ERC-8004 contract addresses by network */
export const CONTRACTS = {
  mainnet: {
    identity: "SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2",
    reputation: "SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.reputation-registry-v2",
    validation: "SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.validation-registry-v2",
  },
  testnet: {
    identity: "ST3YT0XW92E6T2FE59B2G5N2WNNFSBZ6MZKQS5D18.identity-registry-v2",
    reputation: "ST3YT0XW92E6T2FE59B2G5N2WNNFSBZ6MZKQS5D18.reputation-registry-v2",
    validation: "ST3YT0XW92E6T2FE59B2G5N2WNNFSBZ6MZKQS5D18.validation-registry-v2",
  },
} as const;

/** Default caller address for read-only contract calls */
export const BOOT_ADDRESS = {
  mainnet: "SP000000000000000000002Q6VF78",
  testnet: "ST000000000000000000002AMW42H",
} as const;

/** Stacks API base URLs */
export const STACKS_API = {
  mainnet: "https://api.hiro.so",
  testnet: "https://api.testnet.hiro.so",
} as const;

/** Application ID for logging */
export const APP_ID = "erc-8004-indexer";

/** Batch size for parallel agent fetching */
export const FETCH_BATCH_SIZE = 10;

/** Index metadata keys */
export const META_KEYS = {
  LAST_AGENT_ID: "last_agent_id",
  LAST_INDEX_RUN: "last_index_run",
  LAST_INDEX_SUMMARY: "last_index_summary",
} as const;
