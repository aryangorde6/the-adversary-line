// Stage-2 route rows (R group): the four screens by URL, and their content type.
import { GET, record, group, BASE } from '../lib.mjs';

const ROUTES = [
  ['/', 'availability-grid', 'R1'],
  ['/signup', 'signup-email', 'R2'],
  ['/login', 'login-email', 'R3'],
  ['/lookup', 'lookup-reference-input', 'R4'],
];

export default async function routes() {
  group('R routes');
  const bad = [];
  for (const [path, testid, row] of ROUTES) {
    const res = await GET(path);
    const html = (res.headers.get('content-type') || '').toLowerCase();
    const hasShell = res.status === 200 && /<html|<!doctype/i.test(res.text);
    if (res.status !== 200 || !html.includes('text/html') || !hasShell) {
      bad.push(`${row} ${path} answered ${res.status} with ${html || 'no content-type'}`);
    }
    record(row, res.status === 200 && html.includes('text/html') && hasShell,
      `GET ${path} answered ${res.status} ${html || '(no content-type)'}, ${res.text.length} bytes${hasShell ? '' : ', not HTML'}`);
  }
  const api = await GET('/health');
  const apiType = (api.headers.get('content-type') || '').toLowerCase();
  record('R6', apiType.includes('application/json'), `the API answers ${apiType} while the screens answer text/html (base ${BASE})`);
}