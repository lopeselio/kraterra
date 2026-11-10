import { Account, FailoverRpcProvider, JsonRpcProvider, KeyPairSigner, actions, teraToGas, type KeyPairString } from 'near-api-js';
import { config, privateKey } from './config.ts';

// Contract calls. Each signer's calls run one after another so nonces never collide.

// several public testnet RPCs (docs.near.org/api/rpc/providers); on an error the next one is tried
const RPCS = [config.rpcUrl, 'https://rpc.testnet.fastnear.com', 'https://near-testnet.drpc.org', 'https://rpc.testnet.near.org', 'https://testnet-rpc.intea.rs'].filter((u, i, a) => a.indexOf(u) === i);
const provider = new FailoverRpcProvider(RPCS.map((url) => new JsonRpcProvider({ url })));
const accounts = new Map<string, Account>();
const queues = new Map<string, Promise<unknown>>();

function account(id: string): Account {
  let a = accounts.get(id);
  if (!a) {
    a = new Account(id, provider, KeyPairSigner.fromSecretKey(privateKey(id) as KeyPairString));
    accounts.set(id, a);
  }
  return a;
}

export interface CallResult<T> { value: T; tx: string }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const transient = (e: unknown): boolean => /fetch failed|ECONNRESET|ETIMEDOUT|timeout|503|502|429|InvalidNonce|Invalid nonce|Exceeded \d+ providers/i.test(String((e as Error)?.message ?? e));

/** Calls a method as `signer`. Returns the decoded return value and the transaction hash. */
export function call<T = unknown>(signer: string, method: string, args: object, gasTera = 60, depositYocto = 0n): Promise<CallResult<T>> {
  const once = async (): Promise<CallResult<T>> => {
    const outcome = await account(signer).signAndSendTransaction({
      receiverId: config.contract,
      actions: [functionCall(method, args, gasTera, depositYocto)],
      waitUntil: 'EXECUTED_OPTIMISTIC',
      throwOnFailure: false,
    });
    const o = outcome as unknown as { transaction: { hash: string }; status: { SuccessValue?: string; Failure?: unknown } };
    if (o.status && 'Failure' in o.status && o.status.Failure) throw new Error(`${method} failed: ${JSON.stringify(o.status.Failure).slice(0, 300)}`);
    const raw = o.status?.SuccessValue ? Buffer.from(o.status.SuccessValue, 'base64').toString('utf8') : '';
    return { value: (raw ? JSON.parse(raw) : undefined) as T, tx: o.transaction.hash };
  };
  const guarded = async (): Promise<CallResult<T>> => {
    for (let attempt = 0; ; attempt++) {
      try { return await once(); } catch (e) {
        if (attempt >= 4 || !transient(e)) throw e;
        // a stale nonce (another process used this key) can surface as any of these: start afresh
        accounts.delete(signer);
        await sleep(900 * (attempt + 1));
      }
    }
  };
  const run = (queues.get(signer) ?? Promise.resolve()).catch(() => undefined).then(guarded);
  queues.set(signer, run);
  return run;
}

const functionCall = (method: string, args: object, gasTera: number, deposit: bigint) =>
  actions.functionCall(method, args as Record<string, unknown>, teraToGas(gasTera), deposit);

export async function view<T>(method: string, args: object = {}): Promise<T> {
  return (await provider.callFunction({ contractId: config.contract, method, args: args as Record<string, unknown>, blockQuery: { finality: 'optimistic' } })) as T;
}

/** Full-access or function-call key info for (account, publicKey), or null if it isn't a key of that account. */
export async function accessKey(accountId: string, publicKey: string): Promise<{ permission: unknown } | null> {
  try {
    return (await provider.viewAccessKey({ accountId, publicKey, finalityQuery: { finality: 'optimistic' } })) as unknown as { permission: unknown };
  } catch { return null; }
}

export { provider };
