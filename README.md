# Webflow CMS Sync Server

Automatically forwards new CMS items from one Webflow site to another — including rich text and images — and publishes them instantly.

---

## How it works

1. You create a CMS item on your **source** Webflow site
2. Webflow fires a webhook to this server
3. The server fetches the full item (with all fields)
4. Rich-text HTML is parsed, embedded images are re-uploaded to the destination site
5. The item is created on the **destination** Webflow site
6. The destination site is published automatically

---

## Setup

### 1. Clone & install

```bash
git clone <your-repo>
cd webflow-sync
npm install
```

### 2. Configure environment variables

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Where to find it |
|---|---|
| `SOURCE_API_TOKEN` | Source site → Site Settings → Integrations → API Access → Generate Token |
| `SOURCE_COLLECTION_ID` | Source site → CMS → your collection → URL contains the ID |
| `DEST_API_TOKEN` | Destination site → Site Settings → Integrations → API Access |
| `DEST_COLLECTION_ID` | Destination site → CMS → your collection → URL |
| `DEST_SITE_ID` | Destination site → Site Settings → General → Site ID |
| `WEBHOOK_SECRET` | Make up a random string, e.g. `openssl rand -hex 32` |

### 3. Deploy the server

#### Option A: Railway (easiest)
1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Add your environment variables in the Railway dashboard
4. Railway gives you a public URL automatically

#### Option B: Render
1. Push to GitHub
2. Go to [render.com](https://render.com) → New Web Service
3. Connect your repo, set `npm start` as the start command
4. Add environment variables in the Render dashboard

#### Option C: VPS (Ubuntu/Debian)
```bash
# Install Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone and install
git clone <your-repo> /opt/webflow-sync
cd /opt/webflow-sync
npm install

# Set up environment
cp .env.example .env
nano .env  # fill in your values

# Run with PM2 (keeps it alive)
npm install -g pm2
pm2 start index.js --name webflow-sync
pm2 save
pm2 startup
```

### 4. Register the Webflow webhook

1. In your **source** Webflow site, go to **Site Settings → Integrations → Webhooks**
2. Click **Add Webhook**
3. Set the trigger to **Collection Item Created**
4. Set the URL to:
   ```
   https://your-server-url.com/webhook/collection-item-created?secret=YOUR_WEBHOOK_SECRET
   ```
5. Save

> ⚠️ Make sure to use your actual `WEBHOOK_SECRET` value in the URL query string.

---

## Testing

Once deployed, you can verify the server is running:

```bash
curl https://your-server-url.com/health
# → {"status":"ok"}
```

Then create a test item in your source Webflow collection and watch the logs — it should appear published on the destination site within seconds.

---

## Troubleshooting

**Items created but not published**
→ Make sure `DEST_SITE_ID` is correct. Check server logs for publish errors.

**Images not syncing**
→ Source images must be publicly accessible URLs. If they're behind auth, the re-upload will fail and the original URL is used as fallback.

**Rich text looks broken**
→ Confirm the destination collection's rich-text field slug matches exactly.

**401 Unauthorized errors**
→ Check that your `WEBHOOK_SECRET` in the `.env` matches the `?secret=` in your Webflow webhook URL.

**Webflow API rate limits**
→ Webflow allows 60 requests/minute. If you're bulk-creating many items, add a delay between syncs.

---

## Field mapping

Since both collections have identical schemas, fields are forwarded as-is. If you ever need to rename or transform fields, edit the `processFields` function in `index.js`:

```js
async function processFields(fieldData) {
  const processed = {};
  for (const [key, value] of Object.entries(fieldData)) {
    // Example: rename a field
    // if (key === 'old-field-name') { processed['new-field-name'] = value; continue; }
    
    // ... rest of processing
    processed[key] = value;
  }
  return processed;
}
```
