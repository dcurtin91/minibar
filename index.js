require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
app.use(express.json());

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
  source: {
    token: process.env.SOURCE_API_TOKEN,
    collectionId: process.env.SOURCE_COLLECTION_ID,
  },
  dest: {
    token: process.env.DEST_API_TOKEN,
    collectionId: process.env.DEST_COLLECTION_ID,
    siteId: process.env.DEST_SITE_ID,
  },
  webhookSecret: process.env.WEBHOOK_SECRET,
  port: process.env.PORT || 3000,
};

// ─── Webflow API helpers ───────────────────────────────────────────────────────

async function rewriteRichTextImages(html) {
  if (!html) return html;
  const $ = cheerio.load(html, { xmlMode: true });
  const imgTags = $("img").toArray();
  for (const el of imgTags) {
    const src = $(el).attr("src");
    if (!src) continue;
    try {
      const newUrl = await uploadImageToDestination(src);
      $(el).attr("src", newUrl);
      console.log(`  ↳ Rewrote image: ${src} → ${newUrl}`);
    } catch (err) {
      console.warn(`  ↳ Image upload failed, keeping original URL: ${src}`, err.message);
    }
  }
  return $("body").html();
}

async function uploadImageToDestination(imageUrl) {
  const imageResponse = await axios.get(imageUrl, { responseType: "arraybuffer" });
  const imageBuffer = Buffer.from(imageResponse.data);
  const contentType = imageResponse.headers["content-type"] || "image/jpeg";
  const fileName = imageUrl.split("/").pop().split("?")[0] || "image.jpg";
  const fileHash = require("crypto").createHash("md5").update(imageBuffer).digest("hex");

  const registerRes = await axios.post(
    `https://api.webflow.com/v2/sites/${CONFIG.dest.siteId}/assets`,
    { fileName, fileHash },
    { headers: { Authorization: `Bearer ${CONFIG.dest.token}`, "Content-Type": "application/json", "accept-version": "1.0.0" } }
  );

  const { uploadUrl, uploadDetails, hostedUrl } = registerRes.data;
  const FormData = require("form-data");
  const form = new FormData();
  Object.entries(uploadDetails).forEach(([k, v]) => form.append(k, v));
  form.append("file", imageBuffer, { filename: fileName, contentType });
  await axios.post(uploadUrl, form, { headers: form.getHeaders() });
  return hostedUrl;
}

async function processFields(fieldData) {
  const processed = {};
  for (const [key, value] of Object.entries(fieldData)) {
    // Skip internal Webflow fields
    if (key.startsWith("_")) continue;

    if (typeof value === "string" && value.trim().startsWith("<")) {
      console.log(`  Processing rich-text field: ${key}`);
      processed[key] = await rewriteRichTextImages(value);
    } else if (value && typeof value === "object" && value.url) {
      processed[key] = { url: value.url, alt: value.alt || "" };
    } else {
      processed[key] = value;
    }
  }
  return processed;
}

async function findDestinationItemBySlug(slug) {
  const url = `https://api.webflow.com/v2/collections/${CONFIG.dest.collectionId}/items`;
  const { data } = await axios.get(url, {
    params: { limit: 1, slug },
    headers: { Authorization: `Bearer ${CONFIG.dest.token}`, "accept-version": "1.0.0" },
  });
  const items = data?.items || [];
  return items.find((i) => i.fieldData?.slug === slug) || null;
}

async function createDestinationItem(fieldData) {
  const url = `https://api.webflow.com/v2/collections/${CONFIG.dest.collectionId}/items`;
  const { data } = await axios.post(
    url,
    { fieldData, isDraft: false },
    { headers: { Authorization: `Bearer ${CONFIG.dest.token}`, "Content-Type": "application/json", "accept-version": "1.0.0" } }
  );
  return data;
}

async function updateDestinationItem(itemId, fieldData) {
  const url = `https://api.webflow.com/v2/collections/${CONFIG.dest.collectionId}/items/${itemId}`;
  const { data } = await axios.patch(
    url,
    { fieldData, isDraft: false },
    { headers: { Authorization: `Bearer ${CONFIG.dest.token}`, "Content-Type": "application/json", "accept-version": "1.0.0" } }
  );
  return data;
}

async function publishDestinationSite() {
  const url = `https://api.webflow.com/v2/sites/${CONFIG.dest.siteId}/publish`;
  await axios.post(
    url,
    { publishToWebflowSubdomain: true },
    { headers: { Authorization: `Bearer ${CONFIG.dest.token}`, "Content-Type": "application/json", "accept-version": "1.0.0" } }
  );
}

// ─── Webhook endpoint ──────────────────────────────────────────────────────────

function authenticate(req) {
  const secret = req.query.secret || req.headers["x-webhook-secret"];
  return secret === CONFIG.webhookSecret;
}

app.post("/webhook/collection-item-published", async (req, res) => {
  if (!authenticate(req)) {
    console.warn("Unauthorized webhook request");
    return res.status(401).json({ error: "Unauthorized" });
  }

  const payload = req.body;

  // collection_item_published sends an array of items under payload.items
  const items = payload?.payload?.items;
  if (!items || items.length === 0) {
    console.error("No items found in payload:", JSON.stringify(payload));
    return res.status(400).json({ error: "No items in payload" });
  }

  // Respond immediately to avoid Webflow timeout
  res.status(200).json({ received: true, count: items.length });

  // Process each item in the batch
  for (const item of items) {
    const itemId = item.id || item._id;
    const fieldData = item.fieldData;

    if (!itemId || !fieldData) {
      console.error("Skipping item — missing id or fieldData:", item);
      continue;
    }

    syncItem(itemId, fieldData).catch((err) =>
      console.error(`❌ Sync failed for item ${itemId}:`, err.message)
    );
  }
});

/**
 * Core sync — process fields from the webhook payload, upsert by slug, publish.
 * No extra API call needed — the full fieldData comes in the webhook payload.
 */
async function syncItem(itemId, rawFields) {
  console.log(`\n🔄 Syncing item: ${itemId}`);
  const slug = rawFields?.slug;
  console.log("  Slug:", slug);
  console.log("  Fields:", Object.keys(rawFields).join(", "));

  // 1. Process fields (rich text + images, skip internal _ fields)
  console.log("  Processing fields...");
  const processedFields = await processFields(rawFields);

  // 2. Upsert by slug — update if exists, create if not
  console.log("  Checking for existing item on destination...");
  const existingItem = slug ? await findDestinationItemBySlug(slug) : null;

  let resultItem;
  if (existingItem) {
    console.log(`  Found existing item: ${existingItem.id} — updating...`);
    resultItem = await updateDestinationItem(existingItem.id, processedFields);
    console.log("  ✅ Updated item:", resultItem.id);
  } else {
    console.log("  No existing item found — creating...");
    resultItem = await createDestinationItem(processedFields);
    console.log("  ✅ Created item:", resultItem.id);
  }

  // 3. Publish destination site
  console.log("  Publishing destination site...");
  await publishDestinationSite();
  console.log("  ✅ Site published");

  console.log(`\n✅ Sync complete for item ${itemId} → ${resultItem.id}`);
}

// ─── Health check ─────────────────────────────────────────────────────────────

app.get("/health", (_, res) => res.json({ status: "ok" }));

// ─── Start server ──────────────────────────────────────────────────────────────

app.listen(CONFIG.port, () => {
  console.log(`\n🚀 Webflow Sync Server running on port ${CONFIG.port}`);
  console.log(`   Webhook URL: http://your-server.com/webhook/collection-item-published?secret=${CONFIG.webhookSecret}`);
  console.log(`   Health check: http://your-server.com/health\n`);
});