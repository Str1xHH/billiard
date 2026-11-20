'use strict';
// Проверка серверной функции без облака: хранилище и GitHub подменены на заглушки в памяти.
// Запуск: node api/test.js
process.env.BUCKET = 'test';
process.env.GH_CLIENT_ID = 'cid';
process.env.GH_CLIENT_SECRET = 'csec';
process.env.SESSION_SECRET = 'x'.repeat(64);
const assert = require('assert');

const mem = new Map();
const gh = {
  alice: { id: 101, login: 'Alice', name: 'Алиса', avatar_url: 'https://avatars.example/101' },
  bob: { id: 102, login: 'bob', name: '', avatar_url: 'https://avatars.example/102' },
  carol: { id: 103, login: 'carol', name: 'Карина', avatar_url: 'https://avatars.example/103' }
};
const codes = { 'code-a': 'alice', 'code-b': 'bob', 'code-c': 'carol' };
const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => (typeof body === 'string' ? JSON.parse(body) : body), text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
global.fetch = async (url, opt = {}) => {
  const u = new URL(url), method = opt.method || 'GET';
  if (u.host === 'storage.yandexcloud.net') {
    const key = u.pathname.replace(/^\/test\//, '').split('/').map(decodeURIComponent).join('/');
    if (method === 'GET') return mem.has(key) ? res(200, mem.get(key)) : res(404, '');
    if (method === 'PUT') { mem.set(key, opt.body); return res(200, ''); }
    if (method === 'DELETE') { mem.delete(key); return res(204, ''); }
  }
  if (u.host === 'github.com' && u.pathname === '/login/oauth/access_token') {
    const b = JSON.parse(opt.body);
    assert.strictEqual(b.client_secret, 'csec');
    return res(200, codes[b.code] ? { access_token: 'tok-' + codes[b.code] } : { error: 'bad_verification_code' });
  }
  if (u.host === 'api.github.com' && u.pathname === '/user') return res(200, gh[opt.headers.Authorization.replace('Bearer tok-', '')]);
  if (u.host === 'api.github.com' && u.pathname.startsWith('/users/')) {
    const l = decodeURIComponent(u.pathname.slice(7)).toLowerCase();
    return gh[l] ? res(200, gh[l]) : res(404, { message: 'Not Found' });
  }
  throw new Error('неожиданный запрос ' + url);
};

const { handler } = require('./index.js');
const call = async (body, b64) => {
  const raw = JSON.stringify(body);
  const r = await handler({ httpMethod: 'POST', headers: {}, body: b64 ? Buffer.from(raw).toString('base64') : raw, isBase64Encoded: !!b64 }, {});
  return Object.assign({ status: r.statusCode }, JSON.parse(r.body));
};
const st = n => n.toString(16).padStart(32, '0');
const login = async (code, n) => { const r = await call({ a: 'auth-finish', code, state: st(n) }); assert.ok(r.token, JSON.stringify(r)); return r.token; };

(async () => {
  // вход: перенаправление на GitHub
  let r = await handler({ httpMethod: 'GET', queryStringParameters: { a: 'login', state: st(1) } }, {});
  assert.strictEqual(r.statusCode, 302);
  assert.ok(r.headers.Location.startsWith('https://github.com/login/oauth/authorize?client_id=cid&'));
  assert.ok(r.headers.Location.includes('state=' + st(1)));
  r = await handler({ httpMethod: 'GET', queryStringParameters: { a: 'login', state: 'bad' } }, {});
  assert.strictEqual(r.statusCode, 400);
  r = await handler({ httpMethod: 'OPTIONS' }, {});
  assert.strictEqual(r.statusCode, 204);

  // вход: код меняется на ключ, установленное приложение забирает его по state
  const ta = await login('code-a', 1);
  r = await call({ a: 'auth-poll', state: st(1) });
  assert.strictEqual(r.token, ta); assert.strictEqual(r.user.login, 'Alice');
  r = await call({ a: 'auth-poll', state: st(1) });
  assert.ok(r.pending, 'ключ отдаётся только один раз');
  r = await call({ a: 'auth-finish', code: 'nope', state: st(2) });
  assert.strictEqual(r.status, 400);

  r = await call({ a: 'me', t: ta });
  assert.strictEqual(r.user.id, 'gh101'); assert.strictEqual(r.user.name, 'Алиса');
  r = await call({ a: 'me', t: ta.slice(0, -2) + 'xx' });
  assert.strictEqual(r.status, 401);
  r = await call({ a: 'me', t: 'v1.gh999.abc.' + 'a'.repeat(43) });
  assert.strictEqual(r.status, 401);

  // данные: версия, конфликт, «не изменилось»
  r = await call({ a: 'get', t: ta, kind: 'data' });
  assert.strictEqual(r.ver, 0); assert.strictEqual(r.body, null);
  r = await call({ a: 'put', t: ta, kind: 'data', base: 0, body: { sessions: { s1: {} } }, stats: { trainings: 3, shots: 100, made: 64 } });
  assert.strictEqual(r.ver, 1);
  r = await call({ a: 'put', t: ta, kind: 'data', base: 0, body: { sessions: {} } });
  assert.ok(r.conflict); assert.strictEqual(r.ver, 1);
  r = await call({ a: 'get', t: ta, kind: 'data', have: 1 });
  assert.ok(r.same);
  r = await call({ a: 'get', t: ta, kind: 'data' }, true);   // тело в base64, как присылает Cloud Functions для text/plain
  assert.deepStrictEqual(r.body, { sessions: { s1: {} } });
  r = await call({ a: 'put', t: ta, kind: 'guide', base: 0, body: { items: {}, deleted: {} } });
  assert.strictEqual(r.ver, 1);
  r = await call({ a: 'put', t: ta, kind: 'secret', base: 0, body: {} });
  assert.strictEqual(r.status, 400);

  // друзья: заявка тому, кто ещё не входил
  r = await call({ a: 'friend-add', t: ta, login: '@Bob' });
  assert.strictEqual(r.result, 'sent'); assert.strictEqual(r.outgoing.length, 1);
  assert.strictEqual(r.outgoing[0].joined, false);
  r = await call({ a: 'friend-add', t: ta, login: 'alice' });
  assert.strictEqual(r.status, 400); assert.strictEqual(r.error, 'self');
  r = await call({ a: 'friend-add', t: ta, login: 'nobody-here' });
  assert.strictEqual(r.status, 404);
  r = await call({ a: 'friend-add', t: ta, login: 'bad login!' });
  assert.strictEqual(r.status, 400);

  // Боб входит — видит заявку и принимает
  const tb = await login('code-b', 3);
  r = await call({ a: 'friends', t: tb });
  assert.strictEqual(r.incoming.length, 1); assert.strictEqual(r.incoming[0].login, 'Alice');
  assert.strictEqual(r.incoming[0].stats.made, 64);
  r = await call({ a: 'friend-accept', t: tb, uid: 'gh101' });
  assert.strictEqual(r.friends.length, 1); assert.strictEqual(r.incoming.length, 0);
  r = await call({ a: 'friends', t: ta });
  assert.strictEqual(r.friends.length, 1); assert.strictEqual(r.outgoing.length, 0);
  assert.strictEqual(r.friends[0].login, 'bob'); assert.strictEqual(r.friends[0].joined, true);
  r = await call({ a: 'friend-add', t: tb, login: 'alice' });
  assert.strictEqual(r.result, 'already');

  // встречные заявки — сразу друзья
  const tc = await login('code-c', 4);
  await call({ a: 'friend-add', t: tc, login: 'alice' });
  r = await call({ a: 'friend-add', t: ta, login: 'carol' });
  assert.strictEqual(r.result, 'friends'); assert.strictEqual(r.friends.length, 2); assert.strictEqual(r.incoming.length, 0);

  // удалить из друзей, отклонить заявку
  r = await call({ a: 'friend-remove', t: ta, uid: 'gh102' });
  assert.strictEqual(r.friends.length, 1);
  r = await call({ a: 'friends', t: tb });
  assert.strictEqual(r.friends.length, 0);
  await call({ a: 'friend-add', t: tb, login: 'carol' });
  r = await call({ a: 'friend-remove', t: tc, uid: 'gh102' });
  assert.strictEqual(r.incoming.length, 0);
  r = await call({ a: 'friends', t: tb });
  assert.strictEqual(r.outgoing.length, 0);
  r = await call({ a: 'friend-accept', t: tc, uid: 'gh102' });
  assert.strictEqual(r.status, 404);

  // мусор вместо запроса
  r = await handler({ httpMethod: 'POST', body: '{oops', isBase64Encoded: false }, {});
  assert.strictEqual(r.statusCode, 400);
  r = await call({ a: 'drop-all' });
  assert.strictEqual(r.status, 400);

  console.log('api: все проверки пройдены');
})().catch(e => { console.error(e); process.exit(1); });
