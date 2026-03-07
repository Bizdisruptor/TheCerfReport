/**
 * update-articles.js
 * Netlify scheduled function — runs nightly at 2am UTC
 * Fetches The Cerf Report Substack RSS, classifies new articles by topic,
 * merges with existing articles.json, and writes the updated file.
 *
 * Netlify will auto-redeploy when the file changes via the build hook.
 */

const { schedule } = require("@netlify/functions");
const https = require("https");
const fs = require("fs");
const path = require("path");

// ── Topic classifier ──────────────────────────────────────────────────────────
const TOPIC_RULES = [
  {
    topic: "Trade & Tariffs",
    keywords: ["tariff", "trade", "import", "export", "wto", "customs", "duty", "duties", "trade war", "trade deficit", "trade policy", "free trade", "protectionism", "dumping", "trade deal", "nafta", "usmca"],
  },
  {
    topic: "Constitutional Governance",
    keywords: ["constitution", "constitutional", "congress", "senate", "house", "executive", "judiciary", "supreme court", "amendment", "separation of powers", "federalism", "rule of law", "checks and balances", "first amendment", "presidential power", "impeach", "filibuster", "electoral"],
  },
  {
    topic: "Geopolitics",
    keywords: ["iran", "china", "russia", "ukraine", "nato", "middle east", "israel", "saudi", "venezuela", "cuba", "north korea", "taiwan", "sanctions", "geopolit", "foreign policy", "diplomacy", "war", "conflict", "military", "nuclear", "deterrence", "hegemony"],
  },
  {
    topic: "Technology & AI",
    keywords: ["ai ", "artificial intelligence", "machine learning", "technology", "tech ", "data", "algorithm", "automation", "software", "silicon", "semiconductor", "crypto", "blockchain", "surveillance", "big tech", "platform", "metadata", "cloud", "compute"],
  },
  {
    topic: "Media & Politics",
    keywords: ["media", "press", "journalist", "polling", "election", "democrat", "republican", "partisan", "political", "propaganda", "misinformation", "narrative", "campaign", "vote", "voters", "trump", "biden", "populism", "ideology"],
  },
  {
    topic: "Healthcare & Social Policy",
    keywords: ["health", "medicare", "medicaid", "opioid", "drug", "pharmaceutical", "social security", "welfare", "poverty", "inequality", "education", "housing", "immigration", "border", "fentanyl"],
  },
  {
    topic: "Economic Policy",
    keywords: [], // catch-all — matches anything not caught above
  },
];

function classifyTopic(title, subtitle) {
  const text = `${title} ${subtitle || ""}`.toLowerCase();
  for (const rule of TOPIC_RULES) {
    if (rule.keywords.length === 0) continue; // skip catch-all in loop
    if (rule.keywords.some((kw) => text.includes(kw))) {
      return rule.topic;
    }
  }
  return "Economic Policy"; // default
}

// ── RSS fetcher ───────────────────────────────────────────────────────────────
function fetchRSS(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// ── Simple XML parser for RSS fields ─────────────────────────────────────────
function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return m ? (m[1] || m[2] || "").trim() : "";
    };
    const title = get("title");
    const link  = get("link") || block.match(/<link>([^<]+)<\/link>/)?.[1]?.trim() || "";
    const pubDate = get("pubDate");
    const subtitle = get("subtitle") || get("description").replace(/<[^>]+>/g, "").slice(0, 200).trim();
    const guid = get("guid") || link;

    if (!title || !link) continue;

    // Parse date to YYYY-MM-DD
    let date = "";
    try {
      const d = new Date(pubDate);
      date = d.toISOString().slice(0, 10);
    } catch (e) {
      date = new Date().toISOString().slice(0, 10);
    }

    // Detect podcast vs newsletter from categories or title
    const categories = block.match(/<category[^>]*>([\s\S]*?)<\/category>/g) || [];
    const catText = categories.join(" ").toLowerCase();
    const type = catText.includes("podcast") || catText.includes("audio") ? "podcast" : "newsletter";

    // Extract slug from URL
    const slugMatch = link.match(/substack\.com\/p\/([^/?#]+)/);
    const slug = slugMatch ? slugMatch[1] : guid.replace(/[^a-z0-9-]/gi, "-").toLowerCase();

    // post_id from guid
    const idMatch = guid.match(/(\d{6,})/);
    const post_id = idMatch ? idMatch[1] : slug;

    items.push({ post_id, slug, title, subtitle, date, type, topic: classifyTopic(title, subtitle), url: link });
  }
  return items;
}

// ── Main handler ──────────────────────────────────────────────────────────────
const handler = async () => {
  try {
    console.log("[update-articles] Fetching Substack RSS...");
    const xml = await fetchRSS("https://thecerfreport.substack.com/feed");

    const rssItems = parseRSS(xml);
    console.log(`[update-articles] Found ${rssItems.length} items in RSS`);

    // Load existing articles.json
    const articlesPath = path.join(process.cwd(), "data", "articles.json");
    let existing = [];
    try {
      existing = JSON.parse(fs.readFileSync(articlesPath, "utf8"));
    } catch (e) {
      console.log("[update-articles] No existing articles.json found, starting fresh");
    }

    // Merge: RSS items take priority for new posts, existing data preserved for old ones
    const existingUrls = new Set(existing.map((a) => a.url));
    const newItems = rssItems.filter((item) => !existingUrls.has(item.url));

    if (newItems.length === 0) {
      console.log("[update-articles] No new articles found");
      return { statusCode: 200, body: "No new articles" };
    }

    console.log(`[update-articles] Adding ${newItems.length} new article(s): ${newItems.map(a => a.title).join(", ")}`);

    // Prepend new items, sort by date descending
    const merged = [...newItems, ...existing].sort(
      (a, b) => new Date(b.date) - new Date(a.date)
    );

    fs.writeFileSync(articlesPath, JSON.stringify(merged, null, 2));
    console.log(`[update-articles] articles.json updated — ${merged.length} total articles`);

    // Trigger Netlify rebuild via build hook (set NETLIFY_BUILD_HOOK in env vars)
    const buildHook = process.env.NETLIFY_BUILD_HOOK;
    if (buildHook && newItems.length > 0) {
      await new Promise((resolve, reject) => {
        const url = new URL(buildHook);
        const req = https.request({ hostname: url.hostname, path: url.pathname + url.search, method: "POST" }, resolve);
        req.on("error", reject);
        req.end();
      });
      console.log("[update-articles] Build hook triggered");
    }

    return { statusCode: 200, body: `Added ${newItems.length} new article(s)` };
  } catch (err) {
    console.error("[update-articles] Error:", err);
    return { statusCode: 500, body: err.message };
  }
};

// Run nightly at 2:00 AM UTC
exports.handler = schedule("0 2 * * *", handler);
