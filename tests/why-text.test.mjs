// AI-assisted (Claude Code), reviewed by a team member.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WHY_THIS_TEST, SOURCES } from '../src/why-text.js';

const all = [...WHY_THIS_TEST, ...SOURCES.map((s) => s.text)].join(' ');

test('the text is real content, not a placeholder', () => {
  assert.ok(WHY_THIS_TEST.length >= 2);
  assert.doesNotMatch(all, /paragraph \d|participant 3|lorem|todo/i);
});

test('the text avoids the wording the project rules forbid', () => {
  assert.doesNotMatch(all, /diagnos|detects SANS|medical device|clinically validated/i);
});

test('every citation mark points to a listed source with a link', () => {
  const marks = new Set([...WHY_THIS_TEST.join(' ').matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  assert.ok(marks.size > 0);
  for (const id of marks) {
    const source = SOURCES.find((s) => s.id === id);
    assert.ok(source, `source [${id}] is listed`);
    assert.match(source.url, /^https:\/\//);
  }
});

test('the figures match the sources (Mader 2011 abstract, NASA HRP SANS page)', () => {
  assert.match(all, /\+0\.50 to \+1\.75 diopters/);
  assert.match(all, /6 of 7 astronauts/);
  assert.match(all, /29% after short missions and 60% after long ones/);
  assert.match(all, /70% of crew/);
  assert.match(all, /10\.1016\/j\.ophtha\.2011\.06\.021/);
});
