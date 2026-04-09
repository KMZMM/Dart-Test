import dotenv from "dotenv";
import { ProductProvider, StockMode } from "@prisma/client";
import { prisma } from "../prisma";

const shouldOverrideEnv = process.env.DOTENV_OVERRIDE !== "false";
dotenv.config({ override: shouldOverrideEnv });

async function main() {
  const products = [
    {
      code: "OUTLINE_SG_100GB_1M",
      name: "Singapore Server (100Gb)",
      server: "Singapore",
      dataCap: "100GB",
      duration: "1 Month",
      price: 4000,
      category: "VPN_KEYS",
      subCategory: "ALL_SIM_WIFI_VPN_KEYS",
      provider: ProductProvider.OUTLINE,
      stockMode: StockMode.UNLIMITED,
      autoFulfill: true,
      notes: "- Key duration is 1 month.\n- Key is delivered automatically after payment success.\n- Do not share your key.",
    },
    {
      code: "OUTLINE_SG_200GB_1M",
      name: "Singapore Server (200Gb)",
      server: "Singapore",
      dataCap: "200GB",
      duration: "1 Month",
      price: 8000,
      category: "VPN_KEYS",
      subCategory: "ALL_SIM_WIFI_VPN_KEYS",
      provider: ProductProvider.OUTLINE,
      stockMode: StockMode.UNLIMITED,
      autoFulfill: true,
      notes: "- Key duration is 1 month.\n- Key is delivered automatically after payment success.\n- Do not share your key.",
    },
    {
      code: "OUTLINE_SG_300GB_1M",
      name: "Singapore Server (300Gb)",
      server: "Singapore",
      dataCap: "300GB",
      duration: "1 Month",
      price: 12000,
      category: "VPN_KEYS",
      subCategory: "ALL_SIM_WIFI_VPN_KEYS",
      provider: ProductProvider.OUTLINE,
      stockMode: StockMode.UNLIMITED,
      autoFulfill: true,
      notes: "- Key duration is 1 month.\n- Key is delivered automatically after payment success.\n- Do not share your key.",
    },
    {
      code: "OUTLINE_SG_500GB_1M",
      name: "Singapore Server (500Gb)",
      server: "Singapore",
      dataCap: "500GB",
      duration: "1 Month",
      price: 18000,
      category: "VPN_KEYS",
      subCategory: "ALL_SIM_WIFI_VPN_KEYS",
      provider: ProductProvider.OUTLINE,
      stockMode: StockMode.UNLIMITED,
      autoFulfill: true,
      notes: "- Key duration is 1 month.\n- Key is delivered automatically after payment success.\n- Do not share your key.",
    },
    {
      code: "OUTLINE_SG_1000GB_1M",
      name: "Singapore Server (1000Gb)",
      server: "Singapore",
      dataCap: "1000GB",
      duration: "1 Month",
      price: 30000,
      category: "VPN_KEYS",
      subCategory: "ALL_SIM_WIFI_VPN_KEYS",
      provider: ProductProvider.OUTLINE,
      stockMode: StockMode.UNLIMITED,
      autoFulfill: true,
      notes: "- Key duration is 1 month.\n- Key is delivered automatically after payment success.\n- Do not share your key.",
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
        category: product.category,
        subCategory: product.subCategory,
        provider: product.provider,
        stockMode: product.stockMode,
        autoFulfill: product.autoFulfill,
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
