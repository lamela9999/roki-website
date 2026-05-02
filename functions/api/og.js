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
  const img   = (u.searchParams.get('img')   || '').trim().replace(/[^a-z0-9]/gi, '').slice(0, 32);

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

  // Prefer the user-uploaded score-card screenshot if provided, else the static tier mascot.
  const ogImage = img
    ? ('https://roki.buzz/api/share-image/' + img)
    : ('https://roki.buzz/assets/' + tierImage(tier));

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
<meta property="og:image" content="${ogImage}"/>
<meta property="og:image:width"  content="1200"/>
<meta property="og:image:height" content="630"/>
<meta property="og:url"   content="${escapeHtml(u.toString())}"/>

<meta name="twitter:card"        content="summary_large_image"/>
<meta name="twitter:site"        content="@rokitherabbit"/>
<meta name="twitter:title"       content="${escapeHtml(title)}"/>
<meta name="twitter:description" content="${escapeHtml(desc)}"/>
<meta name="twitter:image"       content="${ogImage}"/>

<link rel="canonical" href="https://roki.buzz/zen/"/>
<style>
  body{margin:0;font-family:'Inter Tight',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F5EFE6;color:#14110F;min-height:100vh;display:grid;place-items:center;padding:24px}
  .card{max-width:600px;width:100%;background:#FBF6EC;border:2px solid #14110F;border-radius:14px;box-shadow:6px 6px 0 #14110F;padding:20px;text-align:center}
  .card img{max-width:100%;width:auto;height:auto;border-radius:12px;border:2px solid #14110F;background:transparent;display:block;margin:0 auto 18px;box-shadow:4px 4px 0 #14110F}
  .card h1{font-family:'Archivo Black','Anton',sans-serif;font-size:20px;letter-spacing:2px;text-transform:uppercase;margin:0 0 8px}
  .card p{color:#6B6258;font-size:14px;line-height:1.55;margin:0 0 18px}
  .card a{display:inline-block;background:#E8534A;color:#fff;border:1.5px solid #14110F;border-radius:8px;padding:12px 20px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase;text-decoration:none;box-shadow:0 3px 0 #14110F}
</style>
</head>
<body>
<div class="card">
  <img src="${ogImage}" alt=""/>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(desc)}</p>
  <a href="/zen/">Play ROKI Zen →</a>
</div>
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
