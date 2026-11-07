import { createHash } from 'node:crypto';
import { DOCUMENT_BODY_MAX_BYTES, documentBodyEditSchema } from '../shared/contracts.js';
import { HttpError } from './errors.js';

export class DocumentEditError extends HttpError {
  constructor(status: number, code: string, message: string, readonly details: { currentRevision?: string; editIndex?: number; acceptedRevision?: string } = {}) {
    super(status, message, code);
  }
  toJSON() { return { error: this.message, code: this.code, ...this.details }; }
}

/** This is a body precondition, not a Git SHA or the snapshot's file marker. */
export function bodyRevision(id: string, markdown: string): string {
  return `body-v1:${createHash('sha256').update(JSON.stringify([id, markdown])).digest('hex')}`;
}

interface TextChange { from: number; to: number; text: string }

function splitsSurrogate(text: string, at: number): boolean {
  return at > 0 && /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at] ?? '');
}

function validText(text: string): boolean {
  // Y.Text and file encoding must agree on the characters and their offsets.
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

/** All guards and planning are synchronous. Apply the returned changes without awaiting. */
export function planBodyEdit(id: string, before: string, input: unknown): { markdown: string; revision: string; changes: TextChange[] } {
  if (!input || typeof input !== 'object' || !('expectedRevision' in input) || input.expectedRevision === undefined) {
    throw new DocumentEditError(428, 'revision_required', 'Read the page and pass its revision as expectedRevision.');
  }
  const parsed = documentBodyEditSchema.safeParse(input);
  if (!parsed.success) throw new DocumentEditError(400, 'invalid_body_edit', 'Provide expectedRevision and exactly one of markdown or 1–100 edits; only body fields are allowed.');
  const request = parsed.data;
  const currentRevision = bodyRevision(id, before);
  if (request.expectedRevision !== currentRevision) {
    throw new DocumentEditError(409, 'revision_conflict', 'The document body changed; read it again and reconcile the edit.', { currentRevision });
  }
  const strings = request.markdown === undefined ? request.edits!.flatMap((e) => [e.expectedText, e.text]) : [request.markdown];
  if (strings.reduce((sum, s) => sum + Buffer.byteLength(s), 0) > DOCUMENT_BODY_MAX_BYTES) {
    throw new DocumentEditError(413, 'body_edit_too_large', 'Body edit input exceeds 1 MiB.');
  }
  if (strings.some((s) => s.includes('\r') || !validText(s))) {
    throw new DocumentEditError(400, 'invalid_body_text', 'Use LF line endings and complete Unicode characters.');
  }
  let changes: TextChange[];
  let markdown: string;
  if (request.markdown !== undefined) {
    markdown = request.markdown;
    let from = 0;
    while (from < before.length && from < markdown.length && before[from] === markdown[from]) from++;
    if (splitsSurrogate(before, from) || splitsSurrogate(markdown, from)) from--;
    let oldEnd = before.length;
    let newEnd = markdown.length;
    while (oldEnd > from && newEnd > from && before[oldEnd - 1] === markdown[newEnd - 1]) { oldEnd--; newEnd--; }
    if (splitsSurrogate(before, oldEnd) || splitsSurrogate(markdown, newEnd)) { oldEnd++; newEnd++; }
    changes = before === markdown ? [] : [{ from, to: oldEnd, text: markdown.slice(from, newEnd) }];
  } else {
    const edits = request.edits!.map((edit, editIndex) => ({ ...edit, editIndex })).sort((a, b) => a.from - b.from || a.to - b.to);
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i];
      const previous = edits[i - 1];
      if (e.to < e.from || e.to > before.length || splitsSurrogate(before, e.from) || splitsSurrogate(before, e.to) ||
          (previous && (e.from < previous.to || e.from === previous.from)) || before.slice(e.from, e.to) !== e.expectedText) {
        throw new DocumentEditError(409, 'range_conflict', 'An edit range is invalid, overlaps another edit, or does not match expectedText; read and reconcile.', { currentRevision, editIndex: e.editIndex });
      }
    }
    changes = edits.filter((e) => e.expectedText !== e.text).map(({ from, to, text }) => ({ from, to, text }));
    markdown = before;
    for (const e of [...changes].reverse()) markdown = markdown.slice(0, e.from) + e.text + markdown.slice(e.to);
  }
  if (Buffer.byteLength(markdown) > DOCUMENT_BODY_MAX_BYTES) throw new DocumentEditError(413, 'body_edit_too_large', 'The resulting body exceeds 1 MiB.');
  if (/^---\n(?:[\s\S]*?\n)?(?:---|\.\.\.)(?:\n|$)/.test(markdown)) {
    throw new DocumentEditError(400, 'frontmatter_not_allowed', 'Guarded edits accept the Markdown body only, without frontmatter; use the properties API for metadata.');
  }
  return { markdown, revision: bodyRevision(id, markdown), changes };
}
