import { Type } from 'class-transformer';
import {
  IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ListQuery } from '../../common/paging';
import { APP_STATUSES, COMM_CHANNELS, ENGAGEMENT, FOLLOW_UP_TYPES, SOURCES, STAGES, VENDOR_STATUSES } from './admissions.util';

export const PHONE_RE = /^\+?[0-9 ]{8,16}$/;
const PHONE = { message: 'Enter a valid phone number' };
const EMAIL = { message: 'Enter a valid email' };

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export class LeadQuery extends ListQuery {
  @IsOptional() @IsString() stage?: string;
  @IsOptional() @IsString() source?: string;
  /** An employee id, or "unassigned". */
  @IsOptional() @IsString() counsellorId?: string;
  @IsOptional() @IsString() overdue?: string;
  @IsOptional() @IsString() open?: string;
}

export class CampusQuery {
  @IsOptional() @IsString() campusId?: string;
}

export class ApplicationQuery extends ListQuery {
  /** live | a status */
  @IsOptional() @IsString() status?: string;
  /** complete | incomplete */
  @IsOptional() @IsString() documents?: string;
}

export class VisitQuery extends ListQuery {
  /** week | upcoming | past | all */
  @IsOptional() @IsString() range?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() unhosted?: string;
}

export class ReferralQuery extends ListQuery {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() rewardStatus?: string;
}

export class AlumniQuery extends ListQuery {
  @IsOptional() @IsString() engagement?: string;
  @IsOptional() @IsString() batch?: string;
}

export class VendorQuery extends ListQuery {
  @IsOptional() @IsString() status?: string;
}

export class CommQuery extends ListQuery {
  @IsOptional() @IsString() channel?: string;
}

export class SpendQuery extends CampusQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(2000) @Max(2100) year?: number;
}

// ---------------------------------------------------------------------------
// Leads, stages, follow-ups and visits
// ---------------------------------------------------------------------------

export class CreateLeadDto {
  @IsUUID('all', { message: 'Choose a campus' }) campusId: string;
  @IsString() @MinLength(2, { message: 'Enter the parent’s name' }) @MaxLength(120) parentName: string;
  @IsString() @Matches(PHONE_RE, PHONE) phone: string;
  @IsOptional() @IsEmail({}, EMAIL) @MaxLength(160) email?: string;
  @IsString() @MinLength(2, { message: 'Enter the child’s name' }) @MaxLength(120) studentName: string;
  @IsOptional() @IsDateString({}, { message: 'Enter a valid date' }) studentDob?: string;
  @IsString() @MinLength(1, { message: 'Choose a grade' }) @MaxLength(40) gradeApplied: string;
  @IsOptional() @IsString() @MaxLength(60) curriculum?: string;
  @IsIn([...SOURCES], { message: 'Choose the source' }) source: string;
  @IsOptional() @IsString() @MaxLength(80) campaign?: string;
  @IsOptional() @Type(() => Number) @IsInt({ message: 'Score is 0–100' }) @Min(0, { message: 'Score is 0–100' }) @Max(100, { message: 'Score is 0–100' }) leadScore?: number;
  @IsOptional() @IsUUID('all', { message: 'Choose a counsellor from the list' }) counsellorId?: string | null;
  @IsOptional() @IsBoolean() transportRequired?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class StageDto {
  @IsIn([...STAGES, 'Lost'], { message: 'Choose the new stage' }) stage: string;
  @IsString() @MinLength(3, { message: 'Add a short note — it is kept in the stage history' }) @MaxLength(500) note: string;
  @IsOptional() @IsString() @MaxLength(200) lostReason?: string;
}

export class AssignDto {
  @IsOptional() @IsUUID('all', { message: 'Choose a counsellor from the list' }) counsellorId?: string | null;
}

export class FollowUpDto {
  @IsIn([...FOLLOW_UP_TYPES], { message: 'Choose the follow-up type' }) type: string;
  @IsDateString({}, { message: 'Choose a date and time' }) scheduledAt: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsOptional() @IsUUID('all', { message: 'Choose a counsellor from the list' }) assignedTo?: string | null;
}

export class VisitDto {
  @IsUUID('all', { message: 'Choose a lead' }) enquiryId: string;
  @IsDateString({}, { message: 'Choose a date and time' }) scheduledAt: string;
  @IsOptional() @IsUUID('all', { message: 'Choose a host from the list' }) hostId?: string | null;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class FollowUpPatchDto {
  @IsOptional() @IsIn(['Completed', 'Missed', 'Cancelled']) status?: 'Completed' | 'Missed' | 'Cancelled';
  @IsOptional() @IsString() @MaxLength(300) outcome?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsOptional() @IsUUID('all', { message: 'Choose a counsellor from the list' }) assignedTo?: string | null;
}

export class LeadCommunicationDto {
  @IsIn(['Call', 'WhatsApp', 'Email', 'SMS', 'Note'], { message: 'Choose a channel' }) channel: string;
  @IsString() @MinLength(2, { message: 'Summarise the conversation' }) @MaxLength(200) subject: string;
  @IsOptional() @IsString() @MaxLength(2000) body?: string;
  @IsOptional() @IsIn(['Completed', 'No answer']) status?: string;
}

// ---------------------------------------------------------------------------
// Applications and enrolment
// ---------------------------------------------------------------------------

export class OpenApplicationDto {
  @IsUUID('all', { message: 'Choose a lead' }) enquiryId: string;
}

export class DocumentDto {
  @IsIn(['Pending', 'Submitted', 'Verified'], { message: 'Unknown document status' }) status: string;
}

export class ApplicationStatusDto {
  @IsIn([...APP_STATUSES.filter((s) => s !== 'Enrolled')], { message: 'Choose a valid next step' }) status: string;
  @IsString() @MinLength(3, { message: 'Add a short note — it is kept in the audit trail' }) @MaxLength(500) note: string;
  @IsOptional() @IsDateString({}, { message: 'Choose the assessment date and time' }) assessmentAt?: string;
  @IsOptional() @Type(() => Number) @IsNumber({}, { message: 'Score is 0–100' }) @Min(0, { message: 'Score is 0–100' }) @Max(100, { message: 'Score is 0–100' }) assessmentScore?: number;
  @IsOptional() @IsDateString({}, { message: 'Choose a date from today onwards' }) offerExpiresOn?: string;
}

export class GuardianDto {
  @IsString() @MinLength(2, { message: 'Enter the guardian’s name' }) @MaxLength(120) fullName: string;
  @IsString() @Matches(PHONE_RE, PHONE) phone: string;
  @IsOptional() @IsEmail({}, EMAIL) @MaxLength(160) email?: string;
  @IsOptional() @IsString() @MaxLength(40) relationship?: string;
}

export class TransportDto {
  @IsUUID('all', { message: 'Choose a route or untick transport' }) routeId: string;
  @IsOptional() @IsUUID('all', { message: 'Choose the pickup stop' }) stopId?: string;
}

export class EnrolDto {
  @IsUUID('all', { message: 'Choose a section' }) sectionId: string;
  @IsString() @MinLength(1, { message: 'First name is required' }) @MaxLength(60) firstName: string;
  @IsString() @MinLength(1, { message: 'Last name is required' }) @MaxLength(60) lastName: string;
  @IsDateString({}, { message: 'Date of birth is required' }) dateOfBirth: string;
  @IsIn(['F', 'M', 'O'], { message: 'Select a gender' }) gender: string;
  @IsOptional() @IsDateString({}, { message: 'Enter a valid date' }) admittedOn?: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsString() @MaxLength(60) city?: string;
  @IsOptional() @Matches(/^[0-9]{6}$/, { message: 'PIN code must be 6 digits' }) pincode?: string;
  @ValidateNested() @Type(() => GuardianDto) guardian: GuardianDto;
  @IsOptional() @ValidateNested() @Type(() => TransportDto) transport?: TransportDto;
}

// ---------------------------------------------------------------------------
// Referrals
// ---------------------------------------------------------------------------

export class ReferralLeadDto {
  @IsUUID('all', { message: 'Choose a campus' }) campusId: string;
  @IsString() @MinLength(2, { message: 'Enter the parent’s name' }) @MaxLength(120) parentName: string;
  @IsString() @Matches(PHONE_RE, PHONE) phone: string;
  @IsString() @MinLength(1, { message: 'Choose a grade' }) @MaxLength(40) gradeApplied: string;
}

export class ReferralDto {
  @IsUUID('all', { message: 'Choose the referring parent' }) referrerParentId: string;
  @IsString() @MinLength(2, { message: 'Enter the child’s name' }) @MaxLength(120) referredName: string;
  @IsOptional() @IsBoolean() createLead?: boolean;
  @ValidateIf((o: ReferralDto) => !!o.createLead) @ValidateNested() @Type(() => ReferralLeadDto) lead?: ReferralLeadDto;
}

export class RewardDto {
  @IsIn(['Pending', 'Credited', 'Not eligible'], { message: 'Unknown recognition status' }) rewardStatus: string;
}

// ---------------------------------------------------------------------------
// CRM: alumni, vendors, partners, communications, marketing spend
// ---------------------------------------------------------------------------

export class AlumnusDto {
  @IsString() @MinLength(2, { message: 'Enter a name' }) @MaxLength(120) fullName: string;
  @Type(() => Number) @IsInt({ message: 'Enter a valid batch year' }) @Min(1990, { message: 'Enter a valid batch year' }) @Max(2100, { message: 'Enter a valid batch year' }) batchYear: number;
  @IsOptional() @IsString() @MaxLength(120) university?: string;
  @IsOptional() @IsString() @MaxLength(120) career?: string;
  @IsOptional() @IsEmail({}, EMAIL) @MaxLength(160) email?: string;
  @IsOptional() @IsString() @Matches(PHONE_RE, PHONE) phone?: string;
  @IsOptional() @IsIn([...ENGAGEMENT], { message: 'Choose High, Medium or Low' }) engagement?: string;
  @IsOptional() @IsString() @MaxLength(160) lastEngagement?: string;
  @IsOptional() @IsBoolean() mentoring?: boolean;
}

export class VendorDto {
  @IsString() @MinLength(2, { message: 'Enter the vendor name' }) @MaxLength(120) name: string;
  @IsString() @MinLength(2, { message: 'Enter a category' }) @MaxLength(60) category: string;
  @IsOptional() @IsString() @MaxLength(120) contactPerson?: string;
  @IsOptional() @IsString() @Matches(PHONE_RE, PHONE) phone?: string;
  @IsOptional() @IsEmail({}, EMAIL) @MaxLength(160) email?: string;
  @IsOptional() @IsDateString({}, { message: 'Enter a valid date' }) contractStart?: string;
  @IsOptional() @IsDateString({}, { message: 'Enter a valid date' }) contractEnd?: string;
  @IsOptional() @Type(() => Number) @IsNumber({}, { message: 'Enter a valid amount' }) @Min(0, { message: 'Enter a valid amount' }) contractValue?: number;
  @IsOptional() @IsIn([...VENDOR_STATUSES], { message: 'Choose a status' }) status?: string;
}

export class PartnerDto {
  @IsString() @MinLength(2, { message: 'Enter the partner name' }) @MaxLength(120) name: string;
  @IsString() @MinLength(2, { message: 'Enter the partner type' }) @MaxLength(60) partnerType: string;
  @IsOptional() @Type(() => Number) @IsInt({ message: 'Enter a valid year' }) @Min(1950, { message: 'Enter a valid year' }) @Max(2100, { message: 'Enter a valid year' }) sinceYear?: number;
  @IsOptional() @IsIn(['Active', 'Inactive'], { message: 'Choose a status' }) status?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class CrmCommunicationDto {
  @IsIn([...COMM_CHANNELS], { message: 'Choose a channel' }) channel: string;
  @IsString() @MinLength(2, { message: 'Add a subject' }) @MaxLength(200) subject: string;
  @IsOptional() @IsString() @MaxLength(2000) body?: string;
  @IsOptional() @IsString() @MaxLength(40) status?: string;
  @IsOptional() @IsIn(['Inbound', 'Outbound', 'Internal']) direction?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) recipients?: number;
  @IsOptional() @IsUUID() alumnusId?: string;
  @IsOptional() @IsUUID() vendorId?: string;
  @IsOptional() @IsUUID() partnerId?: string;
  @IsOptional() @IsUUID() guardianId?: string;
  /** Free-text counterpart when the communication is not linked to a record. */
  @IsOptional() @IsString() @MaxLength(160) who?: string;
}

export class SpendDto {
  @IsOptional() @IsUUID('all', { message: 'Choose a campus' }) campusId?: string | null;
  @IsIn([...SOURCES], { message: 'Choose the source' }) source: string;
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'Use the month as YYYY-MM' }) month: string;
  @Type(() => Number) @IsNumber({}, { message: 'Enter a valid amount' }) @Min(0, { message: 'Enter a valid amount' }) amount: number;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}
