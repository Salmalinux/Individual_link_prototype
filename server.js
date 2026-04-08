const express = require('express');
const { v4: uuidv4 } = require('uuid');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ─── Persistent storage setup ──────────────────────────────────────────────────
// Use /data if a Railway Volume is mounted there, otherwise fall back to local dir
const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const INVITES_FILE = path.join(DATA_DIR, 'invites.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// Load invites from file on startup
function loadInvites() {
  try {
    if (fs.existsSync(INVITES_FILE)) {
      return JSON.parse(fs.readFileSync(INVITES_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading invites:', e.message);
  }
  return {};
}

// Save invites to file
function saveInvites() {
  try {
    fs.writeFileSync(INVITES_FILE, JSON.stringify(invites, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving invites:', e.message);
  }
}

// Load settings from file on startup
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading settings:', e.message);
  }
  return {};
}

// Save settings to file
function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ waLink: WA_GROUP_LINK }, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving settings:', e.message);
  }
}

// ─── Initialize from persisted data ────────────────────────────────────────────
const invites = loadInvites();
const savedSettings = loadSettings();
let WA_GROUP_LINK = savedSettings.waLink || process.env.WA_GROUP_LINK || '';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'invites@yourdomain.com';
const ORG_NAME = process.env.ORG_NAME || 'IGNITE YOUTH EMPOWERMENT INITIATIVE';

console.log(`Data directory: ${DATA_DIR}`);
console.log(`Loaded ${Object.keys(invites).length} existing invites from disk`);

// ─── Auth ──────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── Settings ─────────────────────────────────────────────────────────────────
app.get('/api/settings', requireAuth, (req, res) => {
  res.json({ waLink: WA_GROUP_LINK, orgName: ORG_NAME, fromEmail: FROM_EMAIL });
});

app.post('/api/settings', requireAuth, (req, res) => {
  const { waLink } = req.body;
  if (!waLink || !waLink.startsWith('https://chat.whatsapp.com/'))
    return res.status(400).json({ error: 'Invalid WhatsApp link' });
  WA_GROUP_LINK = waLink;
  saveSettings(); // ← Persist to disk
  res.json({ ok: true });
});

// ─── Single invite ─────────────────────────────────────────────────────────────
app.post('/api/invites', requireAuth, (req, res) => {
  const { name, phone, email } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });
  const inv = createInvite(name, phone, email || '');
  const host = `${req.protocol}://${req.get('host')}`;
  res.json({ token: inv.token, link: `${host}/join/${inv.token}` });
});

// ─── Bulk invite ───────────────────────────────────────────────────────────────
app.post('/api/invites/bulk', requireAuth, async (req, res) => {
  const { members } = req.body; // [{ name, phone, email }]
  if (!Array.isArray(members) || members.length === 0)
    return res.status(400).json({ error: 'No members provided' });

  const host = `${req.protocol}://${req.get('host')}`;
  const results = [];

  for (const m of members) {
    if (!m.name || !m.phone) { results.push({ ...m, status: 'skipped', reason: 'Missing name or phone' }); continue; }
    const inv = createInvite(m.name.trim(), m.phone.trim(), (m.email || '').trim());
    const link = `${host}/join/${inv.token}`;
    let emailStatus = 'no_email';

    if (m.email && RESEND_API_KEY) {
      try {
        await sendEmail(m.email.trim(), m.name.trim(), link);
        emailStatus = 'sent';
      } catch (e) {
        emailStatus = 'failed';
      }
    }
    results.push({ name: inv.name, phone: inv.phone, email: inv.email, token: inv.token, link, emailStatus });
  }

  res.json({ ok: true, results });
});

// ─── List invites ──────────────────────────────────────────────────────────────
app.get('/api/invites', requireAuth, (req, res) => {
  const host = `${req.protocol}://${req.get('host')}`;
  const list = Object.values(invites).map(i => ({ ...i, link: `${host}/join/${i.token}` }));
  res.json(list.reverse());
});

// ─── Revoke invite ─────────────────────────────────────────────────────────────
app.delete('/api/invites/:token', requireAuth, (req, res) => {
  const inv = invites[req.params.token];
  if (!inv) return res.status(404).json({ error: 'Not found' });
  if (inv.status !== 'pending') return res.status(400).json({ error: 'Cannot revoke' });
  inv.status = 'revoked';
  saveInvites(); // ← Persist to disk
  res.json({ ok: true });
});

// ─── Reset all invites ─────────────────────────────────────────────────────────
app.post('/api/invites/reset', requireAuth, (req, res) => {
  // Delete all invite keys from the object
  for (const key of Object.keys(invites)) {
    delete invites[key];
  }
  saveInvites(); // ← Persist empty state to disk
  console.log('All invite data has been reset by admin');
  res.json({ ok: true });
});

// ─── PUBLIC: Show join page (GET — does NOT consume link, safe from scanners) ──
app.get('/join/:token', (req, res) => {
  const inv = invites[req.params.token];
  if (!inv) return res.send(errorPage('This invite link is invalid or does not exist.'));
  if (inv.status === 'used') return res.send(errorPage('This invite link has already been used. Each link can only be used once. Please contact your admin for a new one.'));
  if (inv.status === 'revoked') return res.send(errorPage('This invite link has been revoked. Please contact your admin.'));
  if (!WA_GROUP_LINK) return res.send(errorPage('The group link has not been set up yet. Please contact your admin.'));
  // Show confirmation page — link is NOT consumed yet
  res.send(confirmPage(inv.name, inv.token));
});

// ─── PUBLIC: Confirm join (POST — consumes link, only real users do this) ─────
app.post('/join/:token', (req, res) => {
  const inv = invites[req.params.token];
  if (!inv) return res.send(errorPage('This invite link is invalid.'));
  if (inv.status === 'used') return res.send(errorPage('This invite link has already been used.'));
  if (inv.status === 'revoked') return res.send(errorPage('This invite link has been revoked.'));
  if (!WA_GROUP_LINK) return res.send(errorPage('Group link not configured.'));
  // NOW consume the link
  inv.status = 'used';
  inv.usedAt = new Date().toISOString();
  saveInvites(); // ← Persist to disk
  res.send(redirectPage(inv.name, WA_GROUP_LINK));
});

// ─── Helpers ───────────────────────────────────────────────────────────────────
function createInvite(name, phone, email) {
  const token = uuidv4().replace(/-/g, '').substring(0, 16);
  invites[token] = { token, name, phone, email, status: 'pending', createdAt: new Date().toISOString(), usedAt: null };
  saveInvites(); // ← Persist to disk
  return invites[token];
}

function sendEmail(to, name, link) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      from: `${ORG_NAME} <${FROM_EMAIL}>`,
      to: [to],
      subject: `Your invitation to join ${ORG_NAME}`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:2rem;">
          <h2 style="color:#111;">Assalamu Alaikum, ${name}!</h2>
          <p style="color:#444;line-height:1.6;">You have been invited to join the <strong>${ORG_NAME}</strong> WhatsApp group.</p>
          <p style="color:#444;line-height:1.6;">Click the button below to join. This link is unique to you and can only be used once.</p>
          <a href="${link}" style="display:inline-block;margin:1.5rem 0;background:#25D366;color:white;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px;">Join the Group</a>
          <p style="color:#999;font-size:12px;">If the button doesn't work, copy this link into your browser:<br>${link}</p>
          <p style="color:#999;font-size:12px;">Do not share this link — it is personal to you.</p>
        </div>
      `
    });

    const options = {
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };

    const req = https.request(options, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => r.statusCode < 300 ? resolve(d) : reject(new Error(d)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Pages ─────────────────────────────────────────────────────────────────────
function confirmPage(name, token) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Join ${ORG_NAME}</title>
  <style>
    body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5;}
    .box{background:white;border-radius:16px;padding:2rem;max-width:360px;width:90%;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,0.08);}
    .icon{font-size:48px;margin-bottom:1rem;}
    h2{margin:0 0 0.5rem;font-size:20px;color:#111;}
    p{color:#666;font-size:14px;line-height:1.6;margin:0 0 1.5rem;}
    button{background:#25D366;color:white;border:none;padding:14px 28px;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;width:100%;}
    button:hover{background:#1ebe5d;}
    .note{font-size:12px;color:#aaa;margin-top:1rem;}
  </style>
</head>
<body>
  <div class="box">
    <div class="icon">👋</div>
    <h2>Welcome, ${name}!</h2>
    <p>You have been invited to join the <strong>${ORG_NAME}</strong> WhatsApp group. Click the button below to join.</p>
    <form method="POST" action="/join/${token}">
      <button type="submit">Join WhatsApp Group</button>
    </form>
    <p class="note">This link is personal to you. Do not share it.</p>
  </div>
</body>
</html>`;
}

function redirectPage(name, waLink) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Joining group...</title>
  <style>
    body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5;}
    .box{background:white;border-radius:16px;padding:2rem;max-width:360px;width:90%;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,0.08);}
    .icon{font-size:48px;margin-bottom:1rem;}
    h2{margin:0 0 0.5rem;font-size:20px;color:#111;}
    p{color:#666;font-size:14px;line-height:1.6;}
    a{display:inline-block;margin-top:1rem;background:#25D366;color:white;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px;}
  </style>
  <script>setTimeout(()=>window.location.href="${waLink}",2500);</script>
</head>
<body>
  <div class="box">
    <div class="icon">✅</div>
    <h2>You're in, ${name}!</h2>
    <p>Redirecting you to the WhatsApp group now...</p>
    <a href="${waLink}">Open WhatsApp group</a>
  </div>
</body>
</html>`;
}

function errorPage(message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Invalid Invite</title>
  <style>
    body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5;}
    .box{background:white;border-radius:16px;padding:2rem;max-width:360px;width:90%;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,0.08);}
    .icon{font-size:48px;margin-bottom:1rem;}
    h2{margin:0 0 0.75rem;font-size:18px;color:#111;}
    p{color:#666;font-size:14px;line-height:1.6;margin:0;}
  </style>
</head>
<body>
  <div class="box">
    <div class="icon">🔒</div>
    <h2>Link not valid</h2>
    <p>${message}</p>
  </div>
</body>
</html>`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Invite system running on port ${PORT}`));
