import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** Empty strings from forms count as "not given". */
const blank = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() === '' ? undefined : value);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** GET /parents/:pid/children/:cid/location/history */
export class FamilyHistoryQuery {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Use a date like 2026-10-19' }) date?: string;
  @Transform(blank) @IsOptional() @Matches(HHMM, { message: 'Use a time like 07:30' }) from?: string;
  @Transform(blank) @IsOptional() @Matches(HHMM, { message: 'Use a time like 16:00' }) to?: string;
}

/**
 * POST /family/children/:id/fees/pay.
 * The portal sends { amount, method, feeIds }. A client that runs Razorpay Checkout sends { checkout: true, … } to
 * start the order, then { orderId, paymentId, signature } to confirm it.
 */
export class FamilyPayDto {
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Enter a valid amount' }) @IsPositive({ message: 'Enter an amount greater than zero' })
  amount?: number;

  @IsOptional() @IsIn(['UPI', 'Card', 'Net Banking'], { message: 'Choose UPI, Card or Net Banking' })
  method?: 'UPI' | 'Card' | 'Net Banking';

  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID('all', { each: true, message: 'Choose the charges to pay' })
  feeIds?: string[];

  @IsOptional() @IsBoolean()
  checkout?: boolean;

  @IsOptional() @IsString() @MaxLength(80) orderId?: string;
  @IsOptional() @IsString() @MaxLength(80) paymentId?: string;
  @IsOptional() @IsString() @MaxLength(200) signature?: string;
}

/** POST /family/children/:id/pickup — the office verifies the person before the first pickup. */
export class FamilyPickupDto {
  @Transform(trim) @IsString() @MinLength(2, { message: 'Enter the full name' }) @MaxLength(120) personName: string;
  @Transform(trim) @IsString() @MinLength(2, { message: 'Enter the relationship' }) @MaxLength(40) relation: string;
  @Transform(trim) @IsString() @Matches(/^\+?[0-9 ]{8,16}$/, { message: 'Enter a valid phone number' }) phone: string;
  @IsOptional() @IsString() @MaxLength(20) method?: string;
}

/** POST /family/messages — a message to the child's class teacher (or a reply in an existing conversation). */
export class FamilyMessageDto {
  @IsUUID('all', { message: 'Choose the child' }) studentId: string;
  @Transform(trim) @IsString() @MinLength(3, { message: 'Enter a subject (at least 3 characters)' }) @MaxLength(160) subject: string;
  @Transform(trim) @IsString() @MinLength(3, { message: 'Write the message (at least 3 characters)' }) @MaxLength(2000) body: string;
  @Transform(blank) @IsOptional() @IsUUID() threadId?: string;
}

/** GET /family/ptm?studentId= */
export class FamilyPtmQuery {
  @Transform(blank) @IsOptional() @IsUUID('all', { message: 'Choose the child' }) studentId?: string;
}

/** POST /family/ptm/:id/book */
export class FamilyBookDto {
  @IsUUID('all', { message: 'Choose the child' }) studentId: string;
  @Type(() => Number) @IsInt({ message: 'Choose a slot' }) @Min(1) @Max(500) slotNo: number;
}
