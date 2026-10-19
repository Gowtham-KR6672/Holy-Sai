-- CreateTable
CREATE TABLE "TimetablePeriod" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "periodNo" INTEGER NOT NULL,
    "startsAt" TEXT NOT NULL,
    "endsAt" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimetablePeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimetableEntry" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "sectionId" UUID NOT NULL,
    "day" INTEGER NOT NULL,
    "periodNo" INTEGER NOT NULL,
    "subjectId" UUID,
    "activity" TEXT,
    "employeeId" UUID,
    "room" TEXT,
    "needsSubstitute" BOOLEAN NOT NULL DEFAULT false,
    "substituteId" UUID,
    "substituteNote" TEXT,
    "coverDate" DATE,
    "coverAssignedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimetableEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentAttendance" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "sectionId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "arrivalTime" TEXT,
    "parentNotifiedAt" TIMESTAMP(3),
    "markedById" UUID,
    "markedByName" TEXT,
    "markedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentAttendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentAttendanceRegister" (
    "id" UUID NOT NULL,
    "sectionId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "present" INTEGER NOT NULL DEFAULT 0,
    "late" INTEGER NOT NULL DEFAULT 0,
    "absent" INTEGER NOT NULL DEFAULT 0,
    "leave" INTEGER NOT NULL DEFAULT 0,
    "markedById" UUID,
    "markedByName" TEXT,
    "firstMarkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "markedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentAttendanceRegister_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LessonPlan" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "plannedFor" DATE,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "campusId" UUID NOT NULL,
    "sectionId" UUID,
    "subjectId" UUID NOT NULL,
    "objectiveId" UUID,
    "authorId" UUID NOT NULL,
    "content" JSONB NOT NULL DEFAULT '{}',
    "submittedAt" TIMESTAMP(3),
    "reviewStartedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvedById" UUID,
    "approvedByName" TEXT,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LessonPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Homework" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "instructions" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Open',
    "assignedOn" DATE NOT NULL,
    "dueOn" DATE NOT NULL,
    "campusId" UUID NOT NULL,
    "sectionId" UUID NOT NULL,
    "subjectId" UUID NOT NULL,
    "assignedById" UUID,
    "assignedByUserId" UUID,
    "assignedByName" TEXT,
    "publishedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "lastRemindedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Homework_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HomeworkSubmission" (
    "id" UUID NOT NULL,
    "homeworkId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "feedback" TEXT,
    "updatedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HomeworkSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionBankItem" (
    "id" UUID NOT NULL,
    "subjectId" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "stageLabel" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "questionType" TEXT NOT NULL DEFAULT 'short',
    "difficulty" TEXT NOT NULL DEFAULT 'Core',
    "marks" INTEGER NOT NULL DEFAULT 1,
    "timesUsed" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "objectiveId" UUID,
    "createdById" UUID,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuestionBankItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CurriculumStage" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "gradeFrom" INTEGER NOT NULL,
    "gradeTo" INTEGER NOT NULL,
    "keywords" TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CurriculumStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CurriculumObjective" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "subjectId" UUID NOT NULL,
    "stageLabel" TEXT NOT NULL,
    "coveragePct" INTEGER NOT NULL DEFAULT 0,
    "masteryPct" INTEGER NOT NULL DEFAULT 0,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CurriculumObjective_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CurriculumSnapshot" (
    "id" UUID NOT NULL,
    "termLabel" TEXT NOT NULL,
    "termStart" DATE NOT NULL,
    "coverage" DOUBLE PRECISION NOT NULL,
    "mastery" DOUBLE PRECISION NOT NULL,
    "objectives" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CurriculumSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assessment" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "assessmentType" TEXT NOT NULL DEFAULT 'test',
    "status" TEXT NOT NULL DEFAULT 'Scheduled',
    "heldOn" DATE NOT NULL,
    "maxMarks" DOUBLE PRECISION NOT NULL,
    "campusId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "sectionId" UUID,
    "subjectId" UUID NOT NULL,
    "createdById" UUID,
    "createdByName" TEXT,
    "moderationAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "completedById" UUID,
    "completedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Assessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentMark" (
    "id" UUID NOT NULL,
    "assessmentId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "marks" DOUBLE PRECISION,
    "isAbsent" BOOLEAN NOT NULL DEFAULT false,
    "grade" TEXT,
    "enteredById" UUID,
    "enteredByName" TEXT,
    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssessmentMark_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportCardBatch" (
    "id" UUID NOT NULL,
    "sectionId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "term" TEXT NOT NULL,
    "termStart" DATE NOT NULL,
    "termEnd" DATE NOT NULL,
    "stage" INTEGER NOT NULL DEFAULT 0,
    "due" DATE NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "approvedById" UUID,
    "approvedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportCardBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportCardComment" (
    "id" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "comment" TEXT NOT NULL DEFAULT '',
    "aiDrafted" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "reviewedById" UUID,
    "reviewedByName" TEXT,
    "sources" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportCardComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdmissionLead" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "campusId" UUID NOT NULL,
    "parentName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "phoneKey" TEXT NOT NULL,
    "email" TEXT,
    "studentName" TEXT NOT NULL,
    "studentDob" DATE,
    "grade" TEXT NOT NULL,
    "gradeLevel" INTEGER NOT NULL DEFAULT 0,
    "curriculum" TEXT,
    "source" TEXT NOT NULL,
    "campaign" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'New Lead',
    "stageOrder" INTEGER NOT NULL DEFAULT 0,
    "maxStageIndex" INTEGER NOT NULL DEFAULT 0,
    "stageChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "score" INTEGER NOT NULL DEFAULT 50,
    "counsellorId" UUID,
    "counsellorName" TEXT,
    "assignedAt" TIMESTAMP(3),
    "transportRequired" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "lostReason" TEXT,
    "lostAt" TIMESTAMP(3),
    "enrolledAt" TIMESTAMP(3),
    "studentId" UUID,
    "firstContactAt" TIMESTAMP(3),
    "nextAction" TEXT,
    "nextActionAt" TIMESTAMP(3),
    "acquisitionCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdmissionLead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdmissionStageHistory" (
    "id" SERIAL NOT NULL,
    "leadId" UUID NOT NULL,
    "fromStage" TEXT,
    "toStage" TEXT NOT NULL,
    "note" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedById" UUID,
    "changedByName" TEXT,

    CONSTRAINT "AdmissionStageHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdmissionFollowUp" (
    "id" UUID NOT NULL,
    "leadId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Scheduled',
    "assignedTo" UUID,
    "assignedName" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdmissionFollowUp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdmissionApplication" (
    "id" UUID NOT NULL,
    "applicationNo" TEXT NOT NULL,
    "leadId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Submitted',
    "studentName" TEXT NOT NULL,
    "dateOfBirth" DATE,
    "gender" TEXT,
    "grade" TEXT NOT NULL,
    "previousSchool" TEXT,
    "assessmentAt" TIMESTAMP(3),
    "assessmentScore" DOUBLE PRECISION,
    "offerExpiresOn" DATE,
    "offerMadeAt" TIMESTAMP(3),
    "feePaid" BOOLEAN NOT NULL DEFAULT false,
    "studentId" UUID,
    "admissionNo" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedById" UUID,
    "decidedByName" TEXT,
    "enrolledAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdmissionApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdmissionDocument" (
    "id" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "receivedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "verifiedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdmissionDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdmissionReferral" (
    "id" UUID NOT NULL,
    "referrerGuardianId" UUID NOT NULL,
    "referrerName" TEXT NOT NULL,
    "referredName" TEXT NOT NULL,
    "leadId" UUID,
    "campusId" UUID,
    "status" TEXT NOT NULL DEFAULT 'Submitted',
    "rewardStatus" TEXT NOT NULL DEFAULT 'Not eligible',
    "rewardAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "creditedAt" TIMESTAMP(3),
    "creditedById" UUID,
    "creditedByName" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdmissionReferral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdmissionMarketingSpend" (
    "id" UUID NOT NULL,
    "campusId" UUID,
    "source" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "note" TEXT,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdmissionMarketingSpend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmAlumnus" (
    "id" UUID NOT NULL,
    "fullName" TEXT NOT NULL,
    "batchYear" INTEGER NOT NULL,
    "university" TEXT,
    "career" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "phoneKey" TEXT,
    "engagement" TEXT NOT NULL DEFAULT 'Low',
    "engagementRank" INTEGER NOT NULL DEFAULT 3,
    "lastEngagement" TEXT,
    "mentoring" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmAlumnus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmVendor" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "contactPerson" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "contractStart" DATE,
    "contractEnd" DATE,
    "contractValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "renewalNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmVendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmPartner" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "partnerType" TEXT NOT NULL,
    "sinceYear" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmPartner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmCommunication" (
    "id" UUID NOT NULL,
    "leadId" UUID,
    "guardianId" UUID,
    "alumnusId" UUID,
    "vendorId" UUID,
    "partnerId" UUID,
    "counterpart" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'Outbound',
    "subject" TEXT NOT NULL,
    "body" TEXT,
    "status" TEXT NOT NULL,
    "recipients" INTEGER NOT NULL DEFAULT 1,
    "automated" BOOLEAN NOT NULL DEFAULT false,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentById" UUID,
    "sentByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmCommunication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceFeeHead" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceFeeHead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceFeeStructure" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "academicYearId" UUID,
    "feeHeadId" UUID NOT NULL,
    "term" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "dueDate" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceFeeStructure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceCharge" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "classId" UUID,
    "academicYearId" UUID,
    "structureId" UUID,
    "feeHeadId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "concession" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "paid" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "balance" DECIMAL(12,2) NOT NULL,
    "dueDate" DATE NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancePayment" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "academicYearId" UUID,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" TEXT NOT NULL,
    "instrument" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "receiptNo" TEXT,
    "gatewayRef" TEXT,
    "gatewayOrderId" TEXT,
    "failureReason" TEXT,
    "requestedFeeIds" JSONB,
    "collectedById" UUID,
    "collectedBy" TEXT,
    "paidById" UUID,
    "paidBy" TEXT,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receiptSentAt" TIMESTAMP(3),
    "reconciled" BOOLEAN NOT NULL DEFAULT false,
    "reconciledAt" TIMESTAMP(3),
    "refundedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancePaymentAllocation" (
    "id" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "chargeId" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "balanceAfter" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "FinancePaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceConcession" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "academicYearId" UUID,
    "type" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "percent" DECIMAL(5,2),
    "amount" DECIMAL(12,2) NOT NULL,
    "appliedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'Submitted',
    "scholarshipId" UUID,
    "requestedById" UUID,
    "requestedBy" TEXT,
    "reviewedById" UUID,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "decidedById" UUID,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "validUntil" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceConcession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceScholarship" (
    "id" UUID NOT NULL,
    "academicYearId" UUID,
    "name" TEXT NOT NULL,
    "criteria" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "seats" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Open',
    "createdById" UUID,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceScholarship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceExpenseCategory" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceExpenseCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceExpense" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "campusId" UUID NOT NULL,
    "academicYearId" UUID,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "expenseDate" DATE NOT NULL,
    "vendorId" UUID,
    "vendorName" TEXT,
    "submittedById" UUID,
    "raisedBy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "rejectionReason" TEXT,
    "submittedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "decidedById" UUID,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "paidBy" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceExpense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceReimbursement" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "employeeId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "claimType" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "claimDate" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Submitted',
    "rejectionReason" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "decidedById" UUID,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "payrollMonth" TEXT,
    "paidVia" TEXT,
    "payrollRef" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceReimbursement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceAllowance" (
    "id" UUID NOT NULL,
    "allowanceType" TEXT NOT NULL,
    "employeeId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "employeeType" TEXT NOT NULL,
    "appliesTo" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'amount',
    "percentOfBasic" DECIMAL(5,2),
    "amount" DECIMAL(12,2) NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'Monthly',
    "effectiveMonth" DATE NOT NULL,
    "endMonth" DATE,
    "status" TEXT NOT NULL DEFAULT 'Submitted',
    "proposedById" UUID,
    "proposedBy" TEXT,
    "decidedById" UUID,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceAllowance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceBudget" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "academicYearId" UUID,
    "category" TEXT NOT NULL,
    "allocated" DECIMAL(12,2) NOT NULL,
    "owner" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceReconLine" (
    "id" UUID NOT NULL,
    "statementDate" DATE NOT NULL,
    "channel" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Unmatched',
    "note" TEXT,
    "paymentId" UUID,
    "source" TEXT NOT NULL DEFAULT 'import',
    "externalId" TEXT,
    "settlementId" TEXT,
    "matchedAt" TIMESTAMP(3),
    "matchedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceReconLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceReminder" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "message" TEXT NOT NULL,
    "sentById" UUID,
    "sentBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceReminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InnovationIdea" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "problem" TEXT,
    "category" TEXT,
    "wantsMentor" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Submitted',
    "studentId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "submittedOn" DATE NOT NULL,
    "submittedById" UUID,
    "source" TEXT NOT NULL DEFAULT 'staff',
    "reviewedById" UUID,
    "reviewedByName" TEXT,
    "reviewStartedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "projectId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InnovationIdea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InnovationProject" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "stage" INTEGER NOT NULL DEFAULT 3,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "studentId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "mentorId" UUID,
    "startedOn" DATE,
    "completedOn" DATE,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InnovationProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InnovationProjectMember" (
    "projectId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'Member',
    "addedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InnovationProjectMember_pkey" PRIMARY KEY ("projectId","studentId")
);

-- CreateTable
CREATE TABLE "InnovationMilestone" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "dueOn" DATE,
    "completedOn" DATE,
    "completedById" UUID,
    "evidence" TEXT,
    "feedback" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InnovationMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InnovationEvidence" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "milestoneId" UUID,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "link" TEXT,
    "note" TEXT,
    "addedById" UUID,
    "addedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InnovationEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InnovationFeedback" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "authorId" UUID,
    "authorEmployeeId" UUID,
    "authorName" TEXT NOT NULL,
    "authorRole" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InnovationFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InnovationMentor" (
    "employeeId" UUID NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "specialisation" TEXT,
    "addedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InnovationMentor_pkey" PRIMARY KEY ("employeeId")
);

-- CreateTable
CREATE TABLE "InnovationCompetition" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "heldOn" DATE NOT NULL,
    "result" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InnovationCompetition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InnovationCompetitionEntry" (
    "competitionId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "result" TEXT,
    "enteredById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InnovationCompetitionEntry_pkey" PRIMARY KEY ("competitionId","projectId")
);

-- CreateTable
CREATE TABLE "InnovationAchievement" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "level" TEXT,
    "achievedOn" DATE NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedById" UUID,
    "verifiedByName" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "projectId" UUID,
    "competitionId" UUID,
    "note" TEXT,
    "source" TEXT NOT NULL DEFAULT 'innovation',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InnovationAchievement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsAsset" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "campusId" UUID NOT NULL,
    "facilityId" UUID,
    "location" TEXT,
    "assignedTo" UUID,
    "purchasedOn" DATE,
    "purchaseValue" DECIMAL(12,2),
    "lastServiceOn" DATE,
    "nextServiceOn" DATE,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "retiredAt" TIMESTAMP(3),
    "retiredById" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpsAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsAssetService" (
    "id" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "servicedOn" DATE NOT NULL,
    "nextServiceOn" DATE,
    "note" TEXT,
    "cost" DECIMAL(12,2),
    "maintenanceId" UUID,
    "recordedById" UUID,
    "recordedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpsAssetService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsFacility" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "facilityType" TEXT NOT NULL,
    "capacity" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'Available',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpsFacility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsFacilityBooking" (
    "id" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "bookedOn" DATE NOT NULL,
    "startsAt" TEXT NOT NULL,
    "endsAt" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "bookedById" UUID,
    "bookedByName" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpsFacilityBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsMaintenanceRequest" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "campusId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'Medium',
    "priorityRank" INTEGER NOT NULL DEFAULT 2,
    "status" TEXT NOT NULL DEFAULT 'Submitted',
    "assetId" UUID,
    "facilityId" UUID,
    "raisedById" UUID,
    "raisedByName" TEXT,
    "assignedToId" UUID,
    "cost" DECIMAL(12,2),
    "note" TEXT,
    "decidedById" UUID,
    "decidedByName" TEXT,
    "decidedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "history" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpsMaintenanceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsInventoryItem" (
    "id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "campusId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "reorderLevel" INTEGER NOT NULL DEFAULT 0,
    "unitCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "lastMovementAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpsInventoryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsStockMovement" (
    "id" SERIAL NOT NULL,
    "itemId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "movementType" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "note" TEXT,
    "movedById" UUID,
    "movedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpsStockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsPurchaseRequest" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "itemId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCost" DECIMAL(12,2) NOT NULL,
    "estimatedCost" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Requested',
    "requestedById" UUID,
    "requestedByName" TEXT,
    "expenseId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpsPurchaseRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsDocument" (
    "id" UUID NOT NULL,
    "campusId" UUID,
    "studentId" UUID,
    "employeeId" UUID,
    "collection" TEXT,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Submitted',
    "storageKey" TEXT,
    "originalName" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "sha256" TEXT,
    "requestedOn" DATE,
    "requestedById" UUID,
    "uploadedById" UUID,
    "uploadedByName" TEXT,
    "uploadedAt" TIMESTAMP(3),
    "verifiedById" UUID,
    "verifiedByName" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "expiresOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpsDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsCertificate" (
    "id" UUID NOT NULL,
    "certificateType" TEXT NOT NULL,
    "studentId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "studentName" TEXT NOT NULL,
    "admissionNo" TEXT NOT NULL,
    "purpose" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Submitted',
    "requestedById" UUID,
    "requestedByName" TEXT,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "approvedById" UUID,
    "approvedByName" TEXT,
    "approvedAt" TIMESTAMP(3),
    "verificationCode" TEXT,
    "issuedById" UUID,
    "issuedAt" TIMESTAMP(3),
    "rejectedById" UUID,
    "rejectedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "checks" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpsCertificate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsComplianceItem" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "item" TEXT NOT NULL,
    "authority" TEXT NOT NULL,
    "dueOn" DATE NOT NULL,
    "ownerId" UUID,
    "status" TEXT NOT NULL DEFAULT 'Scheduled',
    "notes" TEXT,
    "completedOn" DATE,
    "completedById" UUID,
    "completionNotes" TEXT,
    "recurrenceDays" INTEGER,
    "previousId" UUID,
    "escalatedAt" TIMESTAMP(3),
    "escalations" INTEGER NOT NULL DEFAULT 0,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpsComplianceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParentProfile" (
    "guardianId" UUID NOT NULL,
    "parentCode" TEXT NOT NULL,
    "altPhone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ParentProfile_pkey" PRIMARY KEY ("guardianId")
);

-- CreateTable
CREATE TABLE "CommMessage" (
    "id" UUID NOT NULL,
    "guardianId" UUID,
    "studentId" UUID,
    "campusId" UUID,
    "channel" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "counterpart" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT,
    "status" TEXT NOT NULL,
    "deliveryError" TEXT,
    "needsReply" BOOLEAN NOT NULL DEFAULT false,
    "recipients" INTEGER NOT NULL DEFAULT 1,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentById" UUID,
    "sentByName" TEXT,
    "repliedById" UUID,
    "repliedByName" TEXT,
    "repliedAt" TIMESTAMP(3),
    "replyToId" UUID,
    "threadId" UUID,
    "entityType" TEXT,
    "entityId" TEXT,
    "escalatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommThread" (
    "id" UUID NOT NULL,
    "guardianId" UUID NOT NULL,
    "studentId" UUID,
    "campusId" UUID,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Open',
    "awaitingReply" BOOLEAN NOT NULL DEFAULT false,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastParentMessageAt" TIMESTAMP(3),
    "lastStaffMessageAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommThreadMessage" (
    "id" UUID NOT NULL,
    "threadId" UUID NOT NULL,
    "senderUserId" UUID,
    "senderRole" TEXT NOT NULL,
    "senderName" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommThreadMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommThreadParticipant" (
    "threadId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommThreadParticipant_pkey" PRIMARY KEY ("threadId","userId")
);

-- CreateTable
CREATE TABLE "CommThreadRead" (
    "threadId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommThreadRead_pkey" PRIMARY KEY ("threadId","userId")
);

-- CreateTable
CREATE TABLE "CommCircular" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audience" JSONB NOT NULL,
    "audienceLabel" TEXT NOT NULL,
    "campusId" UUID,
    "channels" TEXT[],
    "requiresAck" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "targetCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" UUID,
    "createdByName" TEXT,
    "submittedAt" TIMESTAMP(3),
    "submittedById" UUID,
    "submittedByName" TEXT,
    "returnedAt" TIMESTAMP(3),
    "returnedByName" TEXT,
    "releasedAt" TIMESTAMP(3),
    "releasedById" UUID,
    "releasedByName" TEXT,
    "withdrawnAt" TIMESTAMP(3),
    "withdrawnByName" TEXT,
    "lastRemindedAt" TIMESTAMP(3),
    "reminderCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommCircular_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommCircularRecipient" (
    "id" UUID NOT NULL,
    "circularId" UUID NOT NULL,
    "guardianId" UUID,
    "userId" UUID,
    "studentIds" TEXT[],
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" UUID,
    "lastRemindedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommCircularRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommEvent" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "eventType" TEXT NOT NULL,
    "startsOn" DATE NOT NULL,
    "endsOn" DATE,
    "startsAt" TEXT,
    "venue" TEXT,
    "audience" JSONB NOT NULL,
    "audienceLabel" TEXT NOT NULL,
    "campusId" UUID,
    "status" TEXT NOT NULL DEFAULT 'Published',
    "notifiedAt" TIMESTAMP(3),
    "notifyCount" INTEGER NOT NULL DEFAULT 0,
    "cancelledAt" TIMESTAMP(3),
    "cancelledByName" TEXT,
    "createdById" UUID,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PtmSession" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "sectionId" UUID NOT NULL,
    "subjectLabel" TEXT NOT NULL,
    "sessionDate" DATE NOT NULL,
    "startsAt" TEXT NOT NULL,
    "slotMinutes" INTEGER NOT NULL,
    "totalSlots" INTEGER NOT NULL,
    "venue" TEXT,
    "lastNotifiedAt" TIMESTAMP(3),
    "notifyCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" UUID,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PtmSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PtmBooking" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "slotNo" INTEGER NOT NULL,
    "studentId" UUID NOT NULL,
    "guardianId" UUID,
    "status" TEXT NOT NULL DEFAULT 'Booked',
    "bookedById" UUID,
    "bookedByName" TEXT,
    "statusChangedAt" TIMESTAMP(3),
    "statusChangedById" UUID,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PtmBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SafetyGateEvent" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "direction" TEXT NOT NULL,
    "gate" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "day" DATE NOT NULL,
    "parentNotifiedAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'manual',
    "deviceId" TEXT,
    "recordedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SafetyGateEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SafetyPickupAuthorisation" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "personName" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "phone" TEXT,
    "method" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "addedVia" TEXT NOT NULL DEFAULT 'office',
    "addedById" UUID,
    "parentApproved" BOOLEAN NOT NULL DEFAULT false,
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "verifiedVia" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "otpHash" TEXT,
    "otpSentAt" TIMESTAMP(3),
    "otpExpiresAt" TIMESTAMP(3),
    "otpAttempts" INTEGER NOT NULL DEFAULT 0,
    "revokedAt" TIMESTAMP(3),
    "revokedById" UUID,
    "lastPickupAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SafetyPickupAuthorisation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SafetyPickupEvent" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "authorisationId" UUID,
    "outcome" TEXT NOT NULL,
    "personName" TEXT NOT NULL,
    "gate" TEXT NOT NULL,
    "method" TEXT,
    "notes" TEXT,
    "incidentId" UUID,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "day" DATE NOT NULL,
    "recordedById" UUID,

    CONSTRAINT "SafetyPickupEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SafetyVisitor" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "badgeNo" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "phone" TEXT,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "checkedInAt" TIMESTAMP(3) NOT NULL,
    "checkedOutAt" TIMESTAMP(3),
    "hostId" UUID,
    "deniedAt" TIMESTAMP(3),
    "createdById" UUID,
    "checkedInById" UUID,
    "checkedOutById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SafetyVisitor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SafetyIncident" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "campusId" UUID NOT NULL,
    "incidentType" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "details" TEXT,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Open',
    "occurredOn" DATE NOT NULL,
    "isConfidential" BOOLEAN NOT NULL DEFAULT false,
    "studentId" UUID,
    "ownerId" UUID,
    "createdById" UUID,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" UUID,
    "escalatedAt" TIMESTAMP(3),
    "principalInformedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closedById" UUID,
    "reviewReminderAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SafetyIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SafetyBroadcast" (
    "id" UUID NOT NULL,
    "campusId" UUID,
    "alertType" TEXT NOT NULL,
    "isDrill" BOOLEAN NOT NULL DEFAULT false,
    "message" TEXT NOT NULL,
    "audiences" TEXT[],
    "channels" TEXT NOT NULL,
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "delivery" JSONB,
    "incidentId" UUID,
    "sentById" UUID,
    "sentByName" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SafetyBroadcast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SafetyInfirmaryVisit" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "visitedAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "actionTaken" TEXT,
    "outcome" TEXT NOT NULL,
    "parentInformed" BOOLEAN NOT NULL DEFAULT false,
    "parentInformedAt" TIMESTAMP(3),
    "attendedById" UUID,
    "attendedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SafetyInfirmaryVisit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SafetyCounsellingSession" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "counsellorId" UUID NOT NULL,
    "sessionOn" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Scheduled',
    "notes" TEXT,
    "notesUpdatedAt" TIMESTAMP(3),
    "notesUpdatedById" UUID,
    "referredAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SafetyCounsellingSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportVehicle" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "busNo" TEXT NOT NULL,
    "registrationNo" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 40,
    "status" TEXT NOT NULL DEFAULT 'active',
    "gpsDeviceId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransportVehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportRouteProfile" (
    "routeId" UUID NOT NULL,
    "area" TEXT NOT NULL DEFAULT '',
    "vehicleId" UUID,
    "runDate" DATE,
    "delayMinutes" INTEGER NOT NULL DEFAULT 0,
    "etaText" TEXT,
    "statusReason" TEXT,
    "statusUpdatedAt" TIMESTAMP(3),
    "statusUpdatedBy" TEXT,
    "doneStops" JSONB NOT NULL DEFAULT '{}',
    "lastLatitude" DOUBLE PRECISION,
    "lastLongitude" DOUBLE PRECISION,
    "lastSpeedKmph" DOUBLE PRECISION,
    "lastHeading" DOUBLE PRECISION,
    "lastPingAt" TIMESTAMP(3),
    "lastPingSource" TEXT,
    "deviationMetres" INTEGER,
    "deviationAlertAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransportRouteProfile_pkey" PRIMARY KEY ("routeId")
);

-- CreateTable
CREATE TABLE "TransportStudentMode" (
    "studentId" UUID NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'both',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransportStudentMode_pkey" PRIMARY KEY ("studentId")
);

-- CreateTable
CREATE TABLE "TransportBusPing" (
    "id" BIGSERIAL NOT NULL,
    "routeId" UUID NOT NULL,
    "vehicleId" UUID,
    "deviceId" UUID,
    "source" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "speedKmph" DOUBLE PRECISION,
    "heading" DOUBLE PRECISION,
    "accuracy" DOUBLE PRECISION,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransportBusPing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportBoardingEvent" (
    "id" UUID NOT NULL,
    "routeId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "runDate" DATE NOT NULL,
    "session" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'Manual',
    "stopId" UUID,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedById" UUID,
    "recordedByName" TEXT,
    "parentNotifiedAt" TIMESTAMP(3),

    CONSTRAINT "TransportBoardingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackingDevice" (
    "id" UUID NOT NULL,
    "deviceCode" TEXT NOT NULL,
    "deviceType" TEXT NOT NULL,
    "imei" TEXT,
    "serialNumber" TEXT,
    "firmwareVersion" TEXT,
    "campusId" UUID,
    "status" TEXT NOT NULL DEFAULT 'available',
    "statusReason" TEXT,
    "notes" TEXT,
    "tokenHash" TEXT,
    "tokenIssuedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "batteryPct" DOUBLE PRECISION,
    "lastLatitude" DOUBLE PRECISION,
    "lastLongitude" DOUBLE PRECISION,
    "traccarId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackingDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackingAssignment" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "notes" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedById" UUID,
    "assignedByName" TEXT,
    "unassignedAt" TIMESTAMP(3),
    "unassignedById" UUID,
    "unassignedByName" TEXT,
    "unassignReason" TEXT,

    CONSTRAINT "TrackingAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackingLocation" (
    "id" BIGSERIAL NOT NULL,
    "studentId" UUID NOT NULL,
    "deviceId" UUID,
    "assignmentId" UUID,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION,
    "speed" DOUBLE PRECISION,
    "heading" DOUBLE PRECISION,
    "batteryPct" DOUBLE PRECISION,
    "locationStatus" TEXT NOT NULL,
    "placeLabel" TEXT,
    "campusId" UUID,
    "routeId" UUID,
    "source" TEXT NOT NULL DEFAULT 'device',
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackingLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackingStudentState" (
    "studentId" UUID NOT NULL,
    "locationId" BIGINT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "accuracy" DOUBLE PRECISION,
    "speed" DOUBLE PRECISION,
    "batteryPct" DOUBLE PRECISION,
    "locationStatus" TEXT,
    "placeLabel" TEXT,
    "deviceId" UUID,
    "source" TEXT,
    "recordedAt" TIMESTAMP(3),
    "homeLatitude" DOUBLE PRECISION,
    "homeLongitude" DOUBLE PRECISION,
    "tripLabel" TEXT,
    "tripUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackingStudentState_pkey" PRIMARY KEY ("studentId")
);

-- CreateTable
CREATE TABLE "WorkforceShift" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "startsAt" TEXT NOT NULL,
    "endsAt" TEXT NOT NULL,
    "splitStartsAt" TEXT,
    "splitEndsAt" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkforceShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkforceRosterEntry" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "shiftId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "post" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Scheduled',
    "coverEmployeeId" UUID,
    "coverReason" TEXT,
    "coverFlaggedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkforceRosterEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkforceAttendance" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "checkIn" TEXT,
    "checkOut" TEXT,
    "source" TEXT NOT NULL,
    "markedById" UUID,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkforceAttendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkforceLeaveType" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "entitlementDays" DOUBLE PRECISION NOT NULL,
    "isPaid" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkforceLeaveType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkforceLeaveRequest" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "employeeId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "leaveTypeId" UUID NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "halfDay" BOOLEAN NOT NULL DEFAULT false,
    "days" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "coverArrangement" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Submitted',
    "appliedVia" TEXT NOT NULL DEFAULT 'self',
    "appliedById" UUID,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "decidedById" UUID,
    "decidedByName" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkforceLeaveRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkforceOvertime" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "workDate" DATE NOT NULL,
    "hours" DECIMAL(5,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "ratePerHour" DECIMAL(12,2) NOT NULL,
    "cost" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Submitted',
    "source" TEXT NOT NULL DEFAULT 'self',
    "submittedById" UUID,
    "decidedById" UUID,
    "decidedByName" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "payrollRunId" UUID,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkforceOvertime_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkforceCpdRecord" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "programme" TEXT NOT NULL,
    "provider" TEXT,
    "hours" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Planned',
    "completedOn" DATE,
    "isMandatory" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkforceCpdRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkforceLoan" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "principal" DECIMAL(12,2) NOT NULL,
    "monthlyInstalment" DECIMAL(12,2) NOT NULL,
    "outstanding" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "startedOn" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkforceLoan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkforcePayrollRun" (
    "id" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "payMonth" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "createdById" UUID,
    "inputsAt" TIMESTAMP(3),
    "inputsById" UUID,
    "calculatedAt" TIMESTAMP(3),
    "calculatedById" UUID,
    "calculatedByName" TEXT,
    "submittedAt" TIMESTAMP(3),
    "submittedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "approvedById" UUID,
    "approvedByName" TEXT,
    "reviewNote" TEXT,
    "returnedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "releasedById" UUID,
    "paidAt" TIMESTAMP(3),
    "paidById" UUID,
    "employeeCount" INTEGER NOT NULL DEFAULT 0,
    "gross" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "deductions" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "net" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "overtime" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "allowances" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "reimbursements" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "inputsSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkforcePayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkforcePayslip" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "campusId" UUID NOT NULL,
    "payMonth" DATE NOT NULL,
    "employeeType" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "designation" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "bankAccountMasked" TEXT,
    "workingDays" DOUBLE PRECISION NOT NULL,
    "daysWorked" DOUBLE PRECISION NOT NULL,
    "leaveDays" DOUBLE PRECISION NOT NULL,
    "lopDays" DOUBLE PRECISION NOT NULL,
    "overtimeHours" DOUBLE PRECISION NOT NULL,
    "basic" DECIMAL(12,2) NOT NULL,
    "gross" DECIMAL(12,2) NOT NULL,
    "totalDeductions" DECIMAL(12,2) NOT NULL,
    "net" DECIMAL(12,2) NOT NULL,
    "allowances" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "reimbursements" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "overtimePay" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "earnings" JSONB NOT NULL,
    "deductions" JSONB NOT NULL,
    "meta" JSONB,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "releasedAt" TIMESTAMP(3),
    "paymentDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkforcePayslip_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TimetablePeriod_campusId_periodNo_key" ON "TimetablePeriod"("campusId", "periodNo");

-- CreateIndex
CREATE INDEX "TimetableEntry_campusId_idx" ON "TimetableEntry"("campusId");

-- CreateIndex
CREATE INDEX "TimetableEntry_employeeId_idx" ON "TimetableEntry"("employeeId");

-- CreateIndex
CREATE INDEX "TimetableEntry_substituteId_idx" ON "TimetableEntry"("substituteId");

-- CreateIndex
CREATE UNIQUE INDEX "TimetableEntry_sectionId_day_periodNo_key" ON "TimetableEntry"("sectionId", "day", "periodNo");

-- CreateIndex
CREATE INDEX "StudentAttendance_sectionId_date_idx" ON "StudentAttendance"("sectionId", "date");

-- CreateIndex
CREATE INDEX "StudentAttendance_campusId_date_idx" ON "StudentAttendance"("campusId", "date");

-- CreateIndex
CREATE INDEX "StudentAttendance_date_status_idx" ON "StudentAttendance"("date", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StudentAttendance_studentId_sectionId_date_key" ON "StudentAttendance"("studentId", "sectionId", "date");

-- CreateIndex
CREATE INDEX "StudentAttendanceRegister_campusId_date_idx" ON "StudentAttendanceRegister"("campusId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "StudentAttendanceRegister_sectionId_date_key" ON "StudentAttendanceRegister"("sectionId", "date");

-- CreateIndex
CREATE INDEX "LessonPlan_campusId_status_idx" ON "LessonPlan"("campusId", "status");

-- CreateIndex
CREATE INDEX "LessonPlan_authorId_idx" ON "LessonPlan"("authorId");

-- CreateIndex
CREATE INDEX "LessonPlan_sectionId_idx" ON "LessonPlan"("sectionId");

-- CreateIndex
CREATE INDEX "LessonPlan_objectiveId_idx" ON "LessonPlan"("objectiveId");

-- CreateIndex
CREATE INDEX "Homework_campusId_status_idx" ON "Homework"("campusId", "status");

-- CreateIndex
CREATE INDEX "Homework_sectionId_idx" ON "Homework"("sectionId");

-- CreateIndex
CREATE INDEX "Homework_dueOn_idx" ON "Homework"("dueOn");

-- CreateIndex
CREATE INDEX "HomeworkSubmission_studentId_idx" ON "HomeworkSubmission"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "HomeworkSubmission_homeworkId_studentId_key" ON "HomeworkSubmission"("homeworkId", "studentId");

-- CreateIndex
CREATE INDEX "QuestionBankItem_subjectId_topic_idx" ON "QuestionBankItem"("subjectId", "topic");

-- CreateIndex
CREATE INDEX "QuestionBankItem_status_idx" ON "QuestionBankItem"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CurriculumStage_name_key" ON "CurriculumStage"("name");

-- CreateIndex
CREATE UNIQUE INDEX "CurriculumObjective_code_key" ON "CurriculumObjective"("code");

-- CreateIndex
CREATE INDEX "CurriculumObjective_subjectId_idx" ON "CurriculumObjective"("subjectId");

-- CreateIndex
CREATE INDEX "CurriculumObjective_stageLabel_idx" ON "CurriculumObjective"("stageLabel");

-- CreateIndex
CREATE UNIQUE INDEX "CurriculumSnapshot_termLabel_key" ON "CurriculumSnapshot"("termLabel");

-- CreateIndex
CREATE UNIQUE INDEX "Assessment_code_key" ON "Assessment"("code");

-- CreateIndex
CREATE INDEX "Assessment_campusId_status_idx" ON "Assessment"("campusId", "status");

-- CreateIndex
CREATE INDEX "Assessment_classId_idx" ON "Assessment"("classId");

-- CreateIndex
CREATE INDEX "Assessment_sectionId_idx" ON "Assessment"("sectionId");

-- CreateIndex
CREATE INDEX "Assessment_heldOn_idx" ON "Assessment"("heldOn");

-- CreateIndex
CREATE INDEX "AssessmentMark_studentId_idx" ON "AssessmentMark"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentMark_assessmentId_studentId_key" ON "AssessmentMark"("assessmentId", "studentId");

-- CreateIndex
CREATE INDEX "ReportCardBatch_campusId_stage_idx" ON "ReportCardBatch"("campusId", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "ReportCardBatch_sectionId_term_key" ON "ReportCardBatch"("sectionId", "term");

-- CreateIndex
CREATE INDEX "ReportCardComment_studentId_idx" ON "ReportCardComment"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "ReportCardComment_batchId_studentId_key" ON "ReportCardComment"("batchId", "studentId");

-- CreateIndex
CREATE UNIQUE INDEX "AdmissionLead_code_key" ON "AdmissionLead"("code");

-- CreateIndex
CREATE INDEX "AdmissionLead_campusId_stage_idx" ON "AdmissionLead"("campusId", "stage");

-- CreateIndex
CREATE INDEX "AdmissionLead_counsellorId_idx" ON "AdmissionLead"("counsellorId");

-- CreateIndex
CREATE INDEX "AdmissionLead_createdAt_idx" ON "AdmissionLead"("createdAt");

-- CreateIndex
CREATE INDEX "AdmissionLead_phoneKey_idx" ON "AdmissionLead"("phoneKey");

-- CreateIndex
CREATE INDEX "AdmissionLead_source_createdAt_idx" ON "AdmissionLead"("source", "createdAt");

-- CreateIndex
CREATE INDEX "AdmissionLead_nextActionAt_idx" ON "AdmissionLead"("nextActionAt");

-- CreateIndex
CREATE INDEX "AdmissionStageHistory_leadId_changedAt_idx" ON "AdmissionStageHistory"("leadId", "changedAt");

-- CreateIndex
CREATE INDEX "AdmissionStageHistory_toStage_changedAt_idx" ON "AdmissionStageHistory"("toStage", "changedAt");

-- CreateIndex
CREATE INDEX "AdmissionFollowUp_leadId_status_idx" ON "AdmissionFollowUp"("leadId", "status");

-- CreateIndex
CREATE INDEX "AdmissionFollowUp_type_scheduledAt_idx" ON "AdmissionFollowUp"("type", "scheduledAt");

-- CreateIndex
CREATE INDEX "AdmissionFollowUp_status_scheduledAt_idx" ON "AdmissionFollowUp"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "AdmissionFollowUp_assignedTo_status_idx" ON "AdmissionFollowUp"("assignedTo", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AdmissionApplication_applicationNo_key" ON "AdmissionApplication"("applicationNo");

-- CreateIndex
CREATE INDEX "AdmissionApplication_campusId_status_idx" ON "AdmissionApplication"("campusId", "status");

-- CreateIndex
CREATE INDEX "AdmissionApplication_leadId_idx" ON "AdmissionApplication"("leadId");

-- CreateIndex
CREATE INDEX "AdmissionApplication_createdAt_idx" ON "AdmissionApplication"("createdAt");

-- CreateIndex
CREATE INDEX "AdmissionDocument_applicationId_idx" ON "AdmissionDocument"("applicationId");

-- CreateIndex
CREATE INDEX "AdmissionReferral_referrerGuardianId_idx" ON "AdmissionReferral"("referrerGuardianId");

-- CreateIndex
CREATE INDEX "AdmissionReferral_leadId_idx" ON "AdmissionReferral"("leadId");

-- CreateIndex
CREATE INDEX "AdmissionReferral_campusId_createdAt_idx" ON "AdmissionReferral"("campusId", "createdAt");

-- CreateIndex
CREATE INDEX "AdmissionMarketingSpend_month_source_idx" ON "AdmissionMarketingSpend"("month", "source");

-- CreateIndex
CREATE INDEX "CrmAlumnus_batchYear_idx" ON "CrmAlumnus"("batchYear");

-- CreateIndex
CREATE INDEX "CrmAlumnus_engagementRank_idx" ON "CrmAlumnus"("engagementRank");

-- CreateIndex
CREATE INDEX "CrmAlumnus_phoneKey_idx" ON "CrmAlumnus"("phoneKey");

-- CreateIndex
CREATE INDEX "CrmVendor_status_idx" ON "CrmVendor"("status");

-- CreateIndex
CREATE INDEX "CrmVendor_contractEnd_idx" ON "CrmVendor"("contractEnd");

-- CreateIndex
CREATE INDEX "CrmPartner_status_idx" ON "CrmPartner"("status");

-- CreateIndex
CREATE INDEX "CrmCommunication_leadId_occurredAt_idx" ON "CrmCommunication"("leadId", "occurredAt");

-- CreateIndex
CREATE INDEX "CrmCommunication_occurredAt_idx" ON "CrmCommunication"("occurredAt");

-- CreateIndex
CREATE INDEX "CrmCommunication_channel_occurredAt_idx" ON "CrmCommunication"("channel", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceFeeHead_name_key" ON "FinanceFeeHead"("name");

-- CreateIndex
CREATE INDEX "FinanceFeeStructure_campusId_status_idx" ON "FinanceFeeStructure"("campusId", "status");

-- CreateIndex
CREATE INDEX "FinanceFeeStructure_classId_feeHeadId_term_idx" ON "FinanceFeeStructure"("classId", "feeHeadId", "term");

-- CreateIndex
CREATE INDEX "FinanceCharge_studentId_idx" ON "FinanceCharge"("studentId");

-- CreateIndex
CREATE INDEX "FinanceCharge_campusId_dueDate_idx" ON "FinanceCharge"("campusId", "dueDate");

-- CreateIndex
CREATE INDEX "FinanceCharge_academicYearId_idx" ON "FinanceCharge"("academicYearId");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceCharge_structureId_studentId_key" ON "FinanceCharge"("structureId", "studentId");

-- CreateIndex
CREATE UNIQUE INDEX "FinancePayment_receiptNo_key" ON "FinancePayment"("receiptNo");

-- CreateIndex
CREATE UNIQUE INDEX "FinancePayment_gatewayOrderId_key" ON "FinancePayment"("gatewayOrderId");

-- CreateIndex
CREATE INDEX "FinancePayment_studentId_idx" ON "FinancePayment"("studentId");

-- CreateIndex
CREATE INDEX "FinancePayment_campusId_paidAt_idx" ON "FinancePayment"("campusId", "paidAt");

-- CreateIndex
CREATE INDEX "FinancePayment_status_paidAt_idx" ON "FinancePayment"("status", "paidAt");

-- CreateIndex
CREATE INDEX "FinancePayment_gatewayRef_idx" ON "FinancePayment"("gatewayRef");

-- CreateIndex
CREATE INDEX "FinancePaymentAllocation_paymentId_idx" ON "FinancePaymentAllocation"("paymentId");

-- CreateIndex
CREATE INDEX "FinancePaymentAllocation_chargeId_idx" ON "FinancePaymentAllocation"("chargeId");

-- CreateIndex
CREATE INDEX "FinanceConcession_studentId_idx" ON "FinanceConcession"("studentId");

-- CreateIndex
CREATE INDEX "FinanceConcession_campusId_status_idx" ON "FinanceConcession"("campusId", "status");

-- CreateIndex
CREATE INDEX "FinanceConcession_type_idx" ON "FinanceConcession"("type");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceExpenseCategory_name_key" ON "FinanceExpenseCategory"("name");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceExpense_code_key" ON "FinanceExpense"("code");

-- CreateIndex
CREATE INDEX "FinanceExpense_campusId_status_idx" ON "FinanceExpense"("campusId", "status");

-- CreateIndex
CREATE INDEX "FinanceExpense_category_idx" ON "FinanceExpense"("category");

-- CreateIndex
CREATE INDEX "FinanceExpense_expenseDate_idx" ON "FinanceExpense"("expenseDate");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceReimbursement_code_key" ON "FinanceReimbursement"("code");

-- CreateIndex
CREATE INDEX "FinanceReimbursement_employeeId_status_idx" ON "FinanceReimbursement"("employeeId", "status");

-- CreateIndex
CREATE INDEX "FinanceReimbursement_campusId_status_idx" ON "FinanceReimbursement"("campusId", "status");

-- CreateIndex
CREATE INDEX "FinanceAllowance_allowanceType_idx" ON "FinanceAllowance"("allowanceType");

-- CreateIndex
CREATE INDEX "FinanceAllowance_employeeId_status_idx" ON "FinanceAllowance"("employeeId", "status");

-- CreateIndex
CREATE INDEX "FinanceAllowance_campusId_status_idx" ON "FinanceAllowance"("campusId", "status");

-- CreateIndex
CREATE INDEX "FinanceBudget_campusId_academicYearId_idx" ON "FinanceBudget"("campusId", "academicYearId");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceReconLine_externalId_key" ON "FinanceReconLine"("externalId");

-- CreateIndex
CREATE INDEX "FinanceReconLine_status_idx" ON "FinanceReconLine"("status");

-- CreateIndex
CREATE INDEX "FinanceReconLine_reference_idx" ON "FinanceReconLine"("reference");

-- CreateIndex
CREATE INDEX "FinanceReconLine_statementDate_idx" ON "FinanceReconLine"("statementDate");

-- CreateIndex
CREATE INDEX "FinanceReminder_studentId_idx" ON "FinanceReminder"("studentId");

-- CreateIndex
CREATE INDEX "FinanceReminder_createdAt_idx" ON "FinanceReminder"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "InnovationIdea_projectId_key" ON "InnovationIdea"("projectId");

-- CreateIndex
CREATE INDEX "InnovationIdea_campusId_status_idx" ON "InnovationIdea"("campusId", "status");

-- CreateIndex
CREATE INDEX "InnovationIdea_studentId_idx" ON "InnovationIdea"("studentId");

-- CreateIndex
CREATE INDEX "InnovationIdea_submittedOn_idx" ON "InnovationIdea"("submittedOn");

-- CreateIndex
CREATE UNIQUE INDEX "InnovationProject_code_key" ON "InnovationProject"("code");

-- CreateIndex
CREATE INDEX "InnovationProject_campusId_stage_idx" ON "InnovationProject"("campusId", "stage");

-- CreateIndex
CREATE INDEX "InnovationProject_studentId_idx" ON "InnovationProject"("studentId");

-- CreateIndex
CREATE INDEX "InnovationProject_mentorId_idx" ON "InnovationProject"("mentorId");

-- CreateIndex
CREATE INDEX "InnovationProject_updatedAt_idx" ON "InnovationProject"("updatedAt");

-- CreateIndex
CREATE INDEX "InnovationProjectMember_studentId_idx" ON "InnovationProjectMember"("studentId");

-- CreateIndex
CREATE INDEX "InnovationMilestone_projectId_sequence_idx" ON "InnovationMilestone"("projectId", "sequence");

-- CreateIndex
CREATE INDEX "InnovationMilestone_dueOn_idx" ON "InnovationMilestone"("dueOn");

-- CreateIndex
CREATE INDEX "InnovationEvidence_projectId_createdAt_idx" ON "InnovationEvidence"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "InnovationFeedback_projectId_createdAt_idx" ON "InnovationFeedback"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "InnovationFeedback_authorEmployeeId_createdAt_idx" ON "InnovationFeedback"("authorEmployeeId", "createdAt");

-- CreateIndex
CREATE INDEX "InnovationCompetition_heldOn_idx" ON "InnovationCompetition"("heldOn");

-- CreateIndex
CREATE INDEX "InnovationCompetitionEntry_projectId_idx" ON "InnovationCompetitionEntry"("projectId");

-- CreateIndex
CREATE INDEX "InnovationAchievement_studentId_achievedOn_idx" ON "InnovationAchievement"("studentId", "achievedOn");

-- CreateIndex
CREATE INDEX "InnovationAchievement_campusId_achievedOn_idx" ON "InnovationAchievement"("campusId", "achievedOn");

-- CreateIndex
CREATE INDEX "InnovationAchievement_projectId_idx" ON "InnovationAchievement"("projectId");

-- CreateIndex
CREATE INDEX "InnovationAchievement_type_idx" ON "InnovationAchievement"("type");

-- CreateIndex
CREATE UNIQUE INDEX "OpsAsset_code_key" ON "OpsAsset"("code");

-- CreateIndex
CREATE INDEX "OpsAsset_campusId_status_idx" ON "OpsAsset"("campusId", "status");

-- CreateIndex
CREATE INDEX "OpsAsset_nextServiceOn_idx" ON "OpsAsset"("nextServiceOn");

-- CreateIndex
CREATE INDEX "OpsAsset_assignedTo_idx" ON "OpsAsset"("assignedTo");

-- CreateIndex
CREATE INDEX "OpsAssetService_assetId_servicedOn_idx" ON "OpsAssetService"("assetId", "servicedOn");

-- CreateIndex
CREATE UNIQUE INDEX "OpsFacility_campusId_name_key" ON "OpsFacility"("campusId", "name");

-- CreateIndex
CREATE INDEX "OpsFacilityBooking_facilityId_bookedOn_idx" ON "OpsFacilityBooking"("facilityId", "bookedOn");

-- CreateIndex
CREATE UNIQUE INDEX "OpsMaintenanceRequest_code_key" ON "OpsMaintenanceRequest"("code");

-- CreateIndex
CREATE INDEX "OpsMaintenanceRequest_campusId_status_idx" ON "OpsMaintenanceRequest"("campusId", "status");

-- CreateIndex
CREATE INDEX "OpsMaintenanceRequest_assetId_idx" ON "OpsMaintenanceRequest"("assetId");

-- CreateIndex
CREATE INDEX "OpsMaintenanceRequest_facilityId_idx" ON "OpsMaintenanceRequest"("facilityId");

-- CreateIndex
CREATE INDEX "OpsMaintenanceRequest_raisedById_idx" ON "OpsMaintenanceRequest"("raisedById");

-- CreateIndex
CREATE UNIQUE INDEX "OpsInventoryItem_sku_key" ON "OpsInventoryItem"("sku");

-- CreateIndex
CREATE INDEX "OpsInventoryItem_campusId_category_idx" ON "OpsInventoryItem"("campusId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "OpsInventoryItem_campusId_name_key" ON "OpsInventoryItem"("campusId", "name");

-- CreateIndex
CREATE INDEX "OpsStockMovement_itemId_createdAt_idx" ON "OpsStockMovement"("itemId", "createdAt");

-- CreateIndex
CREATE INDEX "OpsStockMovement_campusId_createdAt_idx" ON "OpsStockMovement"("campusId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OpsPurchaseRequest_code_key" ON "OpsPurchaseRequest"("code");

-- CreateIndex
CREATE INDEX "OpsPurchaseRequest_itemId_idx" ON "OpsPurchaseRequest"("itemId");

-- CreateIndex
CREATE INDEX "OpsPurchaseRequest_status_createdAt_idx" ON "OpsPurchaseRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "OpsDocument_studentId_status_idx" ON "OpsDocument"("studentId", "status");

-- CreateIndex
CREATE INDEX "OpsDocument_collection_idx" ON "OpsDocument"("collection");

-- CreateIndex
CREATE INDEX "OpsDocument_status_campusId_idx" ON "OpsDocument"("status", "campusId");

-- CreateIndex
CREATE INDEX "OpsDocument_employeeId_idx" ON "OpsDocument"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "OpsCertificate_verificationCode_key" ON "OpsCertificate"("verificationCode");

-- CreateIndex
CREATE INDEX "OpsCertificate_studentId_idx" ON "OpsCertificate"("studentId");

-- CreateIndex
CREATE INDEX "OpsCertificate_campusId_status_idx" ON "OpsCertificate"("campusId", "status");

-- CreateIndex
CREATE INDEX "OpsComplianceItem_campusId_status_dueOn_idx" ON "OpsComplianceItem"("campusId", "status", "dueOn");

-- CreateIndex
CREATE INDEX "OpsComplianceItem_ownerId_idx" ON "OpsComplianceItem"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "ParentProfile_parentCode_key" ON "ParentProfile"("parentCode");

-- CreateIndex
CREATE INDEX "CommMessage_guardianId_occurredAt_idx" ON "CommMessage"("guardianId", "occurredAt");

-- CreateIndex
CREATE INDEX "CommMessage_needsReply_occurredAt_idx" ON "CommMessage"("needsReply", "occurredAt");

-- CreateIndex
CREATE INDEX "CommMessage_campusId_occurredAt_idx" ON "CommMessage"("campusId", "occurredAt");

-- CreateIndex
CREATE INDEX "CommMessage_threadId_idx" ON "CommMessage"("threadId");

-- CreateIndex
CREATE INDEX "CommMessage_occurredAt_idx" ON "CommMessage"("occurredAt");

-- CreateIndex
CREATE INDEX "CommThread_guardianId_idx" ON "CommThread"("guardianId");

-- CreateIndex
CREATE INDEX "CommThread_campusId_lastMessageAt_idx" ON "CommThread"("campusId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "CommThread_lastMessageAt_idx" ON "CommThread"("lastMessageAt");

-- CreateIndex
CREATE INDEX "CommThreadMessage_threadId_createdAt_idx" ON "CommThreadMessage"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "CommThreadParticipant_userId_idx" ON "CommThreadParticipant"("userId");

-- CreateIndex
CREATE INDEX "CommThreadRead_userId_idx" ON "CommThreadRead"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CommCircular_reference_key" ON "CommCircular"("reference");

-- CreateIndex
CREATE INDEX "CommCircular_status_idx" ON "CommCircular"("status");

-- CreateIndex
CREATE INDEX "CommCircular_campusId_idx" ON "CommCircular"("campusId");

-- CreateIndex
CREATE INDEX "CommCircular_releasedAt_idx" ON "CommCircular"("releasedAt");

-- CreateIndex
CREATE INDEX "CommCircularRecipient_guardianId_idx" ON "CommCircularRecipient"("guardianId");

-- CreateIndex
CREATE INDEX "CommCircularRecipient_userId_idx" ON "CommCircularRecipient"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CommCircularRecipient_circularId_guardianId_key" ON "CommCircularRecipient"("circularId", "guardianId");

-- CreateIndex
CREATE UNIQUE INDEX "CommCircularRecipient_circularId_userId_key" ON "CommCircularRecipient"("circularId", "userId");

-- CreateIndex
CREATE INDEX "CommEvent_startsOn_idx" ON "CommEvent"("startsOn");

-- CreateIndex
CREATE INDEX "CommEvent_campusId_idx" ON "CommEvent"("campusId");

-- CreateIndex
CREATE INDEX "CommEvent_status_idx" ON "CommEvent"("status");

-- CreateIndex
CREATE INDEX "PtmSession_campusId_sessionDate_idx" ON "PtmSession"("campusId", "sessionDate");

-- CreateIndex
CREATE INDEX "PtmSession_sectionId_idx" ON "PtmSession"("sectionId");

-- CreateIndex
CREATE INDEX "PtmSession_employeeId_idx" ON "PtmSession"("employeeId");

-- CreateIndex
CREATE INDEX "PtmBooking_sessionId_slotNo_idx" ON "PtmBooking"("sessionId", "slotNo");

-- CreateIndex
CREATE INDEX "PtmBooking_studentId_idx" ON "PtmBooking"("studentId");

-- CreateIndex
CREATE INDEX "PtmBooking_guardianId_idx" ON "PtmBooking"("guardianId");

-- CreateIndex
CREATE INDEX "SafetyGateEvent_campusId_day_idx" ON "SafetyGateEvent"("campusId", "day");

-- CreateIndex
CREATE INDEX "SafetyGateEvent_studentId_day_idx" ON "SafetyGateEvent"("studentId", "day");

-- CreateIndex
CREATE INDEX "SafetyGateEvent_day_occurredAt_idx" ON "SafetyGateEvent"("day", "occurredAt");

-- CreateIndex
CREATE INDEX "SafetyPickupAuthorisation_studentId_status_idx" ON "SafetyPickupAuthorisation"("studentId", "status");

-- CreateIndex
CREATE INDEX "SafetyPickupAuthorisation_campusId_status_idx" ON "SafetyPickupAuthorisation"("campusId", "status");

-- CreateIndex
CREATE INDEX "SafetyPickupEvent_campusId_day_idx" ON "SafetyPickupEvent"("campusId", "day");

-- CreateIndex
CREATE INDEX "SafetyPickupEvent_studentId_day_idx" ON "SafetyPickupEvent"("studentId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "SafetyVisitor_badgeNo_key" ON "SafetyVisitor"("badgeNo");

-- CreateIndex
CREATE INDEX "SafetyVisitor_campusId_checkedInAt_idx" ON "SafetyVisitor"("campusId", "checkedInAt");

-- CreateIndex
CREATE INDEX "SafetyVisitor_status_checkedInAt_idx" ON "SafetyVisitor"("status", "checkedInAt");

-- CreateIndex
CREATE UNIQUE INDEX "SafetyIncident_code_key" ON "SafetyIncident"("code");

-- CreateIndex
CREATE INDEX "SafetyIncident_campusId_status_idx" ON "SafetyIncident"("campusId", "status");

-- CreateIndex
CREATE INDEX "SafetyIncident_incidentType_status_idx" ON "SafetyIncident"("incidentType", "status");

-- CreateIndex
CREATE INDEX "SafetyIncident_occurredOn_idx" ON "SafetyIncident"("occurredOn");

-- CreateIndex
CREATE INDEX "SafetyBroadcast_campusId_sentAt_idx" ON "SafetyBroadcast"("campusId", "sentAt");

-- CreateIndex
CREATE INDEX "SafetyInfirmaryVisit_campusId_visitedAt_idx" ON "SafetyInfirmaryVisit"("campusId", "visitedAt");

-- CreateIndex
CREATE INDEX "SafetyInfirmaryVisit_studentId_visitedAt_idx" ON "SafetyInfirmaryVisit"("studentId", "visitedAt");

-- CreateIndex
CREATE INDEX "SafetyCounsellingSession_campusId_sessionOn_idx" ON "SafetyCounsellingSession"("campusId", "sessionOn");

-- CreateIndex
CREATE INDEX "SafetyCounsellingSession_studentId_idx" ON "SafetyCounsellingSession"("studentId");

-- CreateIndex
CREATE INDEX "SafetyCounsellingSession_status_sessionOn_idx" ON "SafetyCounsellingSession"("status", "sessionOn");

-- CreateIndex
CREATE UNIQUE INDEX "TransportVehicle_registrationNo_key" ON "TransportVehicle"("registrationNo");

-- CreateIndex
CREATE UNIQUE INDEX "TransportVehicle_gpsDeviceId_key" ON "TransportVehicle"("gpsDeviceId");

-- CreateIndex
CREATE INDEX "TransportVehicle_campusId_idx" ON "TransportVehicle"("campusId");

-- CreateIndex
CREATE INDEX "TransportRouteProfile_vehicleId_idx" ON "TransportRouteProfile"("vehicleId");

-- CreateIndex
CREATE INDEX "TransportBusPing_routeId_recordedAt_idx" ON "TransportBusPing"("routeId", "recordedAt");

-- CreateIndex
CREATE INDEX "TransportBoardingEvent_routeId_runDate_session_idx" ON "TransportBoardingEvent"("routeId", "runDate", "session");

-- CreateIndex
CREATE INDEX "TransportBoardingEvent_studentId_runDate_idx" ON "TransportBoardingEvent"("studentId", "runDate");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingDevice_deviceCode_key" ON "TrackingDevice"("deviceCode");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingDevice_imei_key" ON "TrackingDevice"("imei");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingDevice_tokenHash_key" ON "TrackingDevice"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingDevice_traccarId_key" ON "TrackingDevice"("traccarId");

-- CreateIndex
CREATE INDEX "TrackingDevice_status_idx" ON "TrackingDevice"("status");

-- CreateIndex
CREATE INDEX "TrackingDevice_campusId_idx" ON "TrackingDevice"("campusId");

-- CreateIndex
CREATE INDEX "TrackingAssignment_studentId_status_idx" ON "TrackingAssignment"("studentId", "status");

-- CreateIndex
CREATE INDEX "TrackingAssignment_deviceId_status_idx" ON "TrackingAssignment"("deviceId", "status");

-- CreateIndex
CREATE INDEX "TrackingAssignment_assignedAt_idx" ON "TrackingAssignment"("assignedAt");

-- CreateIndex
CREATE INDEX "TrackingLocation_studentId_recordedAt_idx" ON "TrackingLocation"("studentId", "recordedAt");

-- CreateIndex
CREATE INDEX "TrackingLocation_assignmentId_idx" ON "TrackingLocation"("assignmentId");

-- CreateIndex
CREATE INDEX "TrackingLocation_deviceId_recordedAt_idx" ON "TrackingLocation"("deviceId", "recordedAt");

-- CreateIndex
CREATE INDEX "TrackingStudentState_recordedAt_idx" ON "TrackingStudentState"("recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkforceShift_name_key" ON "WorkforceShift"("name");

-- CreateIndex
CREATE INDEX "WorkforceRosterEntry_campusId_date_idx" ON "WorkforceRosterEntry"("campusId", "date");

-- CreateIndex
CREATE INDEX "WorkforceRosterEntry_coverEmployeeId_date_idx" ON "WorkforceRosterEntry"("coverEmployeeId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "WorkforceRosterEntry_employeeId_date_key" ON "WorkforceRosterEntry"("employeeId", "date");

-- CreateIndex
CREATE INDEX "WorkforceAttendance_campusId_date_idx" ON "WorkforceAttendance"("campusId", "date");

-- CreateIndex
CREATE INDEX "WorkforceAttendance_date_idx" ON "WorkforceAttendance"("date");

-- CreateIndex
CREATE UNIQUE INDEX "WorkforceAttendance_employeeId_date_key" ON "WorkforceAttendance"("employeeId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "WorkforceLeaveType_code_key" ON "WorkforceLeaveType"("code");

-- CreateIndex
CREATE UNIQUE INDEX "WorkforceLeaveType_name_key" ON "WorkforceLeaveType"("name");

-- CreateIndex
CREATE UNIQUE INDEX "WorkforceLeaveRequest_code_key" ON "WorkforceLeaveRequest"("code");

-- CreateIndex
CREATE INDEX "WorkforceLeaveRequest_employeeId_status_idx" ON "WorkforceLeaveRequest"("employeeId", "status");

-- CreateIndex
CREATE INDEX "WorkforceLeaveRequest_campusId_status_idx" ON "WorkforceLeaveRequest"("campusId", "status");

-- CreateIndex
CREATE INDEX "WorkforceLeaveRequest_fromDate_toDate_idx" ON "WorkforceLeaveRequest"("fromDate", "toDate");

-- CreateIndex
CREATE INDEX "WorkforceOvertime_employeeId_workDate_idx" ON "WorkforceOvertime"("employeeId", "workDate");

-- CreateIndex
CREATE INDEX "WorkforceOvertime_campusId_workDate_idx" ON "WorkforceOvertime"("campusId", "workDate");

-- CreateIndex
CREATE INDEX "WorkforceOvertime_status_idx" ON "WorkforceOvertime"("status");

-- CreateIndex
CREATE INDEX "WorkforceCpdRecord_employeeId_idx" ON "WorkforceCpdRecord"("employeeId");

-- CreateIndex
CREATE INDEX "WorkforceCpdRecord_campusId_status_idx" ON "WorkforceCpdRecord"("campusId", "status");

-- CreateIndex
CREATE INDEX "WorkforceLoan_employeeId_status_idx" ON "WorkforceLoan"("employeeId", "status");

-- CreateIndex
CREATE INDEX "WorkforcePayrollRun_payMonth_idx" ON "WorkforcePayrollRun"("payMonth");

-- CreateIndex
CREATE UNIQUE INDEX "WorkforcePayrollRun_campusId_payMonth_key" ON "WorkforcePayrollRun"("campusId", "payMonth");

-- CreateIndex
CREATE INDEX "WorkforcePayslip_employeeId_payMonth_idx" ON "WorkforcePayslip"("employeeId", "payMonth");

-- CreateIndex
CREATE UNIQUE INDEX "WorkforcePayslip_runId_employeeId_key" ON "WorkforcePayslip"("runId", "employeeId");

-- AddForeignKey
ALTER TABLE "HomeworkSubmission" ADD CONSTRAINT "HomeworkSubmission_homeworkId_fkey" FOREIGN KEY ("homeworkId") REFERENCES "Homework"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentMark" ADD CONSTRAINT "AssessmentMark_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "Assessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportCardComment" ADD CONSTRAINT "ReportCardComment_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ReportCardBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionStageHistory" ADD CONSTRAINT "AdmissionStageHistory_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "AdmissionLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionFollowUp" ADD CONSTRAINT "AdmissionFollowUp_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "AdmissionLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionApplication" ADD CONSTRAINT "AdmissionApplication_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "AdmissionLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionDocument" ADD CONSTRAINT "AdmissionDocument_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "AdmissionApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionReferral" ADD CONSTRAINT "AdmissionReferral_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "AdmissionLead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmCommunication" ADD CONSTRAINT "CrmCommunication_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "AdmissionLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceFeeStructure" ADD CONSTRAINT "FinanceFeeStructure_feeHeadId_fkey" FOREIGN KEY ("feeHeadId") REFERENCES "FinanceFeeHead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceCharge" ADD CONSTRAINT "FinanceCharge_structureId_fkey" FOREIGN KEY ("structureId") REFERENCES "FinanceFeeStructure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceCharge" ADD CONSTRAINT "FinanceCharge_feeHeadId_fkey" FOREIGN KEY ("feeHeadId") REFERENCES "FinanceFeeHead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancePaymentAllocation" ADD CONSTRAINT "FinancePaymentAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "FinancePayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancePaymentAllocation" ADD CONSTRAINT "FinancePaymentAllocation_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "FinanceCharge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceConcession" ADD CONSTRAINT "FinanceConcession_scholarshipId_fkey" FOREIGN KEY ("scholarshipId") REFERENCES "FinanceScholarship"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceReconLine" ADD CONSTRAINT "FinanceReconLine_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "FinancePayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InnovationIdea" ADD CONSTRAINT "InnovationIdea_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "InnovationProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InnovationProjectMember" ADD CONSTRAINT "InnovationProjectMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "InnovationProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InnovationMilestone" ADD CONSTRAINT "InnovationMilestone_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "InnovationProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InnovationEvidence" ADD CONSTRAINT "InnovationEvidence_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "InnovationProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InnovationEvidence" ADD CONSTRAINT "InnovationEvidence_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "InnovationMilestone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InnovationFeedback" ADD CONSTRAINT "InnovationFeedback_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "InnovationProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InnovationCompetitionEntry" ADD CONSTRAINT "InnovationCompetitionEntry_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "InnovationCompetition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InnovationCompetitionEntry" ADD CONSTRAINT "InnovationCompetitionEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "InnovationProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsAsset" ADD CONSTRAINT "OpsAsset_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "OpsFacility"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsAssetService" ADD CONSTRAINT "OpsAssetService_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "OpsAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsFacilityBooking" ADD CONSTRAINT "OpsFacilityBooking_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "OpsFacility"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsMaintenanceRequest" ADD CONSTRAINT "OpsMaintenanceRequest_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "OpsAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsMaintenanceRequest" ADD CONSTRAINT "OpsMaintenanceRequest_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "OpsFacility"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsStockMovement" ADD CONSTRAINT "OpsStockMovement_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "OpsInventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsPurchaseRequest" ADD CONSTRAINT "OpsPurchaseRequest_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "OpsInventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommThreadMessage" ADD CONSTRAINT "CommThreadMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "CommThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommThreadParticipant" ADD CONSTRAINT "CommThreadParticipant_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "CommThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommThreadRead" ADD CONSTRAINT "CommThreadRead_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "CommThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommCircularRecipient" ADD CONSTRAINT "CommCircularRecipient_circularId_fkey" FOREIGN KEY ("circularId") REFERENCES "CommCircular"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PtmBooking" ADD CONSTRAINT "PtmBooking_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "PtmSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SafetyPickupEvent" ADD CONSTRAINT "SafetyPickupEvent_authorisationId_fkey" FOREIGN KEY ("authorisationId") REFERENCES "SafetyPickupAuthorisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SafetyPickupEvent" ADD CONSTRAINT "SafetyPickupEvent_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "SafetyIncident"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingAssignment" ADD CONSTRAINT "TrackingAssignment_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "TrackingDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceRosterEntry" ADD CONSTRAINT "WorkforceRosterEntry_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "WorkforceShift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceLeaveRequest" ADD CONSTRAINT "WorkforceLeaveRequest_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "WorkforceLeaveType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceOvertime" ADD CONSTRAINT "WorkforceOvertime_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "WorkforcePayrollRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforcePayslip" ADD CONSTRAINT "WorkforcePayslip_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkforcePayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
