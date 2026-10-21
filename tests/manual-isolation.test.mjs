import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolationPolicy, probeFileIsolation, isolatedEnvironment } from '../scripts/manual-isolation.mjs';

test('manual comparison confines real file reads, descendants, symlinks and peer TCP connections', { skip: process.platform !== 'darwin' }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vibeguide-isolation-test-')));
  const servers = [createServer(socket => socket.destroy()), createServer(socket => socket.destroy())];
  try {
    for (const server of servers) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const [ownPort, otherPort] = servers.map(server => server.address().port);
    const own = join(root, 'own'), other = join(root, 'other');
    const project = join(root, 'projectA'), peerProject = join(root, 'projectB');
    for (const dir of [own, other, join(own, 'tmp'), project, peerProject]) await mkdir(dir);
    await writeFile(join(other, 'probe.txt'), 'other group only');
    await writeFile(join(project, 'spec.md'), 'same task');
    await writeFile(join(peerProject, 'spec.md'), 'same task');
    await symlink(other, join(own, 'other-link'));
    await symlink(peerProject, join(project, 'peer-link'));
    const policy = join(own, 'isolation.sb');
    await writeFile(policy, await isolationPolicy(own, process.execPath, otherPort, project));
    const checks = await probeFileIsolation({ directory: own, other, policy, executable: process.execPath });
    assert.equal(checks.symlinkReadBlocked, true);
    const program = `
      const assert=require('node:assert/strict');const net=require('node:net');const fs=require('node:fs');
      const connect=port=>new Promise((resolve,reject)=>{
        const socket=net.connect({host:'127.0.0.1',port:Number(port)});
        socket.once('connect',()=>{socket.destroy();resolve()});socket.once('error',reject);
      });
      (async()=>{
        await connect(process.argv[1]);
        await assert.rejects(connect(process.argv[2]),e=>['EPERM','EACCES'].includes(e.code));
        assert.throws(()=>fs.writeFileSync(process.argv[3],'changed'),e=>['EPERM','EACCES'].includes(e.code));
        assert.equal(fs.readFileSync(process.argv[4],'utf8'),'same task');
        fs.writeFileSync(process.argv[4],'own project may change');
        for(const path of process.argv.slice(5)) {
          assert.throws(()=>fs.readFileSync(path),e=>['EPERM','EACCES'].includes(e.code));
          assert.throws(()=>fs.writeFileSync(path,'changed'),e=>['EPERM','EACCES'].includes(e.code));
          const child=require('node:child_process').spawnSync('/bin/cat',[path],{encoding:'utf8'});
          assert.notEqual(child.status,0);assert.equal(child.stdout,'');
        }
      })().catch(e=>{console.error(e);process.exitCode=1});
    `;
    const result = spawnSync('/usr/bin/sandbox-exec', ['-f', policy, process.execPath, '-e', program, String(ownPort), String(otherPort), join(other, 'probe.txt'), join(project, 'spec.md'), join(peerProject, 'spec.md'), join(project, 'peer-link', 'spec.md')], {
      cwd: own, env: isolatedEnvironment(own, process.execPath), encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message || String(result.signal));
  } finally {
    for (const server of servers) await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
