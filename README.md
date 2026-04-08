# WhatsApp Invite Manager

A one-time invite link system for WhatsApp groups. Each member gets a unique link. Once used, it expires — if shared, it won't work.

## Files in this project
- `server.js` — the backend
- `public/index.html` — the admin dashboard
- `package.json` — dependencies

## Setup on Glitch

### Step 1 — Environment variables
In Glitch, click on your project name at the top → **Settings** → **Environment variables**, then add:

| Key | Value |
|-----|-------|
| `ADMIN_PASSWORD` | Choose a strong password for admin login |
| `WA_GROUP_LINK` | (optional) Your WhatsApp group link |

### Step 2 — You're live!
Your admin dashboard is at:
`https://your-project-name.glitch.me`

Log in with the password you set above.

### Step 3 — Using the system
1. Go to **Settings** tab → paste your WhatsApp group link → Save
2. Go to **Generate invite** → enter member's name + phone → Generate
3. Copy the unique link and send it to the member directly
4. When they click it, they join the group — link expires instantly
5. Track all invites in the **Members** tab

## Security notes
- The admin dashboard is protected by password
- The real WhatsApp link is never visible to members
- Links are single-use only
- You can revoke pending links anytime
<img width="109" height="1074" alt="image" src="https://github.com/user-attachments/assets/b6cfc427-7e95-49d2-8528-b1136c075a27" />
