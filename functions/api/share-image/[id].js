// GET /api/share-image/:id  →  PNG bytes
// Reads the share blob KV stored by /api/share-image's POST handler.

export async function onRequestGet({ params, env }) {
  if (!env.ZEN_KV) {
    return new Response('KV not configured', { status: 500 });
  }
  const id = String(params.id || '').replace(/[^a-z0-9]/gi, '');
  if (!id || id.length < 4 || id.length > 32) {
    return new Response('bad id', { status: 400 });
  }
  const bytes = await env.ZEN_KV.get('share:' + id, 'arrayBuffer');
  if (!bytes) return new Response('not found', { status: 404 });
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=86400, immutable',
      'access-control-allow-origin': '*',
    },
  });
}
