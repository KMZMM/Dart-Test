import { PaymentMethod, Prisma, Product, ProductProvider, RequestStatus, SessionStep, StockMode, User, WalletTransactionType } from "@prisma/client";
import { Bot, Context, InlineKeyboard } from "grammy";
import type { User as TelegramUser } from "grammy/types";
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
const PRODUCT_CATEGORY_VPN_KEYS = "VPN_KEYS";
const PRODUCT_SUBCATEGORY_ALL_SIM_WIFI = "ALL_SIM_WIFI_VPN_KEYS";
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

function formatKs(value: number): string {
  return `${value.toLocaleString("en-US")} Ks`;
}

function statusText(status: RequestStatus): string {
  if (status === "APPROVED") return "Approved";
  if (status === "REJECTED") return "Rejected";
  return "Pending";
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

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Buy Vpn Keys", callback_data: "main:buyvpn" }],
      [
        { text: "Transaction History", callback_data: "main:history" },
        { text: "Guide", callback_data: "main:guide" },
      ],
      [{ text: "Join Channel", url: config.channelLink }],
      [{ text: "Top Up", callback_data: "main:topup", style: "success" }],
    ],
  } as any;
}

function topUpMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "KBZ Pay", callback_data: "topup:method:KBZ_PAY" }],
      [{ text: "Wave Pay", callback_data: "topup:method:WAVE_PAY" }],
      [{ text: "UAB Pay", callback_data: "topup:method:UAB_PAY" }],
      [{ text: "AYA Pay", callback_data: "topup:method:AYA_PAY" }],
      [{ text: "Top-Up History", callback_data: "topup:history" }],
      [{ text: "Back", callback_data: "main:menu" }],
    ],
  } as any;
}

function vpnRootKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "All Sim & Wifi Vpn Keys", callback_data: "vpn:child:all_sim_wifi" }],
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
  return new InlineKeyboard()
    .text("How to Top Up", "guide:topup")
    .row()
    .text("How to Buy VPN Key", "guide:buyvpn")
    .row()
    .text("Back", "main:menu");
}

function productDetailsKeyboard(productId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("Buy 1", `buy1:${productId}`)
    .row()
    .text("Buy Multiple", `buym:${productId}`)
    .row()
    .text("Back", "main:buyvpn");
}

function paymentChoiceKeyboard(productId: number, quantity: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("Pay with Wallet", `pay:WALLET:${productId}:${quantity}`)
    .row()
    .text("KBZ Pay", `pay:KBZ_PAY:${productId}:${quantity}`)
    .row()
    .text("Wave Pay", `pay:WAVE_PAY:${productId}:${quantity}`)
    .row()
    .text("UAB Pay", `pay:UAB_PAY:${productId}:${quantity}`)
    .row()
    .text("AYA Pay", `pay:AYA_PAY:${productId}:${quantity}`)
    .row()
    .text("Cancel", "main:buyvpn");
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

function buildMainMenuText(user: User): string {
  return `Hi, ${displayName(user)}\nID: ${user.telegramId.toString()}\nBalance: ${formatKs(user.balance)}`;
}

async function respondMenu(ctx: BotContext, text: string, keyboard: any): Promise<void> {
  const htmlText = boldText(text);
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
  await respondMenu(ctx, buildMainMenuText(freshUser), mainMenuKeyboard());
}

async function sendTopUpHistory(ctx: BotContext, userId: number): Promise<void> {
  const requests = await prisma.topUpRequest.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  if (!requests.length) {
    await ctx.reply("No top-up history yet.");
    return;
  }

  const lines = requests.map((item, index) => {
    return `${index + 1}. ${formatDate(item.createdAt)} | ${formatKs(item.amount)} | ${PAYMENT_METHOD_LABELS[item.paymentMethod]} | ${statusText(item.status)}`;
  });

  await ctx.reply(`Top-Up History\n\n${lines.join("\n")}`);
}

async function sendTransactionHistory(ctx: BotContext, userId: number): Promise<void> {
  const [topups, purchases] = await Promise.all([
    prisma.topUpRequest.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
    prisma.purchase.findMany({
      where: { userId },
      include: { product: true },
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
  ]);

  const lines: string[] = ["Transaction History", ""];

  lines.push("Top-Ups:");
  if (!topups.length) {
    lines.push("- No top-up records");
  } else {
    for (const item of topups) {
      lines.push(
        `- ${formatDate(item.createdAt)} | ${formatKs(item.amount)} | ${PAYMENT_METHOD_LABELS[item.paymentMethod]} | ${statusText(item.status)}`,
      );
    }
  }

  lines.push("");
  lines.push("Purchases:");
  if (!purchases.length) {
    lines.push("- No purchase records");
  } else {
    for (const item of purchases) {
      lines.push(
        `- ${formatDate(item.createdAt)} | ${item.product.name} x${item.quantity} | ${formatKs(item.totalCost)} | ${PAYMENT_METHOD_LABELS[item.paymentMethod]} | ${statusText(item.status)}`,
      );
    }
  }

  await respondMenu(ctx, lines.join("\n"), new InlineKeyboard().text("Back", "main:menu"));
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

async function sendProductList(ctx: BotContext, subCategory = PRODUCT_SUBCATEGORY_ALL_SIM_WIFI): Promise<void> {
  const products = await prisma.product.findMany({
    where: {
      isActive: true,
      category: PRODUCT_CATEGORY_VPN_KEYS,
      subCategory,
    },
    orderBy: { price: "asc" },
  });

  if (!products.length) {
    await respondMenu(ctx, "No products available right now.", new InlineKeyboard().text("Back", "main:buyvpn"));
    return;
  }

  const finiteProductIds = products.filter((product) => product.stockMode === "FINITE").map((product) => product.id);
  const stockGroups = finiteProductIds.length
    ? await prisma.vpnKey.groupBy({
      by: ["productId"],
      where: {
        status: "AVAILABLE",
        productId: { in: finiteProductIds },
      },
      _count: { _all: true },
    })
    : [];
  const stockByProduct = new Map<number, number>(
    stockGroups.map((group) => [group.productId, group._count._all]),
  );

  const keyboard = new InlineKeyboard();
  for (const product of products) {
    const stockLabel = product.stockMode === "UNLIMITED"
      ? "(♾️)"
      : `(${stockByProduct.get(product.id) ?? 0})`;
    keyboard.text(`${product.name} | ${stockLabel} | ${formatKs(product.price)}/month`, `prod:${product.id}`);
    keyboard.row();
  }
  keyboard.text("Back", "main:buyvpn");

  await respondMenu(ctx, "Hi, please choose a product:", keyboard);
}

async function sendProductDetails(ctx: BotContext, product: Product): Promise<void> {
  const stockText = product.stockMode === "UNLIMITED" ? "Unlimited" : "Limited";
  const text = [
    "Product Details",
    "",
    `Server: ${product.server}`,
    `Data: ${product.dataCap}`,
    `Duration: ${product.duration}`,
    `Stock: ${stockText}`,
    `Price: ${formatKs(product.price)}/month`,
    "",
    "Notes:",
    product.notes || "- The key will expire after the duration ends.\n- Do not share your key.\n- No refund after activation.",
  ].join("\n");

  await respondMenu(ctx, text, productDetailsKeyboard(product.id));
}

async function sendPurchasePaymentChoice(ctx: BotContext, product: Product, quantity: number): Promise<void> {
  const total = product.price * quantity;
  const text = [
    "Confirm your purchase.",
    "",
    `Product: ${product.name}`,
    `Quantity: ${quantity}`,
    `Total Cost: ${formatKs(total)}`,
    "",
    "Choose payment method:",
  ].join("\n");

  await respondMenu(ctx, text, paymentChoiceKeyboard(product.id, quantity));
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
  await respondMenu(ctx, "Vpn Keys", vpnRootKeyboard());
});

bot.callbackQuery("vpn:child:all_sim_wifi", async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendProductList(ctx, PRODUCT_SUBCATEGORY_ALL_SIM_WIFI);
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
        await ctx.reply("Insufficient balance. Please top up your account.");
        return;
      }
      if (result.reason === "OUT_OF_STOCK") {
        await ctx.reply("Not enough keys in stock for this quantity.");
        return;
      }
      await ctx.reply("Purchase failed. Please try again.");
      return;
    }

    await clearSession(user.id);

    if (result.deliveryMode === "OUTLINE") {
      try {
        const keys = await generateOutlineKeys(user, product, quantity);
        await ctx.reply(
          [
            "Purchase Successful",
            "",
            `Product: ${product.name}`,
            `Quantity: ${quantity}`,
            `Total Paid: ${formatKs(result.totalCost)}`,
            `Remaining Balance: ${formatKs(result.newBalance)}`,
            "",
            "Keys:",
            ...keys.map((key, index) => `${index + 1}. ${key}`),
          ].join("\n"),
        );
      } catch (error) {
        await ctx.reply(
          [
            "Purchase Successful",
            "",
            `Product: ${product.name}`,
            `Quantity: ${quantity}`,
            `Total Paid: ${formatKs(result.totalCost)}`,
            `Remaining Balance: ${formatKs(result.newBalance)}`,
            "",
            "Payment confirmed. Key delivery is processing. Please wait.",
          ].join("\n"),
        );
        await notifyAdminsOutlineDeliveryIssue(
          result.purchaseId,
          user,
          product.name,
          error instanceof Error ? error.message : String(error),
        );
      }
      return;
    }

    if (result.deliveryMode === "MANUAL") {
      await ctx.reply(
        [
          "Purchase Successful",
          "",
          `Product: ${product.name}`,
          `Quantity: ${quantity}`,
          `Total Paid: ${formatKs(result.totalCost)}`,
          `Remaining Balance: ${formatKs(result.newBalance)}`,
          "",
          "Your order requires manual delivery. Admin will send your key soon.",
        ].join("\n"),
      );

      await notifyAdminsManualWalletPurchase(
        result.purchaseId,
        user,
        product.name,
        quantity,
        result.totalCost,
      );
      return;
    }

    await ctx.reply(
      [
        "Purchase Successful",
        "",
        `Product: ${product.name}`,
        `Quantity: ${quantity}`,
        `Total Paid: ${formatKs(result.totalCost)}`,
        `Remaining Balance: ${formatKs(result.newBalance)}`,
        "",
        "Keys:",
        ...result.keys.map((key, index) => `${index + 1}. ${key}`),
      ].join("\n"),
    );
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
      await ctx.answerCallbackQuery({ text: "Top-up approved" });
      await ctx.reply(`Top-up #${id} approved.`);
    } else {
      await bot.api.sendMessage(
        result.user.telegramId.toString(),
        "Top-Up Failed\n\nPlease contact support or try again.",
      );
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
          [
            "Payment Confirmed",
            "",
            `Product: ${result.product.name}`,
            `Quantity: ${result.purchase.quantity}`,
            "",
            "Keys:",
            ...keys.map((key, index) => `${index + 1}. ${key}`),
          ].join("\n"),
        );
      } catch (error) {
        await bot.api.sendMessage(
          result.user.telegramId.toString(),
          [
            "Payment Confirmed",
            "",
            `Product: ${result.product.name}`,
            `Quantity: ${result.purchase.quantity}`,
            "",
            "Payment confirmed. Key delivery is processing. Please wait.",
          ].join("\n"),
        );
        await notifyAdminsOutlineDeliveryIssue(
          result.purchase.id,
          result.user,
          result.product.name,
          error instanceof Error ? error.message : String(error),
        );
      }
      await ctx.answerCallbackQuery({ text: "Purchase approved" });
      await ctx.reply(`Purchase #${id} approved.`);
      return;
    }

    const message = result.deliveryMode === "MANUAL"
      ? [
        "Payment Confirmed",
        "",
        `Product: ${result.product.name}`,
        `Quantity: ${result.purchase.quantity}`,
        "",
        "Your order requires manual key delivery. Admin will send it soon.",
      ].join("\n")
      : [
        "Payment Confirmed",
        "",
        `Product: ${result.product.name}`,
        `Quantity: ${result.purchase.quantity}`,
        "",
        "Keys:",
        ...result.keys.map((key, index) => `${index + 1}. ${key}`),
      ].join("\n");
    await bot.api.sendMessage(result.user.telegramId.toString(), message);
    await ctx.answerCallbackQuery({ text: "Purchase approved" });
    await ctx.reply(`Purchase #${id} approved.`);
    return;
  }

  if (result.reason === "INSUFFICIENT_STOCK") {
    await bot.api.sendMessage(
      result.user.telegramId.toString(),
      "Payment not approved because keys are out of stock. Please contact support.",
    );
    await ctx.answerCallbackQuery({ text: "Rejected - out of stock" });
    await ctx.reply(`Purchase #${id} rejected (insufficient stock).`);
    return;
  }

  await bot.api.sendMessage(
    result.user.telegramId.toString(),
    "Payment not approved. Please contact support.",
  );
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
    if (!(await editKnownUiMessage(ctx, data.uiMessageId, textProcessing, { inline_keyboard: [[{ text: "⬅️ Main Menu", callback_data: "main:menu" }]] }))) {
      await respondMenu(ctx, textProcessing, new InlineKeyboard().text("⬅️ Main Menu", "main:menu"));
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
      new InlineKeyboard().text("⬅️ Main Menu", "main:menu"),
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
