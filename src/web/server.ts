import dotenv from "dotenv";
import express from "express";
import session from "express-session";
import { Product, StockMode, VpnKeyStatus } from "@prisma/client";
import { prisma } from "../prisma";
import { syncCatalogProducts } from "../catalog/product-codes";

dotenv.config();

const ADMIN_USERNAME = process.env.ADMIN_PANEL_USERNAME?.trim() || "YeHtut";
const ADMIN_PASSWORD = process.env.ADMIN_PANEL_PASSWORD?.trim() || "KMZgaming";
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET?.trim() || "techstore-admin-session";
const PRODUCT_GROUP_LABELS: Record<string, string> = {
  ALL_SIM_WIFI_VPN_KEYS: "All Sim & Wifi Vpn Keys",
};

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

function humanizeCode(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return "Products";
  }
  return normalized
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function productGroupLabel(subCategory: string): string {
  return PRODUCT_GROUP_LABELS[subCategory] || humanizeCode(subCategory);
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
    input, textarea, button { padding: 10px; border: 1px solid #d3d8e2; border-radius: 8px; font-size: 14px; }
    input, textarea { min-width: 180px; }
    textarea { min-height: 100px; width: 100%; resize: vertical; }
    button { cursor: pointer; }
    .btn { background: #1a73e8; color: #fff; border: none; }
    .btn-danger { background: #cf2338; color: #fff; border: none; }
    .btn-secondary { background: #3f4d64; color: #fff; border: none; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #edf0f5; padding: 8px; text-align: left; font-size: 13px; vertical-align: top; }
    .muted { color: #5d6575; font-size: 13px; }
    code { font-size: 12px; }
    .stack { display: grid; gap: 10px; }
  </style>
</head>
<body>
  <div class="wrap">${body}</div>
</body>
</html>`;
}

type ProductGroup = {
  key: string;
  title: string;
  products: Product[];
};

function tabLink(group: ProductGroup, activeGroupKey: string): string {
  const active = group.key === activeGroupKey ? "active" : "";
  return `<a class="${active}" href="/admin?group=${encodeURIComponent(group.key)}">${escapeHtml(group.title)}</a>`;
}

function buildProductGroups(products: Product[]): ProductGroup[] {
  const map = new Map<string, ProductGroup>();

  for (const product of products) {
    const key = product.subCategory || "GENERAL";
    const existing = map.get(key);
    if (existing) {
      existing.products.push(product);
      continue;
    }
    map.set(key, {
      key,
      title: productGroupLabel(key),
      products: [product],
    });
  }

  return Array.from(map.values()).sort((a, b) => a.title.localeCompare(b.title));
}

async function renderGroupTab(group: ProductGroup): Promise<string> {
  const itemProductIds = group.products.map((product) => product.id);

  const availableCounts = itemProductIds.length
    ? await prisma.vpnKey.groupBy({
      by: ["productId"],
      where: {
        productId: { in: itemProductIds },
        status: VpnKeyStatus.AVAILABLE,
      },
      _count: { _all: true },
    })
    : [];

  const keys = itemProductIds.length
    ? await prisma.vpnKey.findMany({
      where: {
        productId: { in: itemProductIds },
        status: VpnKeyStatus.AVAILABLE,
      },
      select: {
        id: true,
        productId: true,
        keyValue: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 300,
    })
    : [];

  const availableByProduct = new Map<number, number>(availableCounts.map((row) => [row.productId, row._count._all]));
  const keysByProduct = new Map<number, Array<{ id: number; keyValue: string; createdAt: Date }>>();
  for (const key of keys) {
    const existing = keysByProduct.get(key.productId) || [];
    existing.push({ id: key.id, keyValue: key.keyValue, createdAt: key.createdAt });
    keysByProduct.set(key.productId, existing);
  }

  const itemBlocks = group.products
    .sort((a, b) => a.price - b.price)
    .map((product) => {
      const manualAvailableCount = availableByProduct.get(product.id) ?? 0;
      const availableCount = product.stockMode === StockMode.UNLIMITED
        ? `Infinity (manual list: ${manualAvailableCount})`
        : String(manualAvailableCount);
      const listRows = (keysByProduct.get(product.id) || [])
        .slice(0, 20)
        .map((key) => `
          <tr>
            <td><code style="white-space:pre-wrap;word-break:break-all;">${escapeHtml(key.keyValue)}</code></td>
            <td>${key.createdAt.toISOString().slice(0, 10)}</td>
            <td>
              <form method="post" action="/admin/keys/remove">
                <input type="hidden" name="group" value="${escapeHtml(group.key)}" />
                <input type="hidden" name="keyId" value="${key.id}" />
                <button class="btn-danger" type="submit">Remove</button>
              </form>
            </td>
          </tr>
        `)
        .join("");

      const keyListSection = `
        <div class="stack">
          <h3>Key List</h3>
          <form method="post" action="/admin/keys/add" class="stack">
            <input type="hidden" name="group" value="${escapeHtml(group.key)}" />
            <input type="hidden" name="productId" value="${product.id}" />
            <textarea name="keyValues" placeholder="Paste key(s), one per line" required></textarea>
            <div class="row"><button class="btn" type="submit">Add Key(s)</button></div>
          </form>
          <table>
            <thead><tr><th>Key</th><th>Created</th><th>Action</th></tr></thead>
            <tbody>${listRows || "<tr><td colspan='3'>No available keys</td></tr>"}</tbody>
          </table>
          <p class="muted">Only AVAILABLE keys can be removed. Unlimited items still auto-generate on successful purchase.</p>
        </div>
      `;

      return `
        <div class="card">
          <h3>${escapeHtml(product.name)}</h3>
          <p class="muted">
            Price: ${product.price.toLocaleString("en-US")} Ks/month |
            Provider: ${escapeHtml(product.provider)} |
            Stock Mode: ${escapeHtml(product.stockMode)} |
            Stock: ${escapeHtml(availableCount)}
          </p>
          ${keyListSection}
        </div>
      `;
    })
    .join("");

  return `
    <div class="card">
      <h2>${escapeHtml(group.title)}</h2>
      <p class="muted">This tab contains the item list for this product group.</p>
    </div>
    ${itemBlocks || "<div class='card'><p>No items found in this product group.</p></div>"}
  `;
}

async function renderAdminPage(requestedGroupKey: string, message = ""): Promise<string> {
  const products = await prisma.product.findMany({
    where: { isActive: true },
    orderBy: [{ subCategory: "asc" }, { price: "asc" }, { name: "asc" }],
  });
  const groups = buildProductGroups(products);
  const activeGroup = groups.find((group) => group.key === requestedGroupKey) || groups[0] || null;
  const flash = message ? `<p class="muted">${escapeHtml(message)}</p>` : "";
  const tabs = groups.map((group) => tabLink(group, activeGroup?.key || "")).join("");
  const tabContent = activeGroup
    ? await renderGroupTab(activeGroup)
    : `<div class="card"><h2>No products</h2><p class="muted">Run product sync to load product list from code.</p></div>`;

  return renderLayout("TechStore Admin", `
    <div class="card">
      <h1>TechStore Admin</h1>
      ${flash}
      <p class="muted">Products are code-driven. Tabs are product groups. Each tab shows its item list only.</p>
      <div class="tabs">${tabs || "<span class='muted'>No product tabs</span>"}</div>
      <br />
      <div class="row">
        <form method="post" action="/admin/products/sync">
          <input type="hidden" name="group" value="${escapeHtml(activeGroup?.key || "")}" />
          <button class="btn" type="submit">Sync Products From Code</button>
        </form>
        <form method="post" action="/logout"><button class="btn-secondary" type="submit">Logout</button></form>
      </div>
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
    const group = typeof req.query.group === "string" ? req.query.group : "";
    const message = getFlashMessage(req.query.message);
    res.send(await renderAdminPage(group, message));
  });

  app.post("/admin/products/sync", adminOnly, async (req, res) => {
    const group = String(req.body.group || "").trim();
    const count = await syncCatalogProducts(prisma);
    const query = new URLSearchParams({
      message: `Synced ${count} products from code`,
    });
    if (group) {
      query.set("group", group);
    }
    res.redirect(`/admin?${query.toString()}`);
  });

  app.post("/admin/keys/add", adminOnly, async (req, res) => {
    const group = String(req.body.group || "").trim();
    const productId = Number(req.body.productId || 0);
    const keyValuesRaw = String(req.body.keyValues || "");

    if (!Number.isInteger(productId) || productId <= 0) {
      res.redirect(`/admin?group=${encodeURIComponent(group)}&message=Invalid%20product`);
      return;
    }

    const values = keyValuesRaw
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

    if (!values.length) {
      res.redirect(`/admin?group=${encodeURIComponent(group)}&message=No%20keys%20provided`);
      return;
    }

    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product || !product.isActive) {
      res.redirect(`/admin?group=${encodeURIComponent(group)}&message=Product%20not%20found`);
      return;
    }

    const inserted = await prisma.vpnKey.createMany({
      data: values.map((keyValue) => ({
        productId: product.id,
        keyValue,
        status: VpnKeyStatus.AVAILABLE,
      })),
      skipDuplicates: true,
    });

    res.redirect(`/admin?group=${encodeURIComponent(group)}&message=Added%20${inserted.count}%20keys`);
  });

  app.post("/admin/keys/remove", adminOnly, async (req, res) => {
    const group = String(req.body.group || "").trim();
    const keyId = Number(req.body.keyId || 0);

    if (!Number.isInteger(keyId) || keyId <= 0) {
      res.redirect(`/admin?group=${encodeURIComponent(group)}&message=Invalid%20key%20id`);
      return;
    }

    const key = await prisma.vpnKey.findUnique({ where: { id: keyId } });
    if (!key) {
      res.redirect(`/admin?group=${encodeURIComponent(group)}&message=Key%20not%20found`);
      return;
    }

    if (key.status !== VpnKeyStatus.AVAILABLE) {
      res.redirect(`/admin?group=${encodeURIComponent(group)}&message=Only%20available%20keys%20can%20be%20removed`);
      return;
    }

    await prisma.vpnKey.delete({ where: { id: keyId } });
    res.redirect(`/admin?group=${encodeURIComponent(group)}&message=Key%20removed`);
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
