const { spawn } = require('node:child_process');
const serverPath = 'C:\\SourceCode\\clowder-ai\\packages\\mcp-server\\dist\\collab.js';
const env = { ...process.env, CAT_CAFE_DATA_DIR: 'C:\\Users\\Administrator\\.cat-cafe' };
delete env.CAT_CAFE_READONLY;
const child = spawn(process.execPath, [serverPath], { stdio: ['pipe','pipe','pipe'], env });
child.stderr.on('data', () => {});
let buf = '';
let reqId = 0;
const pending = {};
function send(method, params = {}, isNotification = false) {
  const payload = { jsonrpc:'2.0', method, params };
  if (!isNotification) {
    const id = ++reqId;
    payload.id = id;
    child.stdin.write(JSON.stringify(payload) + '\n');
    return new Promise((res, rej) => { pending[id] = { res, rej }; });
  }
  child.stdin.write(JSON.stringify(payload) + '\n');
  return Promise.resolve();
}
child.stdout.on('data', (d) => {
  buf += d.toString();
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending[msg.id]) {
      const p = pending[msg.id];
      delete pending[msg.id];
      if (msg.error) p.rej(new Error(JSON.stringify(msg.error)));
      else p.res(msg.result);
    }
  }
});
(async () => {
  await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '0.1.0' } });
  await send('notifications/initialized', {}, true);
  const tools = await send('tools/list');
  const names = tools.tools.map(t => t.name).sort();
  console.log('ALL TOOLS (' + names.length + '):');
  console.log(JSON.stringify(names, null, 1));
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 20000);
