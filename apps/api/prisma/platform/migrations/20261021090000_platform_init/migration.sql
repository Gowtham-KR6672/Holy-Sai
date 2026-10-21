-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "platform";

-- CreateTable
CREATE TABLE "PlatformAdmin" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "fullName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "lastLoginIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformAdmin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSession" (
    "id" UUID NOT NULL,
    "adminId" UUID NOT NULL,
    "familyId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "rotatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "schemaName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "country" TEXT NOT NULL DEFAULT 'India',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "address" TEXT,
    "taxId" TEXT,
    "notes" TEXT,
    "schemaVersion" TEXT,
    "supportUserId" UUID,
    "suspendedAt" TIMESTAMP(3),
    "suspendReason" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginIdentifier" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "workspaceId" UUID,
    "userId" UUID,
    "platformAdminId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginIdentifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceToken" (
    "tokenHash" TEXT NOT NULL,
    "workspaceId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceToken_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateTable
CREATE TABLE "SupportCode" (
    "codeHash" TEXT NOT NULL,
    "adminId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportCode_pkey" PRIMARY KEY ("codeHash")
);

-- CreateTable
CREATE TABLE "PlatformAuditLog" (
    "id" UUID NOT NULL,
    "adminId" UUID,
    "adminName" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "workspaceId" UUID,
    "description" TEXT NOT NULL,
    "metadata" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformAdmin_email_key" ON "PlatformAdmin"("email");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformAdmin_phone_key" ON "PlatformAdmin"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformSession_tokenHash_key" ON "PlatformSession"("tokenHash");

-- CreateIndex
CREATE INDEX "PlatformSession_adminId_idx" ON "PlatformSession"("adminId");

-- CreateIndex
CREATE INDEX "PlatformSession_familyId_idx" ON "PlatformSession"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_code_key" ON "Workspace"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_schemaName_key" ON "Workspace"("schemaName");

-- CreateIndex
CREATE INDEX "LoginIdentifier_workspaceId_userId_idx" ON "LoginIdentifier"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "LoginIdentifier_kind_value_key" ON "LoginIdentifier"("kind", "value");

-- CreateIndex
CREATE INDEX "DeviceToken_workspaceId_deviceId_idx" ON "DeviceToken"("workspaceId", "deviceId");

-- CreateIndex
CREATE INDEX "PlatformAuditLog_createdAt_idx" ON "PlatformAuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "PlatformAuditLog_workspaceId_idx" ON "PlatformAuditLog"("workspaceId");

-- AddForeignKey
ALTER TABLE "PlatformSession" ADD CONSTRAINT "PlatformSession_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "PlatformAdmin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoginIdentifier" ADD CONSTRAINT "LoginIdentifier_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

