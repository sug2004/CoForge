-- CreateTable
CREATE TABLE "AgentThread" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "AgentThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContextSnapshot" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "focusFileId" TEXT,
    "cursor" JSONB,
    "selection" JSONB,
    "openFileIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContextSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectMemory" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserProjectPreference" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "notes" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserProjectPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentThread_sessionId_userId_idx" ON "AgentThread"("sessionId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentThread_sessionId_userId_id_key" ON "AgentThread"("sessionId", "userId", "id");

-- CreateIndex
CREATE INDEX "AgentMessage_threadId_createdAt_idx" ON "AgentMessage"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "ContextSnapshot_threadId_idx" ON "ContextSnapshot"("threadId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectMemory_projectId_key" ON "ProjectMemory"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "UserProjectPreference_projectId_userId_key" ON "UserProjectPreference"("projectId", "userId");

-- AddForeignKey
ALTER TABLE "AgentThread" ADD CONSTRAINT "AgentThread_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentThread" ADD CONSTRAINT "AgentThread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMessage" ADD CONSTRAINT "AgentMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "AgentThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContextSnapshot" ADD CONSTRAINT "ContextSnapshot_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "AgentThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMemory" ADD CONSTRAINT "ProjectMemory_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserProjectPreference" ADD CONSTRAINT "UserProjectPreference_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserProjectPreference" ADD CONSTRAINT "UserProjectPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
