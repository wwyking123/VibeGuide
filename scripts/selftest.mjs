// Runs the storage and file-reading code on this machine, in a throwaway folder, before the
// installer touches any Harness setting. If this computer handles files differently from the
// ones VibeGuide was developed on, the install stops here with the reason.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GuideStore } from '../dist/guide/store.js';
import { captureFiles } from '../dist/guide/files.js';

export async function selfTest() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vibeguide-selftest-')));
  const step = async (label, run) => {
    try { return await run(); }
    catch (error) { throw new Error(`${label}：${error instanceof Error ? error.message : error}`); }
  };
  let store;
  try {
    store = await step('打开记录', () => GuideStore.open(join(root, 'state')));
    const scope = { sessionId: 'selftest', projectId: 'selftest' };
    await step('保存会话记录', () => store.update(scope, record => { record.partial = true; }));
    const session = await step('读取会话记录', () => store.read(scope));
    if (session.revision !== 1 || !session.partial) throw new Error('读取会话记录：内容和刚保存的不一致');
    await step('保存项目记录', () => store.updateProject('selftest', project => {
      project.feedback.push({ id: 'selftest', cardId: 'selftest', stepId: 'selftest', result: 'pass' });
    }));
    const project = join(root, 'project');
    await mkdir(join(project, 'src'), { recursive: true });
    await writeFile(join(project, 'index.html'), '<h1>selftest</h1>\n');
    await writeFile(join(project, 'src', 'app.js'), 'export default 1;\n');
    const basis = await step('读取项目文件', () => captureFiles(project, 5000));
    if (!basis.complete || Object.keys(basis.files).length !== 2) throw new Error('读取项目文件：没有完整读到测试用的两个文件');
  } finally {
    await store?.close().catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
