import dotenv from "dotenv";
import express from "express";
import session from "express-session";
import { ProductProvider, StockMode } from "@prisma/client";
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

type AdminTab = "products" | "outline";

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
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getFlashMessage(query: unknown): string {
  const raw = typeof query === "string" ? query : "";
  return raw ? escapeHtml(raw) : "";
}

function slug(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .toUpperCase()
    .slice(0, 36) || "PRODUCT";
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
    .wrap { max-width: 1200px; margin: 0 auto; padding: 24px; }
    .card { background: #fff; border-radius: 12px; padding: 16px; margin-bottom: 16px; box-shadow: 0 2px 10px rgba(0,0,0,0.05); }
    h1, h2, h3 { margin: 0 0 12px; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; }
    .tabs a { display:inline-block; margin-right:8px; padding:8px 12px; border-radius:8px; text-decoration:none; background:#e9edf5; color:#24324a; }
    .tabs a.active { background:#1a73e8; color:#fff; }
    input, select, button { padding: 10px; border: 1px solid #d3d8e2; border-radius: 8px; font-size: 14px; }
    input, select { min-width: 180px; }
    button { cursor: pointer; }
    .btn { background: #1a73e8; color: #fff; border: none; }
    .btn-secondary { background: #3f4d64; color: #fff; border: none; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #edf0f5; padding: 8px; text-align: left; font-size: 14px; vertical-align: top; }
    .muted { color: #5d6575; font-size: 13px; }
    code { font-size: 12px; }
  </style>
</head>
<body>
  <div class="wrap">${body}</div>
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
      provider: ProductProvider.OUTLINE,
      stockMode: StockMode.UNLIMITED,
      autoFulfill: true,
      notes: "- Key is delivered automatically after payment success.\\n- No refund after key activation.",
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
      provider: ProductProvider.OUTLINE,
      stockMode: StockMode.UNLIMITED,
      autoFulfill: true,
      isActive: true,
    },
  });
}

function tabLink(tab: AdminTab, currentTab: AdminTab): string {
  const active = tab === currentTab ? "active" : "";
  const title = tab === "products" ? "Products" : "Outline Keys";
  return `<a class="${active}" href="/admin?tab=${tab}">${title}</a>`;
}

async function renderProductsTab(): Promise<string> {
  const products = await prisma.product.findMany({ orderBy: [{ category: "asc" }, { subCategory: "asc" }, { price: "asc" }] });
  const rows = products.map((product) => `
    <tr>
      <td>${escapeHtml(product.name)}</td>
      <td>${escapeHtml(product.category)}</td>
      <td>${escapeHtml(product.subCategory)}</td>
      <td>${escapeHtml(product.provider)}</td>
      <td>${escapeHtml(product.stockMode)}</td>
      <td>${product.autoFulfill ? "Yes" : "No"}</td>
      <td>${product.price.toLocaleString("en-US")} Ks</td>
    </tr>
  `).join("");

  return `
    <div class="card">
      <h2>Products Menu</h2>
      <p class="muted">Use this page for all current and future product architectures.</p>
      <div class="row">
        <form method="post" action="/admin/products/sync-outline"><button class="btn" type="submit">Sync Default Outline Products</button></form>
      </div>
      <br />
      <form method="post" action="/admin/products/create" class="row">
        <input name="name" placeholder="Product Name" required />
        <select name="category">
          <option value="VPN_KEYS">VPN_KEYS</option>
          <option value="ACCOUNTS">ACCOUNTS</option>
          <option value="SOCIAL_SERVICES">SOCIAL_SERVICES</option>
          <option value="OTHER">OTHER</option>
        </select>
        <input name="subCategory" placeholder="Sub-category" value="GENERAL" required />
        <select name="provider">
          <option value="INTERNAL">INTERNAL</option>
          <option value="OUTLINE">OUTLINE</option>
        </select>
        <select name="stockMode">
          <option value="FINITE">FINITE</option>
          <option value="UNLIMITED">UNLIMITED</option>
        </select>
        <input name="server" placeholder="Server" value="Singapore" />
        <input name="dataCap" placeholder="Data (e.g. 100GB)" value="100GB" />
        <input name="duration" placeholder="Duration" value="1 Month" />
        <input name="price" type="number" min="100" placeholder="Price Ks" required />
        <button class="btn" type="submit">Add Product</button>
      </form>
    </div>

    <div class="card">
      <h3>All Products</h3>
      <table>
        <thead><tr><th>Name</th><th>Category</th><th>Sub-category</th><th>Provider</th><th>Stock</th><th>Auto</th><th>Price</th></tr></thead>
        <tbody>${rows || "<tr><td colspan='7'>No products yet</td></tr>"}</tbody>
      </table>
    </div>
  `;
}

async function renderOutlineTab(): Promise<string> {
  const outlineProducts = await prisma.product.findMany({
    where: {
      provider: ProductProvider.OUTLINE,
      category: PRODUCT_CATEGORY_VPN_KEYS,
      subCategory: PRODUCT_SUBCATEGORY_ALL_SIM_WIFI,
    },
    orderBy: { price: "asc" },
  });

  const keys = outlineClient ? await outlineClient.listAccessKeys() : [];
  const productOptions = outlineProducts
    .map((product) => `<option value="${product.id}">${escapeHtml(product.name)} (${product.price.toLocaleString("en-US")} Ks)</option>`)
    .join("");

  const keyRows = keys.map((key) => `
    <tr>
      <td>${escapeHtml(key.id)}</td>
      <td>${escapeHtml(key.name || "-")}</td>
      <td><code>${escapeHtml(key.accessUrl)}</code></td>
    </tr>
  `).join("");

  return `
    <div class="card">
      <h2>Outline Keys</h2>
      <p class="muted">Create a test key using username + selected product. Order flow in bot delivers keys automatically.</p>
      <p class="muted">Outline API: ${OUTLINE_API_URL ? "Connected" : "Not configured"}</p>
      <form method="post" action="/admin/outline/create-key" class="row">
        <input name="username" placeholder="Telegram username" required />
        <select name="productId">${productOptions || "<option value=''>No outline products</option>"}</select>
        <button class="btn" type="submit">Create Test Key</button>
      </form>
    </div>

    <div class="card">
      <h3>Existing Outline Access Keys</h3>
      <table>
        <thead><tr><th>ID</th><th>Name</th><th>Access URL</th></tr></thead>
        <tbody>${keyRows || "<tr><td colspan='3'>No keys found</td></tr>"}</tbody>
      </table>
    </div>
  `;
}

async function renderAdminPage(tab: AdminTab, message = ""): Promise<string> {
  const flash = message ? `<p class="muted">${escapeHtml(message)}</p>` : "";
  const tabContent = tab === "outline" ? await renderOutlineTab() : await renderProductsTab();

  return renderLayout("TechStore Admin", `
    <div class="card">
      <h1>TechStore Admin</h1>
      ${flash}
      <div class="tabs">${tabLink("products", tab)}${tabLink("outline", tab)}</div>
      <br />
      <form method="post" action="/logout"><button class="btn-secondary" type="submit">Logout</button></form>
    </div>
    ${tabContent}
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
    const tabRaw = typeof req.query.tab === "string" ? req.query.tab : "products";
    const tab: AdminTab = tabRaw === "outline" ? "outline" : "products";
    const message = getFlashMessage(req.query.message);
    res.send(await renderAdminPage(tab, message));
  });

  app.post("/admin/products/sync-outline", adminOnly, async (_req, res) => {
    for (const plan of DEFAULT_OUTLINE_PLANS) {
      await upsertOutlinePlan(plan);
    }
    res.redirect("/admin?tab=products&message=Outline%20products%20synced");
  });

  app.post("/admin/products/create", adminOnly, async (req, res) => {
    const name = String(req.body.name || "").trim();
    const category = String(req.body.category || "OTHER").trim().toUpperCase();
    const subCategory = String(req.body.subCategory || "GENERAL").trim().toUpperCase();
    const providerRaw = String(req.body.provider || "INTERNAL").trim().toUpperCase();
    const stockModeRaw = String(req.body.stockMode || "FINITE").trim().toUpperCase();
    const server = String(req.body.server || "").trim() || "General";
    const dataCap = String(req.body.dataCap || "").trim() || "N/A";
    const duration = String(req.body.duration || "").trim() || "N/A";
    const price = Number(req.body.price || 0);

    if (!name || !Number.isFinite(price) || price <= 0) {
      res.redirect("/admin?tab=products&message=Invalid%20product%20input");
      return;
    }

    const provider = providerRaw === "OUTLINE" ? ProductProvider.OUTLINE : ProductProvider.INTERNAL;
    const stockMode = stockModeRaw === "UNLIMITED" ? StockMode.UNLIMITED : StockMode.FINITE;
    const code = `${category}_${slug(name)}_${Date.now().toString().slice(-6)}`;

    await prisma.product.create({
      data: {
        code,
        name,
        category,
        subCategory,
        provider,
        stockMode,
        autoFulfill: provider === ProductProvider.OUTLINE || stockMode === StockMode.FINITE,
        server,
        dataCap,
        duration,
        price,
        notes: provider === ProductProvider.OUTLINE
          ? "- Key is delivered automatically after payment success."
          : "",
        isActive: true,
      },
    });

    res.redirect("/admin?tab=products&message=Product%20created");
  });

  app.post("/admin/outline/create-key", adminOnly, async (req, res) => {
    if (!outlineClient) {
      res.redirect("/admin?tab=outline&message=Outline%20API%20not%20configured");
      return;
    }

    const username = String(req.body.username || "").trim();
    const productId = Number(req.body.productId || 0);
    if (!username || !Number.isInteger(productId) || productId <= 0) {
      res.redirect("/admin?tab=outline&message=Invalid%20input");
      return;
    }

    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      res.redirect("/admin?tab=outline&message=Product%20not%20found");
      return;
    }

    const keyName = buildOutlineKeyName(username, product.code);
    const key = await outlineClient.createAccessKey(keyName);
    res.redirect(`/admin?tab=outline&message=Created%20key%20${encodeURIComponent(key.id)}`);
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