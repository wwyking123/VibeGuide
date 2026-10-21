/** Guided service integration. Returns reviewable templates; never writes credentials or contacts a service. */
export async function probeSupabase(env: Record<string, string | undefined>, fetcher: typeof fetch = fetch) {
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!key?.startsWith('sb_publishable_')) return { ok: false, code: 'PUBLISHABLE_KEY_REQUIRED' };
  let base: URL;
  try { base = new URL(env.VITE_SUPABASE_URL ?? ''); } catch { return { ok: false, code: 'INVALID_PROJECT_URL' }; }
  if (base.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(base.hostname) || base.port || base.username || base.password || base.pathname !== '/' || base.search || base.hash) return { ok: false, code: 'UNSUPPORTED_PROJECT_URL' };
  const endpoint = new URL('/rest/v1/vibeguide_probe?select=id,label&id=eq.connection-check&limit=1', base);
  try {
    const result = await fetcher(endpoint, { headers: { apikey: key, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!result.ok) return { ok: false, code: 'REQUEST_REJECTED', httpStatus: result.status };
    const data = await result.json();
    const ok = Array.isArray(data) && data.length === 1 && data[0]?.id === 'connection-check' && data[0]?.label === 'connected';
    return { ok, code: ok ? 'EXPECTED_PUBLIC_ROW_READ' : 'EXPECTED_ROW_NOT_VISIBLE', httpStatus: result.status };
  } catch { return { ok: false, code: 'NETWORK_OR_RESPONSE_ERROR' }; }
}
export const serviceStages = ['configuration', 'connection', 'permissions', 'business', 'recovery'] as const;
export function supabaseGuide() {
  return {
    service: 'supabase', supported: 'Supabase 托管项目 + React/Vite；示例支持每个登录用户只读写自己的内容。',
    sources: [
      'https://supabase.com/docs/guides/getting-started/api-keys',
      'https://supabase.com/docs/guides/getting-started/tutorials/with-react',
      'https://supabase.com/docs/guides/api/securing-your-api',
      'https://supabase.com/docs/guides/database/testing',
    ],
    steps: [
      { stage: 'configuration', title: '确定谁能看、谁能改，再配置连接', action: '先保存用户对数据可见范围的要求。由用户在项目 Connect 复制项目 URL 和 publishable key 到本地 .env.local；不要粘贴到聊天或项目记忆。宿主检查变量是否存在，不输出值。', variables: ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY'], expected: '前端仅使用 publishable key，.env.local 不进入版本控制。secret/service_role 禁止用于浏览器。' },
      { stage: 'connection', title: '验证一条确定可公开的示例数据', action: '展示 publicProbeSql 的用途；得到创建演示表的授权后由用户执行。通过宿主写入并运行 probeScript，先 prepare 再登记原生 bash 结果。', expected: '只证明匿名读取到固定演示行；不证明真实业务、写入或权限隔离已经正确。' },
      { stage: 'permissions', title: '验证自己的数据只归自己访问', action: '按已确认规则调整 ownerOnlySql。在本地 Supabase 测试库应用后运行 permissionTestSql（supabase test db）。验证未登录、本人、其他用户分别允许/拒绝的行为，再核对远程策略已部署。', expected: 'SQL 测试在事务中回滚；本地通过与远程部署分开报告。公开共享、管理员名单等规则须另写策略与检查，不直接套用仅本人模板。' },
      { stage: 'business', title: '把数据接进实际页面', action: '接入 clientModule 和用户登录流程，填写一条虚构内容，提交后刷新页面，再以另一测试账号检查隔离。分别记录创建、读回、刷新、跨用户检查。', expected: '页面能读写实际服务，并显示真实成功/失败；连接探针通过不能代替这一步。' },
      { stage: 'recovery', title: '让失败可理解并能重试', action: '在测试环境模拟离线、过期登录和权限拒绝，确认保留未提交内容、不显示保存成功；恢复后读取确认，再决定是否重试，避免重复提交。', expected: '区分尚未保存与结果未知。只读探针可重试，业务写入需先核对已有结果。' },
    ],
    troubleshooting: {
      ENV_FILE_UNAVAILABLE: '本地配置文件没有读到；检查位置和访问权限，不需要重新创建数据库。',
      PUBLISHABLE_KEY_REQUIRED: '需要供浏览器使用的 publishable key；不要改用管理员密钥。',
      INVALID_PROJECT_URL: '项目地址格式不正确，请从 Connect 核对。',
      UNSUPPORTED_PROJECT_URL: '这个指南目前只支持标准 Supabase 托管地址。',
      REQUEST_REJECTED: '请求被拒绝。401 先核对项目和公开密钥；403 核对 grants 与 RLS，不能直接认定只缺某个配置。',
      EXPECTED_ROW_NOT_VISIBLE: '服务有响应但没有读到指定示例行；核对行是否存在、表权限和 RLS。',
      NETWORK_OR_RESPONSE_ERROR: '未获得可验证响应；检查网络或服务状态，当前不能称为接通。',
    },
    artifacts: {
      probeScript: `import { readFile } from 'node:fs/promises';\nimport { parseEnv } from 'node:util';\nconst probe = ${probeSupabase.toString()};\nlet result;\ntry { result = await probe(parseEnv(await readFile('.env.local', 'utf8'))); } catch { result = { ok: false, code: 'ENV_FILE_UNAVAILABLE' }; }\nconsole.log(JSON.stringify({ check: 'supabase-public-read-v1', ...result }));\nprocess.exitCode = result.ok ? 0 : 1;\n`,
      publicProbeSql: `-- Only a fixed, non-personal public demonstration row. Review before applying.\ncreate table public.vibeguide_probe (id text primary key, label text not null);\nalter table public.vibeguide_probe enable row level security;\nrevoke all on public.vibeguide_probe from anon, authenticated;\ngrant select on public.vibeguide_probe to anon, authenticated;\ncreate policy "read demo row" on public.vibeguide_probe for select to anon, authenticated using (id = 'connection-check');\ninsert into public.vibeguide_probe values ('connection-check', 'connected');\n`,
      ownerOnlySql: `-- Use only when the confirmed rule is: each signed-in user owns their entries.\ncreate table public.vibeguide_entries (id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id), body text not null check (length(trim(body)) > 0));\nalter table public.vibeguide_entries enable row level security;\nrevoke all on public.vibeguide_entries from anon, authenticated;\ngrant select, insert, update, delete on public.vibeguide_entries to authenticated;\ncreate policy "owner reads" on public.vibeguide_entries for select to authenticated using ((select auth.uid()) = owner_id);\ncreate policy "owner inserts" on public.vibeguide_entries for insert to authenticated with check ((select auth.uid()) = owner_id);\ncreate policy "owner updates" on public.vibeguide_entries for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);\ncreate policy "owner deletes" on public.vibeguide_entries for delete to authenticated using ((select auth.uid()) = owner_id);\n`,
      permissionTestSql: `-- Run only in the local Supabase test database: supabase test db\nbegin;\ncreate extension if not exists pgtap with schema extensions;\nselect plan(5);\ninsert into auth.users (id, email) values ('11111111-1111-4111-8111-111111111111','vg-a@example.invalid'), ('22222222-2222-4222-8222-222222222222','vg-b@example.invalid');\ninsert into public.vibeguide_entries (owner_id, body) values ('11111111-1111-4111-8111-111111111111','A'), ('22222222-2222-4222-8222-222222222222','B');\nselect set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',true);\nset local role authenticated;\nselect results_eq('select body from public.vibeguide_entries order by body', $$values ('A'::text)$$, 'owner sees only own row');\nselect lives_ok($$insert into public.vibeguide_entries (owner_id,body) values ('11111111-1111-4111-8111-111111111111','A2')$$, 'owner may insert');\nselect throws_ok($$insert into public.vibeguide_entries (owner_id,body) values ('22222222-2222-4222-8222-222222222222','forbidden')$$, '42501', null, 'cannot insert for another user');\nreset role;\nselect set_config('request.jwt.claims','{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}',true);\nset local role authenticated;\nselect results_eq('select body from public.vibeguide_entries order by body', $$values ('B'::text)$$, 'other account sees only own row');\nreset role;\nset local role anon;\nselect throws_ok('select * from public.vibeguide_entries', '42501', null, 'anonymous cannot read private data');\nreset role;\nselect * from finish();\nrollback;\n`,
      clientModule: `import { createClient } from '@supabase/supabase-js';\nexport const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);\nexport async function saveEntry(body, id = crypto.randomUUID()) {\n  const { data: { user } } = await supabase.auth.getUser();\n  if (!user) return { ok: false, message: '请先登录；内容尚未保存。' };\n  const { data, error } = await supabase.from('vibeguide_entries').insert({ id, owner_id: user.id, body }).select('id,body').single();\n  if (error) return { ok: false, id, message: '尚未确认保存成功，请保留内容。重试前先核对这条记录是否已存在。' };\n  return { ok: true, data };\n}\nexport async function loadEntries() {\n  const { data, error } = await supabase.from('vibeguide_entries').select('id,body');\n  return error ? { ok: false, message: '暂时无法读取，请检查登录和网络。' } : { ok: true, data };\n}\n`,
    },
    note: '这些模板不会自动执行。业务写入、账号注册和远程建表通过宿主正常授权流程完成；所有阶段初始均为未验证，不把示例检查当作用户业务通过。',
  };
}
