/*
  Warnings:

  - A unique constraint covering the columns `[symbol]` on the table `Stocks` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "Stocks_symbol_key" ON "Stocks"("symbol");
