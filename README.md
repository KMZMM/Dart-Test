# TechStore Telegram Bot

Telegram bot for a small VPN store with:
- Wallet balance per user
- Top-up flow with screenshot + admin approval
- VPN key purchase flow (wallet or external payments)
- Product catalog and stock-based key delivery
- Transaction history and guide menu

## Stack
- Node.js + TypeScript
- [`grammY`](https://grammy.dev/) for Telegram bot handling
- PostgreSQL + Prisma ORM
- DigitalOcean App Platform deployment scripts

## Important Security Note
Your bot token was posted in chat. Rotate it in BotFather before production.

## Required Environment Variables
Create/update `.env`:

```env
DATABASE_URL="postgresql://username:password@host:25060/techstore?sslmode=require&schema=public"
TELEGRAM_BOT_TOKEN=""
ADMIN_TELEGRAM_IDS=""
JOIN_CHANNEL_LINK="https://t.me/KMZCreationsMM"
PAYMENT_PHONE="09986075167"
PAYMENT_ACCOUNT_NAME="Ye Htut Naing"
GUIDE_TOPUP_VIDEO_URL=""
GUIDE_BUY_VIDEO_URL=""

DIGITALOCEAN_TOKEN=""
DO_REGION="sgp1"
DO_DB_CLUSTER_NAME="techstore-db"
DO_DB_NAME="techstore"
DO_APP_NAME="techstore-bot"
DO_GITHUB_REPO=""
DO_GITHUB_BRANCH="main"
```

`ADMIN_TELEGRAM_IDS` accepts comma-separated Telegram numeric IDs (for approval buttons).

## Local Setup
```powershell
npm install
npm run prisma:generate
npm run prisma:push
npm run seed
npm run dev
```

Use `/myid` in bot chat to get your Telegram ID, then set it in `ADMIN_TELEGRAM_IDS`.

## Import VPN Keys
Create a plain text file with one key per line, then:

```powershell
npm run import:keys -- --product=SG_100GB_1M --file=keys.txt
```

## DigitalOcean Provisioning

### 1) Create managed PostgreSQL
```powershell
npm run provision:do
```

This writes `do.generated.env` with `DATABASE_URL`.

### 2) Deploy/update App Platform worker
`DO_GITHUB_REPO` must point to your GitHub repo (format: `owner/repo`).

```powershell
npm run deploy:do
```

## Features Implemented (from your UX spec)
- Start command main menu:
  - Top Up
  - Buy VPN Key
  - Transaction History
  - Guide
  - Join Channel
- Top-up flow:
  - method selection -> amount -> transfer instructions -> screenshot -> admin approve/reject
- VPN purchase flow:
  - product list -> details -> quantity -> payment options -> delivery after wallet payment or admin approval
- Guide menu with two tutorial entries
- Transaction history (top-ups + purchases)
