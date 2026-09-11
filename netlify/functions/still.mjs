import { createHash, randomBytes } from "node:crypto";
import { neon } from "@neondatabase/serverless";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Stripe-Signature",
};

const FAMILY = [
  "Something that starts with S",
  "A leaf bigger than your hand",
  "Four-legged neighbor, or tracks",
  "A hidden path or shortcut",
  "The color of the sky right now",
];

// Billing constants only. Caps and Stripe stay unused until ENFORCEMENT_ON=true.
function enforcementOn() {
  return String(process.env.ENFORCEMENT_ON || "false").toLowerCase() === "true";
}

const BILLING = {
  whoPays: "host",
  founderEmails: ["davidgoodmanauthor@gmail.com", "coldact45@gmail.com"],
  squad: {
    id: "squad",
    name: "Squad",
    priceCents: 699,
    interval: "month",
    includedPlayers: 10,
  },
  hardCeilingPlayers: 50,
  trial: { days: 3, players: 5, hunts: 1 },
  setupIntent: "one_dollar_auth_reverse",
};

function isFounderEmail(email) {
  return BILLING.founderEmails.includes(String(email || "").trim().toLowerCase());
}

function normEmail(v) {
  return String(v || "").trim().toLowerCase();
}

function daysSince(d) {
  if (!d) return 999;
  return (Date.now() - new Date(d).getTime()) / 86400000;
}

async function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY || "";
  if (!key.startsWith("sk_")) return null;
  const Stripe = (await import("stripe")).default;
  return new Stripe(key);
}

async function squadPriceId(stripe, sql) {
  const rows = await sql`select stripe_price_id from plans where id = ${"squad"} limit 1`;
  if (rows[0]?.stripe_price_id) return rows[0].stripe_price_id;
  const products = await stripe.products.list({ limit: 20 });
  let product = products.data.find((p) => p.metadata?.sm_plan === "squad") || null;
  if (!product) {
    product = await stripe.products.create({
      name: "Scavenger Master Squad",
      metadata: { sm_plan: "squad" },
    });
  }
  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 10 });
  let price = prices.data.find((p) => p.unit_amount === BILLING.squad.priceCents && p.recurring?.interval === "month");
  if (!price) {
    price = await stripe.prices.create({
      product: product.id,
      unit_amount: BILLING.squad.priceCents,
      currency: "usd",
      recurring: { interval: "month" },
      metadata: { sm_plan: "squad" },
    });
  }
  await sql`update plans set stripe_price_id = ${price.id} where id = ${"squad"}`;
  return price.id;
}

async function upsertHost(sql, email, patch) {
  const existing = await sql`select * from hosts where lower(email) = ${email} limit 1`;
  if (!existing[0]) {
    const id = nid("host_");
    await sql`insert into hosts (id, email, plan_id, status)
      values (${id}, ${email}, ${BILLING.squad.id}, ${patch.status || "founder"})`;
    return { id, email, plan_id: BILLING.squad.id, status: patch.status || "founder", trial_hunts_used: 0 };
  }
  const h = existing[0];
  if (patch.status) h.status = patch.status;
  if (patch.stripe_customer_id != null) h.stripe_customer_id = patch.stripe_customer_id;
  if (patch.card_fingerprint != null) h.card_fingerprint = patch.card_fingerprint;
  if (patch.trial_started_at != null) h.trial_started_at = patch.trial_started_at;
  if (patch.trial_ends_at != null) h.trial_ends_at = patch.trial_ends_at;
  if (patch.trial_hunts_used != null) h.trial_hunts_used = patch.trial_hunts_used;
  if (patch.past_due_at !== undefined) h.past_due_at = patch.past_due_at;
  await sql`update hosts set
    stripe_customer_id = ${h.stripe_customer_id || ""},
    card_fingerprint = ${h.card_fingerprint || ""},
    plan_id = ${h.plan_id || "squad"},
    status = ${h.status},
    trial_started_at = ${h.trial_started_at || null},
    trial_ends_at = ${h.trial_ends_at || null},
    trial_hunts_used = ${Number(h.trial_hunts_used) || 0},
    past_due_at = ${h.past_due_at || null}
    where id = ${h.id}`;
  return h;
}

// Real gate. Never runs while ENFORCEMENT_ON is false.
async function assertHostAllowed(sql, email, kind) {
  if (!enforcementOn()) return null;
  const e = normEmail(email);
  if (isFounderEmail(e)) {
    return upsertHost(sql, e, { status: "founder" });
  }
  if (!e) throw new Error("Host email required.");
  const rows = await sql`select * from hosts where lower(email) = ${e} limit 1`;
  const host = rows[0];
  if (!host) throw new Error("Start a 3-day trial first.");
  if (host.status === "founder" || host.status === "active") return host;
  if (host.status === "trialing") {
    if (host.trial_ends_at && new Date(host.trial_ends_at) < new Date()) {
      throw new Error("Trial ended. Squad is $6.99 a month.");
    }
    if (kind === "create" && Number(host.trial_hunts_used || 0) >= BILLING.trial.hunts) {
      throw new Error("Trial allows one hunt.");
    }
    return host;
  }
  if (host.status === "past_due") {
    const grace = daysSince(host.past_due_at) <= BILLING.trial.days;
    if (kind === "create") throw new Error("Card failed. You can finish the current hunt, not start a new one.");
    if (grace) return host;
    await sql`update hosts set status = ${"frozen"} where id = ${host.id}`;
    throw new Error("This hunt is paused until the card is updated.");
  }
  if (host.status === "frozen" || host.status === "canceled") {
    if (kind === "create") throw new Error("Start or renew Squad to host a hunt.");
    throw new Error("This hunt is paused until the card is updated.");
  }
  throw new Error("Start a 3-day trial first.");
}

async function assertJoinCap(sql, hunt) {
  if (!enforcementOn()) return;
  const hid = hunt.host_id || "";
  if (!hid) return;
  const hosts = await sql`select * from hosts where id = ${hid} limit 1`;
  const host = hosts[0];
  if (!host || host.status === "founder") return;
  const cap = host.status === "trialing" ? BILLING.trial.players : BILLING.squad.includedPlayers;
  const n = await sql`select count(*)::int as c from players where hunt_id = ${hunt.id}`;
  if (Number(n[0]?.c || 0) >= cap) throw new Error("Player limit reached for this plan.");
}

async function handleStripeWebhook(event, sql) {
  const sig = event.headers?.["stripe-signature"] || event.headers?.["Stripe-Signature"] || "";
  const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
  if (!sig) return null;
  if (!secret) return json({ ok: false, error: "Webhook secret is not set." }, 400);
  const stripe = await stripeClient();
  if (!stripe) return json({ ok: false, error: "Stripe is not configured." }, 400);
  const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : String(event.body || "");
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(raw, sig, secret);
  } catch {
    return json({ ok: false, error: "Bad Stripe signature." }, 400);
  }
  const obj = stripeEvent.data?.object || {};
  const customerId = obj.customer || obj.id || "";
  const hosts = customerId
    ? await sql`select * from hosts where stripe_customer_id = ${String(customerId)} limit 1`
    : [];
  const host = hosts[0];
  if (host) {
    if (stripeEvent.type === "invoice.payment_failed") {
      await sql`update hosts set status = ${"past_due"}, past_due_at = coalesce(past_due_at, now()) where id = ${host.id}`;
    } else if (stripeEvent.type === "invoice.paid") {
      await sql`update hosts set status = ${"active"}, past_due_at = null where id = ${host.id}`;
    } else if (stripeEvent.type === "customer.subscription.deleted") {
      await sql`update hosts set status = ${"canceled"} where id = ${host.id}`;
    } else if (stripeEvent.type === "customer.subscription.updated") {
      const st = obj.status === "trialing" ? "trialing"
        : obj.status === "active" ? "active"
        : obj.status === "past_due" ? "past_due"
        : obj.status === "canceled" || obj.status === "unpaid" ? "canceled"
        : host.status;
      await sql`update hosts set status = ${st} where id = ${host.id}`;
      await sql`insert into subscriptions (id, host_id, stripe_subscription_id, plan_id, status)
        values (${nid("sub_")}, ${host.id}, ${String(obj.id || "")}, ${"squad"}, ${st})`;
    }
  }
  return json({ ok: true, received: stripeEvent.type });
}

async function startTrialSetup(sql, email) {
  if (!enforcementOn()) return json({ ok: true, skipped: true, enforcement: false });
  const e = normEmail(email);
  if (!e || !e.includes("@")) return json({ ok: false, error: "Host email required." }, 400);
  if (isFounderEmail(e)) {
    await upsertHost(sql, e, { status: "founder" });
    return json({ ok: true, founder: true, enforcement: true });
  }
  const stripe = await stripeClient();
  if (!stripe) return json({ ok: false, error: "Stripe test keys are missing." }, 500);
  await squadPriceId(stripe, sql);
  let host = (await sql`select * from hosts where lower(email) = ${e} limit 1`)[0];
  let customerId = host?.stripe_customer_id || "";
  if (!customerId) {
    const customer = await stripe.customers.create({ email: e, metadata: { sm: "host" } });
    customerId = customer.id;
  }
  host = await upsertHost(sql, e, { stripe_customer_id: customerId, status: host?.status || "canceled" });
  const si = await stripe.setupIntents.create({
    customer: customerId,
    payment_method_types: ["card"],
    usage: "off_session",
  });
  return json({
    ok: true,
    clientSecret: si.client_secret,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || "",
    trialDays: BILLING.trial.days,
  });
}

async function confirmTrial(sql, email, paymentMethod) {
  if (!enforcementOn()) return json({ ok: true, skipped: true, enforcement: false });
  const e = normEmail(email);
  const pmId = String(paymentMethod || "");
  if (!e || !pmId) return json({ ok: false, error: "Email and card are required." }, 400);
  if (isFounderEmail(e)) {
    await upsertHost(sql, e, { status: "founder" });
    return json({ ok: true, founder: true });
  }
  const stripe = await stripeClient();
  if (!stripe) return json({ ok: false, error: "Stripe test keys are missing." }, 500);
  const host = (await sql`select * from hosts where lower(email) = ${e} limit 1`)[0];
  if (!host?.stripe_customer_id) return json({ ok: false, error: "Start the trial card step first." }, 400);
  const pm = await stripe.paymentMethods.retrieve(pmId);
  const fp = pm.card?.fingerprint || "";
  if (fp) {
    const used = await sql`select email from hosts where card_fingerprint = ${fp} and trial_started_at is not null limit 1`;
    if (used[0]) return json({ ok: false, error: "That card already used a free trial." }, 400);
  }
  await stripe.paymentMethods.attach(pmId, { customer: host.stripe_customer_id });
  await stripe.customers.update(host.stripe_customer_id, { invoice_settings: { default_payment_method: pmId } });
  try {
    const pi = await stripe.paymentIntents.create({
      amount: 100,
      currency: "usd",
      customer: host.stripe_customer_id,
      payment_method: pmId,
      confirm: true,
      off_session: true,
      capture_method: "manual",
      description: "Scavenger Master card check (released)",
    });
    await stripe.paymentIntents.cancel(pi.id);
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : "Card check failed." }, 400);
  }
  const priceId = await squadPriceId(stripe, sql);
  const sub = await stripe.subscriptions.create({
    customer: host.stripe_customer_id,
    items: [{ price: priceId }],
    trial_period_days: BILLING.trial.days,
    default_payment_method: pmId,
  });
  const trialEnd = new Date(Date.now() + BILLING.trial.days * 86400000).toISOString();
  await upsertHost(sql, e, {
    stripe_customer_id: host.stripe_customer_id,
    card_fingerprint: fp,
    status: "trialing",
    trial_started_at: new Date().toISOString(),
    trial_ends_at: trialEnd,
    trial_hunts_used: 0,
    past_due_at: null,
  });
  await sql`insert into subscriptions (id, host_id, stripe_subscription_id, plan_id, status)
    values (${nid("sub_")}, ${host.id}, ${sub.id}, ${"squad"}, ${"trialing"})`;
  return json({ ok: true, status: "trialing", trialEndsAt: trialEnd, players: BILLING.trial.players });
}

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
  `alter table hunts add column if not exists spectator_token_hash text not null default ''`,
  `alter table hunts add column if not exists winner_revealed boolean not null default false`,
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
  `alter table hunts add column if not exists host_id text not null default ''`,
  `create table if not exists plans (
    id text primary key,
    name text not null,
    price_cents integer not null,
    interval text not null default 'month',
    included_players integer not null,
    active boolean not null default true
  )`,
  `create table if not exists hosts (
    id text primary key,
    email text not null unique,
    stripe_customer_id text not null default '',
    card_fingerprint text not null default '',
    plan_id text not null default 'squad',
    status text not null default 'founder',
    trial_started_at timestamptz,
    trial_ends_at timestamptz,
    trial_hunts_used integer not null default 0
  )`,
  `alter table hosts add column if not exists past_due_at timestamptz`,
  `alter table plans add column if not exists stripe_price_id text not null default ''`,
  `create table if not exists subscriptions (
    id text primary key,
    host_id text not null references hosts (id) on delete cascade,
    stripe_subscription_id text not null default '',
    plan_id text not null default 'squad',
    status text not null default '',
    created_at timestamptz not null default now()
  )`,
];

function sqlClient() {
  const url =
    process.env.NETLIFY_DATABASE_URL ||
    process.env.DATABASE_URL ||
    process.env.NETLIFY_DATABASE_URL_UNPOOLED;
  if (!url) throw new Error("DATABASE_URL is missing.");
  return neon(url);
}

async function ready(sql) {
  if (globalThis.__smSchema) return;
  for (const stmt of SCHEMA) {
    if (typeof sql.query === "function") await sql.query(stmt);
    else await sql([stmt]);
  }
  await sql`
    insert into plans (id, name, price_cents, interval, included_players, active)
    values (${BILLING.squad.id}, ${BILLING.squad.name}, ${BILLING.squad.priceCents}, ${BILLING.squad.interval}, ${BILLING.squad.includedPlayers}, ${true})
    on conflict (id) do update set
      name = excluded.name,
      price_cents = excluded.price_cents,
      interval = excluded.interval,
      included_players = excluded.included_players,
      active = excluded.active
  `;
  for (const email of BILLING.founderEmails) {
    const existing = await sql`select id from hosts where lower(email) = ${email} limit 1`;
    if (!existing[0]) {
      await sql`insert into hosts (id, email, plan_id, status)
        values (${nid("host_")}, ${email}, ${BILLING.squad.id}, ${"founder"})`;
    }
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

function hash(v) {
  return createHash("sha256").update(String(v)).digest("hex");
}

function makeCode() {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(randomBytes(6), (b) => a[b % a.length]).join("");
}

async function requireHost(sql, code, token) {
  const hunts = await sql`select * from hunts where join_code = ${code} limit 1`;
  if (!hunts[0]) throw new Error("No hunt with that code.");
  if (hunts[0].host_token_hash !== hash(token)) throw new Error("Host key does not match.");
  return hunts[0];
}

async function hostBoard(sql, hunt) {
  const items = await sql`select id, title, sort_order, points, list_no from hunt_items where hunt_id = ${hunt.id} order by list_no, sort_order`;
  const players = await sql`select id, callsign, gift_card_pick, beat from players where hunt_id = ${hunt.id} order by joined_at`;
  const subs = await sql`select id, player_id, item_id, status, note, char_length(photo_data) as bytes from submissions where hunt_id = ${hunt.id}`;
  let extra = [];
  try { extra = JSON.parse(hunt.gift_cards || "[]"); } catch { extra = []; }
  if (!Array.isArray(extra)) extra = [];
  const pts = Object.fromEntries(items.map((it) => [it.id, Math.max(1, Number(it.points) || 1)]));
  const scored = players.map((p) => {
    const mine = subs.filter((x) => x.player_id === p.id && x.status === "counted");
    const points = mine.reduce((n, x) => n + (pts[x.item_id] || 1), 0);
    return { ...p, points, counted: mine.length };
  }).sort((a, b) => b.points - a.points || a.callsign.localeCompare(b.callsign));
  return {
    ok: true,
    hunt: {
      code: hunt.join_code,
      status: hunt.status,
      environment: hunt.environment,
      potEnabled: hunt.pot_enabled,
      potPerPlayer: hunt.pot_per_player,
      potRemaining: hunt.pot_remaining,
      adminName: hunt.admin_name,
      declaredWinnerId: hunt.declared_winner_id || "",
      winnerRevealed: !!hunt.winner_revealed,
      giftCards: extra,
    },
    items,
    players: scored,
    submissions: subs,
  };
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }
  try {
    const sql = sqlClient();
    await ready(sql);
    const q = event.queryStringParameters || {};

    if (event.httpMethod === "GET") {
      const sid = q.sid || "";
      const code = String(q.c || "").toUpperCase();
      const token = String(q.t || "");
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
      if (code.length >= 4 && token.length >= 8) {
        const hunt = await requireHost(sql, code, token);
        return json(await hostBoard(sql, hunt));
      }
      const watch = String(q.w || "");
      if (code.length >= 4 && watch.length >= 8) {
        const hunts = await sql`select * from hunts where join_code = ${code} limit 1`;
        if (!hunts[0] || !hunts[0].spectator_token_hash || hunts[0].spectator_token_hash !== hash(watch)) {
          return json({ ok: false, error: "Spectator link is not valid." }, 403);
        }
        const board = await hostBoard(sql, hunts[0]);
        board.viewOnly = true;
        return json(board);
      }
      if (code.length >= 4) {
        const hunts = await sql`select id, join_code, status, environment, pot_enabled, pot_per_player from hunts where join_code = ${code} limit 1`;
        if (!hunts[0]) return json({ ok: false, error: "No hunt with that code." }, 404);
        const items = await sql`select id, title, sort_order, points, list_no from hunt_items where hunt_id = ${hunts[0].id} order by list_no, sort_order`;
        return json({ ok: true, hunt: hunts[0], items });
      }
      return json({
        ok: true,
        locker: "neon",
        enforcement: enforcementOn(),
        whoPays: BILLING.whoPays,
        plan: BILLING.squad,
        trial: BILLING.trial,
        stripe: String(process.env.STRIPE_SECRET_KEY || "").startsWith("sk_test") ? "test" : (String(process.env.STRIPE_SECRET_KEY || "").startsWith("sk_live") ? "live" : "missing"),
      });
    }

    if (event.httpMethod !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

    const hooked = await handleStripeWebhook(event, sql);
    if (hooked) return hooked;

    const body = JSON.parse(event.body || "{}");
    const action = String(body.a || body.action || "").toLowerCase();

    if (action === "trial") return startTrialSetup(sql, body.email || body.n || "");
    if (action === "trial-confirm") return confirmTrial(sql, body.email || body.n || "", body.payment_method || body.pm || "");

    if (action === "create") {
      const hostEmail = normEmail(body.email || body.hostEmail || "");
      const hostRow = await assertHostAllowed(sql, hostEmail, "create");
      const name = String(body.n || body.name || "Host").trim().slice(0, 24) || "Host";
      const env = ["family", "police", "fire", "office", "warehouse", "school", "other"].includes(body.e)
        ? body.e
        : "family";
      const titles = (Array.isArray(body.i) ? body.i : FAMILY)
        .map((t) => String(t || "").trim())
        .filter((t) => t.length >= 2)
        .slice(0, 80);
      if (titles.length < 1) return json({ ok: false, error: "Add at least one find." }, 400);
      const pot = Math.max(0, Math.min(100, Number(body.p) || 0));
      const hostToken = randomBytes(18).toString("hex");
      const watchToken = randomBytes(18).toString("hex");
      const huntId = nid("h_");
      let join = makeCode();
      for (let n = 0; n < 6; n++) {
        const exists = await sql`select id from hunts where join_code = ${join} limit 1`;
        if (!exists[0]) break;
        join = makeCode();
      }
      const hostId = hostRow?.id || "";
      await sql`insert into hunts (id, join_code, host_token_hash, spectator_token_hash, title, admin_name, environment, pot_enabled, pot_per_player, pot_remaining, status, host_id)
        values (${huntId}, ${join}, ${hash(hostToken)}, ${hash(watchToken)}, ${"Scavenger Master"}, ${name}, ${env}, ${pot > 0}, ${pot}, ${0}, ${"open"}, ${hostId})`;
      for (let n = 0; n < titles.length; n++) {
        await sql`insert into hunt_items (id, hunt_id, sort_order, title, hint, points, list_no)
          values (${nid("i_")}, ${huntId}, ${n}, ${titles[n]}, ${""}, ${1}, ${Math.floor(n / 5) + 1})`;
      }
      if (enforcementOn() && hostRow?.status === "trialing") {
        await sql`update hosts set trial_hunts_used = coalesce(trial_hunts_used, 0) + 1 where id = ${hostRow.id}`;
      }
      return json({ ok: true, code: join, hostToken, watchToken, items: titles, environment: env, pot });
    }

    if (action === "watch") {
      const code = String(body.c || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 8);
      const hunt = await requireHost(sql, code, String(body.t || ""));
      const watchToken = randomBytes(18).toString("hex");
      await sql`update hunts set spectator_token_hash = ${hash(watchToken)} where id = ${hunt.id}`;
      return json({
        ok: true,
        token: watchToken,
        url: "/host.html?c=" + encodeURIComponent(code) + "&w=" + encodeURIComponent(watchToken),
      });
    }

    if (action === "grade") {
      const code = String(body.c || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 8);
      const hunt = await requireHost(sql, code, String(body.t || ""));
      const status = body.s === "rejected" ? "rejected" : body.s === "pending" ? "pending" : "counted";
      await sql`update submissions set status = ${status} where id = ${String(body.sid || "")} and hunt_id = ${hunt.id}`;
      return json(await hostBoard(sql, hunt));
    }

    if (action === "close") {
      const code = String(body.c || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 8);
      const hunt = await requireHost(sql, code, String(body.t || ""));
      const next = hunt.status === "closed" ? "open" : "closed";
      await sql`update hunts set status = ${next} where id = ${hunt.id}`;
      hunt.status = next;
      return json(await hostBoard(sql, hunt));
    }

    if (action === "additems") {
      const code = String(body.c || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 8);
      const hunt = await requireHost(sql, code, String(body.t || ""));
      const titles = (Array.isArray(body.i) ? body.i : [])
        .map((t) => String(t || "").trim())
        .filter((t) => t.length >= 2)
        .slice(0, 20);
      if (!titles.length) return json({ ok: false, error: "Add at least one find." }, 400);
      const last = await sql`select coalesce(max(sort_order), -1) as m, coalesce(max(list_no), 0) as l from hunt_items where hunt_id = ${hunt.id}`;
      const start = Number(last[0]?.m) + 1;
      const listNo = Number(last[0]?.l) + 1;
      for (let n = 0; n < titles.length; n++) {
        await sql`insert into hunt_items (id, hunt_id, sort_order, title, hint, points, list_no)
          values (${nid("i_")}, ${hunt.id}, ${start + n}, ${titles[n]}, ${""}, ${1}, ${listNo})`;
      }
      return json(await hostBoard(sql, hunt));
    }

    if (action === "saveitems") {
      const code = String(body.c || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 8);
      const hunt = await requireHost(sql, code, String(body.t || ""));
      const rows = Array.isArray(body.items) ? body.items : [];
      for (const row of rows) {
        const id = String(row.id || "");
        const title = String(row.title || "").trim().slice(0, 120);
        const points = Math.max(1, Math.min(20, Number(row.points) || 1));
        if (!id || title.length < 2) continue;
        await sql`update hunt_items set title = ${title}, points = ${points} where id = ${id} and hunt_id = ${hunt.id}`;
      }
      return json(await hostBoard(sql, hunt));
    }

    if (action === "addcard") {
      const code = String(body.c || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 8);
      const hunt = await requireHost(sql, code, String(body.t || ""));
      const name = String(body.card || "").trim().slice(0, 40);
      if (name.length < 2) return json({ ok: false, error: "Name the gift card." }, 400);
      let extra = [];
      try { extra = JSON.parse(hunt.gift_cards || "[]"); } catch { extra = []; }
      if (!Array.isArray(extra)) extra = [];
      extra.push(name);
      await sql`update hunts set gift_cards = ${JSON.stringify(extra)} where id = ${hunt.id}`;
      hunt.gift_cards = JSON.stringify(extra);
      return json(await hostBoard(sql, hunt));
    }

    if (action === "winner") {
      const code = String(body.c || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 8);
      const hunt = await requireHost(sql, code, String(body.t || ""));
      const pid = String(body.pid || "");
      await sql`update hunts set declared_winner_id = ${pid}, winner_revealed = ${false} where id = ${hunt.id}`;
      hunt.declared_winner_id = pid;
      hunt.winner_revealed = false;
      return json(await hostBoard(sql, hunt));
    }

    if (action === "reveal") {
      const code = String(body.c || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 8);
      const hunt = await requireHost(sql, code, String(body.t || ""));
      if (!hunt.declared_winner_id) return json({ ok: false, error: "Pick the winner on Scores first." }, 400);
      await sql`update hunts set winner_revealed = ${true} where id = ${hunt.id}`;
      hunt.winner_revealed = true;
      return json(await hostBoard(sql, hunt));
    }

    if (action === "deduct") {
      const code = String(body.c || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 8);
      const hunt = await requireHost(sql, code, String(body.t || ""));
      const next = Math.max(0, Number(hunt.pot_remaining || 0) + (Number(hunt.pot_per_player || 0) * 0) - 10);
      const remain = Math.max(0, Number(body.remain != null ? body.remain : (hunt.pot_remaining || 0) - 10));
      await sql`update hunts set pot_remaining = ${remain} where id = ${hunt.id}`;
      hunt.pot_remaining = remain;
      return json(await hostBoard(sql, hunt));
    }

    if (action === "join") {
      const code = String(body.c || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 8);
      const callsign = String(body.n || "").trim().slice(0, 32);
      const giftCard = String(body.s || "").trim().slice(0, 40);
      const beat = String(body.b || "").trim().slice(0, 24);
      if (!code || callsign.length < 2) return json({ ok: false, error: "Name and code required." }, 400);
      const hunts = await sql`select id, status, host_id from hunts where join_code = ${code} limit 1`;
      if (!hunts[0]) return json({ ok: false, error: "No hunt with that code." }, 404);
      if (hunts[0].status === "closed") return json({ ok: false, error: "This hunt is closed." }, 400);
      const gift = giftCard === "-" ? "" : giftCard;
      let players = await sql`select id from players where hunt_id = ${hunts[0].id} and lower(callsign) = ${callsign.toLowerCase()} limit 1`;
      if (!players[0]) {
        await assertJoinCap(sql, hunts[0]);
        const pid = nid("p_");
        await sql`insert into players (id, hunt_id, token_hash, callsign, gift_card_pick, beat)
          values (${pid}, ${hunts[0].id}, ${nid("t_")}, ${callsign}, ${gift}, ${beat})`;
      } else {
        await sql`update players set gift_card_pick = ${gift}, beat = ${beat || ""} where id = ${players[0].id}`;
      }
      return json({ ok: true, joined: true });
    }

    const code = String(body.c || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 8);
    const callsign = String(body.n || "").trim().slice(0, 32);
    const giftCard = String(body.s || "").trim().slice(0, 40);
    const beat = String(body.b || "").trim().slice(0, 24);
    const itemIndex = Number(body.i) || 0;
    const inBeat = body.ib === "in" || body.ib === "out" ? body.ib : "";
    const photo = String(body.p || "");
    if (!code || callsign.length < 2) return json({ ok: false, error: "Name and code required." }, 400);
    if (!photo.startsWith("data:image/") || photo.length < 64) return json({ ok: false, error: "Missing still." }, 400);
    if (photo.length > 900000) return json({ ok: false, error: "Photo is too large." }, 400);

    const hunts = await sql`select id, status, host_id from hunts where join_code = ${code} limit 1`;
    if (!hunts[0]) return json({ ok: false, error: "No hunt with that code." }, 404);
    if (hunts[0].status === "closed") return json({ ok: false, error: "This hunt is closed." }, 400);
    if (enforcementOn() && hunts[0].host_id) {
      await assertHostAllowed(sql, (await sql`select email from hosts where id = ${hunts[0].host_id} limit 1`)[0]?.email || "", "play");
    }

    const items = await sql`select id from hunt_items where hunt_id = ${hunts[0].id} order by list_no, sort_order`;
    const item = items[itemIndex] || items[Math.max(0, itemIndex - 1)] || items[0];
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
