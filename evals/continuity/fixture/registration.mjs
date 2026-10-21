// Initial demo behavior: no attendance limit. The evaluation asks the agent to add one.
export function register(entries, input) {
  const name = String(input.name ?? '').trim();
  const email = String(input.email ?? '').trim().toLowerCase();
  if (!name || name.length > 80 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) {
    return { ok: false, message: '请填写姓名和有效邮箱。', entries };
  }
  if (entries.some(entry => entry.email === email)) {
    return { ok: false, message: '这个邮箱已在本机演示名单中，请勿重复提交。', entries };
  }
  const entry = { name, email, status: 'confirmed' };
  return { ok: true, message: '已保存到这个浏览器的演示名单。', entries: [...entries, entry] };
}

export function makeDemoEntries(count = 19) {
  return Array.from({ length: count }, (_, index) => ({
    name: `演示参加者 ${index + 1}`,
    email: `demo-${index + 1}@example.test`,
    status: 'confirmed',
  }));
}
