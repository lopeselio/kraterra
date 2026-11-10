import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const env = (k: string, d = ''): string => process.env[k] ?? d;

export const config = {
  port: Number(env('PORT', '8841')),
  network: env('NEAR_NETWORK', 'testnet'),
  rpcUrl: env('NEAR_RPC_URL', 'https://test.rpc.fastnear.com'),
  contract: env('CONTRACT_ID', 'kraterra.testnet'),
  referee: env('REFEREE_ID', 'kraterra-ref.testnet'),
  /** pays gas for players' meta-transactions (NEP-366), relayed by better-near-auth */
  relayer: env('RELAYER_ID', 'kraterra-relay.testnet'),
  /** other origins allowed to talk to the auth endpoints (comma-separated) */
  extraOrigins: env('EXTRA_ORIGINS').split(',').map((x) => x.trim()).filter(Boolean),
  /** turn chain writes off (local play with no keys) */
  chainEnabled: env('CHAIN', '1') !== '0',
  webDist: env('WEB_DIST', join(import.meta.dirname, '../../web/dist')),
  dataDir: env('DATA_DIR', join(import.meta.dirname, '../../../data')),
  sessionSecret: env('SESSION_SECRET', 'dev-only-secret-change-me'),
  publicOrigin: env('PUBLIC_ORIGIN', 'http://localhost:5173'),
  nearAi: {
    apiKey: env('NEARAI_API_KEY') === 'none' ? '' : env('NEARAI_API_KEY'),
    baseUrl: env('NEARAI_BASE_URL', 'https://cloud-api.near.ai/v1'),
    model: env('NEARAI_MODEL', 'Qwen/Qwen3.6-35B-A3B-FP8'),
  },
};

// Hosted: keys come from one JSON env var {account: "ed25519:..."}; locally from ~/.near-credentials.
const hosted: Record<string, string> = (() => {
  try { return JSON.parse(env('NEAR_KEYS', '{}')) as Record<string, string>; } catch { return {}; }
})();

export function privateKey(account: string): string {
  if (hosted[account]) return hosted[account];
  const file = join(homedir(), '.near-credentials', config.network, `${account}.json`);
  try {
    return (JSON.parse(readFileSync(file, 'utf8')) as { private_key: string }).private_key;
  } catch {
    throw new Error(`no key for ${account} (set NEAR_KEYS or add ${file})`);
  }
}

export function hasKey(account: string): boolean {
  try { privateKey(account); return true; } catch { return false; }
}

export const explorerTx = (hash: string): string => `https://testnet.nearblocks.io/txns/${hash}`;
