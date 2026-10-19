import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { ListQuery } from '../../common/paging';
import {
  ACHIEVEMENT_LEVELS, ACHIEVEMENT_TYPES, BEHAVIOUR_TYPES, GENDERS, MOODS, RISK_BANDS, STUDENT_STATUSES, TODAY_STATUSES,
} from './students.util';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MSG = { message: 'Use a YYYY-MM-DD date' };

// ---------------------------------------------------------------------------
// Student register
// ---------------------------------------------------------------------------
export class StudentListQuery extends ListQuery {
  /** Class name, e.g. "Grade 5". */
  @IsOptional() @IsString() grade?: string;
  @IsOptional() @IsIn(RISK_BANDS) risk?: string;
  @IsOptional() @IsString() feeStatus?: string;
  @IsOptional() @IsIn(TODAY_STATUSES) today?: string;
  @IsOptional() @IsString() house?: string;
  @IsOptional() @IsUUID() sectionId?: string;
  @IsOptional() @IsUUID() classId?: string;
  /** active (default) | discontinued | transferred | graduated | inactive (any former student) | all. A search (q) covers every status. */
  @IsOptional() @IsIn([...STUDENT_STATUSES, 'inactive', 'all']) status?: string;
}

export class CampusQuery {
  @IsOptional() @IsString() campusId?: string;
}

/** Checked in the service, so problems are reported against the form's own field names (guardianName, guardianPhone …). */
export class GuardianInput {
  @IsOptional() @IsString() fullName?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() relationship?: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
}

/** Checked in the service (fields routeId / stopId). */
export class TransportInput {
  @IsOptional() @IsString() routeId?: string;
  @IsOptional() @IsString() stopId?: string;
}

/** Fields shared by create and edit (StudentFormModal). */
export class StudentBaseDto {
  @IsString() @MinLength(1, { message: 'First name is required' }) @MaxLength(60) firstName: string;
  @IsString() @MinLength(1, { message: 'Last name is required' }) @MaxLength(60) lastName: string;
  @Matches(DATE, { message: 'Date of birth is required' }) dateOfBirth: string;
  @IsIn(GENDERS, { message: 'Select a gender' }) gender: string;
  @IsOptional() @IsString() @MaxLength(4) bloodGroup?: string;
  @IsString({ message: 'Select a campus' }) campusId: string;
  @IsString({ message: 'Select a class and section' }) sectionId: string;
  @IsOptional() @IsString() @MaxLength(40) house?: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsString() @MaxLength(60) city?: string;
  @IsOptional() @IsString() @MaxLength(6) pincode?: string;
  @IsOptional() @Matches(DATE, DATE_MSG) admittedOn?: string;
  @IsOptional() @IsString() @MaxLength(1000) medicalNotes?: string;
}

export class CreateStudentDto extends StudentBaseDto {
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => GuardianInput) guardians?: GuardianInput[];
  @IsOptional() @ValidateNested() @Type(() => TransportInput) transport?: TransportInput;
  @IsOptional() @IsBoolean() enableTracking?: boolean;
}

export class UpdateStudentDto extends StudentBaseDto {}

export class StatusChangeDto {
  @IsIn(STUDENT_STATUSES, { message: 'Choose active, discontinued, transferred or graduated' }) status: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  /** Defaults to today. */
  @IsOptional() @Matches(DATE, DATE_MSG) effectiveOn?: string;
}

export class LeaveDto {
  @IsOptional() @IsIn(['discontinued', 'transferred', 'graduated']) status?: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @IsOptional() @Matches(DATE, DATE_MSG) effectiveOn?: string;
}

export class ReactivateDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

// ---------------------------------------------------------------------------
// Student 360 records
// ---------------------------------------------------------------------------
export class ProfileBehaviourDto {
  @IsIn(['Positive', 'Note', 'Concern'], { message: 'Choose positive, note or concern' }) recordType: string;
  @IsString() @MinLength(3, { message: 'Write a short note (at least 3 characters)' }) @MaxLength(1000) note: string;
}

export class ObservationDto {
  @IsString() @MinLength(3, { message: 'Write a short observation (at least 3 characters)' }) @MaxLength(2000) observation: string;
}

export class AchievementDto {
  @IsString() @MinLength(3, { message: 'Enter a title (at least 3 characters)' }) @MaxLength(200) title: string;
  @IsIn(ACHIEVEMENT_TYPES, { message: 'Choose the type' }) achievementType: string;
  @IsOptional() @IsIn(ACHIEVEMENT_LEVELS, { message: 'Choose the level' }) level?: string;
  @Matches(DATE, { message: 'Enter the date' }) achievedOn: string;
}

// ---------------------------------------------------------------------------
// Behaviour & Wellbeing page
// ---------------------------------------------------------------------------
export class BehaviourListQuery extends ListQuery {
  @IsOptional() @IsIn(BEHAVIOUR_TYPES) type?: string;
  @IsOptional() @IsUUID() studentId?: string;
}

export class CheckinListQuery extends ListQuery {
  @IsOptional() @IsIn(MOODS) mood?: string;
  @IsOptional() @IsUUID() studentId?: string;
}

export class WellbeingBehaviourDto {
  @IsUUID('all', { message: 'Choose a student' }) studentId: string;
  @IsIn(BEHAVIOUR_TYPES, { message: 'Choose the type' }) recordType: string;
  @IsString() @MinLength(3, { message: 'Write a short note (at least 3 characters)' }) @MaxLength(1000) note: string;
  @IsOptional() @Matches(DATE, DATE_MSG) recordedOn?: string;
}

export class CheckinDto {
  @IsUUID('all', { message: 'Choose a student' }) studentId: string;
  @IsIn(MOODS, { message: 'Choose the mood' }) mood: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional() @IsBoolean() isConfidential?: boolean;
  @IsOptional() @Matches(DATE, DATE_MSG) checkedOn?: string;
}
