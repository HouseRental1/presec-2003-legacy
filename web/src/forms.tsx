import { ReactNode, useEffect, useRef, useState } from 'react';
import { api, HOUSE_NAME } from './api';
import { useToast } from './ui';

export type Field = { name: string; label: string; type?: 'member' | 'text' | 'number' | 'date' | 'datetime-local' | 'email' | 'password' | 'textarea' | 'select' | 'checkbox' | 'file'; options?: [string, string][]; value?: any; required?: boolean; hint?: string; accept?: string; house?: string };

/** A small dialog form. onSubmit receives typed values; the server's message is shown on failure. */
export function FormDialog({ title, fields, submit, onSubmit, onClose, intro }: { title: string; fields: Field[]; submit: string; onSubmit: (v: Record<string, any>) => Promise<unknown>; onClose: () => void; intro?: ReactNode }) {
  const [v, setV] = useState<Record<string, any>>(Object.fromEntries(fields.map((f) => [f.name, f.value ?? (f.type === 'checkbox' ? false : '')])));
  const [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const toast = useToast();
  const go = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    const out: Record<string, any> = {};
    for (const f of fields) out[f.name] = f.type === 'number' ? (v[f.name] === '' ? undefined : Number(v[f.name])) : v[f.name] === '' ? undefined : v[f.name];
    try { await onSubmit(out); onClose(); } catch (x) { setErr((x as Error).message); toast((x as Error).message, true); } finally { setBusy(false); }
  };
  return <div className="sheet-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
    <form className="sheet" role="dialog" aria-modal="true" aria-label={title} onSubmit={go}>
      <div className="row between"><h2>{title}</h2><button type="button" className="btn sm" onClick={onClose}>Close</button></div>
      {intro}
      <div className="fgrid">{fields.map((f) => {
        const id = 'f_' + f.name;
        const common = { id, required: f.required, value: f.type === 'file' || f.type === 'checkbox' ? undefined : v[f.name], onChange: (e: any) => setV({ ...v, [f.name]: f.type === 'checkbox' ? e.target.checked : f.type === 'file' ? e.target.files?.[0] : e.target.value }) };
        return <label key={f.name} className="f" htmlFor={id} style={f.type === 'textarea' ? { gridColumn: '1 / -1' } : undefined}>{f.label}
          {f.type === 'member' ? <MemberPicker id={id} value={v[f.name]} house={f.house} required={f.required} onChange={(no) => setV((cur) => ({ ...cur, [f.name]: no }))} /> :
           f.type === 'textarea' ? <textarea rows={5} {...common} /> : f.type === 'select' ? <select {...common}>{f.options!.map(([val, l]) => <option key={val} value={val}>{l}</option>)}</select>
            : f.type === 'checkbox' ? <input type="checkbox" id={id} checked={!!v[f.name]} onChange={common.onChange} style={{ width: 'auto' }} />
            : <input type={f.type ?? 'text'} step={f.type === 'number' ? 'any' : undefined} accept={f.accept} {...common} />}
          {f.hint && <span className="def">{f.hint}</span>}</label>;
      })}</div>
      {err && <div className="callout bad">{err}</div>}
      <div className="row" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy}>{busy ? 'Saving…' : submit}</button></div>
    </form></div>;
}

/** Hook: const [dialog, open] = useDialog(); open({...}) — render {dialog} somewhere in the page. */
export function useDialog(): [ReactNode, (d: Omit<Parameters<typeof FormDialog>[0], 'onClose'>) => void] {
  const [d, setD] = useState<Omit<Parameters<typeof FormDialog>[0], 'onClose'> | null>(null);
  return [d ? <FormDialog {...d} onClose={() => setD(null)} /> : null, setD];
}

/** Shrink photos before upload (max 1600px, JPEG ~80%) so they work on slow connections. PDFs pass through. */
export async function uploadFile(file: File, kind: string, linked?: { type: string; id: string }): Promise<string> {
  let mime = file.type, blob: Blob = file;
  if (file.type.startsWith('image/')) {
    const img = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/jpeg', 0.8)); mime = 'image/jpeg';
  } else if (file.type !== 'application/pdf') throw new Error('Upload a photo (JPEG, PNG, WebP) or a PDF.');
  if (blob.size > 3_000_000) throw new Error('That file is larger than 3 MB.');
  const dataBase64 = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(blob); });
  const out = await api.post<{ id: string }>('/files', { kind, fileName: file.name.replace(/\.\w+$/, '') + (mime === 'image/jpeg' ? '.jpg' : '.pdf'), mime, dataBase64, linkedType: linked?.type, linkedId: linked?.id });
  return out.id;
}

/** Download a CSV export through the session (the browser saves it). */
export async function downloadCsv(name: string) {
  const res = await fetch('/api/exports/' + name, { credentials: 'include' });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? 'Export failed.');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a'); a.href = url; a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(url);
}

export type Invite = { name: string; link: string; delivery?: { email: boolean; sms: boolean } };
/** Shows a classmate's invitation link so an administrator can copy it or share it on WhatsApp. */
export function InviteSheet({ invite, onClose }: { invite: Invite; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const sent = invite.delivery?.email || invite.delivery?.sms;
  const msg = `Hello ${invite.name.split(' ')[0]}, you are invited to the PRESEC Ɔdadeɛ 2003 Legacy platform. Set your password here (valid 14 days): ${invite.link}`;
  const copy = async () => { try { await navigator.clipboard.writeText(invite.link); setCopied(true); } catch { (document.getElementById('invlink') as HTMLInputElement | null)?.select(); } };
  return <div className="sheet-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
    <div className="sheet stack" role="dialog" aria-modal="true" aria-label="Invitation link">
      <div className="row between"><h2>Invitation for {invite.name}</h2><button type="button" className="btn sm" onClick={onClose}>Close</button></div>
      <p className="small">{sent ? 'It has also been sent by ' + [invite.delivery?.email && 'email', invite.delivery?.sms && 'SMS'].filter(Boolean).join(' and ') + '.' : 'Email and SMS are not connected yet, so nothing was sent. Share this link with them yourself.'} They open it, choose a password, then sign in with their email. The link works once and expires in 14 days.</p>
      <input id="invlink" readOnly value={invite.link} onFocus={(e) => e.target.select()} className="mono" />
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn primary" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</button>
        <a className="btn" href={`https://wa.me/?text=${encodeURIComponent(msg)}`} target="_blank" rel="noreferrer">Share on WhatsApp</a>
      </div>
      <p className="def">Keep this link private: whoever opens it first can set the password for this account.</p>
    </div></div>;
}

/** Searchable classmate picker: type part of a name, number, city or job and choose from the register. Value is the member number. */
export function MemberPicker({ id, value, onChange, house = '', required, placeholder = 'Start typing a name or number' }: { id?: string; value: string; onChange: (memberNo: string, m?: any) => void; house?: string; required?: boolean; placeholder?: string }) {
  const [text, setText] = useState(''), [open, setOpen] = useState(false), [rows, setRows] = useState<any[]>([]), [hi, setHi] = useState(0), [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<any>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!value) { setPicked(null); } }, [value]);
  useEffect(() => {
    if (!open) return;
    let stop = false; setLoading(true);
    const t = setTimeout(() => api.get<any>(`/members?q=${encodeURIComponent(text.trim())}&house=${house}`).then((r) => { if (!stop) { setRows(r.rows); setHi(0); } }).catch(() => !stop && setRows([])).finally(() => !stop && setLoading(false)), 180);
    return () => { stop = true; clearTimeout(t); };
  }, [text, open, house]);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close); return () => document.removeEventListener('mousedown', close);
  }, []);
  const choose = (m: any) => { setPicked(m); setText(''); setOpen(false); onChange(m.member_no, m); };
  const listId = (id ?? 'mp') + '-list';
  if (picked && value === picked.member_no) return <div className="picked">
    <span><b>{picked.full_name}</b> <span className="mono small">{picked.member_no}</span> <span className="muted small">· {HOUSE_NAME[picked.house_id] ?? ''}{picked.city ? ' · ' + picked.city : ''}</span></span>
    <button type="button" className="btn sm" onClick={() => { setPicked(null); onChange(''); setOpen(true); }}>Change</button></div>;
  return <div className="picker" ref={box}>
    <input id={id} role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" autoComplete="off" required={required && !value} placeholder={placeholder}
      value={text} onFocus={() => setOpen(true)} onChange={(e) => { setText(e.target.value); setOpen(true); if (value) onChange(''); }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, rows.length - 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
        else if (e.key === 'Enter' && open && rows[hi]) { e.preventDefault(); choose(rows[hi]); }
        else if (e.key === 'Escape') setOpen(false);
      }} />
    {open && <ul id={listId} role="listbox" className="picker-list">
      {rows.map((m, i) => <li key={m.member_no} role="option" aria-selected={i === hi} className={i === hi ? 'on' : ''} onMouseEnter={() => setHi(i)} onMouseDown={(e) => { e.preventDefault(); choose(m); }}>
        <b>{m.full_name}</b> <span className="mono small">{m.member_no}</span><div className="muted small">{HOUSE_NAME[m.house_id] ?? ''}{m.city ? ' · ' + m.city : ''}{m.profession ? ' · ' + m.profession : ''}</div></li>)}
      {!rows.length && <li className="muted small" aria-disabled="true">{loading ? 'Searching…' : text ? 'No classmate matches. Check the spelling, or add them on the Houses page.' : 'No classmates on the register yet.'}</li>}
    </ul>}
  </div>;
}
