'use strict';
/*
  Серверная часть «Бильярда» (Yandex Cloud Functions, Node.js 22).
  — вход через GitHub (OAuth), свой ключ сессии;
  — хранение тренировок и справочника аккаунта;
  — друзья (заявки) и таблица лидеров по точности.

  Хранилище — приватный бакет Object Storage, данные в JSON-файлах:
    users/<uid>.json            профиль, статистика, друзья и заявки
    data/<uid>/<kind>.json      { ver, savedAt, body } — kind: data | guide
    auth/<sha256(state)>.json   результат входа, пока приложение его не заберёт (10 минут)
    config/secret.json          секрет для подписи ключей сессии (создаётся сам)

  Запросы — POST с телом JSON (Content-Type: text/plain, чтобы браузер не делал предварительный запрос CORS):
    { a: '<действие>', t: '<ключ сессии>', ... }
  Вход — GET ?a=login&state=<случайная строка>: перенаправляет на GitHub.
*/
const crypto = require('crypto');

const BUCKET = process.env.BUCKET || '';
const GH_ID = process.env.GH_CLIENT_ID || '';
const GH_SECRET = process.env.GH_CLIENT_SECRET || '';
const APP_URL = process.env.APP_URL || 'https://str1xhh.github.io/billiard/';
const S3 = process.env.S3_ENDPOINT || 'https://storage.yandexcloud.net/';
const GH_WEB = process.env.GH_WEB || 'https://github.com';
const GH_API = process.env.GH_API || 'https://api.github.com';
const MAX_BODY = 3300000;          // лимит функции на тело запроса — 3,5 МБ
const AUTH_TTL = 10 * 60 * 1000;
const KINDS = new Set(['data', 'guide']);
const LOGIN_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const UID_RE = /^gh\d{1,15}$/;
const STATE_RE = /^[a-f\d]{32,128}$/;

/* ---------- хранилище ---------- */
let iam = '';
const s3url = key => S3 + BUCKET + '/' + key.split('/').map(encodeURIComponent).join('/');
const s3h = extra => Object.assign(iam ? { Authorization: 'Bearer ' + iam } : {}, extra || {});
async function sGet(key) {
  const r = await fetch(s3url(key), { headers: s3h() });
  if (r.status === 404) return null;
  if (!r.ok) throw httpErr(502, 'storage', 'Хранилище не отвечает (' + r.status + ')');
  const text = await r.text();
  try { return JSON.parse(text); } catch (e) { return null; }
}
async function sPut(key, obj) {
  const r = await fetch(s3url(key), { method: 'PUT', headers: s3h({ 'Content-Type': 'application/json' }), body: JSON.stringify(obj) });
  if (!r.ok) throw httpErr(502, 'storage', 'Хранилище не приняло запись (' + r.status + ')');
}
async function sDel(key) {
  const r = await fetch(s3url(key), { method: 'DELETE', headers: s3h() });
  if (!r.ok && r.status !== 404) throw httpErr(502, 'storage', 'Хранилище не удалило запись (' + r.status + ')');
}

/* ---------- ключ сессии ---------- */
let secretCache = process.env.SESSION_SECRET || '';
async function secret() {
  if (secretCache) return secretCache;
  const s = await sGet('config/secret.json');
  if (s && typeof s.k === 'string' && s.k.length >= 32) return (secretCache = s.k);
  const k = crypto.randomBytes(32).toString('hex');
  await sPut('config/secret.json', { k, createdAt: new Date().toISOString() });
  return (secretCache = k);
}
const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function sign(uid) {
  const body = 'v1.' + uid + '.' + Date.now().toString(36);
  return body + '.' + b64u(crypto.createHmac('sha256', await secret()).update(body).digest());
}
async function verify(token) {
  const m = /^v1\.(gh\d{1,15})\.([a-z\d]{1,12})\.([\w-]{43})$/.exec(String(token || ''));
  if (!m) return null;
  const want = b64u(crypto.createHmac('sha256', await secret()).update('v1.' + m[1] + '.' + m[2]).digest());
  const a = Buffer.from(want), b = Buffer.from(m[3]);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? m[1] : null;
}
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

/* ---------- пользователи ---------- */
const userKey = uid => 'users/' + uid + '.json';
function blankUser(gu) {
  return { id: 'gh' + gu.id, login: gu.login, name: gu.name || '', avatar: gu.avatar_url || '', createdAt: new Date().toISOString(), stats: null, friends: [], incoming: [], outgoing: [] };
}
function fixUser(u) {
  ['friends', 'incoming', 'outgoing'].forEach(k => { if (!Array.isArray(u[k])) u[k] = []; u[k] = u[k].filter(x => UID_RE.test(x)); });
  return u;
}
async function loadUser(uid) { const u = await sGet(userKey(uid)); return u ? fixUser(u) : null; }
const saveUser = u => sPut(userKey(u.id), u);
function pub(u) {
  if (!u) return null;
  const s = u.stats;
  return { id: u.id, login: u.login, name: u.name || '', avatar: u.avatar || '', joined: !u.stub, stats: s ? { trainings: s.trainings, shots: s.shots, made: s.made, at: s.at } : null };
}
const without = (arr, x) => arr.filter(y => y !== x);
const withItem = (arr, x) => arr.includes(x) ? arr : arr.concat(x);

/* ---------- GitHub ---------- */
const ghHeaders = extra => Object.assign({ 'User-Agent': 'billiard-app', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, extra || {});
async function ghUserByLogin(login) {
  const url = GH_API + '/users/' + encodeURIComponent(login);
  let r = await fetch(url, { headers: ghHeaders(GH_ID && GH_SECRET ? { Authorization: 'Basic ' + Buffer.from(GH_ID + ':' + GH_SECRET).toString('base64') } : {}) });
  if (r.status === 401) r = await fetch(url, { headers: ghHeaders() });
  if (r.status === 404) return null;
  if (!r.ok) throw httpErr(502, 'github', 'GitHub не ответил, попробуй чуть позже');
  const j = await r.json();
  return j && j.id ? j : null;
}

/* ---------- ответы ---------- */
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
function httpErr(status, code, message) { const e = new Error(message || code); e.status = status; e.code = code; return e; }
const json = (status, obj) => ({ statusCode: status, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, CORS), body: JSON.stringify(obj), isBase64Encoded: false });
const page = (status, html) => ({ statusCode: status, headers: Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, CORS), body: html, isBase64Encoded: false });

/* ---------- действия ---------- */
async function needUser(req) {
  const uid = await verify(req.t);
  if (!uid) throw httpErr(401, 'auth', 'Нужно войти заново');
  const u = await loadUser(uid);
  if (!u || u.stub) throw httpErr(401, 'auth', 'Нужно войти заново');
  return u;
}

async function friendsPayload(me) {
  const ids = [...new Set([...me.friends, ...me.incoming, ...me.outgoing])];
  const all = {};
  await Promise.all(ids.map(async id => { all[id] = await loadUser(id); }));
  const list = arr => arr.map(id => pub(all[id])).filter(Boolean);
  return { me: pub(me), friends: list(me.friends), incoming: list(me.incoming), outgoing: list(me.outgoing) };
}

function cleanStats(s) {
  if (!s || typeof s !== 'object') return null;
  const n = v => Math.max(0, Math.min(1e9, Math.floor(Number(v) || 0)));
  const trainings = n(s.trainings), shots = n(s.shots), made = Math.min(n(s.made), shots);
  return { trainings, shots, made };
}

const actions = {
  ping: async () => ({ ok: true }),

  // приложение (или открытая из него страница входа) завершает вход: код GitHub меняется на ключ сессии
  'auth-finish': async req => {
    const code = String(req.code || ''), state = String(req.state || '');
    if (!/^[\w-]{4,100}$/.test(code) || !STATE_RE.test(state)) throw httpErr(400, 'bad', 'Неверная ссылка входа');
    if (!GH_ID || !GH_SECRET) throw httpErr(500, 'config', 'Вход через GitHub ещё не настроен');
    const tr = await fetch(GH_WEB + '/login/oauth/access_token', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'billiard-app' },
      body: JSON.stringify({ client_id: GH_ID, client_secret: GH_SECRET, code })
    });
    const tj = await tr.json().catch(() => ({}));
    if (!tj.access_token) throw httpErr(400, 'code', 'GitHub не подтвердил вход. Попробуй ещё раз.');
    const ur = await fetch(GH_API + '/user', { headers: ghHeaders({ Authorization: 'Bearer ' + tj.access_token }) });
    if (!ur.ok) throw httpErr(502, 'github', 'GitHub не отдал профиль, попробуй ещё раз');
    const gu = await ur.json();
    if (!gu || !gu.id || !gu.login) throw httpErr(502, 'github', 'GitHub не отдал профиль, попробуй ещё раз');
    const uid = 'gh' + gu.id;
    let u = await loadUser(uid);
    if (!u) u = blankUser(gu);
    // тот, кого добавили в друзья до первого входа, уже есть в базе как «заготовка»
    delete u.stub;
    u.login = gu.login; u.name = gu.name || ''; u.avatar = gu.avatar_url || ''; u.lastLogin = new Date().toISOString();
    await saveUser(u);
    const token = await sign(uid);
    const out = { token, user: pub(u) };
    await sPut('auth/' + sha(state) + '.json', Object.assign({ exp: Date.now() + AUTH_TTL }, out));
    return out;
  },

  // установленное приложение ждёт, пока вход завершится в браузере (iPhone открывает GitHub в Safari)
  'auth-poll': async req => {
    const state = String(req.state || '');
    if (!STATE_RE.test(state)) throw httpErr(400, 'bad', 'Неверный запрос');
    const key = 'auth/' + sha(state) + '.json';
    const rec = await sGet(key);
    if (!rec) return { pending: true };
    await sDel(key);
    if (!(rec.exp > Date.now())) return { expired: true };
    return { token: rec.token, user: rec.user };
  },

  me: async req => ({ user: pub(await needUser(req)) }),

  get: async req => {
    const u = await needUser(req);
    const kind = String(req.kind || '');
    if (!KINDS.has(kind)) throw httpErr(400, 'bad', 'Неверный запрос');
    const f = await sGet('data/' + u.id + '/' + kind + '.json');
    const ver = (f && f.ver) || 0;
    if (req.have != null && Number(req.have) === ver) return { ver, same: true };
    return { ver, savedAt: (f && f.savedAt) || '', body: f ? f.body : null };
  },

  put: async req => {
    const u = await needUser(req);
    const kind = String(req.kind || '');
    if (!KINDS.has(kind) || !req.body || typeof req.body !== 'object') throw httpErr(400, 'bad', 'Неверный запрос');
    const key = 'data/' + u.id + '/' + kind + '.json';
    const f = await sGet(key);
    const ver = (f && f.ver) || 0;
    if (Number(req.base) !== ver) return { conflict: true, ver };
    const savedAt = new Date().toISOString();
    await sPut(key, { ver: ver + 1, savedAt, body: req.body });
    if (kind === 'data') {
      const s = cleanStats(req.stats);
      const old = u.stats || {};
      if (s && (s.trainings !== old.trainings || s.shots !== old.shots || s.made !== old.made)) {
        u.stats = Object.assign(s, { at: savedAt });
        await saveUser(u);
      }
    }
    return { ver: ver + 1, savedAt };
  },

  friends: async req => friendsPayload(await needUser(req)),

  'friend-add': async req => {
    const me = await needUser(req);
    const login = String(req.login || '').trim().replace(/^@/, '').replace(/^https?:\/\/github\.com\//i, '').replace(/\/.*$/, '');
    if (!LOGIN_RE.test(login)) throw httpErr(400, 'login', 'Такого ника на GitHub не бывает');
    const gu = await ghUserByLogin(login);
    if (!gu) throw httpErr(404, 'nouser', 'На GitHub нет пользователя «' + login + '»');
    const uid = 'gh' + gu.id;
    if (uid === me.id) throw httpErr(400, 'self', 'Это ты сам');
    let other = await loadUser(uid);
    if (!other) other = Object.assign(blankUser(gu), { stub: true });
    let result = 'sent';
    if (me.friends.includes(uid)) result = 'already';
    else if (me.incoming.includes(uid)) {
      // он уже позвал меня — сразу дружим
      me.incoming = without(me.incoming, uid); other.outgoing = without(other.outgoing, me.id);
      me.friends = withItem(me.friends, uid); other.friends = withItem(other.friends, me.id);
      result = 'friends';
    } else {
      me.outgoing = withItem(me.outgoing, uid); other.incoming = withItem(other.incoming, me.id);
    }
    if (result !== 'already') await Promise.all([saveUser(me), saveUser(other)]);
    return Object.assign({ result, who: pub(other) }, await friendsPayload(me));
  },

  'friend-accept': async req => {
    const me = await needUser(req);
    const uid = String(req.uid || '');
    if (!UID_RE.test(uid) || !me.incoming.includes(uid)) throw httpErr(404, 'gone', 'Заявки уже нет');
    const other = await loadUser(uid);
    me.incoming = without(me.incoming, uid);
    if (other) {
      other.outgoing = without(other.outgoing, me.id);
      me.friends = withItem(me.friends, uid); other.friends = withItem(other.friends, me.id);
      await Promise.all([saveUser(me), saveUser(other)]);
    } else await saveUser(me);
    return friendsPayload(me);
  },

  // отклонить входящую заявку, отменить свою или удалить из друзей
  'friend-remove': async req => {
    const me = await needUser(req);
    const uid = String(req.uid || '');
    if (!UID_RE.test(uid)) throw httpErr(400, 'bad', 'Неверный запрос');
    const other = await loadUser(uid);
    me.friends = without(me.friends, uid); me.incoming = without(me.incoming, uid); me.outgoing = without(me.outgoing, uid);
    const jobs = [saveUser(me)];
    if (other) {
      other.friends = without(other.friends, me.id); other.incoming = without(other.incoming, me.id); other.outgoing = without(other.outgoing, me.id);
      jobs.push(saveUser(other));
    }
    await Promise.all(jobs);
    return friendsPayload(me);
  }
};

function loginRedirect(q) {
  const state = String(q.state || '');
  if (!STATE_RE.test(state)) return page(400, '<meta charset="utf-8"><p>Неверная ссылка входа. Вернись в приложение и нажми «Войти через GitHub» ещё раз.</p>');
  if (!GH_ID) return page(500, '<meta charset="utf-8"><p>Вход через GitHub ещё не настроен.</p>');
  const url = GH_WEB + '/login/oauth/authorize?client_id=' + encodeURIComponent(GH_ID) + '&redirect_uri=' + encodeURIComponent(APP_URL) + '&state=' + state + '&allow_signup=true';
  return { statusCode: 302, headers: Object.assign({ Location: url, 'Cache-Control': 'no-store' }, CORS), body: '', isBase64Encoded: false };
}

module.exports.handler = async function (event, context) {
  iam = (context && context.token && context.token.access_token) || process.env.TEST_IAM || '';
  const method = String((event && event.httpMethod) || 'POST').toUpperCase();
  if (method === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '', isBase64Encoded: false };
  const q = (event && event.queryStringParameters) || {};
  if (method === 'GET') {
    if (q.a === 'login') return loginRedirect(q);
    return json(200, { ok: true, app: 'billiard' });
  }
  let req;
  try {
    let raw = (event && event.body) || '';
    if (event && event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
    if (raw.length > MAX_BODY) return json(413, { error: 'big', message: 'Слишком много данных за раз' });
    req = JSON.parse(raw || '{}');
  } catch (e) { return json(400, { error: 'bad', message: 'Неверный запрос' }); }
  const fn = actions[req && req.a];
  if (!fn) return json(400, { error: 'bad', message: 'Неизвестное действие' });
  if (!BUCKET) return json(500, { error: 'config', message: 'Сервер ещё не настроен' });
  try {
    return json(200, await fn(req));
  } catch (e) {
    if (e && e.status) return json(e.status, { error: e.code || 'error', message: e.message });
    console.error(e);
    return json(500, { error: 'error', message: 'Ошибка сервера' });
  }
};
