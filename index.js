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

/**
 * Fetch a single CMS item from the source site by its item ID.
 */
async function fetchSourceItem(itemId) {
  const url = `https://api.webflow.com/v2/collections/${CONFIG.source.collectionId}/items/${itemId}`;
  const { data } = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${CONFIG.source.token}`,
      "accept-version": "1.0.0",
    },
  });
  return data;
}

/**
 * Scan rich-text HTML for <img> tags and re-upload each image to the
 * destination site, replacing the src with the new hosted URL.
 * Webflow rich-text images must be publicly accessible URLs — if your
 * source images are already on a CDN this step just passes them through.
 */
async function rewriteRichTextImages(html) {
  if (!html) return html;

  const $ = cheerio.load(html, { xmlMode: true });
  const imgTags = $("img").toArray();

  for (const el of imgTags) {
    const src = $(el).attr("src");
    if (!src) continue;

    try {
      // Attempt to re-upload the image to the destination site's asset library.
      const newUrl = await uploadImageToDestination(src);
      $(el).attr("src", newUrl);
      console.log(`  ↳ Rewrote image: ${src} → ${newUrl}`);
    } catch (err) {
      // If upload fails, leave the original URL — it's still publicly accessible.
      console.warn(`  ↳ Image upload failed, keeping original URL: ${src}`, err.message);
    }
  }

  // Return just the body content (cheerio wraps in <html><body>…</body></html>)
  return $("body").html();
}

/**
 * Upload an image (by URL) to the destination Webflow site asset library.
 * Returns the new hosted URL.
 *
 * Webflow v2 asset upload is a two-step process:
 *   1. POST /sites/{siteId}/assets  →  get an S3 upload form
 *   2. POST to S3 with the file data
 */
async function uploadImageToDestination(imageUrl) {
  // Step 1 — fetch the image as a buffer
  const imageResponse = await axios.get(imageUrl, { responseType: "arraybuffer" });
  const imageBuffer = Buffer.from(imageResponse.data);
  const contentType = imageResponse.headers["content-type"] || "image/jpeg";
  const fileName = imageUrl.split("/").pop().split("?")[0] || "image.jpg";
  const fileHash = require("crypto")
    .createHash("md5")
    .update(imageBuffer)
    .digest("hex");

  // Step 2 — request an upload URL from Webflow
  const registerRes = await axios.post(
    `https://api.webflow.com/v2/sites/${CONFIG.dest.siteId}/assets`,
    { fileName, fileHash },
    {
      headers: {
        Authorization: `Bearer ${CONFIG.dest.token}`,
        "Content-Type": "application/json",
        "accept-version": "1.0.0",
      },
    }
  );

  const { uploadUrl, uploadDetails, hostedUrl } = registerRes.data;

  // Step 3 — upload to S3 using the pre-signed form fields
  const FormData = require("form-data");
  const form = new FormData();
  Object.entries(uploadDetails).forEach(([k, v]) => form.append(k, v));
  form.append("file", imageBuffer, { filename: fileName, contentType });

  await axios.post(uploadUrl, form, { headers: form.getHeaders() });

  return hostedUrl;
}

/**
 * Walk every field in the item's fieldData and:
 *  - rewrite rich-text HTML (re-upload embedded images)
 *  - pass image fields through as-is (Webflow accepts public URLs for image fields)
 */
async function processFields(fieldData) {
  const processed = {};

  for (const [key, value] of Object.entries(fieldData)) {
    if (typeof value === "string" && value.trim().startsWith("<")) {
      // Looks like rich text HTML — rewrite embedded images
      console.log(`  Processing rich-text field: ${key}`);
      processed[key] = await rewriteRichTextImages(value);
    } else if (value && typeof value === "object" && value.url) {
      // Webflow image field object — keep the url, strip internal metadata
      processed[key] = { url: value.url, alt: value.alt || "" };
    } else {
      processed[key] = value;
    }
  }

  return processed;
}

/**
 * Create a new CMS item on the destination site.
 */
async function createDestinationItem(fieldData) {
  const url = `https://api.webflow.com/v2/collections/${CONFIG.dest.collectionId}/items`;
  const { data } = await axios.post(
    url,
    { fieldData, isDraft: false },
    {
      headers: {
        Authorization: `Bearer ${CONFIG.dest.token}`,
        "Content-Type": "application/json",
        "accept-version": "1.0.0",
      },
    }
  );
  return data;
}

/**
 * Publish all pending CMS items on the destination site.
 * Webflow requires an explicit publish call after item creation.
 */
async function publishDestinationSite() {
  const url = `https://api.webflow.com/v2/sites/${CONFIG.dest.siteId}/publish`;
  await axios.post(
    url,
    { publishToWebflowSubdomain: true }, // set to false if using a custom domain only
    {
      headers: {
        Authorization: `Bearer ${CONFIG.dest.token}`,
        "Content-Type": "application/json",
        "accept-version": "1.0.0",
      },
    }
  );
}

// ─── Webhook endpoint ──────────────────────────────────────────────────────────

/**
 * Simple secret-based authentication.
 * In Webflow, append ?secret=YOUR_SECRET to your webhook URL,
 * or validate the x-webflow-signature header if you prefer HMAC.
 */
function authenticate(req) {
  const secret = req.query.secret || req.headers["x-webhook-secret"];
  return secret === CONFIG.webhookSecret;
}

app.post("/webhook/collection-item-created", async (req, res) => {
  if (!authenticate(req)) {
    console.warn("Unauthorized webhook request");
    return res.status(401).json({ error: "Unauthorized" });
  }

  const payload = req.body;
  console.log("\n📦 Webhook received:", JSON.stringify(payload, null, 2));

  // Webflow sends the item ID in different places depending on API version
  const itemId =
    payload?.payload?._id ||
    payload?.payload?.id ||
    payload?._id ||
    payload?.id;

  if (!itemId) {
    console.error("Could not extract item ID from payload:", payload);
    return res.status(400).json({ error: "Missing item ID in payload" });
  }

  // Respond to Webflow immediately to avoid timeout (process async)
  res.status(200).json({ received: true });

  // Process in the background
  syncItem(itemId).catch((err) =>
    console.error("❌ Sync failed for item", itemId, err.message)
  );
});

/**
 * Core sync function — fetch, process, create, publish.
 */
async function syncItem(itemId) {
  console.log(`\n🔄 Syncing item: ${itemId}`);

  // 1. Fetch the full item from the source
  console.log("  Fetching source item...");
  const sourceItem = await fetchSourceItem(itemId);
  const rawFields = sourceItem.fieldData;
  console.log("  Fields found:", Object.keys(rawFields).join(", "));

  // 2. Process fields (rich text image rewriting, image field cleanup)
  console.log("  Processing fields...");
  const processedFields = await processFields(rawFields);

  // 3. Create the item on the destination site
  console.log("  Creating destination item...");
  const newItem = await createDestinationItem(processedFields);
  console.log("  ✅ Created item:", newItem.id);

  // 4. Publish the destination site
  console.log("  Publishing destination site...");
  await publishDestinationSite();
  console.log("  ✅ Site published");

  console.log(`\n✅ Sync complete for item ${itemId} → ${newItem.id}`);
}

// ─── Health check ─────────────────────────────────────────────────────────────

app.get("/health", (_, res) => res.json({ status: "ok" }));

// ─── Start server ──────────────────────────────────────────────────────────────

app.listen(CONFIG.port, () => {
  console.log(`\n🚀 Webflow Sync Server running on port ${CONFIG.port}`);
  console.log(`   Webhook URL: http://your-server.com/webhook/collection-item-created?secret=${CONFIG.webhookSecret}`);
  console.log(`   Health check: http://your-server.com/health\n`);
});
