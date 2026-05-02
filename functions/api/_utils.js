// Shared helpers for /api Pages Functions

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      ...extra,
    },
  });
}

export function preflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
  });
}

export function validName(s) {
  if (typeof s !== 'string') return null;
  const n = s.trim().replace(/^@+/, '');
  if (n.length < 2 || n.length > 20) return null;
  if (!/^[A-Za-z0-9_.]+$/.test(n)) return null;
  return n;
}

export function tierFor(score) {
  if (score >= 270) return 'Legendary';
  if (score >= 200) return 'Elite';
  if (score >= 100) return 'Adept';
  return 'Beginner';
}
