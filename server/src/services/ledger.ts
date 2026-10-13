import { Db, q, invalid, Actor } from '../lib.js';

export const ACCOUNTS = {
  BANK: { name: 'Bank — project account', normal: 'debit' },
  CLEARING: { name: 'Payment provider clearing', normal: 'debit' },
  SUSPENSE: { name: 'Settlement differences under investigation', normal: 'debit' },
  INC_MEMBER: { name: 'Member contributions', normal: 'credit' },
  INC_DONOR: { name: 'Donations (non-member)', normal: 'credit' },
  EXP_FEES: { name: 'Transaction fees', normal: 'debit' },
  PROJECT_COST: { name: 'Classroom block costs', normal: 'debit' },
  RETENTION: { name: 'Retention payable to contractor', normal: 'credit' },
} as const;
export type Account = keyof typeof ACCOUNTS;

export interface Line { account: Account; debit?: number; credit?: number }

/**
 * Post one balanced transaction. The database refuses unbalanced or duplicate postings
 * (deferred balance trigger + UNIQUE(source_type, source_id, kind)).
 */
export async function postTxn(db: Db, t: {
  projectId: string; kind: string; sourceType: string; sourceId: string; date: string; memo: string;
  lines: Line[]; reversalOf?: string | null; actor: Actor | null;
}): Promise<string> {
  const lines = t.lines.filter((l) => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0);
  for (const l of lines) if (!Number.isInteger(l.debit ?? 0) || !Number.isInteger(l.credit ?? 0)) throw invalid('Ledger amounts must be whole pesewas.');
  const dr = lines.reduce((s, l) => s + (l.debit ?? 0), 0), cr = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
  if (dr !== cr || dr === 0) throw invalid(`Unbalanced posting (${dr} ≠ ${cr}).`);
  const [{ id }] = await q<{ id: string }>(db,
    `INSERT INTO ledger_transactions (project_id, kind, source_type, source_id, effective_date, memo, reversal_of, posted_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [t.projectId, t.kind, t.sourceType, t.sourceId, t.date, t.memo, t.reversalOf ?? null, t.actor?.userId ?? null]);
  for (const l of lines) {
    await db.query('INSERT INTO ledger_entries (txn_id, account, debit, credit) VALUES ($1,$2,$3,$4)', [id, l.account, l.debit ?? 0, l.credit ?? 0]);
  }
  return id;
}

/** Reverse a posted transaction exactly (swap debits and credits), optionally remapping accounts. */
export async function reverseTxn(db: Db, txnId: string, memo: string, actor: Actor, remap: Partial<Record<Account, Account>> = {}) {
  const [t] = await q<any>(db, 'SELECT * FROM ledger_transactions WHERE id=$1', [txnId]);
  const lines = await q<any>(db, 'SELECT account, debit, credit FROM ledger_entries WHERE txn_id=$1', [txnId]);
  return postTxn(db, {
    projectId: t.project_id, kind: 'reversal', sourceType: t.source_type, sourceId: t.source_id, date: new Date().toISOString().slice(0, 10), memo,
    reversalOf: txnId, actor,
    lines: lines.map((l) => ({ account: (remap[l.account as Account] ?? l.account) as Account, debit: l.credit, credit: l.debit })),
  });
}

/** Balance in the account's normal direction. */
export async function balance(db: Db | any, account: Account, projectId = 'P1'): Promise<number> {
  const [r] = await q<{ d: number; c: number }>(db,
    `SELECT coalesce(sum(e.debit),0) d, coalesce(sum(e.credit),0) c FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.txn_id
     WHERE e.account=$1 AND t.project_id=$2`, [account, projectId]);
  return ACCOUNTS[account].normal === 'debit' ? r.d - r.c : r.c - r.d;
}

export async function trialBalance(db: Db | any, projectId = 'P1') {
  const rows = await q<any>(db,
    `SELECT a.code, a.name, coalesce(sum(e.debit),0) debits, coalesce(sum(e.credit),0) credits
     FROM ledger_accounts a LEFT JOIN (
       SELECT e.* FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.txn_id WHERE t.project_id=$1
     ) e ON e.account=a.code
     GROUP BY a.code, a.name ORDER BY a.code`, [projectId]);
  const totalDr = rows.reduce((s, r) => s + r.debits, 0), totalCr = rows.reduce((s, r) => s + r.credits, 0);
  return { rows: rows.map((r) => ({ ...r, balance: (ACCOUNTS as any)[r.code].normal === 'debit' ? r.debits - r.credits : r.credits - r.debits })), totalDr, totalCr, balanced: totalDr === totalCr };
}
