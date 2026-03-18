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

async function fetchSourceItem(itemId) {
  const url = `https://api.webflow.com/v2/collections/${CONFIG.source.collectionId}/items/${itemId}`;
  const { data } = await axios.get(url, {
    headers: { Authorization: `Bearer ${CONFIG.source.token}`, "accept-version": "1.0.0" },
  });
  return data;
}

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

/**
 * Search the destination collection for an existing item by slug.
 * Returns the item if found, or null.
 */
async function findDestinationItemBySlug(slug) {
  const url = `https://api.webflow.com/v2/collections/${CONFIG.dest.collectionId}/items`;
  const { data } = await axios.get(url, {
    params: { limit: 1, slug },
    headers: { Authorization: `Bearer ${CONFIG.dest.token}`, "accept-version": "1.0.0" },
  });
  const items = data?.items || [];
  // Double-check slug since Webflow may do partial matching
  return items.find((i) => i.fieldData?.slug === slug) || null;
}

/**
 * Create a new CMS item on the destination site.
 */
async function createDestinationItem(fieldData) {
  const url = `https://api.webflow.com/v2/collections/${CONFIG.dest.collectionId}/items`;
  const { data } = await axios.post(
    url,
    { fieldData, isDraft: false },
    { headers: { Authorization: `Bearer ${CONFIG.dest.token}`, "Content-Type": "application/json", "accept-version": "1.0.0" } }
  );
  return data;
}

/**
 * Update an existing CMS item on the destination site.
 */
async function updateDestinationItem(itemId, fieldData) {
  const url = `https://api.webflow.com/v2/collections/${CONFIG.dest.collectionId}/items/${itemId}`;
  const { data } = await axios.patch(
    url,
    { fieldData, isDraft: false },
    { headers: { Authorization: `Bearer ${CONFIG.dest.token}`, "Content-Type": "application/json", "accept-version": "1.0.0" } }
  );
  return data;
}

/**
 * Publish all pending CMS changes on the destination site.
 */
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
  console.log("\n📦 Webhook received:", JSON.stringify(payload, null, 2));

  const itemId =
    payload?.payload?._id ||
    payload?.payload?.id ||
    payload?._id ||
    payload?.id;

  if (!itemId) {
    console.error("Could not extract item ID from payload:", payload);
    return res.status(400).json({ error: "Missing item ID in payload" });
  }

  // Respond immediately to avoid Webflow timeout
  res.status(200).json({ received: true });

  syncItem(itemId).catch((err) =>
    console.error("❌ Sync failed for item", itemId, err.message)
  );
});

/**
 * Core sync — fetch from source, process fields, upsert by slug, publish.
 */
async function syncItem(itemId) {
  console.log(`\n🔄 Syncing item: ${itemId}`);

  // 1. Fetch the full item from source
  console.log("  Fetching source item...");
  const sourceItem = await fetchSourceItem(itemId);
  const rawFields = sourceItem.fieldData;
  const slug = rawFields?.slug;
  console.log("  Slug:", slug);
  console.log("  Fields found:", Object.keys(rawFields).join(", "));

  // 2. Process fields (rich text + images)
  console.log("  Processing fields...");
  const processedFields = await processFields(rawFields);

  // 3. Upsert by slug — update if exists, create if not
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

  // 4. Publish destination site
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