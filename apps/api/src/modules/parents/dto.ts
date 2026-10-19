import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min,
  MinLength, ValidateIf, ValidateNested,
} from 'class-validator';
import { ListQuery } from '../../common/paging';

const PHONE = /^\+?[0-9 ]{8,16}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const bool = ({ value }: { value: unknown }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value);
/** Empty strings from forms count as "not given". */
const blank = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

// ---------------------------------------------------------------------------
// Directory and parent records
// ---------------------------------------------------------------------------
export class DirectoryQuery extends ListQuery {
  @IsOptional() @IsIn(['high', 'medium', 'low']) engagement?: 'high' | 'medium' | 'low';
  @IsOptional() @IsIn(['booked', 'not_booked']) ptm?: 'booked' | 'not_booked';
  @IsOptional() @IsIn(['yes', 'no']) app?: 'yes' | 'no';
  @IsOptional() @Type(() => Number) @IsInt() gradeLevel?: number;
}

export class ChildLinkDto {
  @IsUUID('all', { message: 'Choose a student' }) studentId: string;
  @IsOptional() @IsString() @MaxLength(40) relationship?: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
}

export class ParentDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @MinLength(2, { message: 'Enter the parent’s full name' }) @MaxLength(120) fullName: string;
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Matches(PHONE, { message: 'Enter a valid phone number, e.g. +91 98407 22110' }) phone: string;
  @Transform(blank) @IsOptional() @Matches(PHONE, { message: 'Enter a valid phone number' }) altPhone?: string;
  @Transform(blank) @IsOptional() @IsEmail({}, { message: 'Enter a valid email address' }) @MaxLength(160) email?: string;
  @Transform(blank) @IsOptional() @IsString() @MaxLength(80) occupation?: string;
  @Transform(blank) @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsIn(['whatsapp', 'sms', 'email', 'push', 'call'], { message: 'Choose a preferred channel' }) preferredChannel?: string;
  @IsOptional() @IsIn(['en', 'ta', 'hi']) language?: string;
  /** Children to link (replaces the current links when given). */
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => ChildLinkDto) children?: ChildLinkDto[];
}

// ---------------------------------------------------------------------------
// Communication
// ---------------------------------------------------------------------------
export class CommQuery extends ListQuery {
  @IsOptional() @IsIn(['WhatsApp', 'SMS', 'Email', 'Call', 'Note', 'In-app']) channel?: string;
  @IsOptional() @IsIn(['inbound', 'outbound', 'internal']) direction?: string;
  @IsOptional() @Transform(bool) @IsBoolean() needsReply?: boolean;
  @IsOptional() @IsUUID() parentId?: string;
  @IsOptional() @IsUUID() studentId?: string;
}

export class SendMessageDto {
  @IsUUID('all', { message: 'Choose a parent' }) parentId: string;
  @Transform(blank) @IsOptional() @IsUUID() studentId?: string;
  @IsIn(['WhatsApp', 'SMS', 'Email', 'In-app'], { message: 'Choose a channel' }) channel: 'WhatsApp' | 'SMS' | 'Email' | 'In-app';
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @MinLength(3, { message: 'Enter a subject (at least 3 characters)' }) @MaxLength(160) subject: string;
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @MinLength(2, { message: 'Write the message' }) @MaxLength(2000) body: string;
  @Transform(blank) @IsOptional() @IsUUID() replyTo?: string;
}

export class LogInteractionDto {
  @IsIn(['Call', 'Note'], { message: 'Choose a call or a note' }) channel: 'Call' | 'Note';
  @Transform(blank) @IsOptional() @IsUUID('all', { message: 'Choose a parent' }) parentId?: string;
  @Transform(blank) @IsOptional() @IsUUID() studentId?: string;
  @Transform(blank) @IsOptional() @IsString() @MaxLength(120) counterpart?: string;
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @MinLength(3, { message: 'Summarise the interaction (at least 3 characters)' }) @MaxLength(160) subject: string;
  @Transform(blank) @IsOptional() @IsString() @MaxLength(2000) body?: string;
  @IsOptional() @IsIn(['Connected', 'No answer', 'Left voicemail']) status?: string;
  @IsOptional() @IsIn(['outbound', 'inbound']) direction?: 'outbound' | 'inbound';
  @IsOptional() @IsBoolean() needsReply?: boolean;
}

export class ThreadQuery extends ListQuery {
  @IsOptional() @IsIn(['Open', 'Closed']) status?: string;
}

export class ThreadReplyDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @MinLength(1, { message: 'Write a reply before sending' }) @MaxLength(2000) body: string;
}

// ---------------------------------------------------------------------------
// Circulars
// ---------------------------------------------------------------------------
export class CircularQuery extends ListQuery {
  @IsOptional() @IsIn(['Draft', 'Under Review', 'Released', 'Withdrawn']) status?: string;
}

export class CircularDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @MinLength(3, { message: 'Enter a title (at least 3 characters)' }) @MaxLength(160) title: string;
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @MinLength(10, { message: 'Write the message (at least 10 characters)' }) @MaxLength(5000) body: string;
  @IsObject({ message: 'Choose an audience' }) audience: Record<string, unknown>;
  @Transform(blank) @IsOptional() @IsUUID('all', { message: 'Choose a campus' }) campusId?: string | null;
  @IsOptional() @IsBoolean() requiresAck?: boolean;
  @IsOptional() @IsArray() @ArrayMinSize(1, { message: 'Choose at least one channel' }) @IsIn(['push', 'whatsapp', 'sms', 'email'], { each: true }) channels?: string[];
}

export class AudienceCountDto {
  @IsObject() audience: Record<string, unknown>;
  @Transform(blank) @IsOptional() @IsUUID() campusId?: string | null;
}

export class AckQuery extends ListQuery {
  @IsOptional() @IsIn(['pending', 'acknowledged']) state?: 'pending' | 'acknowledged';
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
export const EVENT_TYPES = ['School', 'Academic', 'Sports', 'Cultural', 'PTM', 'Holiday'] as const;

export class EventQuery extends ListQuery {
  @IsOptional() @IsIn(['upcoming', 'past', 'all']) when?: 'upcoming' | 'past' | 'all';
  @IsOptional() @IsIn(EVENT_TYPES as unknown as string[]) type?: string;
  @IsOptional() @IsIn(['Published', 'Draft', 'Cancelled']) status?: string;
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
}

export class EventDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @MinLength(3, { message: 'Enter a title (at least 3 characters)' }) @MaxLength(160) title: string;
  @ValidateIf((_, v) => v != null) @IsString() @MaxLength(2000) description?: string | null;
  @IsIn(EVENT_TYPES as unknown as string[], { message: 'Choose an event type' }) eventType: string;
  @Matches(DATE, { message: 'Choose a date' }) startsOn: string;
  @ValidateIf((_, v) => v != null && v !== '') @Matches(DATE, { message: 'Choose a valid end date' }) endsOn?: string | null;
  @ValidateIf((_, v) => v != null && v !== '') @Matches(TIME, { message: 'Enter a time like 18:30' }) startsAt?: string | null;
  @ValidateIf((_, v) => v != null) @IsString() @MaxLength(120) venue?: string | null;
  @IsObject({ message: 'Choose an audience' }) audience: Record<string, unknown>;
  @Transform(blank) @IsOptional() @IsUUID('all', { message: 'Choose a campus' }) campusId?: string | null;
  @IsOptional() @IsIn(['Published', 'Draft']) status?: 'Published' | 'Draft';
}

// ---------------------------------------------------------------------------
// PTM
// ---------------------------------------------------------------------------
export class PtmQuery extends ListQuery {
  @IsOptional() @IsIn(['upcoming', 'past', 'all']) when?: 'upcoming' | 'past' | 'all';
}

export class PtmSessionDto {
  @IsUUID('all', { message: 'Choose a teacher' }) employeeId: string;
  @IsUUID('all', { message: 'Choose a class and section' }) sectionId: string;
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @MinLength(3, { message: 'Enter the subject' }) @MaxLength(160) subjectLabel: string;
  @Matches(DATE, { message: 'Choose a date' }) sessionDate: string;
  @Matches(TIME, { message: 'Enter a start time' }) startsAt: string;
  @Type(() => Number) @IsIn([5, 10, 15, 20, 30], { message: 'Choose a slot length' }) slotMinutes: number;
  @Type(() => Number) @IsInt({ message: 'Between 1 and 60 slots' }) @Min(1, { message: 'Between 1 and 60 slots' }) @Max(60, { message: 'Between 1 and 60 slots' }) totalSlots: number;
  @Transform(blank) @IsOptional() @IsString() @MaxLength(120) venue?: string;
}

export class PtmPatchDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1, { message: 'A session needs at least 1 slot' }) @Max(60, { message: 'A session can have at most 60 slots' }) totalSlots?: number;
  @IsOptional() @Matches(TIME, { message: 'Enter a start time' }) startsAt?: string;
  @ValidateIf((_, v) => v != null) @IsString() @MaxLength(120) venue?: string | null;
}

export class BookingStatusDto {
  @IsIn(['Booked', 'Attended', 'No-show', 'Cancelled'], { message: 'Choose a booking status' }) status: 'Booked' | 'Attended' | 'No-show' | 'Cancelled';
}
