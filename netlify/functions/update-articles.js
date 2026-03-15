/**
 * update-articles.js
 * Netlify scheduled function — runs every hour
 * Fetches The Cerf Report Substack RSS, classifies new articles by topic,
 * merges with existing articles.json, then commits the updated file back
 * to GitHub (which auto-triggers a Netlify redeploy).
 *
 * Required environment variables (set in Netlify UI → Site Settings → Env Vars):
 *   GITHUB_TOKEN        — Personal access token with repo write scope
 *   GITHUB_REPO_OWNER   — e.g. "Bizdisruptor"
 *   GITHUB_REPO_NAME    — e.g. "thecerfreport"   (whatever your repo is named)
 *   GITHUB_BRANCH       — e.g. "main"
 */

const { schedule } = require("@netlify/functions");
const https = require("https");

// ── Topic classifier ──────────────────────────────────────────────────────────
const TOPIC_RULES = [
  {
    topic: "Trade & Tariffs",
    keywords: ["tariff", "trade", "import", "export", "wto", "customs", "duty",
      "duties", "trade war", "trade deficit", "trade policy", "free trade",
      "protectionism", "dumping", "trade deal", "nafta", "usmca", "taco"],
  },
  {
    topic: "Constitutional Governance",
    keywords: ["constitution", "constitutional", "congress", "senate", "house",
      "executive", "judiciary", "supreme court", "scotus", "amendment",
      "separation of powers", "federalism", "rule of law", "checks and balances",
      "first amendment", "presidential power", "impeach", "filibuster",
      "electoral", "impoundment"],
  },
  {
    topic: "Geopolitics",
    keywords: ["iran", "china", "russia", "ukraine", "nato", "middle east",
      "israel", "saudi", "venezuela", "cuba", "north korea", "taiwan",
      "sanctions", "geopolit", "foreign policy", "diplomacy", "war", "conflict",
      "military", "nuclear", "deterrence", "hegemony", "kurdish", "regime"],
  },
  {
    topic: "Technology & AI",
    keywords: ["ai ", "artificial intelligence", "machine learning", "technology",
      "tech ", "data", "algorithm", "automation", "software", "silicon",
      "semiconductor", "crypto", "blockchain", "surveillance", "big tech",
      "platform", "metadata", "cloud", "compute", "spacex", "xai", "consciousness"],
  },
  {
    topic: "Media & Politics",
    keywords: ["media", "press", "journalist", "polling", "election", "democrat",
      "republican", "partisan", "political", "propaganda", "misinformation",
      "narrative", "campaign", "vote", "voters", "trump", "biden", "populism",
      "ideology", "chaos", "pattern"],
  },
  {
    topic: "Healthcare & Social Policy",
    keywords: ["health", "medicare", "medicaid", "opioid", "drug",
      "pharmaceutical", "social security", "welfare", "poverty", "inequality",
      "education", "housing", "immigration", "border", "fentanyl", "safer",
      "crime", "finland", "happiness"],
  },
  {
    topic: "Economic Policy",
    keywords: [], // catch-all
  },
];

function classifyTopic(title, subtitle) {
  const text = `${title} ${subtitle || ""}`.toLowerCase();
  for (const rule of TOPIC_RULES) {
    if (rule.keywords.length === 0) continue;
    if (rule.keywords.some((kw) => text.includes(kw))) return rule.topic;
  }
  return "Economic Policy";
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = { headers: { "User-Agent": "TheCerfReport-Bot/1.0", ...headers } };
    https.get(url, opts, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location, headers).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function httpsRequest(method, hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : "";
    const opts = {
      hostname, path, method,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
        ...headers,
      },
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── RSS parser ────────────────────────────────────────────────────────────────
function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const get = (tag) => {
      const m = block.match(
        new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)
      );
      return m ? (m[1] || m[2] || "").trim() : "";
    };

    const title = get("title");
    const link =
      get("link") ||
      block.match(/<link>([^<]+)<\/link>/)?.[1]?.trim() ||
      "";
    const pubDate = get("pubDate");
    const rawDesc = get("description").replace(/<[^>]+>/g, "").trim();
    const subtitle = get("subtitle") || rawDesc.slice(0, 200);
    const guid = get("guid") || link;

    if (!title || !link) continue;

    // Skip non-article types (chat posts, etc.)
    if (title.toLowerCase().includes("subscriber chat")) continue;

    let date = "";
    try {
      date = new Date(pubDate).toISOString().slice(0, 10);
    } catch {
      date = new Date().toISOString().slice(0, 10);
    }

    // Detect podcast from RSS categories or itunes tags
    const categories = block.match(/<category[^>]*>([\s\S]*?)<\/category>/g) || [];
    const catText = categories.join(" ").toLowerCase();
    const hasItunesDuration = /<itunes:duration/.test(block);
    const hasEnclosure = /<enclosure/.test(block);
    const type =
      catText.includes("podcast") ||
      catText.includes("audio") ||
      hasItunesDuration ||
      hasEnclosure
        ? "podcast"
        : "newsletter";

    const slugMatch = link.match(/substack\.com\/p\/([^/?#]+)/);
    const slug = slugMatch
      ? slugMatch[1]
      : guid.replace(/[^a-z0-9-]/gi, "-").toLowerCase();

    const idMatch = guid.match(/(\d{6,})/);
    const post_id = idMatch ? idMatch[1] : slug;

    items.push({
      post_id,
      slug,
      title,
      subtitle,
      date,
      type,
      topic: classifyTopic(title, subtitle),
      url: link,
    });
  }
  return items;
}

// ── GitHub API helpers ────────────────────────────────────────────────────────
const GH_API = "api.github.com";

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "User-Agent": "TheCerfReport-Bot/1.0",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function getFileSHA(token, owner, repo, branch, filePath) {
  const res = await httpsRequest(
    "GET",
    GH_API,
    `/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`,
    ghHeaders(token),
    null
  );
  if (res.status === 404) return null;
  const json = JSON.parse(res.body);
  return json.sha || null;
}

async function commitFile(token, owner, repo, branch, filePath, content, sha, message) {
  const encoded = Buffer.from(content, "utf8").toString("base64");
  const body = {
    message,
    content: encoded,
    branch,
    ...(sha ? { sha } : {}),
  };
  const res = await httpsRequest(
    "PUT",
    GH_API,
    `/repos/${owner}/${repo}/contents/${filePath}`,
    ghHeaders(token),
    body
  );
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`GitHub commit failed: ${res.status} — ${res.body}`);
  }
  return JSON.parse(res.body);
}

async function getExistingArticles(token, owner, repo, branch, filePath) {
  const res = await httpsRequest(
    "GET",
    GH_API,
    `/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`,
    ghHeaders(token),
    null
  );
  if (res.status === 404) return { articles: [], sha: null };
  const json = JSON.parse(res.body);
  const decoded = Buffer.from(json.content.replace(/\n/g, ""), "base64").toString("utf8");
  return { articles: JSON.parse(decoded), sha: json.sha };
}

// ── Main handler ──────────────────────────────────────────────────────────────
const handler = async () => {
  const GITHUB_TOKEN      = process.env.GITHUB_TOKEN;
  const GITHUB_REPO_OWNER = process.env.GITHUB_REPO_OWNER;
  const GITHUB_REPO_NAME  = process.env.GITHUB_REPO_NAME;
  const GITHUB_BRANCH     = process.env.GITHUB_BRANCH || "main";
  const ARTICLES_PATH     = "data/articles.json";

  if (!GITHUB_TOKEN || !GITHUB_REPO_OWNER || !GITHUB_REPO_NAME) {
    console.error("[update-articles] Missing required env vars: GITHUB_TOKEN, GITHUB_REPO_OWNER, GITHUB_REPO_NAME");
    return { statusCode: 500, body: "Missing env vars" };
  }

  try {
    // 1. Fetch RSS
    console.log("[update-articles] Fetching Substack RSS...");
    const { status, body: xml } = await httpsGet("https://thecerfreport.substack.com/feed");
    if (status !== 200) throw new Error(`RSS fetch returned ${status}`);

    const rssItems = parseRSS(xml);
    console.log(`[update-articles] Parsed ${rssItems.length} items from RSS`);

    // 2. Load existing articles.json from GitHub
    console.log("[update-articles] Loading existing articles.json from GitHub...");
    const { articles: existing, sha } = await getExistingArticles(
      GITHUB_TOKEN, GITHUB_REPO_OWNER, GITHUB_REPO_NAME, GITHUB_BRANCH, ARTICLES_PATH
    );
    console.log(`[update-articles] Existing articles: ${existing.length}`);

    // 3. Merge — deduplicate by URL
    const existingUrls = new Set(existing.map((a) => a.url));
    const newItems = rssItems.filter((item) => !existingUrls.has(item.url));

    if (newItems.length === 0) {
      console.log("[update-articles] No new articles found. Nothing to commit.");
      return { statusCode: 200, body: "No new articles" };
    }

    console.log(`[update-articles] New articles found: ${newItems.map((a) => a.title).join(" | ")}`);

    const merged = [...newItems, ...existing].sort(
      (a, b) => new Date(b.date) - new Date(a.date)
    );

    // 4. Commit updated articles.json to GitHub
    const commitMsg = `chore: add ${newItems.length} new article(s) [${new Date().toISOString().slice(0,10)}]`;
    console.log(`[update-articles] Committing to GitHub: "${commitMsg}"`);

    await commitFile(
      GITHUB_TOKEN,
      GITHUB_REPO_OWNER,
      GITHUB_REPO_NAME,
      GITHUB_BRANCH,
      ARTICLES_PATH,
      JSON.stringify(merged, null, 2),
      sha,
      commitMsg
    );

    console.log(`[update-articles] ✅ Committed. Total articles: ${merged.length}`);
    return {
      statusCode: 200,
      body: `Added ${newItems.length} new article(s). Total: ${merged.length}`,
    };

  } catch (err) {
    console.error("[update-articles] Error:", err);
    return { statusCode: 500, body: err.message };
  }
};

// Run every hour
exports.handler = schedule("0 * * * *", handler);
