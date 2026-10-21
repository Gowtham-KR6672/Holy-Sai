-- AlterTable: an employee's own monthly allowances (used instead of the school's rules when customAllowances is on)
ALTER TABLE "Employee" ADD COLUMN     "conveyanceAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "customAllowances" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hraAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "specialAllowanceAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
