import { ReactNode, useState } from 'react';
import { api } from './api';
import { useToast } from './ui';

export type Field = { name: string; label: string; type?: 'text' | 'number' | 'date' | 'datetime-local' | 'email' | 'password' | 'textarea' | 'select' | 'checkbox' | 'file'; options?: [string, string][]; value?: any; required?: boolean; hint?: string; accept?: string };

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
          {f.type === 'textarea' ? <textarea rows={5} {...common} /> : f.type === 'select' ? <select {...common}>{f.options!.map(([val, l]) => <option key={val} value={val}>{l}</option>)}</select>
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
