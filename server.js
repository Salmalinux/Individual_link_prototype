const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// In-memory store (persists while app is running on Glitch)
// Glitch keeps your app alive so this works fine for small orgs
const invites = {};
let WA_GROUP_LINK = process.env.WA_GROUP_LINK || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';

// ─── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const pwd = req.headers['x-admin-password'];
  if (pwd !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── Admin: set WhatsApp group link ───────────────────────────────────────────
app.post('/api/settings', requireAuth, (req, res) => {
  const { waLink } = req.body;
  if (!waLink || !waLink.startsWith('https://chat.whatsapp.com/')) {
    return res.status(400).json({ error: 'Invalid WhatsApp link' });
  }
  WA_GROUP_LINK = waLink;
  res.json({ ok: true });
});

app.get('/api/settings', requireAuth, (req, res) => {
  res.json({ waLink: WA_GROUP_LINK });
});

// ─── Admin: generate invite ────────────────────────────────────────────────────
app.post('/api/invites', requireAuth, (req, res) => {
  const { name, phone } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });

  const token = uuidv4().replace(/-/g, '').substring(0, 16);
  invites[token] = {
    token,
    name,
    phone,
    status: 'pending',
    createdAt: new Date().toISOString(),
    usedAt: null,
  };

  res.json({ token, link: `${req.protocol}://${req.get('host')}/join/${token}` });
});

// ─── Admin: list invites ───────────────────────────────────────────────────────
app.get('/api/invites', requireAuth, (req, res) => {
  const host = `${req.protocol}://${req.get('host')}`;
  const list = Object.values(invites).map(i => ({
    ...i,
    link: `${host}/join/${i.token}`,
  }));
  res.json(list.reverse());
});

// ─── Admin: revoke invite ──────────────────────────────────────────────────────
app.delete('/api/invites/:token', requireAuth, (req, res) => {
  const inv = invites[req.params.token];
  if (!inv) return res.status(404).json({ error: 'Not found' });
  if (inv.status !== 'pending') return res.status(400).json({ error: 'Cannot revoke — already used or expired' });
  inv.status = 'revoked';
  res.json({ ok: true });
});

// ─── Public: use invite link ───────────────────────────────────────────────────
app.get('/join/:token', (req, res) => {
  const inv = invites[req.params.token];

  if (!inv) {
    return res.send(errorPage('This invite link is invalid.'));
  }

  if (inv.status === 'used') {
    return res.send(errorPage(`This invite link has already been used. Each link can only be used once. Please contact your admin for a new one.`));
  }

  if (inv.status === 'revoked') {
    return res.send(errorPage('This invite link has been revoked. Please contact your admin.'));
  }

  if (!WA_GROUP_LINK) {
    return res.send(errorPage('The group link has not been configured yet. Please contact your admin.'));
  }

  // Mark as used
  inv.status = 'used';
  inv.usedAt = new Date().toISOString();

  // Redirect to WhatsApp group
  res.send(redirectPage(inv.name, WA_GROUP_LINK));
});

// ─── Pages ─────────────────────────────────────────────────────────────────────
function errorPage(message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Invalid Invite</title>
  <style>
    body { font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
    .box { background: white; border-radius: 16px; padding: 2rem; max-width: 360px; text-align: center; }
    .icon { font-size: 40px; margin-bottom: 1rem; }
    h2 { margin: 0 0 0.75rem; font-size: 18px; color: #111; }
    p { color: #666; font-size: 14px; line-height: 1.6; margin: 0; }
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

function redirectPage(name, waLink) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Joining group...</title>
  <style>
    body { font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
    .box { background: white; border-radius: 16px; padding: 2rem; max-width: 360px; text-align: center; }
    .icon { font-size: 40px; margin-bottom: 1rem; }
    h2 { margin: 0 0 0.75rem; font-size: 18px; color: #111; }
    p { color: #666; font-size: 14px; line-height: 1.6; }
    a { display: inline-block; margin-top: 1rem; background: #25D366; color: white; padding: 12px 24px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 15px; }
  </style>
  <script>setTimeout(() => window.location.href = "${waLink}", 2000);</script>
</head>
<body>
  <div class="box">
    <div class="icon">✅</div>
    <h2>Welcome, ${name}!</h2>
    <p>Your invite is valid. You are being redirected to the WhatsApp group now...</p>
    <a href="${waLink}">Open WhatsApp group</a>
  </div>
</body>
</html>`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Invite system running on port ${PORT}`));
