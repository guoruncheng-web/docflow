-- CreateTable
CREATE TABLE "destination_bills" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "vendor_name" TEXT NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "total_minor" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "destination_bills_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "destination_bills_idempotency_key_key" ON "destination_bills"("idempotency_key");

-- CreateIndex
CREATE INDEX "destination_bills_organization_id_created_at_idx" ON "destination_bills"("organization_id", "created_at");
