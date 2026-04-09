import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../prisma";

dotenv.config({ override: true });

function getArg(name: string): string | undefined {
  const entry = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (!entry) return undefined;
  return entry.slice(name.length + 1).trim();
}

async function main() {
  const productCode = getArg("--product");
  const file = getArg("--file");

  if (!productCode || !file) {
    throw new Error("Usage: npm run import:keys -- --product=SG_100GB_1M --file=keys.txt");
  }

  const filePath = path.resolve(process.cwd(), file);
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const product = await prisma.product.findUnique({ where: { code: productCode } });
  if (!product) {
    throw new Error(`Product not found: ${productCode}`);
  }

  const lines = fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    throw new Error("No keys found in file.");
  }

  const result = await prisma.vpnKey.createMany({
    data: lines.map((keyValue) => ({
      productId: product.id,
      keyValue,
    })),
    skipDuplicates: true,
  });

  console.log(`Imported ${result.count} keys to ${product.name}.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
