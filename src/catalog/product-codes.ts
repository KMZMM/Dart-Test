import { PrismaClient, ProductProvider, StockMode } from "@prisma/client";

export type SuccessInstructionsPayload =
  | { type: "text"; text: string }
  | { type: "video"; url: string; caption?: string }
  | { type: "images"; urls: string[]; caption?: string };

export type ProductCatalogItem = {
  code: string;
  name: string;
  server: string;
  dataCap: string;
  duration: string;
  price: number;
  category: string;
  subCategory: string;
  provider: ProductProvider;
  stockMode: StockMode;
  autoFulfill: boolean;
  warning: string;
  notes: string;
  successInstructions: SuccessInstructionsPayload;
};

export const PRODUCT_CATALOG: ProductCatalogItem[] = [
  {
    code: "OUTLINE_SG_100GB_1M",
    name: "Singapore Server(100Gb)",
    server: "Singapore",
    dataCap: "100GB",
    duration: "1 Month",
    price: 4000,
    category: "VPN_KEYS",
    subCategory: "ALL_SIM_WIFI_VPN_KEYS",
    provider: ProductProvider.OUTLINE,
    stockMode: StockMode.UNLIMITED,
    autoFulfill: true,
    warning: "Do not share your key with others.",
    notes: "Key is auto-generated from Outline Manager after order success.",
    successInstructions: {
      type: "text",
      text: "How to use your key:\n1. Install Outline app.\n2. Open app and paste the key URL.\n3. Connect and enjoy.",
    },
  },
  {
    code: "OUTLINE_SG_200GB_1M",
    name: "Singapore Server(200Gb)",
    server: "Singapore",
    dataCap: "200GB",
    duration: "1 Month",
    price: 8000,
    category: "VPN_KEYS",
    subCategory: "ALL_SIM_WIFI_VPN_KEYS",
    provider: ProductProvider.OUTLINE,
    stockMode: StockMode.UNLIMITED,
    autoFulfill: true,
    warning: "Do not share your key with others.",
    notes: "Key is auto-generated from Outline Manager after order success.",
    successInstructions: {
      type: "text",
      text: "How to use your key:\n1. Install Outline app.\n2. Open app and paste the key URL.\n3. Connect and enjoy.",
    },
  },
  {
    code: "OUTLINE_SG_300GB_1M",
    name: "Singapore Server(300Gb)",
    server: "Singapore",
    dataCap: "300GB",
    duration: "1 Month",
    price: 12000,
    category: "VPN_KEYS",
    subCategory: "ALL_SIM_WIFI_VPN_KEYS",
    provider: ProductProvider.OUTLINE,
    stockMode: StockMode.UNLIMITED,
    autoFulfill: true,
    warning: "Do not share your key with others.",
    notes: "Key is auto-generated from Outline Manager after order success.",
    successInstructions: {
      type: "text",
      text: "How to use your key:\n1. Install Outline app.\n2. Open app and paste the key URL.\n3. Connect and enjoy.",
    },
  },
  {
    code: "OUTLINE_SG_500GB_1M",
    name: "Singapore Server(500Gb)",
    server: "Singapore",
    dataCap: "500GB",
    duration: "1 Month",
    price: 18000,
    category: "VPN_KEYS",
    subCategory: "ALL_SIM_WIFI_VPN_KEYS",
    provider: ProductProvider.OUTLINE,
    stockMode: StockMode.UNLIMITED,
    autoFulfill: true,
    warning: "Do not share your key with others.",
    notes: "Key is auto-generated from Outline Manager after order success.",
    successInstructions: {
      type: "text",
      text: "How to use your key:\n1. Install Outline app.\n2. Open app and paste the key URL.\n3. Connect and enjoy.",
    },
  },
  {
    code: "OUTLINE_SG_1000GB_1M",
    name: "Singapore Server(1000Gb)",
    server: "Singapore",
    dataCap: "1000GB",
    duration: "1 Month",
    price: 30000,
    category: "VPN_KEYS",
    subCategory: "ALL_SIM_WIFI_VPN_KEYS",
    provider: ProductProvider.OUTLINE,
    stockMode: StockMode.UNLIMITED,
    autoFulfill: true,
    warning: "Do not share your key with others.",
    notes: "Key is auto-generated from Outline Manager after order success.",
    successInstructions: {
      type: "text",
      text: "How to use your key:\n1. Install Outline app.\n2. Open app and paste the key URL.\n3. Connect and enjoy.",
    },
  },
];

export async function syncCatalogProducts(prisma: PrismaClient): Promise<number> {
  const catalogCodes = PRODUCT_CATALOG.map((item) => item.code);

  await prisma.product.updateMany({
    where: {
      code: {
        notIn: catalogCodes,
      },
    },
    data: {
      isActive: false,
    },
  });

  for (const product of PRODUCT_CATALOG) {
    await prisma.product.upsert({
      where: { code: product.code },
      create: {
        ...product,
        isActive: true,
      },
      update: {
        ...product,
        isActive: true,
      },
    });
  }

  return PRODUCT_CATALOG.length;
}
