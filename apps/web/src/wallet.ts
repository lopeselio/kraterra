import { createAuthClient } from 'better-auth/client';
import { siwnClient } from 'better-near-auth/client';

// Sign in with a NEAR wallet through Better Auth's better-near-auth plugin (SIWN, NEP-413).
// NEAR Connect shows the wallet picker (HOT, Meteor, Intear, MyNearWallet, …); the wallet signs
// "Sign in to <this host>"; the server checks it and sets an HttpOnly session cookie.
//
// Player transactions (claiming a starter munition pack) are NEP-366 meta-transactions:
// the wallet signs a delegate action and the game's relayer pays the gas. If a wallet can't sign
// delegate actions, the same call goes out as an ordinary transaction from the wallet instead.

let contract = 'kraterra.testnet';
export function setContract(id: string): void { contract = id; }

let client: ReturnType<typeof makeClient> | null = null;
function makeClient() {
  const host = location.host;
  return createAuthClient({
    baseURL: location.origin,
    basePath: '/api/ba',
    plugins: [siwnClient({ recipients: { testnet: host, mainnet: host }, networkId: 'testnet' })],
  });
}
const authClient = () => (client ??= makeClient());

/** Open the wallet picker, sign the sign-in message, start a session. Returns the account. */
export async function signIn(): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    void authClient().signIn.near({
      onSuccess: () => resolve(),
      onError: (e: Error) => reject(new Error(e?.message || 'the wallet didn’t sign')),
    }).catch(reject);
  });
  const r = (await authClient().getSession()) as { data?: { user?: { nearAccount?: { accountId?: string } } } | null };
  const account = r.data?.user?.nearAccount?.accountId ?? authClient().near.getAccountId();
  if (!account) throw new Error('Signed in, but no NEAR account came back. Try again.');
  return account;
}

export async function signOut(): Promise<void> {
  try { await authClient().signOut(); } catch { /* cookie may already be gone */ }
  try { await authClient().near.disconnect(); } catch { /* not connected */ }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Make sure the wallet is connected in this tab (a session cookie can outlive the wallet connection). */
async function ensureWallet(): Promise<void> {
  const near = authClient().near;
  if (near.isWalletConnected()) return;
  if (await near.ensureConnected().catch(() => false)) return;
  throw new Error('Reconnect your wallet: sign out and sign in again.');
}

/**
 * A contract call from the signed-in player. Gasless through the relayer when the wallet can sign a
 * delegate action; otherwise a normal transaction (the wallet pays a tiny testnet fee).
 * Returns the transaction hash. Return values come back through /api/me, not here.
 */
export async function call(method: string, args: object): Promise<{ tx: string; gasless: boolean }> {
  await ensureWallet();
  const near = authClient().near;
  try {
    const payload = await near.buildSignedDelegateAction(contract, (b, receiverId) =>
      b.functionCall(receiverId, method, args, { gas: '50 Tgas', attachedDeposit: '0 yocto' }));
    const r = await near.relayTransaction({ payload });
    if (r.error || !r.data) throw new Error(r.error?.message ?? 'the relayer refused the transaction');
    const tx = r.data.txHash;
    for (let k = 0; k < 20; k++) {
      const st = await near.getRelayStatus(tx);
      if (st.data?.status === 'completed') return { tx, gasless: true };
      if (st.data?.status === 'failed') throw new Error(failure(st.data.outcome) ?? `the transaction failed (${tx.slice(0, 10)}…)`);
      await sleep(1500);
    }
    return { tx, gasless: true };
  } catch (e) {
    // a refusal from the contract is final; only fall back when the wallet can't do delegate actions
    const msg = (e as Error).message ?? '';
    if (/panicked|failed \(|refused/i.test(msg)) throw e;
    const out = (await near.getNearClient().call(contract, method, args, { gas: '50 Tgas', attachedDeposit: '0 yocto' })) as { transaction?: { hash: string }; status?: { Failure?: unknown } };
    if (out?.status && 'Failure' in out.status && out.status.Failure) throw new Error(failure(out) ?? 'the transaction failed');
    return { tx: out?.transaction?.hash ?? '', gasless: false };
  }
}

function failure(outcome: unknown): string | undefined {
  const m = /panicked at[^"]*?: ?([^"\\]+)|Smart contract panicked: ([^"\\]+)/.exec(JSON.stringify(outcome ?? ''));
  return m?.[1] ?? m?.[2];
}
