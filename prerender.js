// netlify/edge-functions/prerender.js
// Runs on every request to /  — reads articles.json, injects pre-rendered
// lead article + top 9 list as real HTML before the page is served.
// Crawlers see fully populated content. JS enhances on top of it.

export default async function handler(request, context) {
  const url = new URL(request.url);

  // Only process the homepage
  if (url.pathname !== '/') {
    return context.next();
  }

  // Fetch the original HTML response
  const response = await context.next();
  const html = await response.text();

  // Fetch articles.json — same origin, always fresh
  let articles = [];
  try {
    const dataUrl = new URL('/data/articles.json', request.url).toString();
    const dataRes = await fetch(dataUrl);
    if (dataRes.ok) {
      articles = await dataRes.json();
    }
  } catch (e) {
    // If fetch fails, return the original page untouched
    return new Response(html, response);
  }

  // Sort by date descending, filter to newsletter + podcast only
  const sorted = articles
    .filter(a => a.type === 'newsletter' || a.type === 'podcast')
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  if (sorted.length === 0) {
    return new Response(html, response);
  }

  // ── Helpers ──────────────────────────────────────────────────────────
  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDate(d) {
    if (!d) return '';
    return new Date(d + 'T00:00:00').toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric'
    });
  }

  // ── Lead article (position 1) ─────────────────────────────────────────
  const lead = sorted[0];
  const isPod = lead.type === 'podcast';

  const leadHTML = `
          <!-- Pre-rendered by edge function from articles.json -->
          <div class="lead-article">
            <span class="lead-type-badge ${esc(lead.type)}">${isPod ? '🎙 Episode' : '📄 Essay'}</span>
            <h2 class="lead-title"><a href="${esc(lead.url)}" target="_blank" rel="noopener">${esc(lead.title)}</a></h2>
            ${lead.subtitle ? `<p class="lead-subtitle">${esc(lead.subtitle)}</p>` : ''}
            <div class="lead-meta"><span>${formatDate(lead.date)}</span><span>·</span><span>${esc(lead.topic)}</span></div>
            <a href="${esc(lead.url)}" class="lead-cta" target="_blank" rel="noopener">${isPod ? 'Listen →' : 'Read →'}</a>
          </div>`;

  // ── Recent list (positions 2–10) ──────────────────────────────────────
  const recent = sorted.slice(1, 10);

  const recentHTML = recent.map((a, i) => {
    const ip = a.type === 'podcast';
    return `
          <a href="${esc(a.url)}" class="article-row" target="_blank" rel="noopener" aria-label="${esc(a.title)}">
            <span class="article-row-num">${String(i + 2).padStart(2, '0')}</span>
            <div class="article-row-body">
              <span class="article-row-type ${esc(a.type)}">${ip ? 'Episode' : 'Essay'}</span>
              <div class="article-row-title">${esc(a.title)}</div>
              ${a.subtitle ? `<div class="article-row-subtitle">${esc(a.subtitle)}</div>` : ''}
              <div class="article-row-meta">${formatDate(a.date)} · ${esc(a.topic)}</div>
            </div>
            <span class="article-row-arrow" aria-hidden="true">→</span>
          </a>`;
  }).join('\n');

  // ── Latest date label ─────────────────────────────────────────────────
  const latestDate = formatDate(lead.date);

  // ── Inject into HTML ──────────────────────────────────────────────────
  // Replace lead container contents
  let patched = html.replace(
    /(<div id="lead-article-container">)[\s\S]*?(<\/div>\s*<\/div>\s*<div id="recent-section")/,
    `$1\n${leadHTML}\n        </div>\n      </div>\n\n      <div id="recent-section"`
  );

  // Replace article list container contents
  patched = patched.replace(
    /(<div id="article-list-container" class="article-list">)[\s\S]*?(<\/div>\s*<button id="load-more-btn")/,
    `$1\n          <!-- Pre-rendered by edge function -->${recentHTML}\n        $2`
  );

  // Update the latest-label date
  patched = patched.replace(
    /(<span class="section-count" id="latest-label">)[^<]*/,
    `$1${latestDate}`
  );

  // Also update the noscript block with fresh top 15 links
  const noscriptLinks = sorted.slice(0, 15).map(a =>
    `        <li><a href="${esc(a.url)}">${esc(a.title)} — ${formatDate(a.date)}</a></li>`
  ).join('\n');

  patched = patched.replace(
    /(<ul style="line-height:2\.2;list-style:none;padding:0;">)[\s\S]*?(<\/ul>)/,
    `$1\n${noscriptLinks}\n      $2`
  );

  return new Response(patched, {
    status: response.status,
    headers: response.headers,
  });
}

export const config = {
  path: '/',
};
