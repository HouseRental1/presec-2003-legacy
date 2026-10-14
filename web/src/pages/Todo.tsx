import { Link } from 'react-router-dom';
import { useLoad } from '../ui';

/** What is waiting for this administrator right now, and (while the platform is new) the steps to get it ready. */
export function AdminTodo({ compact = false }: { compact?: boolean }) {
  const t = useLoad<any>('/todo');
  if (!t.data) return null;
  const x = t.data, s = x.setup;
  const items: [number, string, string][] = ([
    [x.signups, ['sign-up request', 'sign-up requests'], '/admin'],
    [x.toVerify, ['payment to verify', 'payments to verify'], '/money'],
    [x.exceptions, ['unmatched payment', 'unmatched payments'], '/money'],
    [x.reversals, ['reversal to confirm', 'reversals to confirm'], '/money'],
    [x.toApprove, ['payment out to approve', 'payments out to approve'], '/money'],
    [x.toRelease, ['approved payment to release', 'approved payments to release'], '/money'],
  ] as [number, [string, string], string][]).filter(([n]) => n > 0).map(([n, [one, many], to]) => [n, n === 1 ? one : many, to]);
  const steps: [boolean, string, string][] = [
    [s.onRegister, 'Add yourself to your house', '/houses'],
    [s.projectDescribed, 'Describe the classroom block project', '/project'],
    [s.classmates >= 10, 'Bring in classmates (approve sign-ups or import the register)', '/admin'],
    [s.superAdmins >= 2, 'Appoint a second super admin, e.g. the treasurer', '/admin'],
    [s.houseProfiles >= 1, 'Write the house profiles (motto, story)', '/houses'],
    [s.competition, 'Open the house competition', '/admin'],
    [s.paystack, 'Connect Paystack for card and mobile money', '/admin'],
    [s.mfaOn, 'Turn on two-factor sign-in for admins', '/profile'],
  ];
  const left = steps.filter(([ok]) => !ok);
  if (compact && !items.length && !left.length) return null;
  return <div className={'todo ' + (compact ? 'compact' : '')}>
    {items.length > 0 ? <div className="card stack" style={{ gap: 8 }}>
      <h2 style={{ margin: 0 }}>Waiting for you</h2>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>{items.map(([n, label, to]) => <Link key={label} to={to} className="chip"><b className="num">{n}</b> {label}</Link>)}</div>
    </div> : !compact && <div className="card"><p className="small muted" style={{ margin: 0 }}>Nothing is waiting for you. New sign-ups, payments to verify and approvals will appear here.</p></div>}
    {left.length > 0 && <div className="card stack setup" style={{ gap: 8 }}>
      <div className="row between"><h2 style={{ margin: 0 }}>Getting the platform ready</h2><span className="small muted">{steps.length - left.length} of {steps.length} done</span></div>
      <ol className="steps">{steps.map(([ok, label, to]) => <li key={label} className={ok ? 'done' : ''}>{ok ? <s>{label}</s> : <Link to={to}>{label}</Link>}</li>)}</ol>
    </div>}
  </div>;
}
