import { describe, expect, it } from 'vitest';
import { documentBodyEditSchema } from '../shared/contracts.js';
import { bodyRevision, upstreamBodyRevision, planBodyEdit, planTextReplacement } from './documentEdits.js';

describe('guarded document body edits', () => {
  const id = 'page-a';
  const body = '# Page\n\nalpha beta alpha\n';
  const revision = bodyRevision(id, body);
  it('binds the revision to the exact returned body and page', () => {
    expect(bodyRevision(id, body.slice(0, -1))).not.toBe(revision);
    expect(bodyRevision('page-b', body)).not.toBe(revision);
  });
  it('rejects stale replacements, including an otherwise unchanged replacement', () => {
    expect(() => planBodyEdit(id, body + 'browser', { expectedRevision: revision, markdown: body })).toThrow(/changed/);
  });
  it('accepts upstream revisions through the same guards without weakening a supplied fork revision', () => {
    const baseRevision = upstreamBodyRevision(body);
    expect(planBodyEdit(id, body, { baseRevision, markdown: body }).revision).toBe(revision);
    expect(() => planBodyEdit(id, body + 'new', { baseRevision, markdown: body })).toThrow(expect.objectContaining({ code: 'revision_conflict' }));
    expect(() => planBodyEdit(id, body, { baseRevision, expectedRevision: bodyRevision('other-page', body), markdown: body })).toThrow(expect.objectContaining({ code: 'revision_conflict' }));
    expect(() => planBodyEdit(id, body, { baseRevision, markdown: '---\nkey: value\n---\ntext' })).toThrow(expect.objectContaining({ code: 'frontmatter_not_allowed' }));
    expect(() => planBodyEdit(id, body, { markdown: body })).toThrow(expect.objectContaining({ code: 'revision_required' }));
  });
  it('uses exact original ranges, irrespective of request order or repeated text', () => {
    const from = body.lastIndexOf('alpha');
    const plan = planBodyEdit(id, body, { expectedRevision: revision, edits: [
      { from, to: from + 5, expectedText: 'alpha', text: 'gamma' },
      { from: 8, to: 13, expectedText: 'alpha', text: 'delta' },
    ] });
    expect(plan.markdown).toBe('# Page\n\ndelta beta gamma\n');
    expect(plan.changes).toHaveLength(2);
  });
  it('rejects mismatches, overlap, duplicate insertion points and split emoji', () => {
    for (const edits of [
      [{ from: 8, to: 13, expectedText: 'wrong', text: 'x' }],
      [{ from: 8, to: 13, expectedText: 'alpha', text: 'x' }, { from: 9, to: 10, expectedText: 'l', text: 'x' }],
      [{ from: 8, to: 8, expectedText: '', text: 'x' }, { from: 8, to: 8, expectedText: '', text: 'y' }],
    ]) expect(() => planBodyEdit(id, body, { expectedRevision: revision, edits })).toThrow();
    expect(() => planBodyEdit(id, 'a😀b', { expectedRevision: bodyRevision(id, 'a😀b'), edits: [{ from: 2, to: 3, expectedText: '\ude00', text: '' }] })).toThrow();
    expect(() => planBodyEdit(id, 'a😀b', { expectedRevision: bodyRevision(id, 'a😀b'), edits: [{ from: 2, to: 2, expectedText: '', text: 'x' }] })).toThrow(expect.objectContaining({ status: 409, code: 'range_conflict' }));
  });
  it('keeps common characters for replacement and detects no-ops', () => {
    expect(planBodyEdit(id, body, { expectedRevision: revision, markdown: body }).changes).toEqual([]);
    const plan = planBodyEdit(id, body, { expectedRevision: revision, markdown: body.replace('beta', 'BETA') });
    expect(plan.changes).toEqual([{ from: 14, to: 18, text: 'BETA' }]);
  });
  it('bounds input and result and refuses frontmatter in the body', () => {
    expect(documentBodyEditSchema.safeParse({ expectedRevision: revision, markdown: body, edits: [] }).success).toBe(false);
    expect(documentBodyEditSchema.safeParse({ expectedRevision: revision, edits: [{ from: -1, to: 0, expectedText: '', text: '' }] }).success).toBe(false);
    expect(() => planBodyEdit(id, body, { expectedRevision: revision, markdown: 'x'.repeat(1_048_577) })).toThrow();
    expect(() => planBodyEdit(id, body, { expectedRevision: revision, markdown: '---\nsecret: value\n---\ntext' })).toThrow(/frontmatter/);
  });
});

describe('explicit unique passage replacement', () => {
  it('preserves unrelated current text and consumes the quotation so an immediate replay conflicts', () => {
    const before = '# Page\n\nA sentence.\n\nSomeone is typing here.\n';
    const plan = planTextReplacement('page', before, { oldText: 'A sentence.', newText: 'A reviewed sentence.' });
    expect(plan.markdown).toBe(before.replace('A sentence.', 'A reviewed sentence.'));
    expect(() => planTextReplacement('page', plan.markdown, { oldText: 'A sentence.', newText: 'A reviewed sentence.' })).toThrow(expect.objectContaining({ code: 'quote_conflict' }));
  });
  it('rejects missing/ambiguous and overlapping quotations, and guards recreated across replacement boundaries', () => {
    for (const [body, oldText, newText] of [['none', 'absent', 'new'], ['banana', 'ana', 'new'], ['abb', 'ab', 'a'], ['word', 'word', 'word appended']]) {
      expect(() => planTextReplacement('page', body, { oldText, newText })).toThrow(expect.objectContaining({ code: 'quote_conflict' }));
    }
    expect(() => planTextReplacement('page', 'body', { oldText: '', newText: 'new' })).toThrow();
  });
});
