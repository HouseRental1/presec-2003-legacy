import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fresh, as, pool, q } from './helpers.js';
import type { App } from '../src/app.js';

let app: App;
beforeAll(async () => { app = await fresh(); });
afterAll(async () => { await app.close(); });

describe('project lifecycle: phases, checklists and stage gates', () => {
  it('shows five phases in order, with execution under way in the sample', async () => {
    const l = (await (await as(app, 'ama')).get('/api/project/lifecycle')).json();
    expect(l.phases.map((p: any) => p.key)).toEqual(['initiation', 'planning', 'procurement', 'execution', 'closing']);
    expect(l.currentPhase).toBe('execution');
    expect(l.phases[0].gate_approved_by_name).toBeTruthy();
  });
  it('members can read but not change the project', async () => {
    const ama = await as(app, 'ama');
    expect((await ama.post('/api/project/deliverables', { phaseKey: 'execution', title: 'Sneaky item' })).statusCode).toBe(403);
    expect((await ama.post('/api/project/details', { name: 'Hacked' })).statusCode).toBe(403);
  });
  it('“done” needs evidence; a gate cannot be signed while items are open; signing opens the next phase', async () => {
    const nana = await as(app, 'nana'), akosua = await as(app, 'akosua');
    const items = (await nana.get('/api/project/lifecycle')).json().phases.find((p: any) => p.key === 'execution').deliverables;
    const first = items.find((d: any) => d.status !== 'done');
    expect((await nana.post(`/api/project/deliverables/${first.id}`, { status: 'done' })).statusCode).toBe(400);
    const blocked = await akosua.post('/api/project/phases/execution/gate', { note: 'Committee meeting 1 Dec' });
    expect(blocked.statusCode).toBe(409); expect(blocked.json().message).toMatch(/still open/);
    expect((await nana.post('/api/project/phases/execution/gate', { note: 'PM trying' })).statusCode).toBe(403);   // PM cannot sign off
    for (const d of items.filter((x: any) => x.status !== 'done'))
      expect((await nana.post(`/api/project/deliverables/${d.id}`, { status: 'done', evidence: 'Report filed in archive' })).statusCode).toBe(200);
    const ok = await akosua.post('/api/project/phases/execution/gate', { note: 'Committee meeting 1 Dec' });
    expect(ok.json()).toEqual({ closed: 'execution', opened: 'closing' });
    const after = (await nana.get('/api/project/lifecycle')).json();
    expect(after.currentPhase).toBe('closing');
    expect((await nana.post(`/api/project/deliverables/${first.id}`, { status: 'todo' })).statusCode).toBe(409); // signed-off phase is locked
  });
  it('reopening a phase is possible for the committee, in order, with a reason', async () => {
    const akosua = await as(app, 'akosua');
    expect((await akosua.post('/api/project/phases/procurement/reopen', { reason: 'test' })).statusCode).toBe(409); // later phase complete
    expect((await akosua.post('/api/project/phases/execution/reopen', { reason: 'Missed snag report' })).statusCode).toBe(200);
    const l = (await akosua.get('/api/project/lifecycle')).json();
    expect(l.phases.find((p: any) => p.key === 'execution').status).toBe('in_progress');
    expect(l.phases.find((p: any) => p.key === 'closing').status).toBe('not_started');
  });
  it('details, custom items, dates and public updates', async () => {
    const nana = await as(app, 'nana');
    expect((await nana.post('/api/project/details', { name: 'Legacy Project 1: six-unit classroom block', site: 'PRESEC Legon', plannedStart: '2026-06-01', plannedEnd: '2026-01-01' })).statusCode).toBe(400);
    expect((await nana.post('/api/project/details', { name: 'Legacy Project 1: six-unit classroom block', site: 'PRESEC Legon', description: 'Six classrooms.' })).statusCode).toBe(200);
    expect((await nana.post('/api/project/deliverables', { phaseKey: 'execution', title: 'Electrical certificate', owner: 'Nana', dueOn: '2026-12-01' })).statusCode).toBe(200);
    expect((await nana.post('/api/project/phases/closing/dates', { plannedStart: '2027-03-01', plannedEnd: '2027-05-01' })).statusCode).toBe(200);
    expect((await nana.post('/api/project/updates', { title: 'Roof sheets delivered', body: 'All 120 sheets on site.', public: true })).statusCode).toBe(200);
    const pub = (await app.inject({ method: 'GET', url: '/api/public' })).json();
    expect(pub.project.description).toBe('Six classrooms.');
    expect(pub.updates[0].title).toBe('Roof sheets delivered');
    expect(pub.phases).toHaveLength(5);
    const [{ n }] = await q<any>(pool, `SELECT count(*)::int n FROM audit_events WHERE action IN ('Signed off phase','Reopened phase','Updated project details','Posted project update')`);
    expect(n).toBeGreaterThanOrEqual(4);
  });
});
