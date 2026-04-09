import dotenv from "dotenv";
import express from "express";
import session from "express-session";
import { Product } from "@prisma/client";
import { prisma } from "../prisma";
import { OutlineManagerClient } from "../services/outline";

dotenv.config();

const ADMIN_USERNAME = process.env.ADMIN_PANEL_USERNAME?.trim() || "YeHtut";
const ADMIN_PASSWORD = process.env.ADMIN_PANEL_PASSWORD?.trim() || "KMZgaming";
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET?.trim() || "techstore-admin-session";
const OUTLINE_API_URL = process.env.OUTLINE_API_URL?.trim() || "";
const OUTLINE_INSECURE_TLS = process.env.OUTLINE_INSECURE_TLS?.trim() !== "false";

const PRODUCT_CATEGORY_VPN_KEYS = "VPN_KEYS";
const PRODUCT_SUBCATEGORY_ALL_SIM_WIFI = "ALL_SIM_WIFI_VPN_KEYS";

const DEFAULT_OUTLINE_PLANS = [
  { code: "OUTLINE_SG_100GB_1M", name: "Singapore Server (100Gb)", server: "Singapore", dataCap: "100GB", duration: "1 Month", price: 4000 },
  { code: "OUTLINE_SG_200GB_1M", name: "Singapore Server (200Gb)", server: "Singapore", dataCap: "200GB", duration: "1 Month", price: 8000 },
  { code: "OUTLINE_SG_300GB_1M", name: "Singapore Server (300Gb)", server: "Singapore", dataCap: "300GB", duration: "1 Month", price: 12000 },
  { code: "OUTLINE_SG_500GB_1M", name: "Singapore Server (500Gb)", server: "Singapore", dataCap: "500GB", duration: "1 Month", price: 18000 },
  { code: "OUTLINE_SG_1000GB_1M", name: "Singapore Server (1000Gb)", server: "Singapore", dataCap: "1000GB", duration: "1 Month", price: 30000 },
];

const outlineClient = OUTLINE_API_URL
  ? new OutlineManagerClient(OUTLINE_API_URL, OUTLINE_INSECURE_TLS)
  : null;

declare module "express-session" {
  interface SessionData {
    isAdmin?: boolean;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getFlashMessage(query: unknown): string {
  const raw = typeof query === "string" ? query : "";
  return raw ? escapeHtml(raw) : "";
}

function buildOutlineKeyName(username: string, productCode: string): string {
  const cleanUser = username.normalize("NFKD").replace(/[^\w.-]/g, "").slice(0, 24) || "user";
  const cleanCode = productCode.replace(/[^\w.-]/g, "").slice(0, 24) || "plan";
  const suffix = Date.now().toString().slice(-6);
  return `${cleanUser}-${cleanCode}-${suffix}`;
}

function adminOnly(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.session?.isAdmin) {
    next();
    return;
  }
  res.redirect("/login");
}

function renderLayout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; background: #f6f8fb; color: #111; }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 24px; }
    .card { background: #fff; border-radius: 12px; padding: 16px; margin-bottom: 16px; box-shadow: 0 2px 10px rgba(0,0,0,0.05); }
    h1, h2, h3 { margin: 0 0 12px; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; }
    input, select, button, textarea { padding: 10px; border: 1px solid #d3d8e2; border-radius: 8px; font-size: 14px; }
    input, select { min-width: 180px; }
    button { cursor: pointer; }
    .btn { background: #1a73e8; color: #fff; border: none; }
    .btn-secondary { background: #3f4d64; color: #fff; border: none; }
    .btn-danger { background: #c62828; color: #fff; border: none; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #edf0f5; padding: 8px; text-align: left; font-size: 14px; }
    .muted { color: #5d6575; font-size: 13px; }
  </style>
</head>
<body>
  <div class="wrap">
    ${body}
  </div>
</body>
</html>`;
}

async function upsertOutlinePlan(input: {
  code: string;
  name: string;
  server: string;
  dataCap: string;
  duration: string;
  price: number;
}) {
  await prisma.product.upsert({
    where: { code: input.code },
    create: {
      code: input.code,
      name: input.name,
      server: input.server,
      dataCap: input.dataCap,
      duration: input.duration,
      price: input.price,
      category: PRODUCT_CATEGORY_VPN_KEYS,
      subCategory: PRODUCT_SUBCATEGORY_ALL_SIM_WIFI,
      provider: "OUTLINE",
      stockMode: "UNLIMITED",
      autoFulfill: false,
      notes: "- Manual fulfillment for selected plans.\n- No refund after key activation.",
      isActive: true,
    },
    update: {
      name: input.name,
      server: input.server,
      dataCap: input.dataCap,
      duration: input.duration,
      price: input.price,
      category: PRODUCT_CATEGORY_VPN_KEYS,
      subCategory: PRODUCT_SUBCATEGORY_ALL_SIM_WIFI,
      provider: "OUTLINE",
      stockMode: "UNLIMITED",
      autoFulfill: false,
      isActive: true,
    },
  });
}

async function renderAdminPage(message = ""): Promise<string> {
  const plans = await prisma.product.findMany({
    where: {
      category: PRODUCT_CATEGORY_VPN_KEYS,
      subCategory: PRODUCT_SUBCATEGORY_ALL_SIM_WIFI,
    },
    orderBy: { price: "asc" },
  });

  const keys = outlineClient ? await outlineClient.listAccessKeys() : [];
  const flash = message ? `<p class="muted">${escapeHtml(message)}</p>` : "";

  const planRows = plans.map((plan) => `
    <tr>
      <td>${escapeHtml(plan.code)}</td>
      <td>${escapeHtml(plan.name)}</td>
      <td>${escapeHtml(plan.dataCap)}</td>
      <td>${plan.price.toLocaleString("en-US")} Ks</td>
      <td>${plan.autoFulfill ? "Auto" : "Manual"}</td>
    </tr>
  `).join("");

  const keyRows = keys.map((key) => `
    <tr>
      <td>${escapeHtml(key.id)}</td>
      <td>${escapeHtml(key.name || "-")}</td>
      <td><code>${escapeHtml(key.accessUrl)}</code></td>
    </tr>
  `).join("");

  const planOptions = plans.map((plan) => `<option value="${escapeHtml(plan.code)}">${escapeHtml(plan.name)}</option>`).join("");

  return renderLayout("TechStore Admin", `
    <div class="card">
      <h1>TechStore Admin</h1>
      <p class="muted">Outline API: ${OUTLINE_API_URL ? "Connected" : "Not configured"}</p>
      ${flash}
      <form method="post" action="/logout"><button class="btn-secondary" type="submit">Logout</button></form>
    </div>

    <div class="card">
      <h2>Outline VPN Plans (Unlimited Stock)</h2>
      <div class="row">
        <form method="post" action="/admin/plans/seed"><button class="btn" type="submit">Seed 5 Default Plans</button></form>
      </div>
      <br />
      <form method="post" action="/admin/plans/upsert" class="row">
        <input name="code" placeholder="Code (OUTLINE_...)" required />
        <input name="name" placeholder="Display Name" required />
        <input name="server" placeholder="Server" value="Singapore" required />
        <input name="dataCap" placeholder="Data (100GB)" required />
        <input name="duration" placeholder="Duration (1 Month)" value="1 Month" required />
        <input name="price" placeholder="Price (Ks)" type="number" min="1000" required />
        <button class="btn" type="submit">Save Plan</button>
      </form>
      <br />
      <table>
        <thead><tr><th>Code</th><th>Name</th><th>Data</th><th>Price</th><th>Delivery</th></tr></thead>
        <tbody>${planRows || "<tr><td colspan='5'>No plans yet</td></tr>"}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Outline Keys</h2>
      <p class="muted">Create key name based on username + plan code.</p>
      <form method="post" action="/admin/outline/create-key" class="row">
        <input name="username" placeholder="Telegram username" required />
        <select name="planCode">${planOptions}</select>
        <button class="btn" type="submit">Create Key</button>
      </form>
      <br />
      <table>
        <thead><tr><th>ID</th><th>Name</th><th>Access URL</th></tr></thead>
        <tbody>${keyRows || "<tr><td colspan='3'>No keys found</td></tr>"}</tbody>
      </table>
    </div>
  `);
}

async function main() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.urlencoded({ extended: true }));
  app.use(session({
    secret: ADMIN_SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", secure: "auto" },
  }));

  app.get("/", (_req, res) => res.redirect("/admin"));

  app.get("/login", (req, res) => {
    const message = getFlashMessage(req.query.message);
    res.send(renderLayout("Admin Login", `
      <div class="card" style="max-width:460px; margin:40px auto;">
        <h2>Admin Login</h2>
        ${message ? `<p class="muted">${message}</p>` : ""}
        <form method="post" action="/login">
          <div class="row"><input name="username" placeholder="Username" required style="width:100%" /></div>
          <div class="row"><input name="password" placeholder="Password" type="password" required style="width:100%" /></div>
          <div class="row"><button class="btn" type="submit">Login</button></div>
        </form>
      </div>
    `));
  });

  app.post("/login", (req, res) => {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
      req.session.isAdmin = true;
      res.redirect("/admin");
      return;
    }
    res.redirect("/login?message=Invalid%20username%20or%20password");
  });

  app.post("/logout", (req, res) => {
    req.session.destroy(() => res.redirect("/login"));
  });

  app.get("/admin", adminOnly, async (req, res) => {
    const message = getFlashMessage(req.query.message);
    res.send(await renderAdminPage(message));
  });

  app.post("/admin/plans/seed", adminOnly, async (_req, res) => {
    for (const plan of DEFAULT_OUTLINE_PLANS) {
      await upsertOutlinePlan(plan);
    }
    res.redirect("/admin?message=Default%20Outline%20plans%20seeded");
  });

  app.post("/admin/plans/upsert", adminOnly, async (req, res) => {
    const code = String(req.body.code || "").trim().toUpperCase();
    const name = String(req.body.name || "").trim();
    const server = String(req.body.server || "").trim() || "Singapore";
    const dataCap = String(req.body.dataCap || "").trim();
    const duration = String(req.body.duration || "").trim() || "1 Month";
    const price = Number(req.body.price || 0);

    if (!code || !name || !dataCap || !Number.isFinite(price) || price <= 0) {
      res.redirect("/admin?message=Invalid%20plan%20input");
      return;
    }

    await upsertOutlinePlan({ code, name, server, dataCap, duration, price });
    res.redirect("/admin?message=Plan%20saved");
  });

  app.post("/admin/outline/create-key", adminOnly, async (req, res) => {
    if (!outlineClient) {
      res.redirect("/admin?message=Outline%20API%20not%20configured");
      return;
    }

    const username = String(req.body.username || "").trim();
    const planCode = String(req.body.planCode || "").trim();
    if (!username || !planCode) {
      res.redirect("/admin?message=Username%20and%20plan%20code%20are%20required");
      return;
    }

    const keyName = buildOutlineKeyName(username, planCode);
    const key = await outlineClient.createAccessKey(keyName);
    res.redirect(`/admin?message=Created%20key%20${encodeURIComponent(key.id)}`);
  });

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  const port = Number(process.env.PORT || 8080);
  app.listen(port, () => {
    console.log(`Admin web listening on :${port}`);
  });
}

void main();

