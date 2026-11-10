// One-time setup of Basalt, the AI tank, on testnet. Idempotent: re-running skips what exists.
//   pnpm setup:ai
// Creates basalt.<contract> (funded with 1 NEAR by the contract account) whose ONLY key is a
// function-call key for `play` and `mint_starter` on the contract, then mints its starter pack.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Account, KeyPair, KeyPairSigner, actions, type KeyPairString } from 'near-api-js';
import { AI_ACCOUNT, AI_METHODS } from './ai-account.ts';
import { call, provider, view } from './chain.ts';
import { config, privateKey } from './config.ts';

const credDir = join(homedir(), '.near-credentials', config.network);
mkdirSync(credDir, { recursive: true });
const NEAR = 10n ** 24n;

async function exists(id: string): Promise<boolean> {
  try { await provider.viewAccount({ accountId: id, finalityQuery: { finality: 'final' } } as never); return true; } catch { return false; }
}

const file = join(credDir, `${AI_ACCOUNT}.json`);
if (!(await exists(AI_ACCOUNT))) {
  if (existsSync(file)) throw new Error(`${file} exists but ${AI_ACCOUNT} doesn't; move the old key away first`);
  const kp = KeyPair.fromRandom('ed25519');
  writeFileSync(file, JSON.stringify({ account_id: AI_ACCOUNT, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  const parent = new Account(config.contract, provider, KeyPairSigner.fromSecretKey(privateKey(config.contract) as KeyPairString));
  const out = (await parent.signAndSendTransaction({
    receiverId: AI_ACCOUNT,
    actions: [
      actions.createAccount(),
      actions.transfer(NEAR),
      actions.addFunctionCallAccessKey(kp.getPublicKey(), config.contract, AI_METHODS, NEAR / 2n),
    ],
    waitUntil: 'EXECUTED_OPTIMISTIC',
  })) as unknown as { transaction: { hash: string } };
  console.log(`created ${AI_ACCOUNT} (function-call key for ${AI_METHODS.join(', ')} only) ${out.transaction.hash}`);
  await new Promise((r) => setTimeout(r, 2500));
} else console.log(`${AI_ACCOUNT} exists`);

if (!(await view<boolean>('has_starter', { account_id: AI_ACCOUNT }))) {
  const r = await call<string>(AI_ACCOUNT, 'mint_starter', {}, 30);
  console.log(`${AI_ACCOUNT} minted its starter pack ${r.value} ${r.tx}`);
} else console.log(`${AI_ACCOUNT} already has its starter pack`);
const packs = await view<{ token_id: string; metadata: { title: string } }[]>('nft_tokens_for_owner', { account_id: AI_ACCOUNT });
console.log(`packs: ${packs.map((p) => `${p.token_id} (${p.metadata.title})`).join(', ')}`);
console.log('done');
