// GET /api/og?score=222&tier=Elite&name=Suliman&id=6455
// Returns an HTML page with PERSONALIZED Open Graph + Twitter Card metadata.
// Real visitors are redirected to /zen/. Bots / Twitter's crawler scrape the meta.
// This makes the link-card title and description per-tweet (score + tier visible)
// while keeping the image as the per-tier static mascot (no server-side rendering needed).

import { tierFor } from './_utils.js';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function tierImage(tier) {
  const t = (tier || '').toLowerCase();
  if (t.indexOf('legendary') >= 0) return 'tier-legendary.png';
  if (t.indexOf('elite')     >= 0) return 'tier-elite.png';
  if (t.indexOf('adept')     >= 0 || t.indexOf('warrior') >= 0) return 'tier-warrior.png';
  return 'tier-beginner.png';
}

export async function onRequestGet({ request }) {
  const u = new URL(request.url);
  const score = parseInt(u.searchParams.get('score') || '0', 10) || 0;
  const tier  = (u.searchParams.get('tier')  || tierFor(score)).trim();
  const name  = (u.searchParams.get('name')  || '').trim().replace(/^@+/, '').slice(0, 30);
  const id    = (u.searchParams.get('id')    || '').trim().slice(0, 10);

  const handle = name ? ('@' + name + (id ? '#' + id : '')) : '';
  const titleParts = [];
  if (handle) titleParts.push(handle);
  if (score > 0) titleParts.push(`scored ${score}/300`);
  if (tier) titleParts.push(`(${tier} tier)`);
  const title = titleParts.length
    ? `ROKI ZEN — ${titleParts.join(' ')}`
    : 'ROKI ZEN — 3 Cuts. One Focus.';

  const desc = score > 0
    ? `${handle ? handle + ' ' : ''}slashed ${score}/300 on ROKI ZEN. 3 cuts. One focus. Try to beat them.`
    : 'Slice the drop. Time it. Place it. Be precise.';

  const img = `https://roki.buzz/assets/${tierImage(tier)}`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="description" content="${escapeHtml(desc)}"/>

<meta property="og:type"  content="website"/>
<meta property="og:title" content="${escapeHtml(title)}"/>
<meta property="og:description" content="${escapeHtml(desc)}"/>
<meta property="og:image" content="${img}"/>
<meta property="og:image:width"  content="3000"/>
<meta property="og:image:height" content="3000"/>
<meta property="og:url"   content="${escapeHtml(u.toString())}"/>

<meta name="twitter:card"        content="summary_large_image"/>
<meta name="twitter:site"        content="@rokitherabbit"/>
<meta name="twitter:title"       content="${escapeHtml(title)}"/>
<meta name="twitter:description" content="${escapeHtml(desc)}"/>
<meta name="twitter:image"       content="${img}"/>

<meta http-equiv="refresh" content="0; url=/zen/"/>
<link rel="canonical" href="https://roki.buzz/zen/"/>
<script>location.replace('/zen/');</script>
</head>
<body>
<p>${escapeHtml(title)} — redirecting to <a href="/zen/">ROKI Zen</a>…</p>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
}
