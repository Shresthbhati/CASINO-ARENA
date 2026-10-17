// @vitest-environment node
/**
 * CASINO ARENA - moderation baseline: reports, who may see and act on them, and chat safety.
 *
 * Every test names a boundary: who may do what, to whom, how often, and what is stored.
 */
import { describe, expect, it } from 'vitest';
import { PartyServer } from '../server';
import type { Command, PartyView } from '../types';

interface Who {
  readonly code: string;
  readonly id: string;
  readonly token: string;
  readonly name: string;
}
type Input = Command extends infer C ? (C extends { id: string } ? Omit<C, 'id'> & { id?: string } : never) : never;
let uid = 0;

function lobby(names = ['Ada', 'Bo', 'Cy', 'Di', 'Ed']) {
  const clock = { t: 5_000_000 };
  let snap = '';
  const server: PartyServer = new PartyServer({
    now: () => clock.t,
    persist: () => {
      snap = JSON.stringify(server.exportState());
    },
  });
  const c = server.createParty(names[0] as string);
  if (!c.ok) throw new Error(c.message);
  const people: Who[] = [{ code: c.code, id: c.memberId, token: c.token, name: names[0] as string }];
  for (const n of names.slice(1)) {
    const j = server.join(c.code, n);
    if (!j.ok) throw new Error(j.message);
    people.push({ code: j.code, id: j.memberId, token: j.token, name: n });
  }
  for (const w of people) server.attach(w.code, w.id, w.token, () => undefined);
  const send = (w: Who, cmd: Input) => server.command(w.code, w.id, w.token, { ...cmd, id: cmd.id ?? `m${(uid += 1)}` } as Command);
  const view = (w: Who): PartyView => (server.viewFor(w.code, w.id, w.token) as { ok: true; view: PartyView }).view;
  return { server, people, clock, send, view, snap: () => snap };
}

describe('filing a report', () => {
  it('stores a structured record: who, whom, why, when, and a status', () => {
    const { people, send, view } = lobby();
    const [a, b, c] = people as [Who, Who, Who];
    expect(send(b, { type: 'report', memberId: c.id, reason: '  spamming   the chat  ' }).ok).toBe(true);
    expect(view(a).reports).toEqual([
      { id: 1, at: expect.any(Number), reporterId: b.id, reporterName: 'Bo', targetId: c.id, targetName: 'Cy', reason: 'spamming the chat', status: 'open' },
    ]);
  });

  it('validates: unknown member, yourself, empty, control characters, too long', () => {
    const { people, send } = lobby();
    const [, b, c] = people as [Who, Who, Who];
    expect(send(b, { type: 'report', memberId: 'm_nobody', reason: 'x' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(send(b, { type: 'report', memberId: b.id, reason: 'me' })).toMatchObject({ ok: false, code: 'INVALID' });
    expect(send(b, { type: 'report', memberId: c.id, reason: '   ' })).toMatchObject({ ok: false, code: 'INVALID' });
    expect(send(b, { type: 'report', memberId: c.id, reason: '\u0000\u0007' })).toMatchObject({ ok: false, code: 'INVALID' });
    expect(send(b, { type: 'report', memberId: c.id, reason: 'x'.repeat(201) })).toMatchObject({ ok: false, code: 'INVALID' });
    expect(send(b, { type: 'report', memberId: c.id, reason: 'x'.repeat(5_000) })).toMatchObject({ ok: false, code: 'INVALID' });
    expect(send(b, { type: 'report', memberId: 42 as unknown as string, reason: 'x' })).toMatchObject({ ok: false });
  });

  it('allows one open report per reporter per target', () => {
    const { people, send } = lobby();
    const [, b, c] = people as [Who, Who, Who];
    expect(send(b, { type: 'report', memberId: c.id, reason: 'first' }).ok).toBe(true);
    expect(send(b, { type: 'report', memberId: c.id, reason: 'again' })).toMatchObject({ ok: false, code: 'DUPLICATE' });
  });

  it('rate limits reports: three, then wait; one comes back each minute', () => {
    const { people, send, clock } = lobby();
    const [a, b, c, d, e] = people as [Who, Who, Who, Who, Who];
    for (const t of [a, c, d]) expect(send(b, { type: 'report', memberId: t.id, reason: 'x' }).ok).toBe(true);
    expect(send(b, { type: 'report', memberId: e.id, reason: 'x' })).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    clock.t += 61_000;
    expect(send(b, { type: 'report', memberId: e.id, reason: 'x' }).ok).toBe(true);
  });

  it('a retried report is applied once', () => {
    const { people, send, view } = lobby();
    const [a, b, c] = people as [Who, Who, Who];
    send(b, { type: 'report', id: 'same', memberId: c.id, reason: 'x' });
    expect(send(b, { type: 'report', id: 'same', memberId: c.id, reason: 'x' })).toMatchObject({ ok: true, duplicate: true });
    expect(view(a).reports).toHaveLength(1);
  });
});

describe('who can see and act on reports', () => {
  it('the leader sees reports about others; the reporter sees their own with its status; nobody else sees anything', () => {
    const { people, send, view } = lobby();
    const [a, b, c, d] = people as [Who, Who, Who, Who];
    send(b, { type: 'report', memberId: c.id, reason: 'rude' });
    expect(view(a).reports).toHaveLength(1);
    expect(view(b).reports).toBeNull();
    expect(view(b).you.myReports).toMatchObject([{ targetName: 'Cy', status: 'open' }]);
    // The person reported and an uninvolved member see no trace of it.
    for (const w of [c, d]) {
      expect(view(w).reports).toBeNull();
      expect(view(w).you.myReports).toEqual([]);
      expect(JSON.stringify(view(w))).not.toContain('rude');
    }
  });

  it('only the leader can resolve a report; a resolved report cannot be resolved twice', () => {
    const { people, send, view } = lobby();
    const [a, b, c] = people as [Who, Who, Who];
    send(b, { type: 'report', memberId: c.id, reason: 'rude' });
    expect(send(b, { type: 'resolveReport', reportId: 1, action: 'dismiss' })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(send(c, { type: 'resolveReport', reportId: 1, action: 'dismiss' })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(send(a, { type: 'resolveReport', reportId: 99, action: 'dismiss' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(send(a, { type: 'resolveReport', reportId: 1, action: 'nonsense' as 'dismiss' })).toMatchObject({ ok: false });
    expect(send(a, { type: 'resolveReport', reportId: 1, action: 'resolve' }).ok).toBe(true);
    expect(view(b).you.myReports[0]?.status).toBe('resolved');
    expect(send(a, { type: 'resolveReport', reportId: 1, action: 'dismiss' })).toMatchObject({ ok: false, code: 'ILLEGAL' });
  });

  it('non-leaders cannot kick, mute, transfer leadership or change settings', () => {
    const { people, send } = lobby();
    const [, b, c] = people as [Who, Who, Who];
    expect(send(b, { type: 'kick', memberId: c.id })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(send(b, { type: 'mute', memberId: c.id, muted: true })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(send(b, { type: 'transferLeader', memberId: b.id })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(send(b, { type: 'configure', config: { startingChips: 5_000 } })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(send(b, { type: 'start' })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });

  it('the leader cannot kick themselves, and a removed member loses all access', () => {
    const { people, send, server } = lobby();
    const [a, b] = people as [Who, Who];
    expect(send(a, { type: 'kick', memberId: a.id })).toMatchObject({ ok: false, code: 'INVALID' });
    expect(send(a, { type: 'kick', memberId: b.id }).ok).toBe(true);
    expect(server.viewFor(b.code, b.id, b.token)).toMatchObject({ ok: false });
    expect(send(b, { type: 'chat', text: 'still here?' })).toMatchObject({ ok: false });
  });

  it('a muted member cannot chat or react, and unmuting restores it', () => {
    const { people, send, view } = lobby();
    const [a, b] = people as [Who, Who];
    send(a, { type: 'mute', memberId: b.id, muted: true });
    expect(send(b, { type: 'chat', text: 'hello' })).toMatchObject({ ok: false, code: 'MUTED' });
    expect(send(b, { type: 'react', reaction: '👍' })).toMatchObject({ ok: false, code: 'MUTED' });
    send(a, { type: 'mute', memberId: b.id, muted: false });
    expect(send(b, { type: 'chat', text: 'hello' }).ok).toBe(true);
    expect(view(a).chat.at(-1)?.text).toBe('hello');
  });

  it('blocking hides a member from you alone, and is not visible to them', () => {
    const { people, send, view } = lobby();
    const [a, b, c] = people as [Who, Who, Who];
    send(b, { type: 'block', memberId: c.id, blocked: true });
    send(c, { type: 'chat', text: 'to everyone' });
    expect(view(b).chat.some((m) => m.text === 'to everyone')).toBe(false);
    expect(view(a).chat.some((m) => m.text === 'to everyone')).toBe(true);
    expect(view(c).you.blocked).toEqual([]);
    expect(send(b, { type: 'block', memberId: b.id, blocked: true })).toMatchObject({ ok: false });
  });
});

describe('a report about the leader', () => {
  it('is never shown to the leader and cannot be resolved by them', () => {
    const { people, send, view } = lobby(['Ada', 'Bo', 'Cy']);
    const [a, b] = people as [Who, Who, Who];
    send(b, { type: 'report', memberId: a.id, reason: 'abusing mute' });
    expect(view(a).reports).toEqual([]);
    expect(JSON.stringify(view(a))).not.toContain('abusing mute');
    expect(send(a, { type: 'resolveReport', reportId: 1, action: 'dismiss' })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(view(b).you.myReports[0]?.status).toBe('open');
  });

  it('passes leadership on once enough different members have reported them, and says so', () => {
    const { people, send, view } = lobby(['Ada', 'Bo', 'Cy', 'Di', 'Ed']);
    const [a, b, c, d] = people as [Who, Who, Who, Who, Who];
    send(b, { type: 'report', memberId: a.id, reason: 'one' });
    expect(view(a).leaderId).toBe(a.id); // one report is not enough (quorum is half the others, at least two)
    send(c, { type: 'report', memberId: a.id, reason: 'two' });
    expect(view(a).leaderId).toBe(b.id); // earliest-joined connected member takes over
    expect(view(d).feed.some((f) => /leadership has passed on/i.test(f.text))).toBe(true);
    expect(view(b).you.myReports[0]?.status).toBe('escalated');
    // The former leader is an ordinary member now: no powers.
    expect(send(a, { type: 'kick', memberId: d.id })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });

  it('a single member in a two-person party cannot depose the leader with one report', () => {
    const { people, send, view } = lobby(['Ada', 'Bo']);
    const [a, b] = people as [Who, Who];
    send(b, { type: 'report', memberId: a.id, reason: 'unfair' });
    expect(view(b).leaderId).toBe(a.id);
  });

  it('repeat reports by one member do not count twice towards the quorum', () => {
    const { people, send, view } = lobby(['Ada', 'Bo', 'Cy', 'Di']);
    const [a, b] = people as [Who, Who];
    send(b, { type: 'report', memberId: a.id, reason: 'one' });
    expect(send(b, { type: 'report', memberId: a.id, reason: 'again' })).toMatchObject({ ok: false, code: 'DUPLICATE' });
    expect(view(b).leaderId).toBe(a.id);
  });
});

describe('chat safety', () => {
  it('stores markup as plain text and never rewrites it into anything executable', () => {
    const { people, send, view } = lobby();
    const [a, b] = people as [Who, Who];
    const payload = '<img src=x onerror=alert(1)> <script>alert(2)</script>';
    expect(send(b, { type: 'chat', text: payload }).ok).toBe(true);
    // The server keeps the exact characters; the client renders them as text nodes (see UI tests).
    expect(view(a).chat.at(-1)?.text).toBe(payload);
  });

  it('strips control characters and collapses whitespace; refuses empty and over-long messages', () => {
    const { people, send, view } = lobby();
    const [a, b] = people as [Who, Who];
    send(b, { type: 'chat', text: 'he\u0000llo\u0007   there\n\nfriend' });
    expect(view(a).chat.at(-1)?.text).toBe('he llo there friend');
    expect(send(b, { type: 'chat', text: '  \u0000  ' })).toMatchObject({ ok: false, code: 'INVALID' });
    expect(send(b, { type: 'chat', text: 'x'.repeat(201) })).toMatchObject({ ok: false, code: 'INVALID' });
    expect(send(b, { type: 'chat', text: 'x'.repeat(5_000) })).toMatchObject({ ok: false, code: 'INVALID' });
    expect(send(b, { type: 'chat', text: 123 as unknown as string })).toMatchObject({ ok: false });
  });

  it('rate limits a flood, then lets messages through again as the bucket refills', () => {
    const { people, send, clock } = lobby();
    const [, b] = people as [Who, Who];
    const results = Array.from({ length: 12 }, (_, i) => send(b, { type: 'chat', text: `spam ${i}` }));
    expect(results.filter((r) => r.ok).length).toBe(5);
    expect(results.some((r) => !r.ok && r.code === 'RATE_LIMITED')).toBe(true);
    clock.t += 3_000;
    expect(send(b, { type: 'chat', text: 'calm now' }).ok).toBe(true);
  });

  it('rejects display names that could carry markup', () => {
    const s = new PartyServer();
    expect(s.createParty('<b>Ada</b>')).toMatchObject({ ok: false });
    const c = s.createParty('Ada');
    if (!c.ok) throw new Error('create failed');
    expect(s.join(c.code, 'Bo<script>')).toMatchObject({ ok: false });
  });

  it('a report exposes only names and the reason: no tokens or hashes', () => {
    const { people, send, view } = lobby();
    const [a, b, c] = people as [Who, Who, Who];
    send(b, { type: 'report', memberId: c.id, reason: 'rude' });
    const text = JSON.stringify(view(a));
    for (const w of people) expect(text).not.toContain(w.token);
    expect(text).not.toMatch(/tokenHash/);
  });
});

describe('reports survive a restart', () => {
  it('structured reports, their statuses and the id counter come back', () => {
    const { people, send, snap } = lobby();
    const [a, b, c, d] = people as [Who, Who, Who, Who];
    send(b, { type: 'report', memberId: c.id, reason: 'rude' });
    send(d, { type: 'report', memberId: c.id, reason: 'also rude' });
    send(a, { type: 'resolveReport', reportId: 1, action: 'resolve' });
    const next = new PartyServer();
    expect(next.restoreState(JSON.parse(snap())).rejected).toEqual([]);
    const v = (next.viewFor(a.code, a.id, a.token) as { ok: true; view: PartyView }).view;
    expect(v.reports?.map((r) => [r.id, r.status])).toEqual([[1, 'resolved'], [2, 'open']]);
    next.attach(b.code, b.id, b.token, () => undefined);
    expect(next.command(b.code, b.id, b.token, { type: 'report', id: 'later', memberId: a.id, reason: 'new' }).ok).toBe(true);
    const after = (next.viewFor(b.code, b.id, b.token) as { ok: true; view: PartyView }).view;
    expect(after.you.myReports.map((r) => r.id)).toEqual([1, 3]); // ids keep counting, never reused
  });

  it('refuses a snapshot whose report has an impossible status', () => {
    const { people, send, snap } = lobby();
    const [, b, c] = people as [Who, Who, Who];
    send(b, { type: 'report', memberId: c.id, reason: 'rude' });
    const bad = JSON.parse(snap());
    bad.parties[0].reports[0].status = 'banished';
    const r = new PartyServer().restoreState(bad);
    expect(r.restored).toEqual([]);
    expect(r.rejected[0]?.reason).toMatch(/status/);
  });
});
