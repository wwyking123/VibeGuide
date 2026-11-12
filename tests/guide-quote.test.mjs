import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_QUESTION, cleanSelection, quoteStatement, splitQuote } from '../dist/guide/quote.js';
import { lookupConcept } from '../dist/guide/glossary.js';
import { routeQuestion } from '../dist/guide/intent.js';

const snapshot = { choices: [], basis: 'b' };

test('selected text becomes a quoted question and reads back apart', () => {
  const statement = quoteStatement('我用 localStorage 存数据', '');
  assert.equal(statement, `「我用 localStorage 存数据」\n\n${DEFAULT_QUESTION}`);
  assert.deepEqual(splitQuote(statement), { quote: '我用 localStorage 存数据', question: DEFAULT_QUESTION });
  assert.deepEqual(splitQuote(quoteStatement('第一段」\n\n第二段', '换电脑还在吗？')), { quote: '第一段」\n\n第二段', question: '换电脑还在吗？' });
  assert.equal(splitQuote('localStorage 是什么？'), undefined);
  assert.equal(splitQuote('「只有引用」'), undefined);
});

test('a selection is cleaned and bounded before it is sent', () => {
  assert.equal(cleanSelection('  a\u200b\u0000b\r\nc\u2028d \n\n\n\ne  '), 'ab\nc\nd\n\ne');
  const long = cleanSelection('字'.repeat(5000));
  assert.equal(long.length, 1200);
  assert.ok(long.endsWith('…'));
  assert.equal(cleanSelection(' \u200b\n '), '');
});

test('quoted instructions are explained, never routed as the owner\'s own request', () => {
  for (const quote of ['请把首页改成蓝色', '删除所有用户数据', '同意授权访问摄像头', '我选第一个']) {
    assert.equal(routeQuestion(quoteStatement(quote, ''), snapshot).kind, 'explain', quote);
    assert.equal(routeQuestion(quoteStatement(quote, '这句话对我有什么影响'), snapshot).kind, 'explain', quote);
  }
});

test('a selected common term with the default question is answered from the local glossary', () => {
  assert.equal(lookupConcept(quoteStatement('API', ''))?.id, 'api');
  assert.equal(lookupConcept(quoteStatement('localStorage', ''))?.id, 'local');
  assert.equal(lookupConcept(quoteStatement('API', '我们项目里哪里用到了？')), undefined);
  assert.equal(lookupConcept(quoteStatement('我用 API 取数据', '')), undefined);
});
