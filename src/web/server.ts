import dotenv from "dotenv";
import express from "express";
import session from "express-session";
import { Product, ProductProvider, StockMode, VpnKeyStatus } from "@prisma/client";
import { prisma } from "../prisma";
import { syncCatalogProducts } from "../catalog/product-codes";
import { verifyUserViewToken } from "../shared/user-view-links";

dotenv.config();

const ADMIN_USERNAME = process.env.ADMIN_PANEL_USERNAME?.trim() || "YeHtut";
const ADMIN_PASSWORD = process.env.ADMIN_PANEL_PASSWORD?.trim() || "KMZgaming";
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET?.trim() || "techstore-admin-session";
const USER_VIEW_LINK_SECRET = process.env.USER_VIEW_LINK_SECRET?.trim() || "";

const PRODUCT_GROUP_LABELS: Record<string, string> = {
  ALL_SIM_WIFI_VPN_KEYS: "All Sim and Wifi Vpn Keys",
};

declare module "express-session" {
  interface SessionData {
    isAdmin?: boolean;
  }
}

type InstructionPayload =
  | { type: "text"; text: string }
  | { type: "video"; url: string; caption?: string }
  | { type: "images"; urls: string[]; caption?: string };

type ProductGroup = {
  key: string;
  title: string;
  category: string;
  products: Product[];
  productInfo: string;
  instruction: InstructionPayload | null;
};

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

function formatKs(value: number): string {
  return `${value.toLocaleString("en-US")} Ks`;
}

function formatDate(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 16);
}

function humanizeCode(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "Products";
  return normalized
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function productGroupLabel(subCategory: string): string {
  return PRODUCT_GROUP_LABELS[subCategory] || humanizeCode(subCategory);
}

function parseInstruction(value: unknown): InstructionPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (type === "text" && typeof record.text === "string" && record.text.trim()) {
    return { type: "text", text: record.text.trim() };
  }
  if (type === "video" && typeof record.url === "string" && record.url.trim()) {
    return {
      type: "video",
      url: record.url.trim(),
      caption: typeof record.caption === "string" ? record.caption.trim() : undefined,
    };
  }
  if (type === "images" && Array.isArray(record.urls)) {
    const urls = record.urls.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    if (!urls.length) return null;
    return {
      type: "images",
      urls,
      caption: typeof record.caption === "string" ? record.caption.trim() : undefined,
    };
  }
  return null;
}

function instructionToForm(instruction: InstructionPayload | null): { type: "text" | "video" | "images"; value: string; caption: string } {
  if (!instruction) return { type: "text", value: "", caption: "" };
  if (instruction.type === "text") return { type: "text", value: instruction.text, caption: "" };
  if (instruction.type === "video") return { type: "video", value: instruction.url, caption: instruction.caption || "" };
  return { type: "images", value: instruction.urls.join("\n"), caption: instruction.caption || "" };
}

function parseInstructionFromForm(typeRaw: string, valueRaw: string, captionRaw: string): InstructionPayload | null {
  const type = typeRaw === "video" || typeRaw === "images" ? typeRaw : "text";
  const value = valueRaw.trim();
  const caption = captionRaw.trim();
  if (!value) return null;
  if (type === "text") return { type: "text", text: value };
  if (type === "video") return { type: "video", url: value, caption: caption || undefined };
  const urls = value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  if (!urls.length) return null;
  return { type: "images", urls, caption: caption || undefined };
}

function instructionPreview(instruction: InstructionPayload | null): string {
  if (!instruction) return "No instruction set";
  if (instruction.type === "text") return `Text: ${instruction.text.slice(0, 80)}${instruction.text.length > 80 ? "..." : ""}`;
  if (instruction.type === "video") return `Video: ${instruction.url}`;
  return `Images: ${instruction.urls.length} URL(s)`;
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
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
    .grid-item { border: 1px solid #dfe5ef; border-radius: 12px; padding: 12px; background: #f9fbff; }
    .grid-item.active { border-color: #1a73e8; background: #eef5ff; }
    .grid-item a { text-decoration: none; color: #1a2a44; font-weight: 600; }
    input, textarea, select, button { padding: 10px; border: 1px solid #d3d8e2; border-radius: 8px; font-size: 14px; }
    input, textarea, select { min-width: 180px; }
    textarea { min-height: 84px; }
    button { cursor: pointer; }
    .btn { background: #1a73e8; color: #fff; border: none; }
    .btn-danger { background: #cf2338; color: #fff; border: none; }
    .btn-secondary { background: #3f4d64; color: #fff; border: none; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #edf0f5; padding: 8px; text-align: left; font-size: 13px; vertical-align: top; }
    .muted { color: #5d6575; font-size: 13px; }
    .stack { display: grid; gap: 10px; }
  </style>
</head>
<body>
  <div class="wrap">${body}</div>
</body>
</html>`;
}

async function renderUserHistoryPage(tokenRaw: unknown): Promise<string> {
  if (!USER_VIEW_LINK_SECRET) {
    return renderLayout("Unavailable", `
      <div class="card" style="max-width:780px; margin:40px auto;">
        <h2>Temporary history links are not configured.</h2>
      </div>
    `);
  }

  const token = typeof tokenRaw === "string" ? tokenRaw.trim() : "";
  if (!token) {
    return renderLayout("Invalid Link", `
      <div class="card" style="max-width:780px; margin:40px auto;">
        <h2>Invalid link.</h2>
      </div>
    `);
  }

  const payload = verifyUserViewToken(token, USER_VIEW_LINK_SECRET);
  if (!payload) {
    return renderLayout("Expired Link", `
      <div class="card" style="max-width:780px; margin:40px auto;">
        <h2>This link is invalid or expired.</h2>
      </div>
    `);
  }

  const user = await prisma.user.findUnique({ where: { id: payload.userId } });
  if (!user) {
    return renderLayout("Not Found", `
      <div class="card" style="max-width:780px; margin:40px auto;">
        <h2>User not found.</h2>
      </div>
    `);
  }

  if (payload.kind === "transactions") {
    const [topups, purchases] = await Promise.all([
      prisma.topUpRequest.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
      prisma.purchase.findMany({
        where: { userId: user.id },
        include: { product: true },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
    ]);

    const topupRows = topups.map((item) => `
      <tr>
        <td>${escapeHtml(formatDate(item.createdAt))}</td>
        <td>${escapeHtml(formatKs(item.amount))}</td>
        <td>${escapeHtml(item.paymentMethod)}</td>
        <td>${escapeHtml(item.status)}</td>
      </tr>
    `).join("");

    const purchaseRows = purchases.map((item) => `
      <tr>
        <td>${escapeHtml(formatDate(item.createdAt))}</td>
        <td>${escapeHtml(item.product.name)}</td>
        <td>${item.quantity}</td>
        <td>${escapeHtml(formatKs(item.totalCost))}</td>
        <td>${escapeHtml(item.paymentMethod)}</td>
        <td>${escapeHtml(item.status)}</td>
      </tr>
    `).join("");

    return renderLayout("Full Transactions", `
      <div class="card">
        <h1>Full Transactions</h1>
        <p class="muted">${escapeHtml(user.firstName)} (${user.telegramId.toString()})</p>
      </div>
      <div class="card">
        <h2>Top-Ups</h2>
        <table>
          <thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Status</th></tr></thead>
          <tbody>${topupRows || "<tr><td colspan='4'>No top-up records.</td></tr>"}</tbody>
        </table>
      </div>
      <div class="card">
        <h2>Purchases</h2>
        <table>
          <thead><tr><th>Date</th><th>Product</th><th>Qty</th><th>Total</th><th>Method</th><th>Status</th></tr></thead>
          <tbody>${purchaseRows || "<tr><td colspan='6'>No purchase records.</td></tr>"}</tbody>
        </table>
      </div>
    `);
  }

  const purchases = await prisma.purchase.findMany({
    where: {
      userId: user.id,
      status: "APPROVED",
    },
    include: {
      product: true,
      vpnKeys: true,
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const cards = purchases.map((item) => {
    const keys = item.vpnKeys.length
      ? item.vpnKeys.map((key, index) => `<div><b>${index + 1}.</b> <code>${escapeHtml(key.keyValue)}</code></div>`).join("")
      : "<div class='muted'>No stored credentials/keys for this purchase.</div>";
    return `
      <div class="card">
        <h3>${escapeHtml(item.product.name)}</h3>
        <div class="muted">${escapeHtml(formatDate(item.createdAt))}</div>
        <p><b>Server:</b> ${escapeHtml(item.product.server)}<br/>
        <b>Data:</b> ${escapeHtml(item.product.dataCap)}<br/>
        <b>Duration:</b> ${escapeHtml(item.product.duration)}<br/>
        <b>Quantity:</b> ${item.quantity}<br/>
        <b>Total Paid:</b> ${escapeHtml(formatKs(item.totalCost))}<br/>
        <b>Payment:</b> ${escapeHtml(item.paymentMethod)}</p>
        <div><b>Credentials / Keys</b></div>
        ${keys}
      </div>
    `;
  }).join("");

  return renderLayout("Full Credentials", `
    <div class="card">
      <h1>Full Credentials</h1>
      <p class="muted">${escapeHtml(user.firstName)} (${user.telegramId.toString()})</p>
    </div>
    ${cards || "<div class='card'>No approved purchases found.</div>"}
  `);
}

async function buildProductGroups(products: Product[]): Promise<ProductGroup[]> {
  const contentRows = await (prisma as any).productCategoryContent.findMany();
  const contentByGroup = new Map((contentRows as Array<{ subCategory: string; title: string; productInfo: string; instruction: unknown }>).map((item) => [item.subCategory, item]));
  const map = new Map<string, ProductGroup>();

  for (const product of products) {
    const key = product.subCategory || "GENERAL";
    const content = contentByGroup.get(key);
    const existing = map.get(key);
    if (existing) {
      existing.products.push(product);
      continue;
    }
    map.set(key, {
      key,
      title: content?.title?.trim() || productGroupLabel(key),
      category: product.category,
      products: [product],
      productInfo: content?.productInfo || "",
      instruction: parseInstruction(content?.instruction),
    });
  }

  return Array.from(map.values()).sort((a, b) => a.title.localeCompare(b.title));
}

function renderCategoryGrid(groups: ProductGroup[], activeKey: string): string {
  const items = groups.map((group) => {
    const active = group.key === activeKey ? "active" : "";
    return `
      <div class="grid-item ${active}">
        <a href="/admin?group=${encodeURIComponent(group.key)}">${escapeHtml(group.title)}</a>
        <div class="muted">${escapeHtml(group.products.length.toString())} items</div>
      </div>
    `;
  }).join("");

  return `<div class="grid">${items || "<div class='muted'>No categories</div>"}</div>`;
}

async function renderGroupSection(group: ProductGroup): Promise<string> {
  const instructionForm = instructionToForm(group.instruction);
  const itemIds = group.products.map((p) => p.id);
  const counts = itemIds.length
    ? await prisma.vpnKey.groupBy({
      by: ["productId"],
      where: { productId: { in: itemIds }, status: VpnKeyStatus.AVAILABLE },
      _count: { _all: true },
    })
    : [];

  const stockByProduct = new Map(counts.map((row) => [row.productId, row._count._all]));
  const itemRows = group.products
    .sort((a, b) => a.price - b.price)
    .map((product) => {
      const stock = product.stockMode === StockMode.UNLIMITED ? "∞" : String(stockByProduct.get(product.id) ?? 0);
      return `
        <tr>
          <td>${escapeHtml(product.name)}</td>
          <td>${escapeHtml(product.code)}</td>
          <td>${product.price.toLocaleString("en-US")} Ks</td>
          <td>${escapeHtml(product.provider)}</td>
          <td>${escapeHtml(product.stockMode)}</td>
          <td>${escapeHtml(stock)}</td>
          <td>
            <form method="post" action="/admin/items/remove">
              <input type="hidden" name="group" value="${escapeHtml(group.key)}" />
              <input type="hidden" name="productId" value="${product.id}" />
              <button class="btn-danger" type="submit">Remove</button>
            </form>
          </td>
        </tr>
      `;
    }).join("");

  return `
    <div class="card">
      <h2>${escapeHtml(group.title)}</h2>
      <p class="muted">Category key: ${escapeHtml(group.key)}</p>
      <div class="stack">
        <h3>Shared Product Info & Instruction</h3>
        <form method="post" action="/admin/category/save" class="stack">
          <input type="hidden" name="group" value="${escapeHtml(group.key)}" />
          <input type="hidden" name="category" value="${escapeHtml(group.category)}" />
          <label>Display Title</label>
          <input name="title" value="${escapeHtml(group.title)}" required />
          <label>Product Info (shared for all items in this category)</label>
          <textarea name="productInfo" placeholder="Info text">${escapeHtml(group.productInfo)}</textarea>
          <label>Instruction Type</label>
          <select name="instructionType">
            <option value="text" ${instructionForm.type === "text" ? "selected" : ""}>Text</option>
            <option value="video" ${instructionForm.type === "video" ? "selected" : ""}>Video URL</option>
            <option value="images" ${instructionForm.type === "images" ? "selected" : ""}>Image URLs (one per line)</option>
          </select>
          <label>Instruction Value</label>
          <textarea name="instructionValue" placeholder="Text or URL(s)">${escapeHtml(instructionForm.value)}</textarea>
          <label>Instruction Caption (for video/images)</label>
          <textarea name="instructionCaption" placeholder="Optional caption">${escapeHtml(instructionForm.caption)}</textarea>
          <button class="btn" type="submit">Save Category Content</button>
          <div class="muted">Current: ${escapeHtml(instructionPreview(group.instruction))}</div>
        </form>
      </div>
    </div>

    <div class="card">
      <h3>Add New Item</h3>
      <form method="post" action="/admin/items/add" class="row">
        <input type="hidden" name="group" value="${escapeHtml(group.key)}" />
        <input type="hidden" name="category" value="${escapeHtml(group.category)}" />
        <input name="code" placeholder="Code (unique)" required />
        <input name="name" placeholder="Name" required />
        <input name="server" placeholder="Server" required />
        <input name="dataCap" placeholder="Data cap" required />
        <input name="duration" placeholder="Duration" required />
        <input name="price" placeholder="Price Ks" required />
        <select name="provider">
          <option value="OUTLINE">OUTLINE</option>
          <option value="INTERNAL">INTERNAL</option>
        </select>
        <select name="stockMode">
          <option value="UNLIMITED">UNLIMITED</option>
          <option value="FINITE">FINITE</option>
        </select>
        <select name="autoFulfill">
          <option value="true">Auto Fulfill</option>
          <option value="false">Manual Fulfill</option>
        </select>
        <textarea name="warning" placeholder="Warning text (multiline supported)"></textarea>
        <textarea name="notes" placeholder="Notes text (multiline supported)"></textarea>
        <button class="btn" type="submit">Add Item</button>
      </form>
    </div>

    <div class="card">
      <h3>Item List</h3>
      <table>
        <thead>
          <tr>
            <th>Name</th><th>Code</th><th>Price</th><th>Provider</th><th>Stock Mode</th><th>Stock</th><th>Action</th>
          </tr>
        </thead>
        <tbody>${itemRows || "<tr><td colspan='7'>No items yet.</td></tr>"}</tbody>
      </table>
    </div>
  `;
}

async function renderAdminPage(requestedGroupKey: string, message = ""): Promise<string> {
  let products = await prisma.product.findMany({
    where: { isActive: true },
    orderBy: [{ subCategory: "asc" }, { price: "asc" }, { name: "asc" }],
  });

  if (!products.length) {
    await syncCatalogProducts(prisma);
    products = await prisma.product.findMany({
      where: { isActive: true },
      orderBy: [{ subCategory: "asc" }, { price: "asc" }, { name: "asc" }],
    });
  }

  const groups = await buildProductGroups(products);
  const activeGroup = groups.find((group) => group.key === requestedGroupKey) || groups[0] || null;
  const flash = message ? `<p class="muted">${escapeHtml(message)}</p>` : "";

  return renderLayout("TechStore Admin", `
    <div class="card">
      <h1>TechStore Admin</h1>
      ${flash}
      <p class="muted">Menu list grid view. Click a category to open its item list and settings.</p>
      ${renderCategoryGrid(groups, activeGroup?.key || "")}
      <br />
      <div class="row">
        <form method="post" action="/admin/products/sync">
          <input type="hidden" name="group" value="${escapeHtml(activeGroup?.key || "")}" />
          <button class="btn" type="submit">Sync Products From Code</button>
        </form>
        <form method="post" action="/logout"><button class="btn-secondary" type="submit">Logout</button></form>
      </div>
    </div>
    ${activeGroup ? await renderGroupSection(activeGroup) : "<div class='card'><p>No categories available.</p></div>"}
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

  app.get("/u/history", async (req, res) => {
    res.send(await renderUserHistoryPage(req.query.token));
  });

  app.post("/admin/products/sync", adminOnly, async (req, res) => {
    const group = String(req.body.group || "").trim();
    const count = await syncCatalogProducts(prisma);
    const query = new URLSearchParams({ message: `Synced ${count} products from code` });
    if (group) query.set("group", group);
    res.redirect(`/admin?${query.toString()}`);
  });

  app.post("/admin/category/save", adminOnly, async (req, res) => {
    const group = String(req.body.group || "").trim();
    const title = String(req.body.title || "").trim();
    const productInfo = String(req.body.productInfo || "").trim();
    const instructionType = String(req.body.instructionType || "text").trim();
    const instructionValue = String(req.body.instructionValue || "");
    const instructionCaption = String(req.body.instructionCaption || "");

    if (!group) {
      res.redirect("/admin?message=Invalid%20category");
      return;
    }

    const instruction = parseInstructionFromForm(instructionType, instructionValue, instructionCaption);
    await (prisma as any).productCategoryContent.upsert({
      where: { subCategory: group },
      create: {
        subCategory: group,
        title: title || productGroupLabel(group),
        productInfo,
        instruction: instruction as unknown as object | null,
      },
      update: {
        title: title || productGroupLabel(group),
        productInfo,
        instruction: instruction as unknown as object | null,
      },
    });

    res.redirect(`/admin?group=${encodeURIComponent(group)}&message=Category%20content%20saved`);
  });

  app.post("/admin/items/add", adminOnly, async (req, res) => {
    const group = String(req.body.group || "").trim();
    const category = String(req.body.category || "VPN_KEYS").trim() || "VPN_KEYS";
    const code = String(req.body.code || "").trim();
    const name = String(req.body.name || "").trim();
    const server = String(req.body.server || "").trim();
    const dataCap = String(req.body.dataCap || "").trim();
    const duration = String(req.body.duration || "").trim();
    const price = Number(req.body.price || 0);
    const providerRaw = String(req.body.provider || "OUTLINE").trim();
    const stockModeRaw = String(req.body.stockMode || "UNLIMITED").trim();
    const autoFulfill = String(req.body.autoFulfill || "true") !== "false";
    const warning = String(req.body.warning || "").trim();
    const notes = String(req.body.notes || "").trim();

    if (!group || !code || !name || !server || !dataCap || !duration || !Number.isFinite(price) || price <= 0) {
      res.redirect(`/admin?group=${encodeURIComponent(group)}&message=Invalid%20item%20input`);
      return;
    }

    const provider = providerRaw === "INTERNAL" ? ProductProvider.INTERNAL : ProductProvider.OUTLINE;
    const stockMode = stockModeRaw === "FINITE" ? StockMode.FINITE : StockMode.UNLIMITED;

    await prisma.product.create({
      data: {
        code,
        name,
        server,
        dataCap,
        duration,
        price,
        category,
        subCategory: group,
        provider,
        stockMode,
        autoFulfill,
        warning,
        notes,
        isActive: true,
      },
    });

    res.redirect(`/admin?group=${encodeURIComponent(group)}&message=Item%20added`);
  });

  app.post("/admin/items/remove", adminOnly, async (req, res) => {
    const group = String(req.body.group || "").trim();
    const productId = Number(req.body.productId || 0);

    if (!Number.isInteger(productId) || productId <= 0) {
      res.redirect(`/admin?group=${encodeURIComponent(group)}&message=Invalid%20product`);
      return;
    }

    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product || !product.isActive) {
      res.redirect(`/admin?group=${encodeURIComponent(group)}&message=Product%20not%20found`);
      return;
    }

    await prisma.product.update({
      where: { id: product.id },
      data: { isActive: false },
    });

    res.redirect(`/admin?group=${encodeURIComponent(group)}&message=Item%20removed`);
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
