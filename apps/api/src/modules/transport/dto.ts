import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength,
} from 'class-validator';
import { ListQuery } from '../../common/paging';
import { DEVICE_STATUSES, DEVICE_TYPES } from './devices.service';
import { RUN_STATUSES, type RunStatus, STUDENT_MODES } from './transport.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
const emptyToNull = ({ value }: { value: unknown }) => (value === '' ? null : value);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export class RoutesQuery {
  @IsOptional() @IsString() campusId?: string;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

export class RouteDto {
  @Transform(upper) @Matches(/^[A-Z]{1,3}\d{1,3}$/, { message: 'Use a code like R12 or V01' }) code: string;
  @Transform(trim) @IsString() @MinLength(2, { message: 'Enter the route name' }) @MaxLength(80) name: string;
  @Transform(trim) @IsString() @MinLength(2, { message: 'Enter the area served' }) @MaxLength(120) area: string;
  @IsUUID('all', { message: 'Choose a campus' }) campusId: string;
  @Transform(emptyToNull) @IsOptional() @IsUUID('all', { message: 'Choose a vehicle' }) vehicleId?: string | null;
  @Transform(emptyToNull) @IsOptional() @IsUUID('all', { message: 'Choose a driver' }) driverId?: string | null;
  @Transform(emptyToNull) @IsOptional() @IsUUID('all', { message: 'Choose an attendant' }) attendantId?: string | null;
}

export class StopDto {
  @Transform(trim) @IsString() @MinLength(2, { message: 'Enter the stop name' }) @MaxLength(120) name: string;
  @Type(() => Number) @IsNumber({}, { message: 'Latitude between -90 and 90' }) @Min(-90, { message: 'Latitude between -90 and 90' }) @Max(90, { message: 'Latitude between -90 and 90' }) latitude: number;
  @Type(() => Number) @IsNumber({}, { message: 'Longitude between -180 and 180' }) @Min(-180, { message: 'Longitude between -180 and 180' }) @Max(180, { message: 'Longitude between -180 and 180' }) longitude: number;
  @Matches(HHMM, { message: 'Choose the pickup time' }) pickupTime: string;
  @Transform(emptyToNull) @IsOptional() @Matches(HHMM, { message: 'Use a time like 15:40' }) dropTime?: string | null;
}

export class StopOrderDto {
  @IsArray() @ArrayMaxSize(200) @IsUUID('all', { each: true }) stopIds: string[];
}

export class AssignStudentDto {
  @IsUUID('all', { message: 'Choose a student' }) studentId: string;
  @IsUUID('all', { message: 'Choose the stop' }) stopId: string;
  @IsOptional() @IsIn(STUDENT_MODES as unknown as string[], { message: 'Choose how the student uses the bus' }) mode: string = 'both';
}

export class RunDto {
  @IsIn(RUN_STATUSES, { message: 'Choose a run status' }) runStatus: RunStatus;
  @IsOptional() @Type(() => Number) @IsInt({ message: 'Enter 0–240 minutes' }) @Min(0, { message: 'Enter 0–240 minutes' }) @Max(240, { message: 'Enter 0–240 minutes' }) delayMinutes?: number;
  @IsOptional() @IsBoolean() notifyParents?: boolean;
  @IsOptional() @IsString() @MaxLength(40) etaText?: string;
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}

export class NotifyDto {
  @Transform(trim) @IsString() @MinLength(5, { message: 'Write a short message (at least 5 characters)' }) @MaxLength(500) message: string;
}

export class BoardingDto {
  @IsUUID('all', { message: 'Choose a student' }) studentId: string;
  @IsUUID('all', { message: 'Choose a route' }) routeId: string;
  @IsIn(['boarded', 'deboarded']) eventType: 'boarded' | 'deboarded';
  @IsOptional() @IsString() @MaxLength(20) method?: string;
  @IsOptional() @IsUUID() stopId?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(-90) @Max(90) latitude?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(-180) @Max(180) longitude?: number;
  @IsOptional() @IsDateString() occurredAt?: string;
}

/** A bus position from the attendant app. */
export class BusLocationDto {
  @Type(() => Number) @IsNumber() @Min(-90) @Max(90) latitude: number;
  @Type(() => Number) @IsNumber() @Min(-180) @Max(180) longitude: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(250) speedKmph?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(360) heading?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) accuracy?: number;
  @IsOptional() @IsDateString() recordedAt?: string;
}

export class VehicleDto {
  @IsUUID('all', { message: 'Choose a campus' }) campusId: string;
  @Transform(trim) @IsString() @MinLength(1, { message: 'Enter the bus number, e.g. Bus 4' }) @MaxLength(40) busNo: string;
  @Transform(upper) @IsString() @MinLength(4, { message: 'Enter the registration number' }) @MaxLength(20) registrationNo: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(120) capacity: number;
  @IsOptional() @IsIn(['active', 'maintenance', 'retired']) status?: string;
  @Transform(emptyToNull) @IsOptional() @IsUUID() gpsDeviceId?: string | null;
}

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

export class TrackingQuery extends ListQuery {
  @IsOptional() @IsString() classId?: string;
  @IsOptional() @IsString() sectionId?: string;
  @IsOptional() @IsIn(['active', 'offline', 'paused', 'disabled']) status?: string;
  @IsOptional() @IsIn(['at_school', 'in_transit', 'at_home', 'on_trip', 'unknown']) locationStatus?: string;
}

export class HistoryQuery {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Use a date like 2026-10-19' }) date?: string;
  @IsOptional() @Matches(HHMM, { message: 'Use a time like 07:30' }) from?: string;
  @IsOptional() @Matches(HHMM, { message: 'Use a time like 16:00' }) to?: string;
}

export class TrackingProfileDto {
  @IsOptional() @IsBoolean() trackingEnabled?: boolean;
  @IsOptional() @IsIn(['active', 'paused', 'disabled']) trackingStatus?: 'active' | 'paused' | 'disabled';
  @IsOptional() @Type(() => Number) @IsNumber() @Min(-90) @Max(90) homeLatitude?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(-180) @Max(180) homeLongitude?: number | null;
  @IsOptional() @IsString() @MaxLength(120) tripLabel?: string | null;
  @IsOptional() @IsDateString() tripUntil?: string | null;
}

export class DevicesQuery extends ListQuery {
  @IsOptional() @IsIn(DEVICE_STATUSES as unknown as string[]) status?: string;
  @IsOptional() @IsIn(DEVICE_TYPES as unknown as string[]) deviceType?: string;
  @IsOptional() @IsIn(['online', 'stale', 'offline', 'never']) gpsStatus?: string;
}

export class LookupQuery {
  @IsOptional() @IsString() @MaxLength(500) code?: string;
}

export class RegisterDeviceDto {
  @IsIn(DEVICE_TYPES as unknown as string[], { message: 'Choose the device type' }) deviceType: string;
  @Transform(upper) @IsOptional() @Matches(/^[A-Z0-9][A-Z0-9-]{2,49}$/, { message: 'Capital letters, digits and hyphens only' }) deviceCode?: string;
  @Transform(trim) @IsOptional() @Matches(/^\d{14,17}$/, { message: 'IMEI is 14–17 digits' }) imei?: string;
  @Transform(trim) @IsOptional() @IsString() @MaxLength(100) serialNumber?: string;
  @Transform(trim) @IsOptional() @IsString() @MaxLength(50) firmwareVersion?: string;
  @IsOptional() @IsUUID('all', { message: 'Choose a campus' }) campusId?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class UpdateDeviceDto {
  @IsOptional() @IsIn(['available', 'maintenance', 'inactive', 'lost', 'assigned']) status?: string;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
  @IsOptional() @IsIn(DEVICE_TYPES as unknown as string[]) deviceType?: string;
  @Transform(emptyToNull) @IsOptional() @Matches(/^\d{14,17}$/, { message: 'IMEI is 14–17 digits' }) imei?: string | null;
  @IsOptional() @IsString() @MaxLength(100) serialNumber?: string | null;
  @IsOptional() @IsString() @MaxLength(50) firmwareVersion?: string | null;
  @Transform(emptyToNull) @IsOptional() @IsUUID() campusId?: string | null;
  @IsOptional() @IsString() @MaxLength(500) notes?: string | null;
}

export class AssignmentsQuery extends ListQuery {
  @IsOptional() @IsIn(['active', 'inactive']) status?: string;
}

export class AssignDeviceDto {
  @IsUUID('all', { message: 'Choose a student' }) studentId: string;
  @IsUUID('all', { message: 'Choose a device' }) deviceId: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsOptional() @IsBoolean() reassign?: boolean;
}

export class UnassignDto {
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}
