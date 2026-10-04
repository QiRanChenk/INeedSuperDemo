import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { botPayload, feedbackText, sendBot } from '../shell/notify.js';

test('botPayload follows each team-chat bot format', () => {
  assert.deepEqual(botPayload('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x', 'hi'), { msgtype: 'text', text: { content: 'hi' } });
  assert.deepEqual(botPayload('https://open.feishu.cn/open-apis/bot/v2/hook/x', 'hi'), { msg_type: 'text', content: { text: 'hi' } });
  assert.deepEqual(botPayload('https://oapi.dingtalk.com/robot/send?access_token=x', 'hi'), { msgtype: 'text', text: { content: 'hi' } });
  assert.deepEqual(botPayload('https://example.com/hook', 'hi'), { text: 'hi' });
});

test('feedbackText never includes the contact itself', () => {
  const t = feedbackText({ name: '菜摊记账' }, { reaction: 'up', contact: 'wx_secret_123', text: '好用', answers: [{ q: '怎么算账？', a: '记本子' }], share: { label: '摊主群' } }, 'https://d.example.com/#/p/x');
  assert.match(t, /菜摊记账/); assert.match(t, /摊主群/); assert.match(t, /留了联系方式/); assert.match(t, /记本子/);
  assert.ok(!t.includes('wx_secret_123'));
});

test('sendBot posts JSON and surfaces bot error codes', async () => {
  let got = null;
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { got = JSON.parse(b); res.end(got.text === 'bad' ? '{"errcode":93000,"errmsg":"invalid webhook url"}' : '{"errcode":0}'); }); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/hook`;
  await sendBot(url, 'hello'); assert.deepEqual(got, { text: 'hello' });
  await assert.rejects(sendBot(url, 'bad'), /invalid webhook url/);
  srv.close();
});

test('feedbackText strips bot mention syntax from visitor text', () => {
  const t = feedbackText({ name: 'x' }, { text: '大家看 <at user_id="all"></at> @所有人 <@123>', name: '@all' });
  assert.ok(!/<at|@所有人|<@|@all/i.test(t), t);
});
