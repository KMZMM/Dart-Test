import dotenv from "dotenv";
import express from "express";
import session from "express-session";
import { ProductProvider } from "@prisma/client";
import { prisma } from "../prisma";
import { OutlineManagerClient } from "../services/outline";
import { syncCatalogProducts } from "../catalog/product-codes";

dotenv.config();

const ADMIN_USERNAME = process.env.ADMIN_PANEL_USERNAME?.trim() || "YeHtut";
const ADMIN_PASSWORD = process.env.ADMIN_PANEL_PASSWORD?.trim() || "KMZgaming";
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET?.trim() || "techstore-admin-session";
const OUTLINE_API_URL = process.env.OUTLINE_API_URL?.trim() || "";
const OUTLINE_INSECURE_TLS = process.env.OUTLINE_INSECURE_TLS?.trim() !== "false";

type AdminTab = "products" | "outline";

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
    .wrap { max-width: 1280px; margin: 0 auto; padding: 24px; }
    .card { background: #fff; border-radius: 12px; padding: 16px; margin-bottom: 16px; box-shadow: 0 2px 10px rgba(0,0,0,0.05); }
    h1, h2, h3 { margin: 0 0 12px; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    .tabs a { display:inline-block; margin-right:8px; padding:8px 12px; border-radius:8px; text-decoration:none; background:#e9edf5; color:#24324a; }
    .tabs a.active { background:#1a73e8; color:#fff; }
    input, select, button { padding: 10px; border: 1px solid #d3d8e2; border-radius: 8px; font-size: 14px; }
    input, select { min-width: 180px; }
    button { cursor: pointer; }
    .btn { background: #1a73e8; color: #fff; border: none; }
    .btn-secondary { background: #3f4d64; color: #fff; border: none; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #edf0f5; padding: 8px; text-align: left; font-size: 13px; vertical-align: top; }
    .muted { color: #5d6575; font-size: 13px; }
    code { font-size: 12px; }
  </style>
</head>
<body>
  <div class="wrap">${body}</div>
</body>
</html>`;
}

function tabLink(tab: AdminTab, currentTab: AdminTab): string {
  const active = tab === currentTab ? "active" : "";
  const title = tab === "products" ? "Products List" : "Outline Keys";
  return `<a class="${active}" href="/admin?tab=${tab}">${title}</a>`;
}

async function renderProductsTab(): Promise<string> {
  const products = await prisma.product.findMany({
    orderBy: [{ category: "asc" }, { subCategory: "asc" }, { price: "asc" }],
  });

  type ProductGroup = {
    category: string;
    subCategory: string;
    itemCount: number;
    providers: Set<string>;
    stockModes: Set<string>;
  };

  const groups = new Map<string, ProductGroup>();
  for (const product of products) {
    const key = `${product.category}::${product.subCategory}`;
    const existing = groups.get(key);
    if (existing) {
      existing.itemCount += 1;
      existing.providers.add(product.provider);
      existing.stockModes.add(product.stockMode);
      continue;
    }
    groups.set(key, {
      category: product.category,
      subCategory: product.subCategory,
      itemCount: 1,
      providers: new Set<string>([product.provider]),
      stockModes: new Set<string>([product.stockMode]),
    });
  }

  const rows = Array.from(groups.values())
    .map((group) => `
      <tr>
        <td>${escapeHtml(group.category)}</td>
        <td>${escapeHtml(group.subCategory)}</td>
        <td>${group.itemCount}</td>
        <td>${escapeHtml(Array.from(group.providers).join(", "))}</td>
        <td>${escapeHtml(Array.from(group.stockModes).join(", "))}</td>
      </tr>
    `)
    .join("");

  return `
    <div class="card">
      <h2>Products List (Code-Driven)</h2>
      <p class="muted">No manual product creation here. Products come from code catalog sync. This view shows only product groups, not item rows.</p>
      <form method="post" action="/admin/products/sync" class="row">
        <button class="btn" type="submit">Sync Products From Code</button>
      </form>
    </div>

    <div class="card">
      <h3>Product Groups</h3>
      <table>
        <thead>
          <tr>
            <th>Category</th><th>Product Group</th><th>Items Count</th><th>Provider</th><th>Stock Mode</th>
          </tr>
        </thead>
        <tbody>${rows || "<tr><td colspan='5'>No products synced</td></tr>"}</tbody>
      </table>
    </div>
  `;
}

async function renderOutlineTab(): Promise<string> {
  const outlineProducts = await prisma.product.findMany({
    where: { provider: ProductProvider.OUTLINE },
    orderBy: [{ category: "asc" }, { subCategory: "asc" }, { price: "asc" }],
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
      <p class="muted">Outline API: ${OUTLINE_API_URL ? "Connected" : "Not configured"}</p>
      <p class="muted">Order flow in bot auto-generates and auto-delivers keys after success.</p>
      <form method="post" action="/admin/outline/create-key" class="row">
        <input name="username" placeholder="Telegram username" required />
        <select name="productId">${productOptions || "<option value=''>No outline products</option>"}</select>
        <button class="btn" type="submit">Create Test Key</button>
      </form>
    </div>

    <div class="card">
      <h3>Existing Access Keys</h3>
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

  app.post("/admin/products/sync", adminOnly, async (_req, res) => {
    const count = await syncCatalogProducts(prisma);
    res.redirect(`/admin?tab=products&message=Synced%20${count}%20products%20from%20code`);
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
