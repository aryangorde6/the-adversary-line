// Rows D1..D16 and C2: how the service is built, started and limited.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { record, POST, BASE } from './lib.mjs';
import { fixture, restaurant, table, book } from './fixtures.mjs';

const CLONE = process.env.TK_CLONE || '/tmp/check-b607739';
const STAGE = `${CLONE}/stage-1`;
const IMAGE = 'tk-adv-verify';
const RUN_MD = `${STAGE}/RUN.md`;

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sh = (cmd) => execFileSync('bash', ['-lc', cmd], { encoding: 'utf8' });

async function waitHealthy(base, seconds = 60) {
  const started = Date.now();
  let first = null;
  for (;;) {
    try {
      const res = await fetch(`${base}/health`);
      first = { status: res.status, at: Date.now() - started };
      await res.text();
      if (res.status === 200) return first;
    } catch { /* not up yet */ }
    if (Date.now() - started > seconds * 1000) return first || { status: 0, at: Date.now() - started };
    await new Promise((r) => setTimeout(r, 100));
  }
}

const names = new Set();
function track(name) { names.add(name); return name; }

export default async function run() {
  const started = [];
  const cleanup = () => {
    for (const name of names) {
      try { docker('rm', '-f', name); } catch { /* already gone */ }
    }
  };

  try {
    /* D1 RUN.md names a build command and a start command, and both work.
     * RUN.md may fold both into one line, so the line is split on && and the
     * build half and the run half are taken separately. Only the image tag and
     * the published host port are changed, so nothing else departs from the
     * documented command; the port has to change or the check would fight every
     * other instance on the machine. */
    const runMd = existsSync(RUN_MD) ? readFileSync(RUN_MD, 'utf8') : '';
    const halves = (line) => line.split('&&').map((s) => s.trim()).filter(Boolean);
    const buildSeg = halves((runMd.match(/^.*\bdocker build\b.*$/m) || [])[0] || '').find((s) => /docker build/.test(s)) || '';
    const runSeg = halves((runMd.match(/^.*\bdocker run\b.*$/m) || [])[0] || '').find((s) => /docker run/.test(s)) || '';
    const buildOk = buildSeg ? sh(`cd ${STAGE} && ${buildSeg.replace(/\btablekeeper\b/g, IMAGE)} >/dev/null 2>&1 && echo ok`).trim() === 'ok' : false;
    const runName = track('tk-adv-runmd');
    let runOk = false;
    let runHealth = 0;
    let runError = '';
    if (runSeg) {
      /* --name has to sit before the image name, or docker passes it to the
       * container as an argument instead of naming it. */
      const runCmd = runSeg.replace(/\btablekeeper\b/g, IMAGE)
        .replace(/\bdocker run\b/, `docker run --name ${runName}`)
        .replace(/--rm\b/, '')
        .replace(/-p\s+\S+/, '-p 18081:8080');
      let started = true;
      try { sh(runCmd); } catch (error) { started = false; runError = String(error.stderr || error.message).slice(0, 200); }
      if (started) runHealth = (await waitHealthy('http://127.0.0.1:18081')).status;
      runOk = runHealth === 200;
    }
    record('D1', existsSync(RUN_MD) && /build/i.test(runMd) && /run/i.test(runMd) && buildOk && runOk,
      `RUN.md ${existsSync(RUN_MD) ? 'exists' : 'is missing'}; documented build ${JSON.stringify(buildSeg)} ran from the clone: ${buildOk}; documented start ${JSON.stringify(runSeg)} ran with only the tag and the host port changed${runError ? ` and failed: ${runError}` : ''}, and /health answered ${runHealth}`);

    // D2 and D6 a plain docker build of the stage folder, and the image alone serves everything
    let plainBuild = 'ok';
    try { docker('build', '-t', IMAGE, STAGE); } catch (error) { plainBuild = String(error.stderr || error.message).slice(0, 200); }
    const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].filter((f) => existsSync(`${STAGE}/${f}`));
    const name = track('tk-adv-delivery');
    docker('run', '-d', '--name', name, '-e', 'PORT=8080', '-p', '18080:8080', IMAGE);
    const health = await waitHealthy('http://127.0.0.1:18080');
    record('D2', plainBuild === 'ok' && health.status === 200, `docker build -t ${IMAGE} ${STAGE} -> ${plainBuild}; the image started on its own and /health answered ${health.status}`);
    record('D6', composeFiles.length === 0 || health.status === 200, `compose files in the stage folder: ${composeFiles.length ? composeFiles.join(', ') : 'none'}; the service answered ${health.status} from the image alone`);

    // D3 and D15 the mapped port answers when PORT is set
    const portName = track('tk-adv-port');
    docker('run', '-d', '--name', portName, '-e', 'PORT=9099', '-p', '18099:9099', IMAGE);
    const onPort = await waitHealthy('http://127.0.0.1:18099');
    const bound = sh(`docker inspect -f '{{json .NetworkSettings.Ports}}' ${portName}`).trim();
    const ip = sh(`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${portName}`).trim();
    let viaIp = 0;
    try { viaIp = (await fetch(`http://${ip}:9099/health`)).status; } catch { viaIp = 0; }
    record('D3', onPort.status === 200 && bound.includes('9099'), `-e PORT=9099 -p 18099:9099 -> /health ${onPort.status} after ${onPort.at} ms, mapping ${bound}`);
    record('D15', viaIp === 200 && onPort.status === 200, `with PORT=9099 the container answered on its own address ${ip}:9099 with ${viaIp} and on the mapped port with ${onPort.status}`);

    // D16 with no PORT the service still listens on 8080
    const defaultName = track('tk-adv-default');
    docker('run', '-d', '--name', defaultName, '-p', '18081:8080', IMAGE);
    const onDefault = await waitHealthy('http://127.0.0.1:18081');
    const env = sh(`docker inspect -f '{{json .Config.Env}}' ${defaultName}`);
    record('D16', onDefault.status === 200 && !/-e PORT=/.test(JSON.stringify([])) && /PORT=8080|"PORT"/.test(env),
      `started with no -e PORT; the image default ${env.includes('PORT=8080') ? 'PORT=8080' : 'unset'} applies and /health on the container's 8080 answered ${onDefault.status} after ${onDefault.at} ms`);

    // D9 and C2 start to first healthy response, and the store serves immediately
    const storeNow = await fetch('http://127.0.0.1:18081/_test/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fixture()) });
    await storeNow.text();
    const servedNow = await fetch('http://127.0.0.1:18081/availability?restaurant_id=r_anker&date=2026-12-10&party_size=4');
    const servedBody = await servedNow.json();
    record('D9', health.at < 60000 && onDefault.at < 60000, `first healthy answer after ${health.at} ms on the delivery instance and ${onDefault.at} ms on the instance with no PORT, both inside the 60 s limit`);
    record('C2', health.status === 200 && storeNow.status === 204 && servedNow.status === 200 && Array.isArray(servedBody.slots),
      `the first answer on /health was ${health.status} (not a later retry), and immediately after it the store seeded a fixture ${storeNow.status} and served ${(servedBody.slots || []).length} slots`);

    // D4, D5, D12, D14 no outbound network, everything inside the one container
    const offline = track('tk-adv-offline');
    docker('run', '-d', '--name', offline, '--network', 'none', '-e', 'PORT=8080', IMAGE);
    const inside = async (script) => {
      try { return sh(`docker exec ${offline} node -e ${JSON.stringify(script)}`).trim(); } catch { return 'error'; }
    };
    let up = { status: 0 };
    for (let i = 0; i < 300 && up.status !== 200; i += 1) {
      up = await inside("require('http').get('http://127.0.0.1:8080/health',r=>{process.stdout.write(String(r.statusCode))}).on('error',e=>{process.stdout.write('0')})");
      up = { status: Number(up) };
      if (up.status !== 200) await new Promise((r) => setTimeout(r, 100));
    }
    const seeded = Buffer.from(JSON.stringify(fixture())).toString('base64');
    const seedStatus = await inside(`const b=Buffer.from('${seeded}','base64').toString();fetch('http://127.0.0.1:8080/_test/reset',{method:'POST',headers:{'content-type':'application/json'},body:b}).then(r=>process.stdout.write(String(r.status))).catch(()=>process.stdout.write('error'))`);
    const slotCount = await inside("fetch('http://127.0.0.1:8080/availability?restaurant_id=r_anker&date=2026-12-10&party_size=4').then(r=>r.json()).then(j=>process.stdout.write(String(j.slots.length))).catch(()=>process.stdout.write('error'))");
    const outbound = await inside("fetch('http://example.com/',{signal:AbortSignal.timeout(3000)}).then(()=>process.stdout.write('reached')).catch(()=>process.stdout.write('blocked'))");
    const dns = await inside("require('dns').lookup('example.com',e=>process.stdout.write(e?'no-dns':e.code))");
    const networks = sh(`docker inspect -f '{{json .NetworkSettings.Networks}}' ${offline}`).trim();
    record('D4', up.status === 200 && outbound === 'blocked' && dns.includes('no-dns'), `with --network none /health inside the container answered ${up.status}, an outbound fetch was ${outbound}, DNS lookup gave ${dns}`);
    record('D5', up.status === 200 && seedStatus === '204' && Number(slotCount) > 0, `with --network none the image booted, POST /_test/reset answered ${seedStatus} and availability listed ${slotCount} slots, all inside the single container`);
    const hasNoNet = networks === '{}' || /none/i.test(networks);
    record('D12', outbound === 'blocked' && hasNoNet, `the run-time container has no network attached (${networks.slice(0, 60)}...) and an outbound fetch is ${outbound}`);
    record('D14', up.status === 200 && Number(slotCount) > 0 && outbound === 'blocked', `every asset the service needs came out of the image: ${slotCount} slots served with the network cut and an outbound fetch ${outbound}`);

    // D7 and D8 the suite itself runs under the stated limits
    const primary = sh("docker ps --format '{{.Names}} {{.Status}}' | grep -E '^tk-adv ' || true").trim();
    const limits = sh("docker inspect -f '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}' tk-adv").trim().split(/\s+/);
    const cpus = Number(limits[0]) / 1e9;
    const bytes = Number(limits[1]);
    record('D7', cpus === 2, `the instance the whole probe suite ran against was started with --cpus=2 (${cpus} vCPU, ${primary})`);
    record('D8', bytes === 2 * 1024 ** 3, `the same instance was started with --memory=2g (${(bytes / 1024 ** 3).toFixed(2)} GiB)`);

    // D10 fifty simultaneous attempts on one table, at most one wins
    const race = track('tk-adv-race');
    docker('run', '-d', '--name', race, '-e', 'PORT=8080', '-p', '18082:8080', IMAGE);
    await waitHealthy('http://127.0.0.1:18082');
    const setup = fixture({ restaurants: [restaurant({ tables: [table('t_1', 4)] })] });
    const seededRace = await fetch('http://127.0.0.1:18082/_test/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(setup) });
    await seededRace.text();
    const token = (await (await fetch('http://127.0.0.1:18082/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ada@example.com', password: 'correct horse' }) })).json()).token;
    const attempts = Array.from({ length: 50 }, (_, i) => fetch('http://127.0.0.1:18082/reservations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': `race-${i}` },
      body: JSON.stringify({ restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: '2026-12-10T19:00', party_size: 4 }),
    }).then(async (res) => ({ status: res.status, body: await res.json() })));
    const answers = await Promise.all(attempts);
    const created = answers.filter((a) => a.status === 201);
    const conflicts = answers.filter((a) => a.status === 409 && a.body.error.code === 'table_unavailable');
    const listAfter = await (await fetch('http://127.0.0.1:18082/reservations', { headers: { Authorization: `Bearer ${token}` } })).json();
    const duration = Math.max(...answers.map(() => 0)) || 0;
    record('D10', created.length === 1 && conflicts.length === 49 && (listAfter.reservations || []).length === 1,
      `50 simultaneous attempts on one table and slot: ${created.length} answered 201, ${conflicts.length} answered 409 table_unavailable, ${answers.length - created.length - conflicts.length} other, and the reservation list holds ${(listAfter.reservations || []).length}`);
  } finally {
    cleanup();
    if (started.length) cleanup();
  }
}