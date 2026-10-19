-- CreateTable
CREATE TABLE "ExamCorrectionConfig" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "aiEnabled" BOOLEAN NOT NULL DEFAULT true,
    "effort" TEXT NOT NULL DEFAULT 'medium',
    "timeoutSec" INTEGER,
    "maxRetries" INTEGER NOT NULL DEFAULT 2,
    "retryUnusable" BOOLEAN NOT NULL DEFAULT true,
    "externalAck" BOOLEAN NOT NULL DEFAULT false,
    "externalAckById" UUID,
    "externalAckByName" TEXT,
    "externalAckAt" TIMESTAMP(3),
    "redactTopPercent" INTEGER NOT NULL DEFAULT 0,
    "lastSync" JSONB,
    "updatedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExamCorrectionConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamCorrectionExam" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "academicYear" TEXT NOT NULL,
    "className" TEXT NOT NULL,
    "section" TEXT NOT NULL DEFAULT '',
    "subject" TEXT NOT NULL,
    "gradeLevel" TEXT NOT NULL DEFAULT '',
    "instructions" TEXT NOT NULL DEFAULT '',
    "campusId" UUID,
    "classId" UUID,
    "sectionId" UUID,
    "subjectId" UUID,
    "resultsStatus" TEXT NOT NULL DEFAULT 'draft',
    "resultsChangedAt" TIMESTAMP(3),
    "resultsChangedById" UUID,
    "resultsChangedByName" TEXT,
    "assessmentId" UUID,
    "pushedAt" TIMESTAMP(3),
    "pushedByName" TEXT,
    "createdById" UUID,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExamCorrectionExam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamCorrectionTeacher" (
    "id" UUID NOT NULL,
    "examId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "assignedById" UUID,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamCorrectionTeacher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamCorrectionQuestion" (
    "id" UUID NOT NULL,
    "examId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "qtype" TEXT NOT NULL DEFAULT 'short',
    "maxMarks" DOUBLE PRECISION NOT NULL,
    "markIncrement" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "numericAnswer" TEXT,
    "numericTolerance" DOUBLE PRECISION NOT NULL DEFAULT 0.01,
    "unit" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExamCorrectionQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamCorrectionRubric" (
    "id" UUID NOT NULL,
    "questionId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'teacher',
    "referenceAnswer" TEXT NOT NULL DEFAULT '',
    "criteria" JSONB NOT NULL,
    "expectedConcepts" JSONB NOT NULL DEFAULT '[]',
    "alternatives" JSONB NOT NULL DEFAULT '[]',
    "misconceptions" JSONB NOT NULL DEFAULT '[]',
    "partialCreditRules" TEXT NOT NULL DEFAULT '',
    "requiredElements" TEXT NOT NULL DEFAULT '',
    "ignoreCriteria" TEXT NOT NULL DEFAULT '',
    "subjectRules" TEXT NOT NULL DEFAULT '',
    "problems" JSONB NOT NULL DEFAULT '[]',
    "model" TEXT,
    "createdById" UUID,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamCorrectionRubric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamCorrectionSubmission" (
    "id" UUID NOT NULL,
    "examId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "statusNote" TEXT NOT NULL DEFAULT '',
    "identityVerified" BOOLEAN NOT NULL DEFAULT false,
    "identityVerifiedById" UUID,
    "identityVerifiedByName" TEXT,
    "identityVerifiedAt" TIMESTAMP(3),
    "filename" TEXT NOT NULL DEFAULT '',
    "uploadedById" UUID,
    "uploadedByName" TEXT,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExamCorrectionSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamCorrectionPage" (
    "id" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "pageNo" INTEGER NOT NULL,
    "uploadedNo" INTEGER NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "sourceMime" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "sha256" TEXT NOT NULL DEFAULT '',
    "imageKey" TEXT,
    "imageMime" TEXT,
    "rotation" INTEGER NOT NULL DEFAULT 0,
    "width" INTEGER,
    "height" INTEGER,
    "quality" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamCorrectionPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamCorrectionJob" (
    "id" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "progress" TEXT NOT NULL DEFAULT '',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "evaluateAfter" BOOLEAN NOT NULL DEFAULT true,
    "force" BOOLEAN NOT NULL DEFAULT false,
    "answerIds" JSONB,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExamCorrectionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamCorrectionExtraction" (
    "id" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "error" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "pages" JSONB NOT NULL DEFAULT '[]',
    "answers" JSONB NOT NULL DEFAULT '[]',
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "nameOnSheet" TEXT,
    "unassignedText" TEXT NOT NULL DEFAULT '',
    "redacted" BOOLEAN NOT NULL DEFAULT false,
    "sentAs" TEXT NOT NULL DEFAULT '',
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamCorrectionExtraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamCorrectionAnswer" (
    "id" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "questionId" UUID NOT NULL,
    "extractionId" UUID,
    "originalText" TEXT NOT NULL DEFAULT '',
    "correctedText" TEXT,
    "ocrStatus" TEXT NOT NULL DEFAULT 'extracted',
    "ocrConfidence" DOUBLE PRECISION,
    "pageRefs" JSONB NOT NULL DEFAULT '[]',
    "flags" JSONB NOT NULL DEFAULT '[]',
    "finalMarks" DOUBLE PRECISION,
    "criterionMarks" JSONB NOT NULL DEFAULT '{}',
    "rubricVersion" INTEGER,
    "markStatus" TEXT NOT NULL DEFAULT 'pending',
    "feedback" TEXT NOT NULL DEFAULT '',
    "verifiedById" UUID,
    "verifiedByName" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvedById" UUID,
    "approvedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExamCorrectionAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamCorrectionEvaluation" (
    "id" UUID NOT NULL,
    "answerId" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "rubricVersion" INTEGER NOT NULL DEFAULT 0,
    "promptVersion" TEXT NOT NULL,
    "suggestedMarks" DOUBLE PRECISION,
    "criterionMarks" JSONB NOT NULL DEFAULT '{}',
    "requiresReview" BOOLEAN NOT NULL DEFAULT false,
    "reviewReasons" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "checks" JSONB NOT NULL DEFAULT '[]',
    "result" JSONB,
    "confidence" DOUBLE PRECISION,
    "answerText" TEXT NOT NULL DEFAULT '',
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamCorrectionEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamCorrectionAnswerEvent" (
    "id" UUID NOT NULL,
    "answerId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "marksBefore" DOUBLE PRECISION,
    "marksAfter" DOUBLE PRECISION,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT NOT NULL DEFAULT '',
    "byId" UUID,
    "byName" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamCorrectionAnswerEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupTransfer" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "fromCampusId" UUID NOT NULL,
    "fromSectionId" UUID,
    "toCampusId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Submitted',
    "requestedOn" DATE NOT NULL,
    "requestedById" UUID,
    "requestedByName" TEXT,
    "reviewStartedAt" TIMESTAMP(3),
    "reviewedById" UUID,
    "decidedAt" TIMESTAMP(3),
    "decidedById" UUID,
    "decidedByName" TEXT,
    "decisionNote" TEXT,
    "toSectionId" UUID,
    "completedAt" TIMESTAMP(3),
    "completedById" UUID,
    "completedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupPolicy" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'All campuses',
    "version" TEXT NOT NULL DEFAULT 'v1.0',
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "body" TEXT,
    "effectiveOn" DATE,
    "createdById" UUID,
    "createdByName" TEXT,
    "updatedById" UUID,
    "updatedByName" TEXT,
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupPolicyVersion" (
    "id" UUID NOT NULL,
    "policyId" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "body" TEXT,
    "effectiveOn" DATE,
    "changeNote" TEXT,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedById" UUID,
    "archivedByName" TEXT,

    CONSTRAINT "GroupPolicyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EarlyWarningSignal" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "studentId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "sectionId" UUID,
    "signalType" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "signal" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "stage" INTEGER NOT NULL DEFAULT 0,
    "decision" TEXT,
    "raisedOn" DATE NOT NULL,
    "raisedById" UUID,
    "raisedByName" TEXT,
    "reviewStartedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" UUID,
    "reviewedByName" TEXT,
    "context" TEXT,
    "actionPlan" TEXT,
    "ownerId" UUID,
    "nextReviewOn" DATE,
    "riskLevel" TEXT,
    "dismissReason" TEXT,
    "outcome" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedById" UUID,
    "closedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EarlyWarningSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EarlyWarningEvent" (
    "id" UUID NOT NULL,
    "signalId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "byId" UUID,
    "byName" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EarlyWarningEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EarlyWarningStudent" (
    "studentId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "sectionId" UUID,
    "attendancePct" DOUBLE PRECISION,
    "markedDays" INTEGER NOT NULL DEFAULT 0,
    "absent30" INTEGER NOT NULL DEFAULT 0,
    "late30" INTEGER NOT NULL DEFAULT 0,
    "average" DOUBLE PRECISION,
    "previousAverage" DOUBLE PRECISION,
    "trend" DOUBLE PRECISION,
    "termLabel" TEXT,
    "homeworkRate" DOUBLE PRECISION,
    "homeworkDue" INTEGER NOT NULL DEFAULT 0,
    "concerns60" INTEGER NOT NULL DEFAULT 0,
    "positives60" INTEGER NOT NULL DEFAULT 0,
    "wellbeingFlags30" INTEGER NOT NULL DEFAULT 0,
    "activities" INTEGER NOT NULL DEFAULT 0,
    "feesOverdue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "feesOverdueDays" INTEGER NOT NULL DEFAULT 0,
    "indicators" TEXT[],
    "band" TEXT NOT NULL DEFAULT 'On Track',
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EarlyWarningStudent_pkey" PRIMARY KEY ("studentId")
);

-- CreateTable
CREATE TABLE "TalentStrength" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "skill" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "confidence" TEXT NOT NULL,
    "evidence" TEXT[],
    "evidenceCount" INTEGER NOT NULL DEFAULT 0,
    "activities" INTEGER NOT NULL DEFAULT 0,
    "assessedOn" DATE NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TalentStrength_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TalentDecision" (
    "id" UUID NOT NULL,
    "strengthId" UUID,
    "studentId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "skill" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "scoreAtDecision" INTEGER NOT NULL,
    "decidedById" UUID NOT NULL,
    "decidedByName" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TalentDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopilotDraft" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "title" TEXT NOT NULL,
    "classLabel" TEXT,
    "campusId" UUID,
    "gradeLevel" INTEGER,
    "sectionId" UUID,
    "subjectId" UUID,
    "studentId" UUID,
    "objectiveId" UUID,
    "prompt" JSONB NOT NULL,
    "output" JSONB NOT NULL,
    "warnings" INTEGER NOT NULL DEFAULT 0,
    "generatorKind" TEXT NOT NULL DEFAULT 'template',
    "requestedById" UUID NOT NULL,
    "requestedByName" TEXT NOT NULL,
    "approvedById" UUID,
    "approvedByName" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "lessonPlanId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CopilotDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeSource" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "refId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "section" TEXT,
    "campusId" UUID,
    "visibility" TEXT NOT NULL DEFAULT 'families',
    "audience" TEXT[],
    "restricted" BOOLEAN NOT NULL DEFAULT false,
    "keywords" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'indexed',
    "error" TEXT,
    "contentHash" TEXT,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeChunk" (
    "id" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "heading" TEXT,
    "text" TEXT NOT NULL,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeQuestion" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "roleKey" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'web',
    "campusId" UUID,
    "question" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "found" BOOLEAN NOT NULL,
    "kind" TEXT NOT NULL,
    "confidence" TEXT,
    "sourceIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeFeedback" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "helpful" BOOLEAN NOT NULL,
    "routeToPerson" BOOLEAN NOT NULL DEFAULT false,
    "documentIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappConversation" (
    "id" UUID NOT NULL,
    "waId" TEXT NOT NULL,
    "phoneKey" TEXT NOT NULL,
    "profileName" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'prospect',
    "guardianId" UUID,
    "leadId" UUID,
    "campusId" UUID,
    "status" TEXT NOT NULL DEFAULT 'open',
    "escalatedAt" TIMESTAMP(3),
    "escalationReason" TEXT,
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappMessage" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "direction" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "messageType" TEXT NOT NULL DEFAULT 'text',
    "body" TEXT NOT NULL,
    "intent" TEXT,
    "escalated" BOOLEAN NOT NULL DEFAULT false,
    "generator" TEXT,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "sourceIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsappMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentBehaviourNote" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "sectionId" UUID,
    "recordType" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "recordedOn" DATE NOT NULL,
    "recordedById" UUID,
    "recordedByEmployeeId" UUID,
    "recordedByName" TEXT,
    "source" TEXT NOT NULL DEFAULT 'student360',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentBehaviourNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentWellbeingCheckin" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "sectionId" UUID,
    "mood" TEXT NOT NULL,
    "notes" TEXT,
    "isConfidential" BOOLEAN NOT NULL DEFAULT false,
    "checkedOn" DATE NOT NULL,
    "recordedById" UUID,
    "recordedByEmployeeId" UUID,
    "recordedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentWellbeingCheckin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentObservation" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "observedOn" DATE NOT NULL,
    "authorId" UUID,
    "authorEmployeeId" UUID,
    "authorName" TEXT NOT NULL,
    "authorRole" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentStatusChange" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "fromStatus" TEXT NOT NULL,
    "toStatus" TEXT NOT NULL,
    "effectiveOn" DATE NOT NULL,
    "reason" TEXT,
    "disabledUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabledUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "trackingStatusBefore" TEXT,
    "changedById" UUID,
    "changedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentStatusChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentAccountHold" (
    "userId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "studentId" UUID NOT NULL,
    "previousStatus" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentAccountHold_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "ExamCorrectionExam_campusId_createdAt_idx" ON "ExamCorrectionExam"("campusId", "createdAt");

-- CreateIndex
CREATE INDEX "ExamCorrectionExam_classId_idx" ON "ExamCorrectionExam"("classId");

-- CreateIndex
CREATE INDEX "ExamCorrectionTeacher_userId_idx" ON "ExamCorrectionTeacher"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ExamCorrectionTeacher_examId_userId_key" ON "ExamCorrectionTeacher"("examId", "userId");

-- CreateIndex
CREATE INDEX "ExamCorrectionQuestion_examId_order_idx" ON "ExamCorrectionQuestion"("examId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "ExamCorrectionQuestion_examId_number_key" ON "ExamCorrectionQuestion"("examId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "ExamCorrectionRubric_questionId_version_key" ON "ExamCorrectionRubric"("questionId", "version");

-- CreateIndex
CREATE INDEX "ExamCorrectionSubmission_studentId_idx" ON "ExamCorrectionSubmission"("studentId");

-- CreateIndex
CREATE INDEX "ExamCorrectionSubmission_examId_status_idx" ON "ExamCorrectionSubmission"("examId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ExamCorrectionSubmission_examId_studentId_key" ON "ExamCorrectionSubmission"("examId", "studentId");

-- CreateIndex
CREATE INDEX "ExamCorrectionPage_submissionId_pageNo_idx" ON "ExamCorrectionPage"("submissionId", "pageNo");

-- CreateIndex
CREATE INDEX "ExamCorrectionJob_status_runAfter_idx" ON "ExamCorrectionJob"("status", "runAfter");

-- CreateIndex
CREATE INDEX "ExamCorrectionJob_submissionId_createdAt_idx" ON "ExamCorrectionJob"("submissionId", "createdAt");

-- CreateIndex
CREATE INDEX "ExamCorrectionExtraction_submissionId_createdAt_idx" ON "ExamCorrectionExtraction"("submissionId", "createdAt");

-- CreateIndex
CREATE INDEX "ExamCorrectionAnswer_questionId_idx" ON "ExamCorrectionAnswer"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "ExamCorrectionAnswer_submissionId_questionId_key" ON "ExamCorrectionAnswer"("submissionId", "questionId");

-- CreateIndex
CREATE INDEX "ExamCorrectionEvaluation_answerId_createdAt_idx" ON "ExamCorrectionEvaluation"("answerId", "createdAt");

-- CreateIndex
CREATE INDEX "ExamCorrectionAnswerEvent_answerId_at_idx" ON "ExamCorrectionAnswerEvent"("answerId", "at");

-- CreateIndex
CREATE INDEX "GroupTransfer_studentId_status_idx" ON "GroupTransfer"("studentId", "status");

-- CreateIndex
CREATE INDEX "GroupTransfer_fromCampusId_status_idx" ON "GroupTransfer"("fromCampusId", "status");

-- CreateIndex
CREATE INDEX "GroupTransfer_toCampusId_status_idx" ON "GroupTransfer"("toCampusId", "status");

-- CreateIndex
CREATE INDEX "GroupTransfer_requestedOn_idx" ON "GroupTransfer"("requestedOn");

-- CreateIndex
CREATE INDEX "GroupPolicy_status_idx" ON "GroupPolicy"("status");

-- CreateIndex
CREATE INDEX "GroupPolicy_name_idx" ON "GroupPolicy"("name");

-- CreateIndex
CREATE INDEX "GroupPolicyVersion_policyId_archivedAt_idx" ON "GroupPolicyVersion"("policyId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EarlyWarningSignal_code_key" ON "EarlyWarningSignal"("code");

-- CreateIndex
CREATE INDEX "EarlyWarningSignal_studentId_signalType_idx" ON "EarlyWarningSignal"("studentId", "signalType");

-- CreateIndex
CREATE INDEX "EarlyWarningSignal_campusId_decision_idx" ON "EarlyWarningSignal"("campusId", "decision");

-- CreateIndex
CREATE INDEX "EarlyWarningSignal_ownerId_idx" ON "EarlyWarningSignal"("ownerId");

-- CreateIndex
CREATE INDEX "EarlyWarningSignal_raisedOn_idx" ON "EarlyWarningSignal"("raisedOn");

-- CreateIndex
CREATE INDEX "EarlyWarningSignal_closedAt_idx" ON "EarlyWarningSignal"("closedAt");

-- CreateIndex
CREATE INDEX "EarlyWarningEvent_signalId_at_idx" ON "EarlyWarningEvent"("signalId", "at");

-- CreateIndex
CREATE INDEX "EarlyWarningEvent_studentId_action_idx" ON "EarlyWarningEvent"("studentId", "action");

-- CreateIndex
CREATE INDEX "EarlyWarningStudent_campusId_band_idx" ON "EarlyWarningStudent"("campusId", "band");

-- CreateIndex
CREATE INDEX "EarlyWarningStudent_sectionId_idx" ON "EarlyWarningStudent"("sectionId");

-- CreateIndex
CREATE INDEX "TalentStrength_campusId_skill_idx" ON "TalentStrength"("campusId", "skill");

-- CreateIndex
CREATE UNIQUE INDEX "TalentStrength_studentId_skill_key" ON "TalentStrength"("studentId", "skill");

-- CreateIndex
CREATE INDEX "TalentDecision_studentId_skill_idx" ON "TalentDecision"("studentId", "skill");

-- CreateIndex
CREATE INDEX "TalentDecision_campusId_decidedAt_idx" ON "TalentDecision"("campusId", "decidedAt");

-- CreateIndex
CREATE INDEX "CopilotDraft_requestedById_createdAt_idx" ON "CopilotDraft"("requestedById", "createdAt");

-- CreateIndex
CREATE INDEX "CopilotDraft_campusId_status_idx" ON "CopilotDraft"("campusId", "status");

-- CreateIndex
CREATE INDEX "CopilotDraft_createdAt_idx" ON "CopilotDraft"("createdAt");

-- CreateIndex
CREATE INDEX "KnowledgeSource_status_idx" ON "KnowledgeSource"("status");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeSource_kind_refId_key" ON "KnowledgeSource"("kind", "refId");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_sourceId_ordinal_idx" ON "KnowledgeChunk"("sourceId", "ordinal");

-- CreateIndex
CREATE INDEX "KnowledgeQuestion_createdAt_idx" ON "KnowledgeQuestion"("createdAt");

-- CreateIndex
CREATE INDEX "KnowledgeQuestion_normalized_idx" ON "KnowledgeQuestion"("normalized");

-- CreateIndex
CREATE INDEX "KnowledgeFeedback_createdAt_idx" ON "KnowledgeFeedback"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappConversation_waId_key" ON "WhatsappConversation"("waId");

-- CreateIndex
CREATE INDEX "WhatsappConversation_phoneKey_idx" ON "WhatsappConversation"("phoneKey");

-- CreateIndex
CREATE INDEX "WhatsappConversation_status_lastInboundAt_idx" ON "WhatsappConversation"("status", "lastInboundAt");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappMessage_providerMessageId_key" ON "WhatsappMessage"("providerMessageId");

-- CreateIndex
CREATE INDEX "WhatsappMessage_conversationId_createdAt_idx" ON "WhatsappMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "StudentBehaviourNote_studentId_recordedOn_idx" ON "StudentBehaviourNote"("studentId", "recordedOn");

-- CreateIndex
CREATE INDEX "StudentBehaviourNote_campusId_recordedOn_idx" ON "StudentBehaviourNote"("campusId", "recordedOn");

-- CreateIndex
CREATE INDEX "StudentBehaviourNote_recordType_recordedOn_idx" ON "StudentBehaviourNote"("recordType", "recordedOn");

-- CreateIndex
CREATE INDEX "StudentWellbeingCheckin_studentId_checkedOn_idx" ON "StudentWellbeingCheckin"("studentId", "checkedOn");

-- CreateIndex
CREATE INDEX "StudentWellbeingCheckin_campusId_checkedOn_idx" ON "StudentWellbeingCheckin"("campusId", "checkedOn");

-- CreateIndex
CREATE INDEX "StudentObservation_studentId_observedOn_idx" ON "StudentObservation"("studentId", "observedOn");

-- CreateIndex
CREATE INDEX "StudentObservation_campusId_observedOn_idx" ON "StudentObservation"("campusId", "observedOn");

-- CreateIndex
CREATE INDEX "StudentStatusChange_studentId_createdAt_idx" ON "StudentStatusChange"("studentId", "createdAt");

-- CreateIndex
CREATE INDEX "StudentStatusChange_campusId_createdAt_idx" ON "StudentStatusChange"("campusId", "createdAt");

-- CreateIndex
CREATE INDEX "StudentAccountHold_studentId_idx" ON "StudentAccountHold"("studentId");

-- AddForeignKey
ALTER TABLE "ExamCorrectionTeacher" ADD CONSTRAINT "ExamCorrectionTeacher_examId_fkey" FOREIGN KEY ("examId") REFERENCES "ExamCorrectionExam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamCorrectionQuestion" ADD CONSTRAINT "ExamCorrectionQuestion_examId_fkey" FOREIGN KEY ("examId") REFERENCES "ExamCorrectionExam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamCorrectionRubric" ADD CONSTRAINT "ExamCorrectionRubric_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "ExamCorrectionQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamCorrectionSubmission" ADD CONSTRAINT "ExamCorrectionSubmission_examId_fkey" FOREIGN KEY ("examId") REFERENCES "ExamCorrectionExam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamCorrectionPage" ADD CONSTRAINT "ExamCorrectionPage_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "ExamCorrectionSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamCorrectionJob" ADD CONSTRAINT "ExamCorrectionJob_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "ExamCorrectionSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamCorrectionExtraction" ADD CONSTRAINT "ExamCorrectionExtraction_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "ExamCorrectionSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamCorrectionAnswer" ADD CONSTRAINT "ExamCorrectionAnswer_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "ExamCorrectionSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamCorrectionAnswer" ADD CONSTRAINT "ExamCorrectionAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "ExamCorrectionQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamCorrectionEvaluation" ADD CONSTRAINT "ExamCorrectionEvaluation_answerId_fkey" FOREIGN KEY ("answerId") REFERENCES "ExamCorrectionAnswer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamCorrectionAnswerEvent" ADD CONSTRAINT "ExamCorrectionAnswerEvent_answerId_fkey" FOREIGN KEY ("answerId") REFERENCES "ExamCorrectionAnswer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupPolicyVersion" ADD CONSTRAINT "GroupPolicyVersion_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "GroupPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EarlyWarningEvent" ADD CONSTRAINT "EarlyWarningEvent_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "EarlyWarningSignal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappMessage" ADD CONSTRAINT "WhatsappMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "WhatsappConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
