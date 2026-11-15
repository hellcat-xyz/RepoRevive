-- CreateEnum
CREATE TYPE "PublishMode" AS ENUM ('PATCH_ONLY', 'REVIEW_PR', 'AUTO_PR');

-- CreateEnum
CREATE TYPE "PublicationStatus" AS ENUM ('NOT_REQUESTED', 'PENDING_APPROVAL', 'QUEUED', 'AUTHORIZING', 'PREPARING_BRANCH', 'PUBLISHING_COMMIT', 'CREATING_PR', 'CREATED', 'FAILED', 'BLOCKED', 'CANCELLED', 'AUTH_EXPIRED');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED');

-- AlterTable
ALTER TABLE "Resurrection" ADD COLUMN     "allowForkPublish" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "allowPartialPublish" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ecosystem" TEXT,
ADD COLUMN     "ownerId" TEXT,
ADD COLUMN     "packageManager" TEXT,
ADD COLUMN     "publishMode" "PublishMode" NOT NULL DEFAULT 'PATCH_ONLY';

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "githubUserId" INTEGER NOT NULL,
    "login" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GithubConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "accessTokenEnc" TEXT NOT NULL,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenEnc" TEXT,
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "lastValidatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GithubConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GithubInstallation" (
    "id" TEXT NOT NULL,
    "installationId" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "accountLogin" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "repositorySelection" TEXT NOT NULL,
    "permissions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GithubInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepositoryPermission" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL,
    "canPush" BOOLEAN NOT NULL,
    "canFork" BOOLEAN NOT NULL,
    "isPrivate" BOOLEAN NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepositoryPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Publication" (
    "id" TEXT NOT NULL,
    "resurrectionId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "mode" "PublishMode" NOT NULL,
    "status" "PublicationStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "targetOwner" TEXT NOT NULL,
    "targetRepo" TEXT NOT NULL,
    "baseBranch" TEXT NOT NULL,
    "baseSha" TEXT NOT NULL,
    "headOwner" TEXT,
    "headRepo" TEXT,
    "headBranch" TEXT NOT NULL,
    "commitSha" TEXT,
    "prNumber" INTEGER,
    "prUrl" TEXT,
    "isDraft" BOOLEAN NOT NULL DEFAULT true,
    "allowFork" BOOLEAN NOT NULL DEFAULT false,
    "excluded" JSONB,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastErrorCode" TEXT,
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Publication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_githubUserId_key" ON "User"("githubUserId");

-- CreateIndex
CREATE UNIQUE INDEX "GithubConnection_userId_key" ON "GithubConnection"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "GithubInstallation_installationId_key" ON "GithubInstallation"("installationId");

-- CreateIndex
CREATE INDEX "GithubInstallation_userId_idx" ON "GithubInstallation"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryPermission_userId_owner_name_key" ON "RepositoryPermission"("userId", "owner", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Publication_resurrectionId_key" ON "Publication"("resurrectionId");

-- CreateIndex
CREATE UNIQUE INDEX "Publication_idempotencyKey_key" ON "Publication"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Publication_status_updatedAt_idx" ON "Publication"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "Publication_targetOwner_targetRepo_baseSha_idx" ON "Publication"("targetOwner", "targetRepo", "baseSha");

-- CreateIndex
CREATE INDEX "Resurrection_ownerId_createdAt_idx" ON "Resurrection"("ownerId", "createdAt");

-- AddForeignKey
ALTER TABLE "Resurrection" ADD CONSTRAINT "Resurrection_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GithubConnection" ADD CONSTRAINT "GithubConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GithubInstallation" ADD CONSTRAINT "GithubInstallation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryPermission" ADD CONSTRAINT "RepositoryPermission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Publication" ADD CONSTRAINT "Publication_resurrectionId_fkey" FOREIGN KEY ("resurrectionId") REFERENCES "Resurrection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

