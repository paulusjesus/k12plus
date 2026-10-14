"""Generate the Supabase Edge Function supabase/functions/aim/index.ts from
backend/index.js, so the tutor backend has a single source of truth.
Run: python3 backend/build-edge.py
"""
import pathlib, re

root = pathlib.Path(__file__).resolve().parent.parent
src = (root / 'backend' / 'index.js').read_text()
src = re.sub(r"const functions = require\('@google-cloud/functions-framework'\);\n", '', src)

header = '''// @ts-nocheck
// GENERATED FILE: edit backend/index.js, then run `python3 backend/build-edge.py`.
// Supabase Edge Function `aim` (Deno). Thin adapter around the Cloud Run handler.
// deno-lint-ignore-file no-explicit-any

// process.env shim: Supabase provides SUPABASE_SERVICE_ROLE_KEY automatically.
const process: any = {
  env: new Proxy({}, {
    get: (_t, k) => {
      const key = String(k);
      if (key === 'SUPABASE_SERVICE_KEY') return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      return Deno.env.get(key);
    },
  }),
};

// functions-framework shim: capture the handler registered with functions.http
let handler: any = null;
const functions = { http: (_name: string, h: any) => { handler = h; } };

'''

footer = '''

// Express-style req/res adapter for Deno.serve
Deno.serve(async (request: Request) => {
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  let body: any = {};
  if (request.method === 'POST') {
    try { body = await request.json(); } catch { body = {}; }
  }
  const req = { method: request.method, headers, body };
  return await new Promise<Response>((resolve) => {
    const outHeaders = new Headers();
    let statusCode = 200;
    const res: any = {
      set(k: string, v: string) { outHeaders.set(k, v); return res; },
      status(c: number) { statusCode = c; return res; },
      json(o: unknown) {
        outHeaders.set('Content-Type', 'application/json');
        resolve(new Response(JSON.stringify(o), { status: statusCode, headers: outHeaders }));
        return res;
      },
      send(s: string) {
        resolve(new Response(statusCode === 204 ? null : s, { status: statusCode, headers: outHeaders }));
        return res;
      },
    };
    Promise.resolve(handler(req, res)).catch((e: any) => {
      console.error(e);
      resolve(new Response(JSON.stringify({ error: 'server error' }), { status: 500, headers: outHeaders }));
    });
  });
});
'''

out = root / 'supabase' / 'functions' / 'aim' / 'index.ts'
out.write_text(header + src + footer)
print('wrote', out.relative_to(root), len(header + src + footer), 'chars')
