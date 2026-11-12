// External, normally inert I/O fault shim. Application source remains unchanged.
// The sole armed case rejects a selected atomic rename before replacing its file.
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const originalRename = fs.rename;
const seen = new Map();
fs.rename = async function(source, destination) {
  let fault;
  try { fault = JSON.parse(await fs.readFile('/audit/fault-control.json', 'utf8')); }
  catch { fault = {}; }
  if (['rename-once','rename-block'].includes(fault.kind) && fault.id && fault.target === String(destination)) {
    const count = seen.get(fault.id) ?? 0;
    const body = await fs.readFile(source, 'utf8');
    if ((count === 0 || fault.kind === 'rename-block') && body.includes(fault.bodyMarker)) {
      seen.set(fault.id, count + 1);
      console.error(JSON.stringify({ reproFault: fault.id, kind: 'rename', injected: count + 1, code: 'EIO' }));
      throw Object.assign(new Error('Synthetic one-shot atomic body write failure'), { code: 'EIO', syscall: 'rename' });
    }
  }
  return originalRename.call(this, source, destination);
};
syncBuiltinESMExports();
