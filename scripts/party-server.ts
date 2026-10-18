/**
 * Party Mode server: `npm run party:server` (PORT, HOST, PARTY_FILE default .party-state.json).
 *
 * Live sessions survive a restart. Every state change is written (atomically, checksummed) BEFORE
 * players are told about it, and on start the saved parties are restored by replaying their
 * journals through the engine. A corrupt snapshot is set aside, never half-loaded.
 * The Vite dev server proxies /api/party to this process. For hosting, set STATIC_DIR=dist and this one
 * process serves the built app and the API together (see docs/HOSTING.md).
 */
import { resolve } from 'node:path';
import { createPartyHttpServer } from '../src/party/http';
import { PartyServer } from '../src/party/server';
import { FileStore } from '../src/party/store';

const port = Number(process.env.PORT ?? 8787);
const stateFile = resolve(process.env.PARTY_FILE ?? '.party-state.json');
const store = new FileStore(stateFile);
// The saved state holds the recorded shuffles, i.e. every live player's cards: treat it like a key.
if (process.platform === 'win32') {
  console.warn("state file: Windows does not enforce a private file mode; the file inherits its folder's permissions. Keep PARTY_FILE in a folder only you can read.");
}
if (['onedrive', 'dropbox', 'google drive', 'icloud'].some((cloud) => stateFile.toLowerCase().includes(cloud))) {
  console.warn(`state file: ${stateFile} is in a cloud-synced folder, so the saved shuffles are being uploaded. Point PARTY_FILE at a local, unsynced, private folder.`);
}
let release = (): void => undefined;
try {
  release = store.lock();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
process.on('exit', release);

const party: PartyServer = new PartyServer({ persist: () => save(), onPersistError: (e) => console.error(`party state save failed: ${(e as Error).message}`) });
function save(): void {
  try {
    store.save(party.exportState());
  } catch (e) {
    console.error(`could not save party state: ${(e as Error).message}`);
  }
}

const loaded = store.load();
for (const p of loaded.problems) console.warn(`state file: ${p}`);
if (loaded.state !== null) {
  const report = party.restoreState(loaded.state);
  console.log(`restored ${report.restored.length} party(ies) from the ${loaded.source} snapshot`);
  for (const r of report.rejected) console.warn(`rejected ${r.code ?? 'snapshot'}: ${r.reason}`);
  save();
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    save();
    process.exit(0);
  });
}

// STATIC_DIR (for example `dist`) makes this one process serve the built app as well as the API.
const staticDir = process.env.STATIC_DIR;
const http = createPartyHttpServer(party, { ...(staticDir ? { staticDir } : {}), onError: (e) => console.error(`request failed: ${(e as Error).message}`) });
const bound = await http.listen(port, process.env.HOST ?? '127.0.0.1');
console.log(`Party server listening on http://${process.env.HOST ?? '127.0.0.1'}:${bound}${staticDir ? ` (also serving ${staticDir})` : ''}`);

// Keep the process alive until signaled. Vite-node's runner may not hold the event
// loop by itself once the module finishes executing, so pin it explicitly.
const alive = new Promise<void>((resolve) => {
  const onSig = (_sig: string) => {
    http.close();
    resolve();
  };
  process.once('SIGINT', () => onSig('SIGINT'));
  process.once('SIGTERM', () => onSig('SIGTERM'));
  // Fallback: also exit if the server itself aborts.
  process.once('exit', () => resolve());
});
await alive;
process.exit(0);
