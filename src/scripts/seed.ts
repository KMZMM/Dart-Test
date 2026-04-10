import dotenv from "dotenv";
import { prisma } from "../prisma";
import { syncCatalogProducts } from "../catalog/product-codes";

const shouldOverrideEnv = process.env.DOTENV_OVERRIDE !== "false";
dotenv.config({ override: shouldOverrideEnv });

async function main() {
  const count = await syncCatalogProducts(prisma);
  console.log(`Seed completed. Synced ${count} products from code catalog.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

