import { PaymentMethod, Prisma, Product, ProductProvider, RequestStatus, SessionStep, StockMode, User, WalletTransactionType } from "@prisma/client";
import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import type { MessageEntity, User as TelegramUser } from "grammy/types";
import { config } from "./config";
import { prisma } from "./prisma";
import { OutlineManagerClient } from "./services/outline";

type BotContext = Context & { state: { dbUser?: User } };

type TopUpAmountSessionData = {
  paymentMethod: PaymentMethod;
  uiMessageId?: number;
};

type TopUpScreenshotSessionData = {
  paymentMethod: PaymentMethod;
  amount: number;
  uiMessageId?: number;
};

type BuyQuantitySessionData = {
  productId: number;
};

type BuyScreenshotSessionData = {
  productId: number;
  quantity: number;
  paymentMethod: PaymentMethod;
  totalCost: number;
};

const bot = new Bot<BotContext>(config.botToken);
const MIN_TOPUP_AMOUNT = 3000;
const uiMessageByChat = new Map<number, number>();
const OUTLINE_API_URL = process.env.OUTLINE_API_URL?.trim() || "";
const OUTLINE_INSECURE_TLS = process.env.OUTLINE_INSECURE_TLS?.trim() !== "false";
const outlineClient = OUTLINE_API_URL ? new OutlineManagerClient(OUTLINE_API_URL, OUTLINE_INSECURE_TLS) : null;

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  WALLET: "Wallet",
  KBZ_PAY: "KBZ Pay",
  WAVE_PAY: "Wave Pay",
  UAB_PAY: "UAB Pay",
  AYA_PAY: "AYA Pay",
};

const PURCHASE_EMOJI = {
  TITLE_SUCCESS: "6267008582294705964",
  PRODUCT: "6160983930158717740",
  QUANTITY: "6163514786882526317",
  TOTAL: "5409048419211682843",
  BALANCE: "5258204546391351475",
  WARNING: "6161048324603412599",
} as const;

function formatKs(value: number): string {
  return `${value.toLocaleString("en-US")} Ks`;
}

function statusText(status: RequestStatus): string {
  if (status === "APPROVED") return "Approved";
  if (status === "REJECTED") return "Rejected";
  return "Pending";
}

function paymentEmojiId(method: PaymentMethod): string {
  if (method === "KBZ_PAY") return "6242327582793014742";
  if (method === "AYA_PAY") return "6244330244438760349";
  if (method === "WAVE_PAY") return "6244400153621438081";
  if (method === "UAB_PAY") return "6244369556274421017";
  return "5206173732019659003";
}

function statusEmojiId(status: RequestStatus): string {
  if (status === "APPROVED") return "5260416304224936047";
  if (status === "REJECTED") return "5226886710020820160";
  return "5262838597060422237";
}

function appendCustomEmoji(
  text: string,
  entities: MessageEntity[],
  emojiId: string,
): string {
  const placeholder = "\u{1F642}";
  const offset = text.length;
  entities.push({
    type: "custom_emoji",
    offset,
    length: placeholder.length,
    custom_emoji_id: emojiId,
  });
  return `${text}${placeholder}`;
}

function displayName(user: User): string {
  const full = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return full || user.username || "User";
}

function parsePositiveInt(text: string): number | null {
  const digits = text.replace(/[^\d]/g, "");
  if (!digits) return null;
  const value = Number(digits);
  if (!Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

function parseDataCapToBytes(dataCap: string): number | null {
  const match = dataCap.trim().match(/^(\d+)\s*(TB|GB|MB)$/i);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  const unit = match[2].toUpperCase();
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  if (unit === "TB") return value * 1024 * 1024 * 1024 * 1024;
  if (unit === "GB") return value * 1024 * 1024 * 1024;
  return value * 1024 * 1024;
}

function buildOutlineKeyName(user: User, product: Product, index: number): string {
  const base = (user.username || user.firstName || "user")
    .normalize("NFKD")
    .replace(/[^\w.-]/g, "")
    .slice(0, 24) || "user";
  const plan = product.code.replace(/[^\w.-]/g, "").slice(0, 24) || "plan";
  const suffix = `${Date.now().toString().slice(-6)}${index + 1}`;
  return `${base}-${plan}-${suffix}`;
}

type SuccessInstructionsPayload =
  | { type: "text"; text: string }
  | { type: "video"; url: string; caption?: string }
  | { type: "images"; urls: string[]; caption?: string };

function parseSuccessInstructions(value: Prisma.JsonValue | null): SuccessInstructionsPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  if (type === "text" && typeof record.text === "string" && record.text.trim()) {
    return { type: "text", text: record.text.trim() };
  }
  if (type === "video" && typeof record.url === "string" && record.url.trim()) {
    const caption = typeof record.caption === "string" ? record.caption.trim() : undefined;
    return { type: "video", url: record.url.trim(), caption };
  }
  if (type === "images" && Array.isArray(record.urls)) {
    const urls = record.urls.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    if (urls.length) {
      const caption = typeof record.caption === "string" ? record.caption.trim() : undefined;
      return { type: "images", urls, caption };
    }
  }
  return null;
}

async function sendSuccessInstructionsToUser(telegramId: bigint, product: Product): Promise<void> {
  let payload = parseSuccessInstructions(product.successInstructions as Prisma.JsonValue | null);
  if (!payload) {
    const categoryContent = await (prisma as any).productCategoryContent.findUnique({
      where: { subCategory: product.subCategory },
      select: { instruction: true },
    });
    payload = parseSuccessInstructions(categoryContent?.instruction as Prisma.JsonValue | null);
  }
  if (!payload) {
    return;
  }

  const chatId = telegramId.toString();
  if (payload.type === "text") {
    await bot.api.sendMessage(chatId, payload.text);
    return;
  }
  if (payload.type === "video") {
    await bot.api.sendVideo(chatId, payload.url, {
      caption: payload.caption,
    });
    return;
  }
  if (payload.urls.length === 1) {
    await bot.api.sendPhoto(chatId, payload.urls[0], { caption: payload.caption });
    return;
  }
  await bot.api.sendMediaGroup(
    chatId,
    payload.urls.map((url, index) => ({
      type: "photo",
      media: url,
      caption: index === 0 ? payload.caption : undefined,
    })),
  );
}

function isAdminUser(telegramId: bigint, username?: string | null): boolean {
  if (config.adminIds.some((id) => id === telegramId)) {
    return true;
  }
  const normalized = username?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return false;
  }
  return config.adminUsernames.includes(normalized);
}

function formatDate(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 16);
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function boldText(text: string): string {
  return `<b>${escapeHtml(text)}</b>`;
}

function buildPurchaseSuccessHtml(params: {
  title: string;
  productName: string;
  quantity: number;
  totalPaid: number;
  remainingBalance?: number;
  keys?: string[];
  note?: string;
}): string {
  const lines: string[] = [
    `<tg-emoji emoji-id='${PURCHASE_EMOJI.TITLE_SUCCESS}'>✅</tg-emoji><b>${escapeHtml(params.title)}</b>`,
    "",
    `<tg-emoji emoji-id='${PURCHASE_EMOJI.PRODUCT}'>🛍</tg-emoji><b>Product: ${escapeHtml(params.productName)}</b>`,
    `<tg-emoji emoji-id='${PURCHASE_EMOJI.QUANTITY}'>✅</tg-emoji><b>Quantity: ${params.quantity}</b>`,
    `<tg-emoji emoji-id='${PURCHASE_EMOJI.TOTAL}'>💵</tg-emoji><b>Total Paid: ${escapeHtml(formatKs(params.totalPaid))}</b>`,
  ];

  if (typeof params.remainingBalance === "number") {
    lines.push(`<tg-emoji emoji-id='${PURCHASE_EMOJI.BALANCE}'>💰</tg-emoji><b>Remaining Balance: ${escapeHtml(formatKs(params.remainingBalance))}</b>`);
  }

  lines.push("");

  if (params.note) {
    lines.push(`<b>${escapeHtml(params.note)}</b>`);
  }

  if (params.keys?.length) {
    if (params.note) lines.push("");
    lines.push("<b>Keys:</b>");
    for (const [index, key] of params.keys.entries()) {
      lines.push(`<b>${index + 1}. </b><code>${escapeHtml(key)}</code>`);
    }
  }

  return lines.join("\n");
}

function latestDate(dates: Date[]): string {
  if (!dates.length) return "-";
  const maxTs = Math.max(...dates.map((d) => d.getTime()));
  return formatDate(new Date(maxTs));
}

function htmlTemplate(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 16px; background: #f5f7fb; color: #111827; font-family: Arial, sans-serif; }
    .wrap { max-width: 980px; margin: 0 auto; }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 14px; margin-bottom: 12px; }
    h1, h2, h3 { margin: 0 0 10px; }
    .muted { color: #6b7280; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 8px; text-align: left; vertical-align: top; font-size: 13px; }
    code { display: block; white-space: pre-wrap; word-break: break-all; background: #f9fafb; border-radius: 8px; padding: 6px; }
    @media (max-width: 720px) {
      body { padding: 10px; }
      table, thead, tbody, tr, th, td { display: block; width: 100%; }
      thead { display: none; }
      tr { border: 1px solid #e5e7eb; border-radius: 10px; padding: 8px; margin-bottom: 8px; background: #fff; }
      td { border-bottom: none; padding: 4px 0; }
      td::before { content: attr(data-label) ": "; font-weight: 700; color: #374151; }
    }
  </style>
</head>
<body><div class="wrap">${body}</div></body>
</html>`;
}

function buildTransactionsExportHtml(params: {
  user: User;
  topups: Array<{ createdAt: Date; amount: number; paymentMethod: PaymentMethod; status: RequestStatus }>;
  purchases: Array<{ createdAt: Date; quantity: number; totalCost: number; paymentMethod: PaymentMethod; status: RequestStatus; product: { name: string } }>;
}): string {
  const generatedAt = formatDate(new Date());
  const lastDataAt = latestDate([
    ...params.topups.map((x) => x.createdAt),
    ...params.purchases.map((x) => x.createdAt),
  ]);

  const topupRows = params.topups.map((item) => `
    <tr>
      <td data-label="Date">${escapeHtml(formatDate(item.createdAt))}</td>
      <td data-label="Amount">${escapeHtml(formatKs(item.amount))}</td>
      <td data-label="Method">${escapeHtml(PAYMENT_METHOD_LABELS[item.paymentMethod])}</td>
      <td data-label="Status">${escapeHtml(statusText(item.status))}</td>
    </tr>
  `).join("");

  const purchaseRows = params.purchases.map((item) => `
    <tr>
      <td data-label="Date">${escapeHtml(formatDate(item.createdAt))}</td>
      <td data-label="Product">${escapeHtml(item.product.name)}</td>
      <td data-label="Qty">${item.quantity}</td>
      <td data-label="Total">${escapeHtml(formatKs(item.totalCost))}</td>
      <td data-label="Method">${escapeHtml(PAYMENT_METHOD_LABELS[item.paymentMethod])}</td>
      <td data-label="Status">${escapeHtml(statusText(item.status))}</td>
    </tr>
  `).join("");

  return htmlTemplate("TechStore Full Transactions", `
    <div class="card">
      <h1>TechStore Full Transactions</h1>
      <div class="muted">User: ${escapeHtml(displayName(params.user))} (${params.user.telegramId.toString()})</div>
      <div class="muted">Generated at: ${escapeHtml(generatedAt)}</div>
      <div class="muted">Last data time: ${escapeHtml(lastDataAt)}</div>
    </div>
    <div class="card">
      <h2>Top-Ups</h2>
      <table>
        <thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Status</th></tr></thead>
        <tbody>${topupRows || "<tr><td data-label='Info' colspan='4'>No top-up records.</td></tr>"}</tbody>
      </table>
    </div>
    <div class="card">
      <h2>Purchases</h2>
      <table>
        <thead><tr><th>Date</th><th>Product</th><th>Qty</th><th>Total</th><th>Method</th><th>Status</th></tr></thead>
        <tbody>${purchaseRows || "<tr><td data-label='Info' colspan='6'>No purchase records.</td></tr>"}</tbody>
      </table>
    </div>
  `);
}

function buildCredentialsExportHtml(params: {
  user: User;
  purchases: Array<{
    createdAt: Date;
    quantity: number;
    totalCost: number;
    paymentMethod: PaymentMethod;
    product: { name: string; server: string; dataCap: string; duration: string };
    vpnKeys: Array<{ keyValue: string }>;
  }>;
}): string {
  const generatedAt = formatDate(new Date());
  const lastDataAt = latestDate(params.purchases.map((x) => x.createdAt));
  const purchaseCards = params.purchases.map((item) => {
    const keysHtml = item.vpnKeys.length
      ? item.vpnKeys.map((k, i) => `<div><b>${i + 1}.</b><code>${escapeHtml(k.keyValue)}</code></div>`).join("")
      : "<div class='muted'>No stored credentials/keys for this purchase.</div>";
    return `
      <div class="card">
        <h3>${escapeHtml(item.product.name)}</h3>
        <div class="muted">Date: ${escapeHtml(formatDate(item.createdAt))}</div>
        <div><b>Server:</b> ${escapeHtml(item.product.server)}</div>
        <div><b>Data:</b> ${escapeHtml(item.product.dataCap)}</div>
        <div><b>Duration:</b> ${escapeHtml(item.product.duration)}</div>
        <div><b>Quantity:</b> ${item.quantity}</div>
        <div><b>Total Paid:</b> ${escapeHtml(formatKs(item.totalCost))}</div>
        <div><b>Payment:</b> ${escapeHtml(PAYMENT_METHOD_LABELS[item.paymentMethod])}</div>
        <div style="margin-top:8px;"><b>Credentials / Keys</b></div>
        ${keysHtml}
      </div>
    `;
  }).join("");

  return htmlTemplate("TechStore Full Credentials", `
    <div class="card">
      <h1>TechStore Full Credentials</h1>
      <div class="muted">User: ${escapeHtml(displayName(params.user))} (${params.user.telegramId.toString()})</div>
      <div class="muted">Generated at: ${escapeHtml(generatedAt)}</div>
      <div class="muted">Last data time: ${escapeHtml(lastDataAt)}</div>
    </div>
    ${purchaseCards || "<div class='card'>No approved purchases found.</div>"}
  `);
}

async function sendTransactionsExportFile(ctx: BotContext, userId: number): Promise<void> {
  const [user, topups, purchases] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId } }),
    prisma.topUpRequest.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 500,
      select: { createdAt: true, amount: true, paymentMethod: true, status: true },
    }),
    prisma.purchase.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 500,
      include: { product: { select: { name: true } } },
    }),
  ]);
  if (!user) {
    await ctx.reply("User not found.");
    return;
  }
  const html = buildTransactionsExportHtml({ user, topups, purchases });
  const filename = `techstore-transactions-${userId}.html`;
  await ctx.replyWithDocument(new InputFile(Buffer.from(html, "utf-8"), filename), {
    caption: "Full transactions export (offline HTML).",
  });
}

async function sendCredentialsExportFile(ctx: BotContext, userId: number): Promise<void> {
  const [user, purchases] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId } }),
    prisma.purchase.findMany({
      where: { userId, status: "APPROVED" },
      orderBy: { createdAt: "desc" },
      take: 500,
      include: {
        product: { select: { name: true, server: true, dataCap: true, duration: true } },
        vpnKeys: { select: { keyValue: true } },
      },
    }),
  ]);
  if (!user) {
    await ctx.reply("User not found.");
    return;
  }
  const html = buildCredentialsExportHtml({ user, purchases });
  const filename = `techstore-credentials-${userId}.html`;
  await ctx.replyWithDocument(new InputFile(Buffer.from(html, "utf-8"), filename), {
    caption: "Full credentials export (offline HTML).",
  });
}

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{
        text: "Buy Vpn Keys",
        callback_data: "main:buyvpn",
        icon_custom_emoji_id: "6037533655105016950",
      }],
      [
        {
          text: "Transaction History",
          callback_data: "main:history",
          icon_custom_emoji_id: "5246723905535632915",
        },
        {
          text: "Guide",
          callback_data: "main:guide",
          icon_custom_emoji_id: "5452026937172048380",
        },
      ],
      [
        {
          text: "Join Channel",
          url: config.channelLink,
          icon_custom_emoji_id: "5866355487255039002",
        },
        {
          text: "Contact Admin",
          url: "https://t.me/y_e_h_t_u_t",
          icon_custom_emoji_id: "5237697567906617034",
        },
      ],
      [{
        text: "Top Up",
        callback_data: "main:topup",
        icon_custom_emoji_id: "5206173732019659003",
        style: "success",
      }],
    ],
  } as any;
}

function topUpMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "KBZ Pay", callback_data: "topup:method:KBZ_PAY", icon_custom_emoji_id: "6242327582793014742" }],
      [{ text: "Wave Pay", callback_data: "topup:method:WAVE_PAY", icon_custom_emoji_id: "6244400153621438081" }],
      [{ text: "UAB Pay", callback_data: "topup:method:UAB_PAY", icon_custom_emoji_id: "6244369556274421017" }],
      [{ text: "AYA Pay", callback_data: "topup:method:AYA_PAY", icon_custom_emoji_id: "6244330244438760349" }],
      [{ text: "Top-Up History", callback_data: "topup:history", icon_custom_emoji_id: "5246723905535632915" }],
      [{ text: "Back", callback_data: "main:menu" }],
    ],
  } as any;
}

function topUpCancelKeyboard() {
  return {
    inline_keyboard: [[{ text: "Cancel", callback_data: "topup:cancel", style: "danger" }]],
  } as any;
}

function buyCancelKeyboard() {
  return {
    inline_keyboard: [[{ text: "Cancel", callback_data: "buy:cancel", style: "danger" }]],
  } as any;
}

function guideMenuKeyboard(): InlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: "How to Top Up", callback_data: "guide:topup", icon_custom_emoji_id: "5452026937172048380" }],
      [{ text: "How to Buy VPN Key", callback_data: "guide:buyvpn", icon_custom_emoji_id: "5452026937172048380" }],
      [{ text: "Back", callback_data: "main:menu" }],
    ],
  } as any;
}

function productDetailsKeyboard(productId: number, subCategory: string): InlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: "Buy 1", callback_data: `buy1:${productId}`, style: "success" }],
      [{ text: "Buy Multiple", callback_data: `buym:${productId}`, style: "success" }],
      [{ text: "Back", callback_data: `cat:${encodeURIComponent(subCategory)}`, style: "danger" }],
    ],
  } as any;
}

function paymentChoiceKeyboard(productId: number, quantity: number) {
  return {
    inline_keyboard: [
      [{ text: "Pay with Wallet", callback_data: `pay:WALLET:${productId}:${quantity}`, icon_custom_emoji_id: "5206173732019659003" }],
      [{ text: "KBZ Pay", callback_data: `pay:KBZ_PAY:${productId}:${quantity}`, icon_custom_emoji_id: "6242327582793014742" }],
      [{ text: "Wave Pay", callback_data: `pay:WAVE_PAY:${productId}:${quantity}`, icon_custom_emoji_id: "6244400153621438081" }],
      [{ text: "UAB Pay", callback_data: `pay:UAB_PAY:${productId}:${quantity}`, icon_custom_emoji_id: "6244369556274421017" }],
      [{ text: "AYA Pay", callback_data: `pay:AYA_PAY:${productId}:${quantity}`, icon_custom_emoji_id: "6244330244438760349" }],
      [{ text: "Cancel", callback_data: "main:buyvpn" }],
    ],
  } as any;
}

function adminTopupKeyboard(requestId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("Approve", `adm:topup:approve:${requestId}`)
    .text("Reject", `adm:topup:reject:${requestId}`);
}

function adminPurchaseKeyboard(purchaseId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("Approve", `adm:purchase:approve:${purchaseId}`)
    .text("Reject", `adm:purchase:reject:${purchaseId}`);
}

function buildMainMenuText(user: User): { text: string; entities: MessageEntity[] } {
  const line1 = `\u{1F464} ${displayName(user)}`;
  const line2 = `\u{1F194} ${user.telegramId.toString()}`;
  const line3 = `\u{1F45B} ${formatKs(user.balance)}`;
  const text = [line1, line2, line3].join("\n");
  const offset2 = line1.length + 1;
  const offset3 = offset2 + line2.length + 1;

  const entities: MessageEntity[] = [
    { type: "custom_emoji", offset: 0, length: 2, custom_emoji_id: "5258011929993026890" },
    { type: "custom_emoji", offset: offset2, length: 2, custom_emoji_id: "5875335525136602241" },
    { type: "custom_emoji", offset: offset3, length: 2, custom_emoji_id: "5256186332669035163" },
  ];

  return { text, entities };
}

async function respondMenu(
  ctx: BotContext,
  text: string,
  keyboard: any,
  options?: { rawHtml?: boolean },
): Promise<void> {
  const htmlText = options?.rawHtml ? text : boldText(text);
  const chatId = ctx.chat?.id;
  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(htmlText, { reply_markup: keyboard, parse_mode: "HTML" });
      if (chatId) {
        uiMessageByChat.set(chatId, ctx.callbackQuery.message.message_id);
      }
      return;
    } catch {
      // Fallback to a new message when editing is not possible.
    }
  }
  if (chatId) {
    const previousMessageId = uiMessageByChat.get(chatId);
    if (previousMessageId) {
      try {
        await ctx.api.editMessageText(chatId, previousMessageId, htmlText, { reply_markup: keyboard, parse_mode: "HTML" });
        return;
      } catch {
        // Ignore and fallback to sending a new message.
      }
    }
  }

  const sent = await ctx.reply(htmlText, { reply_markup: keyboard, parse_mode: "HTML" });
  if (chatId) {
    uiMessageByChat.set(chatId, sent.message_id);
  }
}

async function respondMenuWithEntities(
  ctx: BotContext,
  text: string,
  entities: MessageEntity[],
  keyboard: any,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, { reply_markup: keyboard, entities });
      if (chatId) {
        uiMessageByChat.set(chatId, ctx.callbackQuery.message.message_id);
      }
      return;
    } catch {
      // Fallback to a new message when editing is not possible.
    }
  }
  if (chatId) {
    const previousMessageId = uiMessageByChat.get(chatId);
    if (previousMessageId) {
      try {
        await ctx.api.editMessageText(chatId, previousMessageId, text, { reply_markup: keyboard, entities });
        return;
      } catch {
        // Ignore and fallback to sending a new message.
      }
    }
  }

  const sent = await ctx.reply(text, { reply_markup: keyboard, entities });
  if (chatId) {
    uiMessageByChat.set(chatId, sent.message_id);
  }
}

async function editKnownUiMessage(
  ctx: BotContext,
  messageId: number | undefined,
  text: string,
  keyboard: any,
): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (!chatId || !messageId) {
    return false;
  }
  try {
    await ctx.api.editMessageText(chatId, messageId, boldText(text), {
      reply_markup: keyboard,
      parse_mode: "HTML",
    });
    uiMessageByChat.set(chatId, messageId);
    return true;
  } catch {
    return false;
  }
}

async function cleanupIncomingMessage(ctx: BotContext): Promise<void> {
  const messageId = ctx.msg?.message_id;
  const chatId = ctx.chat?.id;
  if (!messageId || !chatId) {
    return;
  }
  try {
    await ctx.api.deleteMessage(chatId, messageId);
  } catch {
    // Ignore cleanup failures.
  }
}

async function getSession(userId: number) {
  return prisma.userSession.findUnique({ where: { userId } });
}

async function setSession(
  userId: number,
  step: SessionStep,
  data: Prisma.InputJsonValue | typeof Prisma.JsonNull = Prisma.JsonNull,
) {
  await prisma.userSession.upsert({
    where: { userId },
    create: { userId, step, data },
    update: { step, data },
  });
}

async function clearSession(userId: number) {
  await setSession(userId, "NONE", Prisma.JsonNull);
}

async function loadProduct(productId: number): Promise<Product | null> {
  return prisma.product.findFirst({
    where: {
      id: productId,
      isActive: true,
    },
  });
}

async function upsertUser(from: TelegramUser): Promise<User> {
  const telegramId = BigInt(from.id);
  const shouldBeAdmin = isAdminUser(telegramId, from.username ?? null);

  const existing = await prisma.user.findUnique({ where: { telegramId } });
  if (!existing) {
    return prisma.user.create({
      data: {
        telegramId,
        username: from.username ?? null,
        firstName: from.first_name,
        lastName: from.last_name ?? null,
        isAdmin: shouldBeAdmin,
      },
    });
  }

  const needsUpdate =
    existing.username !== (from.username ?? null) ||
    existing.firstName !== from.first_name ||
    existing.lastName !== (from.last_name ?? null) ||
    existing.isAdmin !== shouldBeAdmin;

  if (!needsUpdate) {
    return existing;
  }

  return prisma.user.update({
    where: { id: existing.id },
    data: {
      username: from.username ?? null,
      firstName: from.first_name,
      lastName: from.last_name ?? null,
      isAdmin: shouldBeAdmin,
    },
  });
}

async function sendMainMenu(ctx: BotContext, userId: number): Promise<void> {
  const freshUser = await prisma.user.findUnique({ where: { id: userId } });
  if (!freshUser) return;
  const main = buildMainMenuText(freshUser);
  await respondMenuWithEntities(ctx, main.text, main.entities, mainMenuKeyboard());
}

async function sendMainMenuToChat(telegramId: bigint): Promise<void> {
  const freshUser = await prisma.user.findUnique({ where: { telegramId } });
  if (!freshUser) return;
  const main = buildMainMenuText(freshUser);
  await bot.api.sendMessage(telegramId.toString(), main.text, {
    entities: main.entities,
    reply_markup: mainMenuKeyboard(),
  });
}

async function sendTopUpHistory(ctx: BotContext, userId: number): Promise<void> {
  const requests = await prisma.topUpRequest.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  if (!requests.length) {
    await respondMenu(ctx, "<b>Top-Up History\n\nNo top-up history yet.</b>", new InlineKeyboard().text("Back", "main:topup"), { rawHtml: true });
    return;
  }

  const lines = requests.map((item) => {
    return `<b>[${escapeHtml(formatDate(item.createdAt))}] | ${escapeHtml(formatKs(item.amount))} | ${escapeHtml(PAYMENT_METHOD_LABELS[item.paymentMethod])} | ${escapeHtml(statusText(item.status))}</b>`;
  });

  const text = [
    "<b>Top-Up History</b>",
    "",
    "<b>Top-Ups:</b>",
    ...lines,
  ].join("\n");
  await respondMenu(ctx, text, new InlineKeyboard().text("Back", "main:topup"), { rawHtml: true });
}

async function sendTransactionHistory(ctx: BotContext, userId: number): Promise<void> {
  const [topups, purchases] = await Promise.all([
    prisma.topUpRequest.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    prisma.purchase.findMany({
      where: { userId },
      include: { product: true },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
  ]);

  const lines: string[] = ["<b>Transaction History</b>", "", "<b>Top-Ups:</b>"];
  if (!topups.length) {
    lines.push("<b>No top-up records</b>");
  } else {
    for (const item of topups) {
      lines.push(
        `<b>[${escapeHtml(formatDate(item.createdAt))}] | ${escapeHtml(formatKs(item.amount))} | ${escapeHtml(PAYMENT_METHOD_LABELS[item.paymentMethod])} | ${escapeHtml(statusText(item.status))}</b>`,
      );
    }
  }

  lines.push("", "<b>Purchases:</b>");
  if (!purchases.length) {
    lines.push("<b>No purchase records</b>");
  } else {
    for (const item of purchases) {
      lines.push(`<b>[${escapeHtml(formatDate(item.createdAt))}]</b>`);
      lines.push(
        `<b>${escapeHtml(item.product.name)} x ${item.quantity} | ${escapeHtml(formatKs(item.totalCost))} | ${escapeHtml(PAYMENT_METHOD_LABELS[item.paymentMethod])} | ${escapeHtml(statusText(item.status))}</b>`,
      );
    }
  }

  const keyboard = new InlineKeyboard()
    .text("Purchased Items", "history:purchased")
    .row()
    .text("Full Transactions (.html)", "history:export:transactions")
    .row()
    .text("Full Credentials (.html)", "history:export:credentials")
    .row();
  keyboard.text("Back", "main:menu");

  await respondMenu(ctx, lines.join("\n"), keyboard, { rawHtml: true });
}

async function sendPurchasedItemsHistory(ctx: BotContext, userId: number): Promise<void> {
  const purchases = await prisma.purchase.findMany({
    where: {
      userId,
      status: "APPROVED",
    },
    include: {
      product: true,
      vpnKeys: true,
    },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  if (!purchases.length) {
    await respondMenu(
      ctx,
      "<b>Purchased Items\n\nNo approved purchases yet.</b>",
      new InlineKeyboard().text("Back", "main:history"),
      { rawHtml: true },
    );
    return;
  }

  const blocks: string[] = ["<b>Purchased Items</b>"];
  for (const item of purchases) {
    const keyLines = item.vpnKeys.length
      ? item.vpnKeys.map((k, idx) => `<b>${idx + 1}. </b><code>${escapeHtml(k.keyValue)}</code>`)
      : ["<b>Credentials/Keys: Not available in history for this item.</b>"];

    blocks.push(
      "",
      `<b>[${escapeHtml(formatDate(item.createdAt))}]</b>`,
      `<b>Product: ${escapeHtml(item.product.name)}</b>`,
      `<b>Server: ${escapeHtml(item.product.server)}</b>`,
      `<b>Data: ${escapeHtml(item.product.dataCap)}</b>`,
      `<b>Duration: ${escapeHtml(item.product.duration)}</b>`,
      `<b>Quantity: ${item.quantity}</b>`,
      `<b>Total Paid: ${escapeHtml(formatKs(item.totalCost))}</b>`,
      `<b>Payment: ${escapeHtml(PAYMENT_METHOD_LABELS[item.paymentMethod])}</b>`,
      "<b>Credentials/Keys:</b>",
      ...keyLines,
    );
  }

  const keyboard = new InlineKeyboard()
    .text("Full Transactions (.html)", "history:export:transactions")
    .row()
    .text("Full Credentials (.html)", "history:export:credentials")
    .row()
    .text("Back", "main:history");

  await respondMenu(ctx, blocks.join("\n"), keyboard, { rawHtml: true });
}

async function sendGuide(ctx: BotContext, topic: "topup" | "buyvpn"): Promise<void> {
  if (topic === "topup") {
    const lines = [
      "How to Top Up",
      "",
      "1. Open Top Up from main menu.",
      "2. Choose KBZ/Wave/UAB/AYA.",
      "3. Enter amount in MMK.",
      "4. Transfer to:",
      `Phone: ${config.paymentPhone}`,
      `Account Name: ${config.paymentAccountName}`,
      "5. Send transaction screenshot.",
      "6. Wait for admin approval.",
    ];
    if (config.guideTopUpVideoUrl) {
      lines.push("");
      lines.push(`Video: ${config.guideTopUpVideoUrl}`);
    }
    await respondMenu(ctx, lines.join("\n"), guideMenuKeyboard());
    return;
  }

  const lines = [
    "How to Buy VPN Key",
    "",
    "1. Open Buy VPN Key.",
    "2. Choose your product.",
    "3. Select Buy 1 or Buy Multiple.",
    "4. Choose wallet or external payment.",
    "5. For wallet: keys are delivered instantly on success.",
    "6. For external payment: send screenshot and wait for admin approval.",
  ];
  if (config.guideBuyVideoUrl) {
    lines.push("");
    lines.push(`Video: ${config.guideBuyVideoUrl}`);
  }
  await respondMenu(ctx, lines.join("\n"), guideMenuKeyboard());
}

async function notifyAdminsTopup(topupId: number, user: User, amount: number, paymentMethod: PaymentMethod, fileId: string) {
  const adminIds = await resolveAdminTelegramIds();
  if (!adminIds.length) {
    return false;
  }

  const caption = [
    "New Top-Up Request",
    "",
    `User: ${displayName(user)}`,
    `ID: ${user.telegramId.toString()}`,
    `Amount: ${formatKs(amount)}`,
    `Method: ${PAYMENT_METHOD_LABELS[paymentMethod]}`,
  ].join("\n");

  await Promise.all(
    adminIds.map(async (adminId) => {
      await bot.api.sendPhoto(adminId.toString(), fileId, {
        caption,
        reply_markup: adminTopupKeyboard(topupId),
      });
    }),
  );
  return true;
}

async function notifyAdminsPurchase(
  purchaseId: number,
  user: User,
  productName: string,
  quantity: number,
  totalCost: number,
  paymentMethod: PaymentMethod,
  fileId: string,
) {
  const adminIds = await resolveAdminTelegramIds();
  if (!adminIds.length) {
    return false;
  }

  const caption = [
    "New Purchase Payment Request",
    "",
    `User: ${displayName(user)}`,
    `ID: ${user.telegramId.toString()}`,
    `Product: ${productName}`,
    `Quantity: ${quantity}`,
    `Amount: ${formatKs(totalCost)}`,
    `Method: ${PAYMENT_METHOD_LABELS[paymentMethod]}`,
  ].join("\n");

  await Promise.all(
    adminIds.map(async (adminId) => {
      await bot.api.sendPhoto(adminId.toString(), fileId, {
        caption,
        reply_markup: adminPurchaseKeyboard(purchaseId),
      });
    }),
  );
  return true;
}

async function notifyAdminsManualWalletPurchase(
  purchaseId: number,
  user: User,
  productName: string,
  quantity: number,
  totalCost: number,
) {
  const adminIds = await resolveAdminTelegramIds();
  if (!adminIds.length) {
    return false;
  }

  const text = [
    "Manual Delivery Purchase",
    "",
    `User: ${displayName(user)}`,
    `ID: ${user.telegramId.toString()}`,
    `Product: ${productName}`,
    `Quantity: ${quantity}`,
    `Amount: ${formatKs(totalCost)}`,
    `Purchase ID: ${purchaseId}`,
    "",
    "Payment was completed via wallet. Please deliver key manually.",
  ].join("\n");

  await Promise.all(adminIds.map((adminId) => bot.api.sendMessage(adminId.toString(), text)));
  return true;
}

async function notifyAdminsOutlineDeliveryIssue(
  purchaseId: number,
  user: User,
  productName: string,
  reason: string,
) {
  const adminIds = await resolveAdminTelegramIds();
  if (!adminIds.length) {
    return false;
  }

  const text = [
    "Outline Delivery Failed",
    "",
    `User: ${displayName(user)}`,
    `ID: ${user.telegramId.toString()}`,
    `Purchase ID: ${purchaseId}`,
    `Product: ${productName}`,
    `Reason: ${reason}`,
  ].join("\n");

  await Promise.all(adminIds.map((adminId) => bot.api.sendMessage(adminId.toString(), text)));
  return true;
}

async function generateOutlineKeys(user: User, product: Product, quantity: number): Promise<string[]> {
  if (!outlineClient) {
    throw new Error("Outline API is not configured");
  }

  const dataLimitBytes = parseDataCapToBytes(product.dataCap);
  const urls: string[] = [];
  for (let i = 0; i < quantity; i += 1) {
    const keyName = buildOutlineKeyName(user, product, i);
    const key = await outlineClient.createAccessKey(keyName, dataLimitBytes ?? undefined);
    urls.push(key.accessUrl);
  }
  return urls;
}

async function resolveAdminTelegramIds(): Promise<bigint[]> {
  const ids = new Set<string>(config.adminIds.map((id) => id.toString()));
  const dbAdmins = await prisma.user.findMany({
    where: { isAdmin: true },
    select: { telegramId: true },
  });

  for (const admin of dbAdmins) {
    ids.add(admin.telegramId.toString());
  }

  return Array.from(ids, (id) => BigInt(id));
}

function formatCategoryTitle(subCategory: string): string {
  if (subCategory === "ALL_SIM_WIFI_VPN_KEYS") return "All Sim and Wifi Vpn Keys";
  return subCategory
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

async function sendCategoryList(ctx: BotContext): Promise<void> {
  const categories = await prisma.product.findMany({
    where: { isActive: true },
    select: { subCategory: true },
    distinct: ["subCategory"],
    orderBy: { subCategory: "asc" },
  });

  if (!categories.length) {
    await respondMenu(ctx, "No categories available right now.", new InlineKeyboard().text("Back", "main:menu"));
    return;
  }

  const meta = await (prisma as any).productCategoryContent.findMany({
    where: { subCategory: { in: categories.map((c) => c.subCategory) } },
    select: { subCategory: true, title: true },
  });
  const titleByCategory = new Map((meta as Array<{ subCategory: string; title: string }>).map((item) => [item.subCategory, item.title]));

  const rows: Array<Array<{ text: string; callback_data: string; icon_custom_emoji_id?: string }>> = [];
  let row: Array<{ text: string; callback_data: string; icon_custom_emoji_id?: string }> = [];
  for (const category of categories) {
    const title = titleByCategory.get(category.subCategory)?.trim() || formatCategoryTitle(category.subCategory);
    row.push({
      text: title,
      callback_data: `cat:${encodeURIComponent(category.subCategory)}`,
      icon_custom_emoji_id: "6037533655105016950",
    });
    if (row.length === 2) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length > 0) rows.push(row);
  rows.push([{ text: "Back", callback_data: "main:menu" }]);

  await respondMenu(ctx, "Choose a category:", { inline_keyboard: rows });
}

async function sendProductList(ctx: BotContext, subCategory: string): Promise<void> {
  const products = await prisma.product.findMany({
    where: { isActive: true, subCategory },
    orderBy: [{ price: "asc" }, { name: "asc" }],
  });

  if (!products.length) {
    await respondMenu(ctx, "No products in this category right now.", new InlineKeyboard().text("Back", "main:buyvpn"));
    return;
  }

  const finiteProductIds = products.filter((product) => product.stockMode === "FINITE").map((product) => product.id);
  const stockGroups = finiteProductIds.length
    ? await prisma.vpnKey.groupBy({
      by: ["productId"],
      where: { status: "AVAILABLE", productId: { in: finiteProductIds } },
      _count: { _all: true },
    })
    : [];
  const stockByProduct = new Map<number, number>(
    stockGroups.map((group) => [group.productId, group._count._all]),
  );

  const rows: Array<Array<{ text: string; callback_data: string; icon_custom_emoji_id?: string }>> = [];
  for (const product of products) {
    const stockLabel = product.stockMode === "UNLIMITED"
      ? "(∞)"
      : `(${stockByProduct.get(product.id) ?? 0})`;
    rows.push([{
      text: `${product.name} | ${stockLabel} | ${formatKs(product.price)}/month`,
      callback_data: `prod:${product.id}`,
      icon_custom_emoji_id: "6082614104290232643",
    }]);
  }
  rows.push([{ text: "Back", callback_data: "main:buyvpn" }]);

  await respondMenu(ctx, "Product List", { inline_keyboard: rows });
}

async function sendProductDetails(ctx: BotContext, product: Product): Promise<void> {
  const categoryContent = await (prisma as any).productCategoryContent.findUnique({
    where: { subCategory: product.subCategory },
    select: { productInfo: true },
  });
  const sharedInfo = categoryContent?.productInfo?.trim() || "";
  const stockText = product.stockMode === "UNLIMITED" ? "Unlimited" : "Limited";
  const text = [
    `<tg-emoji emoji-id='4960766907113276588'>💠</tg-emoji><b> Product Details</b>`,
    "",
    `<tg-emoji emoji-id='6082614104290232643'>👍</tg-emoji><b> Server: ${escapeHtml(product.server)}</b>`,
    `<tg-emoji emoji-id='6082116463609517673'>🌐</tg-emoji><b> Data: ${escapeHtml(product.dataCap)}</b>`,
    `<tg-emoji emoji-id='5909068103790106321'>⏱</tg-emoji><b> Duration: ${escapeHtml(product.duration)}</b>`,
    `<tg-emoji emoji-id='5449872877929127395'>📈</tg-emoji><b> Stock: ${escapeHtml(stockText)}</b>`,
    `<tg-emoji emoji-id='5409048419211682843'>💵</tg-emoji><b> Price: ${escapeHtml(formatKs(product.price))}/month</b>`,
    "",
    `<tg-emoji emoji-id='5445375244011328755'>😩</tg-emoji><b> Product Info:</b>`,
    `<b>${escapeHtml(sharedInfo || "-")}</b>`,
  ].join("\n");

  await respondMenu(ctx, text, productDetailsKeyboard(product.id, product.subCategory), { rawHtml: true });
}
async function sendPurchasePaymentChoice(ctx: BotContext, product: Product, quantity: number): Promise<void> {
  const total = product.price * quantity;
  const lines = [
    "💠 Confirm your purchase.",
    "",
    `🛍Product: ${product.name}`,
    `💰 Quantity: ${quantity}`,
    `💵 Total Cost: ${formatKs(total)}`,
    "",
    "Choose payment method:",
  ];
  const text = lines.join("\n");

  const lineOffsets: number[] = [];
  let runningOffset = 0;
  for (const line of lines) {
    lineOffsets.push(runningOffset);
    runningOffset += line.length + 1;
  }

  const entities: MessageEntity[] = [
    { type: "custom_emoji", offset: lineOffsets[0], length: 2, custom_emoji_id: "4960766907113276588" }, // title
    { type: "custom_emoji", offset: lineOffsets[3], length: 2, custom_emoji_id: "5301008864773159042" }, // quantity
    { type: "custom_emoji", offset: lineOffsets[4], length: 2, custom_emoji_id: "5409048419211682843" }, // total
    { type: "bold", offset: 0, length: text.length },
  ];

  try {
    await respondMenuWithEntities(ctx, text, entities, paymentChoiceKeyboard(product.id, quantity));
  } catch {
    await respondMenu(ctx, text, paymentChoiceKeyboard(product.id, quantity));
  }
}

async function processWalletPurchase(userId: number, product: Product, quantity: number) {
  const totalCost = product.price * quantity;

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) {
      return { ok: false as const, reason: "USER_NOT_FOUND" as const };
    }

    if (user.balance < totalCost) {
      return { ok: false as const, reason: "INSUFFICIENT_BALANCE" as const, currentBalance: user.balance };
    }

    if (product.provider === ProductProvider.OUTLINE) {
      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: { balance: { decrement: totalCost } },
      });

      const purchase = await tx.purchase.create({
        data: {
          userId,
          productId: product.id,
          quantity,
          unitPrice: product.price,
          totalCost,
          paymentMethod: "WALLET",
          status: "APPROVED",
          reviewedAt: new Date(),
          adminNote: "Outline auto-delivery",
        },
      });

      await tx.walletTransaction.create({
        data: {
          userId,
          type: WalletTransactionType.PURCHASE_DEBIT,
          amount: -totalCost,
          balanceBefore: user.balance,
          balanceAfter: updatedUser.balance,
          description: `Wallet payment for ${product.name} x${quantity}`,
          purchaseId: purchase.id,
        },
      });

      return {
        ok: true as const,
        deliveryMode: "OUTLINE" as const,
        keys: [] as string[],
        purchaseId: purchase.id,
        newBalance: updatedUser.balance,
        totalCost,
      };
    }

    if (!product.autoFulfill || product.stockMode === StockMode.UNLIMITED) {
      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: { balance: { decrement: totalCost } },
      });

      const purchase = await tx.purchase.create({
        data: {
          userId,
          productId: product.id,
          quantity,
          unitPrice: product.price,
          totalCost,
          paymentMethod: "WALLET",
          status: "APPROVED",
          reviewedAt: new Date(),
          adminNote: "Manual fulfillment pending",
        },
      });

      await tx.walletTransaction.create({
        data: {
          userId,
          type: WalletTransactionType.PURCHASE_DEBIT,
          amount: -totalCost,
          balanceBefore: user.balance,
          balanceAfter: updatedUser.balance,
          description: `Wallet payment for ${product.name} x${quantity}`,
          purchaseId: purchase.id,
        },
      });

      return {
        ok: true as const,
        deliveryMode: "MANUAL" as const,
        keys: [] as string[],
        purchaseId: purchase.id,
        newBalance: updatedUser.balance,
        totalCost,
      };
    }

    const keys = await tx.vpnKey.findMany({
      where: {
        productId: product.id,
        status: "AVAILABLE",
      },
      orderBy: { id: "asc" },
      take: quantity,
    });

    if (keys.length < quantity) {
      return { ok: false as const, reason: "OUT_OF_STOCK" as const };
    }

    const updatedUser = await tx.user.update({
      where: { id: userId },
      data: { balance: { decrement: totalCost } },
    });

    const purchase = await tx.purchase.create({
      data: {
        userId,
        productId: product.id,
        quantity,
        unitPrice: product.price,
        totalCost,
        paymentMethod: "WALLET",
        status: "APPROVED",
        reviewedAt: new Date(),
      },
    });

    for (const key of keys) {
      await tx.vpnKey.update({
        where: { id: key.id },
        data: {
          status: "SOLD",
          soldAt: new Date(),
          soldToUserId: userId,
          soldToPurchaseId: purchase.id,
        },
      });
    }

    await tx.walletTransaction.create({
      data: {
        userId,
        type: WalletTransactionType.PURCHASE_DEBIT,
        amount: -totalCost,
        balanceBefore: user.balance,
        balanceAfter: updatedUser.balance,
        description: `Wallet payment for ${product.name} x${quantity}`,
        purchaseId: purchase.id,
      },
    });

    return {
      ok: true as const,
      deliveryMode: "INSTANT_KEYS" as const,
      keys: keys.map((key) => key.keyValue),
      purchaseId: purchase.id,
      newBalance: updatedUser.balance,
      totalCost,
    };
  });
}

async function reviewTopUp(requestId: number, adminUserId: number, approve: boolean) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.topUpRequest.findUnique({
      where: { id: requestId },
      include: { user: true },
    });

    if (!request || request.status !== "PENDING") {
      return null;
    }

    if (!approve) {
      const rejected = await tx.topUpRequest.update({
        where: { id: request.id },
        data: {
          status: "REJECTED",
          reviewedAt: new Date(),
          reviewedByAdminId: adminUserId,
        },
      });

      return {
        request: rejected,
        user: request.user,
        approved: false,
        newBalance: request.user.balance,
      };
    }

    const updatedUser = await tx.user.update({
      where: { id: request.userId },
      data: { balance: { increment: request.amount } },
    });

    const approvedRequest = await tx.topUpRequest.update({
      where: { id: request.id },
      data: {
        status: "APPROVED",
        reviewedAt: new Date(),
        reviewedByAdminId: adminUserId,
      },
    });

    await tx.walletTransaction.create({
      data: {
        userId: request.userId,
        type: WalletTransactionType.TOPUP_CREDIT,
        amount: request.amount,
        balanceBefore: request.user.balance,
        balanceAfter: updatedUser.balance,
        description: `Top-up via ${PAYMENT_METHOD_LABELS[request.paymentMethod]}`,
        topUpRequestId: request.id,
      },
    });

    return {
      request: approvedRequest,
      user: request.user,
      approved: true,
      newBalance: updatedUser.balance,
    };
  });
}

async function reviewPurchase(purchaseId: number, adminUserId: number, approve: boolean) {
  return prisma.$transaction(async (tx) => {
    const purchase = await tx.purchase.findUnique({
      where: { id: purchaseId },
      include: { user: true, product: true },
    });

    if (!purchase || purchase.status !== "PENDING") {
      return null;
    }

    if (!approve) {
      const rejected = await tx.purchase.update({
        where: { id: purchase.id },
        data: {
          status: "REJECTED",
          reviewedByAdminId: adminUserId,
          reviewedAt: new Date(),
        },
      });

      return {
        purchase: rejected,
        user: purchase.user,
        product: purchase.product,
        approved: false,
        deliveryMode: "REJECTED" as const,
        keys: [] as string[],
        reason: null as string | null,
      };
    }

    if (purchase.product.provider === ProductProvider.OUTLINE) {
      const approvedOutline = await tx.purchase.update({
        where: { id: purchase.id },
        data: {
          status: "APPROVED",
          reviewedByAdminId: adminUserId,
          reviewedAt: new Date(),
          adminNote: "Outline auto-delivery",
        },
      });

      return {
        purchase: approvedOutline,
        user: purchase.user,
        product: purchase.product,
        approved: true,
        deliveryMode: "OUTLINE" as const,
        keys: [] as string[],
        reason: null as string | null,
      };
    }

    if (!purchase.product.autoFulfill || purchase.product.stockMode === StockMode.UNLIMITED) {
      const approvedManual = await tx.purchase.update({
        where: { id: purchase.id },
        data: {
          status: "APPROVED",
          reviewedByAdminId: adminUserId,
          reviewedAt: new Date(),
          adminNote: "Manual fulfillment required",
        },
      });

      return {
        purchase: approvedManual,
        user: purchase.user,
        product: purchase.product,
        approved: true,
        deliveryMode: "MANUAL" as const,
        keys: [] as string[],
        reason: null as string | null,
      };
    }

    const keys = await tx.vpnKey.findMany({
      where: {
        productId: purchase.productId,
        status: "AVAILABLE",
      },
      orderBy: { id: "asc" },
      take: purchase.quantity,
    });

    if (keys.length < purchase.quantity) {
      const rejectedByStock = await tx.purchase.update({
        where: { id: purchase.id },
        data: {
          status: "REJECTED",
          reviewedByAdminId: adminUserId,
          reviewedAt: new Date(),
          adminNote: "Insufficient key stock",
        },
      });

      return {
        purchase: rejectedByStock,
        user: purchase.user,
        product: purchase.product,
        approved: false,
        deliveryMode: "REJECTED" as const,
        keys: [] as string[],
        reason: "INSUFFICIENT_STOCK",
      };
    }

    for (const key of keys) {
      await tx.vpnKey.update({
        where: { id: key.id },
        data: {
          status: "SOLD",
          soldAt: new Date(),
          soldToUserId: purchase.userId,
          soldToPurchaseId: purchase.id,
        },
      });
    }

    const approvedPurchase = await tx.purchase.update({
      where: { id: purchase.id },
      data: {
        status: "APPROVED",
        reviewedByAdminId: adminUserId,
        reviewedAt: new Date(),
      },
    });

    return {
      purchase: approvedPurchase,
      user: purchase.user,
      product: purchase.product,
      approved: true,
      deliveryMode: "INSTANT_KEYS" as const,
      keys: keys.map((k) => k.keyValue),
      reason: null as string | null,
    };
  });
}

bot.use(async (ctx, next) => {
  ctx.state = (ctx.state ?? {}) as BotContext["state"];
  if (ctx.from) {
    ctx.state.dbUser = await upsertUser(ctx.from);
  }
  await next();
});

bot.command("start", async (ctx) => {
  const user = ctx.state.dbUser;
  if (!user) return;
  await clearSession(user.id);
  await sendMainMenu(ctx, user.id);
});

bot.command("menu", async (ctx) => {
  const user = ctx.state.dbUser;
  if (!user) return;
  await sendMainMenu(ctx, user.id);
});

bot.command("myid", async (ctx) => {
  if (!ctx.from) return;
  await ctx.reply(`Your Telegram ID: ${ctx.from.id}`);
});

bot.callbackQuery("main:menu", async (ctx) => {
  const user = ctx.state.dbUser;
  if (!user) return;
  await ctx.answerCallbackQuery();
  await sendMainMenu(ctx, user.id);
});

bot.callbackQuery("main:topup", async (ctx) => {
  await ctx.answerCallbackQuery();
  await respondMenu(
    ctx,
    "Top-Up Menu\nPlease choose a payment method:",
    topUpMenuKeyboard(),
  );
});

bot.callbackQuery("topup:history", async (ctx) => {
  const user = ctx.state.dbUser;
  if (!user) return;
  await ctx.answerCallbackQuery();
  await sendTopUpHistory(ctx, user.id);
});

bot.callbackQuery(/^topup:method:(KBZ_PAY|WAVE_PAY|UAB_PAY|AYA_PAY)$/, async (ctx) => {
  const user = ctx.state.dbUser;
  if (!user) return;
  await ctx.answerCallbackQuery();
  const method = ctx.match[1] as PaymentMethod;
  const uiMessageId = ctx.callbackQuery.message?.message_id;
  await setSession(user.id, "TOPUP_ENTER_AMOUNT", { paymentMethod: method, uiMessageId });
  await respondMenu(
    ctx,
    [
      "Top-Up Amount",
      "",
      `Method: ${PAYMENT_METHOD_LABELS[method]}`,
      `Enter amount in MMK (minimum ${formatKs(MIN_TOPUP_AMOUNT)}):`,
    ].join("\n"),
    topUpCancelKeyboard(),
  );
});

bot.callbackQuery("topup:cancel", async (ctx) => {
  const user = ctx.state.dbUser;
  if (!user) return;
  await ctx.answerCallbackQuery({ text: "Top-up canceled" });
  await clearSession(user.id);
  await sendMainMenu(ctx, user.id);
});

bot.callbackQuery("buy:cancel", async (ctx) => {
  const user = ctx.state.dbUser;
  if (!user) return;
  await ctx.answerCallbackQuery({ text: "Purchase canceled" });
  await clearSession(user.id);
  await sendMainMenu(ctx, user.id);
});

bot.callbackQuery("main:buyvpn", async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendCategoryList(ctx);
});

bot.callbackQuery(/^cat:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const subCategory = decodeURIComponent(ctx.match[1]);
  await sendProductList(ctx, subCategory);
});

bot.callbackQuery(/^prod:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const productId = Number(ctx.match[1]);
  const product = await loadProduct(productId);
  if (!product) {
    await ctx.reply("This product is not available.");
    return;
  }
  await sendProductDetails(ctx, product);
});

bot.callbackQuery(/^buy1:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const productId = Number(ctx.match[1]);
  const product = await loadProduct(productId);
  if (!product) {
    await ctx.reply("This product is not available.");
    return;
  }
  await sendPurchasePaymentChoice(ctx, product, 1);
});

bot.callbackQuery(/^buym:(\d+)$/, async (ctx) => {
  const user = ctx.state.dbUser;
  if (!user) return;
  await ctx.answerCallbackQuery();
  const productId = Number(ctx.match[1]);
  const product = await loadProduct(productId);
  if (!product) {
    await ctx.reply("This product is not available.");
    return;
  }
  await setSession(user.id, "BUY_ENTER_QUANTITY", { productId });
  await ctx.reply("Enter quantity:");
});

bot.callbackQuery(/^pay:(WALLET|KBZ_PAY|WAVE_PAY|UAB_PAY|AYA_PAY):(\d+):(\d+)$/, async (ctx) => {
  const user = ctx.state.dbUser;
  if (!user) return;
  await ctx.answerCallbackQuery();

  const method = ctx.match[1] as PaymentMethod;
  const productId = Number(ctx.match[2]);
  const quantity = Number(ctx.match[3]);

  if (!Number.isInteger(quantity) || quantity <= 0) {
    await ctx.reply("Invalid quantity.");
    return;
  }

  const product = await loadProduct(productId);
  if (!product) {
    await ctx.reply("This product is not available.");
    return;
  }

  if (method === "WALLET") {
    const result = await processWalletPurchase(user.id, product, quantity);
    if (!result.ok) {
      if (result.reason === "INSUFFICIENT_BALANCE") {
        await clearSession(user.id);
        await respondMenu(
          ctx,
          "Insufficient balance. Please top up your account.",
          new InlineKeyboard().text("Main Menu", "main:menu"),
        );
        return;
      }
      if (result.reason === "OUT_OF_STOCK") {
        await clearSession(user.id);
        await respondMenu(
          ctx,
          "Not enough keys in stock for this quantity.",
          new InlineKeyboard().text("Main Menu", "main:menu"),
        );
        return;
      }
      await clearSession(user.id);
      await respondMenu(
        ctx,
        "Purchase failed. Please try again.",
        new InlineKeyboard().text("Main Menu", "main:menu"),
      );
      return;
    }

    await clearSession(user.id);

    if (result.deliveryMode === "OUTLINE") {
      try {
        const keys = await generateOutlineKeys(user, product, quantity);
        await ctx.reply(buildPurchaseSuccessHtml({
          title: "Purchase Successful",
          productName: product.name,
          quantity,
          totalPaid: result.totalCost,
          remainingBalance: result.newBalance,
          keys,
        }), { parse_mode: "HTML" });
        await sendSuccessInstructionsToUser(user.telegramId, product);
      } catch (error) {
        await ctx.reply(buildPurchaseSuccessHtml({
          title: "Purchase Successful",
          productName: product.name,
          quantity,
          totalPaid: result.totalCost,
          remainingBalance: result.newBalance,
          note: "Payment confirmed. Key delivery is processing. Please wait.",
        }), { parse_mode: "HTML" });
        await notifyAdminsOutlineDeliveryIssue(
          result.purchaseId,
          user,
          product.name,
          error instanceof Error ? error.message : String(error),
        );
      }
      await sendMainMenu(ctx, user.id);
      return;
    }

    if (result.deliveryMode === "MANUAL") {
      await ctx.reply(buildPurchaseSuccessHtml({
        title: "Purchase Successful",
        productName: product.name,
        quantity,
        totalPaid: result.totalCost,
        remainingBalance: result.newBalance,
        note: "Your order requires manual delivery. Admin will send your key soon.",
      }), { parse_mode: "HTML" });
      await sendSuccessInstructionsToUser(user.telegramId, product);

      await notifyAdminsManualWalletPurchase(
        result.purchaseId,
        user,
        product.name,
        quantity,
        result.totalCost,
      );
      await sendMainMenu(ctx, user.id);
      return;
    }

    await ctx.reply(buildPurchaseSuccessHtml({
      title: "Purchase Successful",
      productName: product.name,
      quantity,
      totalPaid: result.totalCost,
      remainingBalance: result.newBalance,
      keys: result.keys,
    }), { parse_mode: "HTML" });
    await sendSuccessInstructionsToUser(user.telegramId, product);
    await sendMainMenu(ctx, user.id);
    return;
  }

  const totalCost = product.price * quantity;
  const sessionData: BuyScreenshotSessionData = {
    productId: product.id,
    quantity,
    paymentMethod: method,
    totalCost,
  };
  await setSession(user.id, "BUY_WAIT_SCREENSHOT", sessionData as unknown as Prisma.InputJsonValue);

  await respondMenu(
    ctx,
    [
      "Please transfer the total amount to:",
      "",
      `Phone: ${config.paymentPhone}`,
      `Account Name: ${config.paymentAccountName}`,
      "",
      `Amount: ${formatKs(totalCost)}`,
      `Method: ${PAYMENT_METHOD_LABELS[method]}`,
      "",
      "After payment, send your screenshot.",
    ].join("\n"),
    buyCancelKeyboard(),
  );
});

bot.callbackQuery("main:history", async (ctx) => {
  const user = ctx.state.dbUser;
  if (!user) return;
  await ctx.answerCallbackQuery();
  await sendTransactionHistory(ctx, user.id);
});

bot.callbackQuery("history:purchased", async (ctx) => {
  const user = ctx.state.dbUser;
  if (!user) return;
  await ctx.answerCallbackQuery();
  await sendPurchasedItemsHistory(ctx, user.id);
});

bot.callbackQuery("history:export:transactions", async (ctx) => {
  const user = ctx.state.dbUser;
  if (!user) return;
  await ctx.answerCallbackQuery({ text: "Preparing full transactions HTML..." });
  await sendTransactionsExportFile(ctx, user.id);
});

bot.callbackQuery("history:export:credentials", async (ctx) => {
  const user = ctx.state.dbUser;
  if (!user) return;
  await ctx.answerCallbackQuery({ text: "Preparing full credentials HTML..." });
  await sendCredentialsExportFile(ctx, user.id);
});

bot.callbackQuery("main:guide", async (ctx) => {
  await ctx.answerCallbackQuery();
  await respondMenu(ctx, "Guide Menu", guideMenuKeyboard());
});

bot.callbackQuery("guide:topup", async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendGuide(ctx, "topup");
});

bot.callbackQuery("guide:buyvpn", async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendGuide(ctx, "buyvpn");
});

bot.callbackQuery(/^adm:(topup|purchase):(approve|reject):(\d+)$/, async (ctx) => {
  const user = ctx.state.dbUser;
  if (!user || !isAdminUser(user.telegramId, ctx.from?.username ?? user.username)) {
    await ctx.answerCallbackQuery({ text: "Admin only", show_alert: true });
    return;
  }

  const entity = ctx.match[1];
  const action = ctx.match[2];
  const id = Number(ctx.match[3]);
  const approve = action === "approve";

  if (entity === "topup") {
    const result = await reviewTopUp(id, user.id, approve);
    if (!result) {
      await ctx.answerCallbackQuery({ text: "Already processed", show_alert: true });
      return;
    }

    if (result.approved) {
      await bot.api.sendMessage(
        result.user.telegramId.toString(),
        [
          "Top-Up Successful",
          "",
          `Amount: ${formatKs(result.request.amount)}`,
          `New Balance: ${formatKs(result.newBalance)}`,
        ].join("\n"),
      );
      await sendMainMenuToChat(result.user.telegramId);
      await ctx.answerCallbackQuery({ text: "Top-up approved" });
      await ctx.reply(`Top-up #${id} approved.`);
    } else {
      await bot.api.sendMessage(
        result.user.telegramId.toString(),
        "Top-Up Failed\n\nPlease contact support or try again.",
      );
      await sendMainMenuToChat(result.user.telegramId);
      await ctx.answerCallbackQuery({ text: "Top-up rejected" });
      await ctx.reply(`Top-up #${id} rejected.`);
    }
    return;
  }

  const result = await reviewPurchase(id, user.id, approve);
  if (!result) {
    await ctx.answerCallbackQuery({ text: "Already processed", show_alert: true });
    return;
  }

  if (result.approved) {
    if (result.deliveryMode === "OUTLINE") {
      try {
        const keys = await generateOutlineKeys(result.user, result.product, result.purchase.quantity);
        await bot.api.sendMessage(
          result.user.telegramId.toString(),
          buildPurchaseSuccessHtml({
            title: "Payment Confirmed",
            productName: result.product.name,
            quantity: result.purchase.quantity,
            totalPaid: result.purchase.totalCost,
            keys,
          }),
          { parse_mode: "HTML" },
        );
        await sendSuccessInstructionsToUser(result.user.telegramId, result.product);
      } catch (error) {
        await bot.api.sendMessage(
          result.user.telegramId.toString(),
          buildPurchaseSuccessHtml({
            title: "Payment Confirmed",
            productName: result.product.name,
            quantity: result.purchase.quantity,
            totalPaid: result.purchase.totalCost,
            note: "Payment confirmed. Key delivery is processing. Please wait.",
          }),
          { parse_mode: "HTML" },
        );
        await notifyAdminsOutlineDeliveryIssue(
          result.purchase.id,
          result.user,
          result.product.name,
          error instanceof Error ? error.message : String(error),
        );
      }
      await sendMainMenuToChat(result.user.telegramId);
      await ctx.answerCallbackQuery({ text: "Purchase approved" });
      await ctx.reply(`Purchase #${id} approved.`);
      return;
    }

    const message = result.deliveryMode === "MANUAL"
      ? buildPurchaseSuccessHtml({
        title: "Payment Confirmed",
        productName: result.product.name,
        quantity: result.purchase.quantity,
        totalPaid: result.purchase.totalCost,
        note: "Your order requires manual key delivery. Admin will send it soon.",
      })
      : buildPurchaseSuccessHtml({
        title: "Payment Confirmed",
        productName: result.product.name,
        quantity: result.purchase.quantity,
        totalPaid: result.purchase.totalCost,
        keys: result.keys,
      });
    await bot.api.sendMessage(result.user.telegramId.toString(), message, { parse_mode: "HTML" });
    await sendSuccessInstructionsToUser(result.user.telegramId, result.product);
    await sendMainMenuToChat(result.user.telegramId);
    await ctx.answerCallbackQuery({ text: "Purchase approved" });
    await ctx.reply(`Purchase #${id} approved.`);
    return;
  }

  if (result.reason === "INSUFFICIENT_STOCK") {
    await bot.api.sendMessage(
      result.user.telegramId.toString(),
      `<tg-emoji emoji-id='${PURCHASE_EMOJI.WARNING}'>⚠️</tg-emoji><b>Payment not approved because keys are out of stock. Please contact support.</b>`,
      { parse_mode: "HTML" },
    );
    await sendMainMenuToChat(result.user.telegramId);
    await ctx.answerCallbackQuery({ text: "Rejected - out of stock" });
    await ctx.reply(`Purchase #${id} rejected (insufficient stock).`);
    return;
  }

  await bot.api.sendMessage(
    result.user.telegramId.toString(),
    `<tg-emoji emoji-id='${PURCHASE_EMOJI.WARNING}'>⚠️</tg-emoji><b>Payment not approved. Please contact support.</b>`,
    { parse_mode: "HTML" },
  );
  await sendMainMenuToChat(result.user.telegramId);
  await ctx.answerCallbackQuery({ text: "Purchase rejected" });
  await ctx.reply(`Purchase #${id} rejected.`);
});

bot.on("message:text", async (ctx) => {
  const user = ctx.state.dbUser;
  if (!user) return;

  const text = ctx.message.text.trim();
  if (text.startsWith("/")) {
    return;
  }

  const session = await getSession(user.id);
  if (!session || session.step === "NONE") {
    return;
  }

  if (session.step === "TOPUP_ENTER_AMOUNT") {
    const data = session.data as unknown as TopUpAmountSessionData | null;
    if (!data?.paymentMethod) {
      await clearSession(user.id);
      await respondMenu(ctx, "Session expired. Please open Top Up again.", topUpMenuKeyboard());
      return;
    }

    const amount = parsePositiveInt(text);
    if (!amount) {
      await cleanupIncomingMessage(ctx);
      const textInvalid = `Please enter a valid amount in MMK (minimum ${formatKs(MIN_TOPUP_AMOUNT)}).`;
      if (!(await editKnownUiMessage(ctx, data.uiMessageId, textInvalid, topUpCancelKeyboard()))) {
        await respondMenu(ctx, textInvalid, topUpCancelKeyboard());
      }
      return;
    }

    if (amount < MIN_TOPUP_AMOUNT) {
      await cleanupIncomingMessage(ctx);
      const textMin = `Minimum top-up amount is ${formatKs(MIN_TOPUP_AMOUNT)}.\nPlease enter a higher amount.`;
      if (!(await editKnownUiMessage(ctx, data.uiMessageId, textMin, topUpCancelKeyboard()))) {
        await respondMenu(ctx, textMin, topUpCancelKeyboard());
      }
      return;
    }

    await cleanupIncomingMessage(ctx);

    const nextData: TopUpScreenshotSessionData = {
      paymentMethod: data.paymentMethod,
      amount,
      uiMessageId: data.uiMessageId,
    };
    await setSession(user.id, "TOPUP_WAIT_SCREENSHOT", nextData as unknown as Prisma.InputJsonValue);

    const textTransfer = [
      "Please transfer the amount to the following account:",
      "",
      `Phone: ${config.paymentPhone}`,
      `Account Name: ${config.paymentAccountName}`,
      "",
      `Amount: ${formatKs(amount)}`,
      "",
      "After completing the transfer, send your transaction screenshot here.",
    ].join("\n");
    if (!(await editKnownUiMessage(ctx, data.uiMessageId, textTransfer, topUpCancelKeyboard()))) {
      await respondMenu(ctx, textTransfer, topUpCancelKeyboard());
    }
    return;
  }

  if (session.step === "BUY_ENTER_QUANTITY") {
    const data = session.data as unknown as BuyQuantitySessionData | null;
    if (!data?.productId) {
      await clearSession(user.id);
      await ctx.reply("Session expired. Please choose a product again.");
      return;
    }

    const quantity = parsePositiveInt(text);
    if (!quantity) {
      await cleanupIncomingMessage(ctx);
      await ctx.reply("Please enter a valid quantity.");
      return;
    }
    await cleanupIncomingMessage(ctx);

    const product = await loadProduct(data.productId);
    if (!product) {
      await clearSession(user.id);
      await ctx.reply("This product is no longer available.");
      return;
    }

    await clearSession(user.id);
    await sendPurchasePaymentChoice(ctx, product, quantity);
    return;
  }

  if (session.step === "TOPUP_WAIT_SCREENSHOT" || session.step === "BUY_WAIT_SCREENSHOT") {
    await cleanupIncomingMessage(ctx);
    if (session.step === "TOPUP_WAIT_SCREENSHOT") {
      await respondMenu(ctx, "Please send your payment screenshot image.", topUpCancelKeyboard());
      return;
    }
    await respondMenu(ctx, "Please send your payment screenshot image.", buyCancelKeyboard());
  }
});

bot.on("message:photo", async (ctx) => {
  const user = ctx.state.dbUser;
  if (!user) return;

  const session = await getSession(user.id);
  if (!session || session.step === "NONE") {
    return;
  }

  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const fileId = photo.file_id;

  if (session.step === "TOPUP_WAIT_SCREENSHOT") {
    const data = session.data as unknown as TopUpScreenshotSessionData | null;
    if (!data?.paymentMethod || !data.amount) {
      await clearSession(user.id);
      await respondMenu(ctx, "Session expired. Please start top-up again.", topUpMenuKeyboard());
      return;
    }

    const request = await prisma.topUpRequest.create({
      data: {
        userId: user.id,
        amount: data.amount,
        paymentMethod: data.paymentMethod,
        screenshotFileId: fileId,
        status: "PENDING",
      },
    });

    await clearSession(user.id);
    await cleanupIncomingMessage(ctx);

    const textProcessing = [
      "Payment is being processed.",
      "",
      `Amount: ${formatKs(data.amount)}`,
      `Method: ${PAYMENT_METHOD_LABELS[data.paymentMethod]}`,
      "Status: Pending Approval",
    ].join("\n");
    if (!(await editKnownUiMessage(ctx, data.uiMessageId, textProcessing, { inline_keyboard: [[{ text: "Main Menu", callback_data: "main:menu" }]] }))) {
      await respondMenu(ctx, textProcessing, new InlineKeyboard().text("Main Menu", "main:menu"));
    }

    const adminNotified = await notifyAdminsTopup(
      request.id,
      user,
      data.amount,
      data.paymentMethod,
      fileId,
    );

    if (!adminNotified) {
      await ctx.reply("Top-up request saved, but admin is not configured yet.");
    }
    return;
  }

  if (session.step === "BUY_WAIT_SCREENSHOT") {
    const data = session.data as unknown as BuyScreenshotSessionData | null;
    if (!data?.productId || !data.quantity || !data.paymentMethod || !data.totalCost) {
      await clearSession(user.id);
      await ctx.reply("Session expired. Please start purchase again.");
      return;
    }

    const product = await loadProduct(data.productId);
    if (!product) {
      await clearSession(user.id);
      await ctx.reply("This product is not available.");
      return;
    }

    const purchase = await prisma.purchase.create({
      data: {
        userId: user.id,
        productId: product.id,
        quantity: data.quantity,
        unitPrice: product.price,
        totalCost: data.totalCost,
        paymentMethod: data.paymentMethod,
        status: "PENDING",
        screenshotFileId: fileId,
      },
    });

    await clearSession(user.id);
    await cleanupIncomingMessage(ctx);

    await respondMenu(
      ctx,
      [
        "Payment is being processed.",
        "",
        `Product: ${product.name}`,
        `Quantity: ${data.quantity}`,
        `Amount: ${formatKs(data.totalCost)}`,
        `Method: ${PAYMENT_METHOD_LABELS[data.paymentMethod]}`,
        "Status: Pending Approval",
      ].join("\n"),
      new InlineKeyboard().text("Main Menu", "main:menu"),
    );

    const adminNotified = await notifyAdminsPurchase(
      purchase.id,
      user,
      product.name,
      data.quantity,
      data.totalCost,
      data.paymentMethod,
      fileId,
    );

    if (!adminNotified) {
      await ctx.reply("Purchase request saved, but admin is not configured yet.");
    }
    return;
  }
});

bot.catch(async (err) => {
  console.error("Bot error:", err.error);
  if (err.ctx.chat?.id) {
    await err.ctx.reply("Something went wrong. Please try again.");
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

async function bootstrapWithRetry() {
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      await prisma.$connect();

      await bot.api.setMyCommands([
        { command: "start", description: "Open main menu" },
        { command: "menu", description: "Show main menu" },
        { command: "myid", description: "Show your Telegram ID" },
      ]);

      console.log("Starting TechStore bot polling...");
      await bot.start();
      return;
    } catch (error) {
      const message = formatError(error);
      const delayMs = Math.min(60000, 5000 * attempt);
      console.error(`Bot start attempt ${attempt} failed: ${message}`);
      console.error(`Retrying in ${Math.floor(delayMs / 1000)}s...`);
      try {
        await prisma.$disconnect();
      } catch {
        // Ignore disconnect errors during retries.
      }
      await sleep(delayMs);
    }
  }
}

void bootstrapWithRetry();

