import dotenv from "dotenv";
import { prisma } from "../prisma";

const shouldOverrideEnv = process.env.DOTENV_OVERRIDE !== "false";
dotenv.config({ override: shouldOverrideEnv });

async function main() {
  const products = [
    {
      code: "SG_100GB_1M",
      name: "Singapore Server 100GB",
      server: "Singapore",
      dataCap: "100GB",
      duration: "1 Month",
      price: 500,
      notes: "- The key will expire after 1 month.\n- Do not share your key.\n- No refund after activation.",
    },
    {
      code: "SG_200GB_1M",
      name: "Singapore Server 200GB",
      server: "Singapore",
      dataCap: "200GB",
      duration: "1 Month",
      price: 900,
      notes: "- The key will expire after 1 month.\n- Do not share your key.\n- No refund after activation.",
    },
  ];

  for (const product of products) {
    await prisma.product.upsert({
      where: { code: product.code },
      create: product,
      update: {
        name: product.name,
        server: product.server,
        dataCap: product.dataCap,
        duration: product.duration,
        price: product.price,
        notes: product.notes,
        isActive: true,
      },
    });
  }

  console.log("Seed completed.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
