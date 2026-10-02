import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const instructorHtml = fs.readFileSync(new URL('../public/instructor.html', import.meta.url), 'utf8');
const instructorJs = fs.readFileSync(new URL('../public/instructor.js', import.meta.url), 'utf8');
const studentHtml = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const studentJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const sharedStyles = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

test('instructor cancellations use the in-page confirmation flow', () => {
  assert.match(instructorHtml, /<dialog id="cancel-dialog"/);
  assert.match(instructorHtml, /id="cancel-form"/);
  assert.match(instructorHtml, /id="cancel-dialog-error"[^>]+role="alert"/);
  assert.match(instructorHtml, /id="cancel-note"[^>]+maxlength="40"/);
  assert.doesNotMatch(instructorJs, /\bprompt\s*\(/);
  assert.match(instructorJs, /requestCancellation\(\{\s*path: '\/api\/instructor\/session\/void'/);
  assert.match(instructorJs, /path: `\/api\/instructor\/room\/\$\{button\.dataset\.voidRoom\}\/void`/);
  assert.match(instructorJs, /cancel-form'\)\.addEventListener\('submit'/);
});

test('the hidden attribute wins over component display rules', () => {
  assert.match(sharedStyles, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
});

test('browser authentication uses server-side cookies and bounded SSE only', () => {
  assert.doesNotMatch(studentJs, /localStorage|Authorization|Bearer|new WebSocket|[?&]token=/);
  assert.doesNotMatch(instructorJs, /new WebSocket|\/ws\b/);
  assert.match(studentJs, /new EventSource\('\/api\/events'\)/);
  assert.match(instructorJs, /new EventSource\('\/api\/instructor\/events'\)/);
  assert.match(studentJs, /inviteCode:\s*\$\('#invite-code'\)/);
});

test('the instructor creates roster-bound invitations and exposes explicit retention purge', () => {
  assert.match(instructorJs, /const body = \{ game: setup\.game, mode: setup\.mode, roster \}/);
  assert.match(instructorJs, /Download invitation CSV/);
  assert.match(instructorJs, /audit-export\.json/);
  assert.match(instructorJs, /spreadsheetSafe/);
  assert.match(instructorJs, /confirmation:\s*'PURGE ARCHIVED DATA'/);
});

test('browser pages have no remote font or asset dependency', () => {
  assert.doesNotMatch(studentHtml, /https?:\/\//);
  assert.doesNotMatch(instructorHtml, /https?:\/\//);
  assert.doesNotMatch(sharedStyles, /@import|url\(\s*['"]?https?:/);
});

test('strict CSP styling uses stylesheet classes rather than inline-style translation', () => {
  assert.doesNotMatch(studentJs, /style="|insertRule|data-atg-style|setAttribute\(['"]style|\.style\b|cssText|setProperty\(/);
  assert.doesNotMatch(instructorJs, /style="|insertRule|data-atg-style|setAttribute\(['"]style|\.style\b|cssText|setProperty\(/);
  assert.doesNotMatch(studentHtml, /style="/);
  assert.doesNotMatch(instructorHtml, /style="/);
});
