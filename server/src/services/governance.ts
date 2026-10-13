import { z } from 'zod';
import { Actor, Db, q, one, need, audit, notify, forbid, conflict, today } from '../lib.js';
import { applyVotedVariation } from './project.js';

export const ProposalInput = z.object({
  title: z.string().min(5), description: z.string().min(5), threshold: z.enum(['simple', 'two_thirds']),
  quorumPct: z.number().min(0).max(100), opensOn: z.string(), closesOn: z.string(),
  linkedType: z.enum(['variation', 'rules']).optional(), linkedId: z.string().optional(),
});
export async function createProposal(db: Db, actor: Actor, input: z.infer<typeof ProposalInput>) {
  need(actor, 'gov.manage', 'create ballots');
  const [{ n }] = await q<any>(db, 'SELECT count(*)::int n FROM proposals');
  const [{ eligible }] = await q<any>(db, 'SELECT count(*)::int eligible FROM members WHERE verified_at IS NOT NULL');
  const id = `P${n + 1}`;
  await db.query(`INSERT INTO proposals (id, title, description, threshold, quorum_bp, opens_on, closes_on, status, eligible_count, linked_type, linked_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8,$9,$10)`, [id, input.title, input.description, input.threshold, Math.round(input.quorumPct * 100), input.opensOn, input.closesOn, eligible, input.linkedType ?? null, input.linkedId ?? null]);
  if (input.linkedType === 'variation') await db.query('UPDATE variations SET proposal_id=$2 WHERE id=$1', [input.linkedId, id]);
  await notify(db, 'all', ['in_app', 'email', 'sms'], `Ballot ${id} is open: ${input.title}. Voting closes ${input.closesOn}.`);
  await audit(db, actor, 'Opened ballot', id, input.title);
  return { id, eligible };
}

/**
 * Secret ballot: the voter roll records THAT a member voted (date only); the ballot box records
 * WHAT was chosen with a random token and no member reference or timestamp. Both rows are written
 * in one transaction, so a vote is never counted without its roll entry and vice-versa.
 */
export async function castVote(db: Db, actor: Actor, proposalId: string, choice: 'yes' | 'no' | 'abstain') {
  need(actor, 'vote', 'vote');
  if (!actor.memberId) throw forbid('Only members can vote.');
  const m = await one<any>(db, 'SELECT verified_at FROM members WHERE id=$1', [actor.memberId]);
  if (!m.verified_at) throw forbid('Only verified members can vote.');
  const p = await one<any>(db, 'SELECT * FROM proposals WHERE id=$1 FOR SHARE', [proposalId]);
  const d = today();
  if (p.status !== 'open' || d < p.opens_on || d > p.closes_on) throw conflict('This ballot is not open.');
  try {
    await db.query('INSERT INTO voter_roll (proposal_id, member_id, voted_on) VALUES ($1,$2,$3)', [proposalId, actor.memberId, d]);
  } catch (e: any) { if (e.code === '23505') throw conflict('You have already voted on this ballot.'); throw e; }
  const [{ token }] = await q<any>(db, 'INSERT INTO ballots (proposal_id, choice) VALUES ($1,$2) RETURNING token', [proposalId, choice]);
  await audit(db, actor, 'Cast a vote', proposalId, 'choice not recorded');
  return { token };
}

export async function closeBallot(db: Db, actor: Actor, proposalId: string) {
  need(actor, 'gov.manage', 'close ballots');
  const p = await one<any>(db, 'SELECT * FROM proposals WHERE id=$1 FOR UPDATE', [proposalId]);
  if (p.status !== 'open') throw conflict('Ballot already closed.');
  const [c] = await q<any>(db, `SELECT count(*) FILTER (WHERE choice='yes')::int yes, count(*) FILTER (WHERE choice='no')::int no,
      count(*) FILTER (WHERE choice='abstain')::int abstain, count(*)::int total FROM ballots WHERE proposal_id=$1`, [proposalId]);
  const [{ roll }] = await q<any>(db, 'SELECT count(*)::int roll FROM voter_roll WHERE proposal_id=$1', [proposalId]);
  if (roll !== c.total) throw conflict(`Integrity check failed: ${roll} on the roll but ${c.total} ballots.`);
  let result: 'passed' | 'not_passed' | 'no_quorum';
  if (roll * 10000 < p.quorum_bp * p.eligible_count) result = 'no_quorum';
  else {
    const decided = c.yes + c.no;
    result = p.threshold === 'two_thirds' ? (c.yes * 3 >= decided * 2 && decided > 0 ? 'passed' : 'not_passed') : (c.yes > c.no ? 'passed' : 'not_passed');
  }
  await db.query(`UPDATE proposals SET status='closed', result=$2, closed_by=$3, yes_count=$4, no_count=$5, abstain_count=$6 WHERE id=$1`, [proposalId, result, actor.userId, c.yes, c.no, c.abstain]);
  if (p.linked_type === 'variation') await applyVotedVariation(db, p.linked_id, result === 'passed', proposalId);
  if (p.linked_type === 'rules') await db.query(`UPDATE competition_rules SET status=$2, approved_by=$3 WHERE version=$1 AND status='draft'`, [p.linked_id, result === 'passed' ? 'in_force' : 'rejected', `Member vote ${proposalId} (${result})`]);
  await notify(db, 'all', ['in_app', 'email'], `Ballot ${proposalId} result: ${result.replace('_', ' ')}.`);
  await audit(db, actor, 'Closed ballot and counted', proposalId, `${result} · turnout ${roll}/${p.eligible_count} · yes ${c.yes} no ${c.no} abstain ${c.abstain}`);
  return { result, ...c, turnout: roll };
}

export async function listProposals(db: Db | any, actor: Actor) {
  if (!actor.memberId && !actor.roles.includes('committee')) throw forbid('Voting is for members.');
  return q(db, `SELECT p.id, p.title, p.description, p.threshold, p.quorum_bp, p.opens_on, p.closes_on, p.status, p.result, p.eligible_count, p.linked_type, p.linked_id,
      (SELECT count(*)::int FROM voter_roll v WHERE v.proposal_id=p.id) turnout,
      EXISTS (SELECT 1 FROM voter_roll v WHERE v.proposal_id=p.id AND v.member_id=$1) i_voted,
      CASE WHEN p.status='closed' THEN p.yes_count END yes, CASE WHEN p.status='closed' THEN p.no_count END no, CASE WHEN p.status='closed' THEN p.abstain_count END abstain
    FROM proposals p ORDER BY p.opens_on DESC`, [actor.memberId]);
}
