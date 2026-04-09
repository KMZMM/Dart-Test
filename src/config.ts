import dotenv from "dotenv";

const shouldOverrideEnv = process.env.DOTENV_OVERRIDE !== "false";
dotenv.config({ override: shouldOverrideEnv });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function parseAdminIds(raw: string | undefined): bigint[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((id) => /^\d+$/.test(id))
    .filter(Boolean)
    .map((id) => BigInt(id));
}

function parseAdminUsernames(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .map((name) => (name.startsWith("@") ? name.slice(1) : name))
    .filter(Boolean);
}

export const config = {
  botToken: requireEnv("TELEGRAM_BOT_TOKEN"),
  channelLink: process.env.JOIN_CHANNEL_LINK?.trim() || "https://t.me/KMZCreationsMM",
  paymentPhone: process.env.PAYMENT_PHONE?.trim() || "09986075167",
  paymentAccountName: process.env.PAYMENT_ACCOUNT_NAME?.trim() || "Ye Htut Naing",
  adminIds: parseAdminIds(process.env.ADMIN_TELEGRAM_IDS),
  adminUsernames: parseAdminUsernames(process.env.ADMIN_USERNAMES),
  guideTopUpVideoUrl: process.env.GUIDE_TOPUP_VIDEO_URL?.trim() || "",
  guideBuyVideoUrl: process.env.GUIDE_BUY_VIDEO_URL?.trim() || "",
};
