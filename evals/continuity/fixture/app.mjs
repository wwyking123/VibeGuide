import { makeDemoEntries, register } from './registration.mjs';

const storageKey = 'vibeguide-continuity-local-demo-v1';
const form = document.querySelector('#registration-form');
const feedback = document.querySelector('#feedback');
let entries = [];
let loadFailed = false;

try {
  const parsed = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
  if (!Array.isArray(parsed) || parsed.some(item =>
    !item || typeof item.name !== 'string' || typeof item.email !== 'string'
    || !['confirmed', 'waitlist'].includes(item.status))) {
    throw new Error('Invalid demo records');
  }
  entries = parsed;
} catch {
  loadFailed = true;
  feedback.textContent = '未能读取本机演示名单，已暂停写入以免覆盖原数据。可先检查浏览器存储，或在组织者演示页明确清空演示数据。';
}

function renderList() {
  document.querySelector('#registration-count').textContent = `共 ${entries.length} 条演示记录`;
  const list = document.querySelector('#registration-list');
  list.replaceChildren();
  for (const entry of entries) {
    const row = document.createElement('li');
    row.textContent = `${entry.name} · ${entry.email} · ${entry.status === 'waitlist' ? '候补（未获得参加名额）' : '已报名'}`;
    list.append(row);
  }
}

function saveEntries(next, message) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(next));
    entries = next;
    loadFailed = false;
    renderList();
    feedback.textContent = message;
    return true;
  } catch {
    feedback.textContent = '保存失败：没有确认这次报名已写入浏览器，请检查存储设置后重试。';
    return false;
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  if (loadFailed) {
    feedback.textContent = '原演示名单未能读取，当前不能新增报名，避免覆盖原数据。';
    return;
  }
  // Read once more before submitting to reduce stale same-browser state. This is
  // not an atomic operation and does not implement multi-user capacity safety.
  try {
    const current = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    if (!Array.isArray(current) || current.some(item => !item || typeof item.email !== 'string')) {
      throw new Error('Invalid demo records');
    }
    entries = current;
  } catch {
    loadFailed = true;
    feedback.textContent = '当前演示名单读取失败，本次未提交。';
    return;
  }
  const result = register(entries, Object.fromEntries(new FormData(form)));
  if (!result.ok) {
    feedback.textContent = result.message;
    return;
  }
  if (saveEntries(result.entries, result.message)) form.reset();
});

for (const [tab, organizer] of [['participant-tab', false], ['organizer-tab', true]]) {
  document.getElementById(tab).addEventListener('click', () => {
    document.querySelector('#participant-view').hidden = organizer;
    document.querySelector('#organizer-view').hidden = !organizer;
    document.querySelector('#participant-tab').setAttribute('aria-pressed', String(!organizer));
    document.querySelector('#organizer-tab').setAttribute('aria-pressed', String(organizer));
  });
}

document.querySelector('#seed-demo').addEventListener('click', () => {
  if (confirm('用 19 条虚构报名替换当前浏览器的演示名单？')) {
    saveEntries(makeDemoEntries(), '已替换为 19 条虚构报名。');
  }
});
document.querySelector('#clear-demo').addEventListener('click', () => {
  if (confirm('清空当前浏览器的演示名单？AI 的项目记录不会改变。')) {
    saveEntries([], '已清空本机演示名单。');
  }
});
renderList();
