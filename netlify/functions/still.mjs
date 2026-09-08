import { neon } from "@neondatabase/serverless";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const SCHEMA = [
  `create table if not exists hunts (
    id text primary key,
    join_code text not null unique,
    host_token_hash text not null default '',
    title text not null default 'Scavenger Master',
    notes text not null default '',
    prize_pot text not null default '',
    gift_cards text not null default '[]',
    status text not null default 'open',
    created_at timestamptz not null default now(),
    admin_name text not null default '',
    environment text not null default 'family',
    pot_enabled boolean not null default false,
    pot_per_player integer not null default 0,
    pot_remaining integer not null default 0,
    skip_ids text not null default '[]',
    declared_winner_id text not null default ''
  )`,
  `create table if not exists hunt_items (
    id text primary key,
    hunt_id text not null references hunts (id) on delete cascade,
    sort_order integer not null,
    title text not null,
    hint text not null default '',
    points integer not null default 1,
    list_no integer not null default 1
  )`,
  `create table if not exists players (
    id text primary key,
    hunt_id text not null references hunts (id) on delete cascade,
    token_hash text not null default '',
    callsign text not null,
    gift_card_pick text not null default '',
    beat text not null default '',
    joined_at timestamptz not null default now()
  )`,
  `create unique index if not exists players_hunt_callsign_idx on players (hunt_id, lower(callsign))`,
  `create table if not exists submissions (
    id text primary key,
    hunt_id text not null references hunts (id) on delete cascade,
    player_id text not null references players (id) on delete cascade,
    item_id text not null references hunt_items (id) on delete cascade,
    photo_data text not null,
    note text not null default '',
    status text not null default 'pending',
    created_at timestamptz not null default now()
  )`,
  `create unique index if not exists submissions_player_item_idx on submissions (player_id, item_id)`,
];

function sqlClient() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is missing.");
  return neon(url);
}

async function ready(sql) {
  if (globalThis.__smSchema) return;
  for (const stmt of SCHEMA) {
    if (typeof sql.query === "function") await sql.query(stmt);
    else await sql([stmt]);
  }
  globalThis.__smSchema = true;
}

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: { ...cors, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function nid(prefix) {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }
  try {
    const sql = sqlClient();
    await ready(sql);

    if (event.httpMethod === "GET") {
      const sid = event.queryStringParameters?.sid || "";
      const code = String(event.queryStringParameters?.c || "").toUpperCase();
      if (sid) {
        const rows = await sql`select photo_data from submissions where id = ${sid} limit 1`;
        const data = rows[0]?.photo_data || "";
        if (!data.startsWith("data:image/")) return { statusCode: 404, headers: cors, body: "Not found" };
        const comma = data.indexOf(",");
        const meta = data.slice(0, comma);
        const b64 = data.slice(comma + 1);
        const mime = /data:(image\/[a-zA-Z0-9.+-]+)/.exec(meta)?.[1] || "image/jpeg";
        return {
          statusCode: 200,
          headers: { ...cors, "Content-Type": mime, "Cache-Control": "private, max-age=120" },
          body: b64,
          isBase64Encoded: true,
        };
      }
      if (code.length >= 4) {
        const hunts = await sql`select id, join_code, status, environment, pot_enabled, pot_per_player from hunts where join_code = ${code} limit 1`;
        if (!hunts[0]) return json({ ok: false, error: "No hunt with that code." }, 404);
        const items = await sql`select id, title, sort_order, points, list_no from hunt_items where hunt_id = ${hunts[0].id} order by list_no, sort_order`;
        return json({ ok: true, hunt: hunts[0], items });
      }
      return json({ ok: true, locker: "neon" });
    }

    if (event.httpMethod !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

    const body = JSON.parse(event.body || "{}");
    const code = String(body.c || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 8);
    const callsign = String(body.n || "").trim().slice(0, 32);
    const giftCard = String(body.s || "").trim().slice(0, 40);
    const beat = String(body.b || "").trim().slice(0, 24);
    const itemIndex = Number(body.i) || 0;
    const inBeat = body.ib === "in" || body.ib === "out" ? body.ib : "";
    let photo = String(body.p || "");
    if (!code || callsign.length < 2) return json({ ok: false, error: "Name and code required." }, 400);
    if (!photo.startsWith("data:image/") || photo.length < 64) return json({ ok: false, error: "Missing still." }, 400);
    if (photo.length > 900_000) return json({ ok: false, error: "Photo is too large." }, 400);

    const hunts = await sql`select id, status from hunts where join_code = ${code} limit 1`;
    if (!hunts[0]) return json({ ok: false, error: "No hunt with that code." }, 404);
    if (hunts[0].status === "closed") return json({ ok: false, error: "This hunt is closed." }, 400);

    const items = await sql`select id from hunt_items where hunt_id = ${hunts[0].id} order by list_no, sort_order`;
    const item = items[Math.max(0, itemIndex - 1)] || items[itemIndex] || items[0];
    if (!item) return json({ ok: false, error: "That item is not on this hunt." }, 400);

    let players = await sql`select id from players where hunt_id = ${hunts[0].id} and lower(callsign) = ${callsign.toLowerCase()} limit 1`;
    if (!players[0]) {
      const pid = nid("p_");
      await sql`insert into players (id, hunt_id, token_hash, callsign, gift_card_pick, beat)
        values (${pid}, ${hunts[0].id}, ${nid("t_")}, ${callsign}, ${giftCard}, ${beat})`;
      players = [{ id: pid }];
    } else if (giftCard) {
      await sql`update players set gift_card_pick = ${giftCard}, beat = ${beat || ""} where id = ${players[0].id}`;
    }

    const sid = nid("s_");
    const note = inBeat ? `beat:${inBeat}` : "";
    await sql`
      insert into submissions (id, hunt_id, player_id, item_id, photo_data, note, status)
      values (${sid}, ${hunts[0].id}, ${players[0].id}, ${item.id}, ${photo}, ${note}, 'pending')
      on conflict (player_id, item_id) do update set photo_data = excluded.photo_data, note = excluded.note, status = 'pending', created_at = now()
    `;
    return json({ ok: true, sid });
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : "Send failed." }, 500);
  }
}
