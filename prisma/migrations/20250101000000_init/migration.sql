-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'CLONING', 'ANALYZING', 'BASELINE', 'DIAGNOSING', 'REPAIRING', 'VERIFYING', 'REPORTING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "Health" AS ENUM ('DEAD', 'DIAGNOSING', 'REPAIRING', 'PARTIALLY_REVIVED', 'REVIVED', 'UNRECOVERABLE');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('VERIFIED', 'VERIFIED_STATIC', 'REVERTED', 'SUGGESTED', 'ERROR');

-- CreateTable
CREATE TABLE "Resurrection" (
    "id" TEXT NOT NULL,
    "repoUrl" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "health" "Health" NOT NULL DEFAULT 'DEAD',
    "heartbeat" INTEGER NOT NULL DEFAULT 0,
    "currentStage" TEXT,
    "commitSha" TEXT,
    "commitDate" TIMESTAMP(3),
    "runtime" TEXT,
    "analysis" JSONB,
    "baseline" JSONB,
    "final" JSONB,
    "report" JSONB,
    "patch" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "clientIp" TEXT,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Resurrection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepairAttempt" (
    "id" TEXT NOT NULL,
    "resurrectionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "issueKind" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "status" "AttemptStatus" NOT NULL,
    "reason" TEXT,
    "files" TEXT[],
    "diff" TEXT,
    "verification" JSONB,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepairAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobEvent" (
    "id" BIGSERIAL NOT NULL,
    "resurrectionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,
    "data" JSONB,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Resurrection_status_createdAt_idx" ON "Resurrection"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Resurrection_createdAt_idx" ON "Resurrection"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RepairAttempt_resurrectionId_seq_key" ON "RepairAttempt"("resurrectionId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "JobEvent_resurrectionId_seq_key" ON "JobEvent"("resurrectionId", "seq");

-- AddForeignKey
ALTER TABLE "RepairAttempt" ADD CONSTRAINT "RepairAttempt_resurrectionId_fkey" FOREIGN KEY ("resurrectionId") REFERENCES "Resurrection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobEvent" ADD CONSTRAINT "JobEvent_resurrectionId_fkey" FOREIGN KEY ("resurrectionId") REFERENCES "Resurrection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
