-- CreateTable
CREATE TABLE "ProductCategoryContent" (
    "id" SERIAL NOT NULL,
    "subCategory" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "productInfo" TEXT NOT NULL DEFAULT '',
    "instruction" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductCategoryContent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductCategoryContent_subCategory_key" ON "ProductCategoryContent"("subCategory");
