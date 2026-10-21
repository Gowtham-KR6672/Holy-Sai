-- CreateTable
CREATE TABLE "Plan" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "months" INTEGER NOT NULL,
    "priceInr" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "priceUsd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "SubscriptionPeriod" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "planCode" TEXT NOT NULL,
    "startsOn" DATE NOT NULL,
    "endsOn" DATE NOT NULL,
    "source" TEXT NOT NULL,
    "paymentId" UUID,
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "planCode" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "gateway" TEXT NOT NULL,
    "method" TEXT,
    "status" TEXT NOT NULL DEFAULT 'initiated',
    "gatewayOrderId" TEXT,
    "gatewayPaymentId" TEXT,
    "reference" TEXT,
    "failureReason" TEXT,
    "paidAt" TIMESTAMP(3),
    "recordedById" UUID,
    "initiatedById" UUID,
    "invoiceId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "workspaceId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "planCode" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "currency" TEXT NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "taxPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL,
    "seller" JSONB NOT NULL,
    "billTo" JSONB NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GatewayConfig" (
    "gateway" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" TEXT NOT NULL DEFAULT 'test',
    "config" JSONB NOT NULL DEFAULT '{}',
    "secretsEnc" TEXT,
    "lastTestedAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastTestMessage" TEXT,
    "updatedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GatewayConfig_pkey" PRIMARY KEY ("gateway")
);

-- CreateTable
CREATE TABLE "GatewayEvent" (
    "id" UUID NOT NULL,
    "gateway" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GatewayEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformCounter" (
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PlatformCounter_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ReminderLog" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReminderLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SubscriptionPeriod_workspaceId_endsOn_idx" ON "SubscriptionPeriod"("workspaceId", "endsOn");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_gatewayOrderId_key" ON "Payment"("gatewayOrderId");

-- CreateIndex
CREATE INDEX "Payment_workspaceId_createdAt_idx" ON "Payment"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_status_createdAt_idx" ON "Payment"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_paymentId_key" ON "Invoice"("paymentId");

-- CreateIndex
CREATE INDEX "Invoice_workspaceId_issuedAt_idx" ON "Invoice"("workspaceId", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GatewayEvent_gateway_eventId_key" ON "GatewayEvent"("gateway", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "ReminderLog_workspaceId_kind_key" ON "ReminderLog"("workspaceId", "kind");

-- AddForeignKey
ALTER TABLE "SubscriptionPeriod" ADD CONSTRAINT "SubscriptionPeriod_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

