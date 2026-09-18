import { neon } from "@neondatabase/serverless";

const REF_RE = /^[A-Za-z0-9_-]{1,64}$/;

function sqlClient() {
  const url =
    process.env.NETLIFY_DATABASE_URL ||
    process.env.DATABASE_URL ||
    process.env.NETLIFY_DATABASE_URL_UNPOOLED;
  if (!url) throw new Error("DATABASE_URL is missing.");
  return neon(url);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function ensure(sql) {
  await sql`create table if not exists outreach_clicks (
    id bigserial primary key,
    ref text not null,
    path text not null default '',
    ts timestamptz not null default now(),
    ua text not null default ''
  )`;
  await sql`create index if not exists outreach_clicks_ref_idx on outreach_clicks (ref)`;
}

function cleanRef(v) {
  const ref = String(v || "");
  return REF_RE.test(ref) ? ref : "";
}

function cleanPath(v) {
  const path = String(v || "/").slice(0, 200);
  return path.startsWith("/") ? path : "/";
}

function cleanUa(req) {
  return String(req.headers.get("user-agent") || "").slice(0, 120);
}

async function logClick(sql, ref, path, ua) {
  await sql`insert into outreach_clicks (ref, path, ts, ua)
    values (${ref}, ${path}, ${new Date().toISOString()}, ${ua})`;
}

async function stats(sql) {
  const rows = await sql`
    select ref, count(*)::int as clicks, max(ts) as last_ts
    from outreach_clicks
    group by ref
    order by clicks desc, ref asc
  `;
  const total = rows.reduce((n, r) => n + Number(r.clicks || 0), 0);
  return { ok: true, total, byRef: rows };
}

export default async (req) => {
  try {
    const sql = sqlClient();
    await ensure(sql);
    const url = new URL(req.url);

    if (req.method === "GET") {
      const key = url.searchParams.get("key") || "";
      const expected = String(process.env.OUTREACH_STATS_KEY || "");
      if (!expected || key !== expected) return json({ ok: false, error: "unauthorized" }, 401);
      return json(await stats(sql));
    }

    if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);

    let body = {};
    try {
      const text = await req.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }

    const ref = cleanRef(body.ref || url.searchParams.get("ref"));
    if (!ref) return new Response(null, { status: 204 });

    await logClick(sql, ref, cleanPath(body.path || url.pathname), cleanUa(req));
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: err.message || "outreach failed" }, 500);
  }
};
