/* My Planner — reminder sender.
   Runs every ~10 minutes from .github/workflows/reminders.yml. For every
   user who turned reminders on (users/{uid}/data/push), it works out which
   reminders are due in THEIR time zone and sends them through Firebase
   Cloud Messaging. Each reminder is sent at most once per day (push.sent).

   Env:
     FIREBASE_SERVICE_ACCOUNT  service-account JSON (GitHub secret)
     DRY_RUN=1                 print instead of sending (local testing)
     FIRESTORE_EMULATOR_HOST   point at the emulator (local testing)
     NOW=ISO-date              pretend it's this moment (local testing) */
const admin = require('firebase-admin');

const DRY = process.env.DRY_RUN === '1';
const APP_URL = 'https://trxhq8.github.io/Schedule/';
const LATE_OK_MIN = 45; // the scheduler can run late; still send within this window

function init() {
  if (process.env.FIRESTORE_EMULATOR_HOST) { admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-schedule' }); return true; }
  let sa = null;
  try { sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || ''); } catch (e) {}
  if (!sa || !sa.project_id) { console.log('No FIREBASE_SERVICE_ACCOUNT secret yet — nothing to do.'); return false; }
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  return true;
}

const NOW = process.env.NOW ? new Date(process.env.NOW) : new Date();
function localParts(tz) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(NOW).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, H: +p.hour, M: +p.minute };
}
function hijriMonth(tz) {
  try { return +new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', { timeZone: tz, month: 'numeric' }).format(NOW); } catch (e) { return 0; }
}
const toMin = hm => { const [h, m] = String(hm || '').split(':').map(Number); return isNaN(h) ? null : h * 60 + (m || 0); };
const pad = n => String(n).padStart(2, '0');

const ptCache = {};
async function prayerTimes(cfg, lp) {
  const dd = `${pad(lp.d)}-${pad(lp.m)}-${lp.y}`;
  const key = `${cfg.city}|${cfg.country}|${cfg.method}|${dd}`;
  if (ptCache[key] !== undefined) return ptCache[key];
  try {
    const r = await fetch(`https://api.aladhan.com/v1/timingsByCity/${dd}?city=${encodeURIComponent(cfg.city)}&country=${encodeURIComponent(cfg.country)}&method=${cfg.method || 3}`);
    const j = await r.json();
    ptCache[key] = j.code === 200 ? j.data.timings : null;
  } catch (e) { ptCache[key] = null; }
  return ptCache[key];
}

const PRAYERS = [['Fajr', 'الفجر'], ['Dhuhr', 'الظهر'], ['Asr', 'العصر'], ['Maghrib', 'المغرب'], ['Isha', 'العشاء']];
function text(lang, kind, x) {
  const ar = lang !== 'en';
  switch (kind) {
    case 'morning': return ar ? ['☀️ صباح الخير', 'يومك جاهز بمخططي — افتح وشوف خطتك'] : ['☀️ Good morning', 'Your day is ready in My Planner — take a look.'];
    case 'prayer': return ar
      ? [`🕌 ${x.ar}`, x.lead ? `باقي ${x.lead} دقيقة على صلاة ${x.ar}` : `حان وقت صلاة ${x.ar}`]
      : [`🕌 ${x.en}`, x.lead ? `${x.en} in ${x.lead} minutes` : `It’s time for ${x.en}`];
    case 'evening': return ar ? [`🔥 سلسلتك ${x.risk} يوم بخطر`, 'باقي لك شوية — خلّص يومك قبل النوم'] : [`🔥 Your ${x.risk}-day streak is at risk`, 'A few things left — finish your day before bed.'];
    case 'suhoor': return ar ? ['🌙 السحور', 'باقي ٤٥ دقيقة على الفجر'] : ['🌙 Suhoor', '45 minutes until Fajr'];
    case 'iftar': return ar ? ['🌙 حان وقت الإفطار', 'تقبل الله صيامك'] : ['🌙 Time for iftar', 'May your fast be accepted'];
  }
  return ['My Planner', ''];
}

/* every reminder that is due for this user right now */
async function dueFor(push) {
  const tz = push.tz || 'Asia/Kuwait';
  const lp = localParts(tz);
  const today = `${lp.y}-${pad(lp.m)}-${pad(lp.d)}`;
  const nowMin = lp.H * 60 + lp.M;
  const pf = push.prefs || {};
  const lang = push.lang || 'ar';
  const out = [];
  const add = (id, atMin, kind, x) => {
    if (atMin == null) return;
    const late = nowMin - atMin;
    if (late < 0 || late > LATE_OK_MIN) return;
    const key = `${id}:${today}`;
    if (push.sent && push.sent[key]) return;
    const [title, body] = text(lang, kind, x || {});
    out.push({ key, title, body, tag: id });
  };
  if (pf.morning) add('morning', toMin(pf.morning), 'morning');
  if (pf.evening && push.day && push.day.date === today && (push.day.risk || 0) >= 3 && (push.day.pct || 0) < 100) add('evening', 21 * 60, 'evening', { risk: push.day.risk });
  const wantPrayers = pf.prayers && push.hasPrayers;
  const ramadan = pf.ramadan && hijriMonth(tz) === 9;
  if ((wantPrayers || ramadan) && push.prayerCfg) {
    const tm = await prayerTimes(push.prayerCfg, lp);
    if (tm) {
      if (wantPrayers) for (const [en, ar] of PRAYERS) add('prayer-' + en, toMin(tm[en]) - (pf.prayerLead || 0), 'prayer', { en, ar, lead: pf.prayerLead || 0 });
      if (ramadan) { add('suhoor', toMin(tm.Fajr) - 45, 'suhoor'); add('iftar', toMin(tm.Maghrib), 'iftar'); }
    }
  }
  return { out, today };
}

async function sendTo(tokens, n) {
  if (DRY) { console.log('  [dry-run]', n.title, '—', n.body); return { bad: [] }; }
  const res = await admin.messaging().sendEachForMulticast({
    tokens,
    webpush: { headers: { Urgency: 'high', TTL: '3600' }, data: { title: n.title, body: n.body, url: APP_URL, tag: n.tag } }
  });
  const bad = [];
  res.responses.forEach((r, i) => {
    const code = r.error && r.error.code;
    if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token' || code === 'messaging/invalid-argument') bad.push(tokens[i]);
  });
  return { bad, ok: res.successCount };
}

(async () => {
  if (!init()) return;
  const db = admin.firestore();
  const refs = await db.collection('users').listDocuments();
  let users = 0, sent = 0;
  for (const ref of refs) {
    const snap = await ref.collection('data').doc('push').get();
    if (!snap.exists) continue;
    const push = snap.data();
    if (!push.prefs || !push.prefs.enabled || !(push.tokens || []).length) continue;
    users++;
    const { out, today } = await dueFor(push);
    // "Send me a test" from the app's Reminders settings
    const testAt = push.testAt && push.testAt.toDate ? push.testAt.toDate() : null;
    const testSent = push.testSentAt && push.testSentAt.toDate ? push.testSentAt.toDate() : null;
    if (testAt && (!testSent || testSent < testAt)) {
      const ar = (push.lang || 'ar') !== 'en';
      out.push({ key: 'test:' + today + ':' + testAt.getTime(), title: ar ? '🔔 التذكيرات شغالة!' : '🔔 Reminders work!', body: ar ? 'هذا تذكير تجربة من مخططي' : 'This is a test reminder from My Planner', tag: 'test', test: true });
    }
    if (!out.length) continue;
    let tokens = push.tokens.slice();
    const sentMap = { ...(push.sent || {}) };
    for (const n of out) {
      const r = await sendTo(tokens, n);
      if (r.bad.length) tokens = tokens.filter(t => !r.bad.includes(t));
      sentMap[n.key] = true; sent++;
    }
    // keep a few days of "already sent" keys
    const cutoff = new Date(NOW.getTime() - 3 * 864e5).toISOString().slice(0, 10);
    Object.keys(sentMap).forEach(k => { const d = k.split(':')[1]; if (d && d < cutoff) delete sentMap[k]; });
    const upd = { sent: sentMap, tokens };
    if (out.some(n => n.test)) upd.testSentAt = admin.firestore.FieldValue.serverTimestamp();
    Object.keys(upd.sent).forEach(k => { if (k.startsWith('test:')) delete upd.sent[k]; });
    await ref.collection('data').doc('push').set(upd, { merge: true });
    console.log(`user ${ref.id.slice(0, 6)}…: ${out.map(n => n.tag).join(', ')} (${today})`);
  }
  console.log(`done: ${users} user(s) with reminders on, ${sent} reminder(s) sent`);
})().catch(e => { console.error(e); process.exit(1); });
