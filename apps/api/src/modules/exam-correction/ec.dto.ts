import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min,
  MinLength, ValidateNested,
} from 'class-validator';
import { QTYPES } from './ec.util';

export class ExamDto {
  @IsString() @MinLength(1, { message: 'Enter a name' }) @MaxLength(160) name: string;
  @IsString() @MinLength(4, { message: 'Enter the academic year' }) @MaxLength(20) academic_year: string;
  @IsString() @MinLength(1, { message: 'Choose a class' }) @MaxLength(160) class_name: string;
  @IsOptional() @IsString() @MaxLength(40) section?: string;
  @IsString() @MinLength(1, { message: 'Choose a subject' }) @MaxLength(120) subject: string;
  @IsOptional() @IsString() @MaxLength(80) grade_level?: string;
  @IsOptional() @IsString() @MaxLength(4000) instructions?: string;
}

export class TeachersDto {
  @IsArray() @ArrayUnique() @ArrayMaxSize(200) @IsUUID('all', { each: true }) user_ids: string[];
}

export class StudentsQuery {
  @IsOptional() @IsString() @MaxLength(160) class_name?: string;
}

export class QuestionDto {
  @IsString() @Matches(/^\d{1,2}[a-z]?$/i, { message: 'Like 1, 2 or 2a' }) number: string;
  @IsString() @MinLength(1, { message: 'Enter the question' }) @MaxLength(6000) text: string;
  @IsIn(QTYPES) qtype: string;
  @IsNumber() @Min(0.25, { message: 'Between 0.5 and 100' }) @Max(100, { message: 'Between 0.5 and 100' }) max_marks: number;
  @IsIn([0.25, 0.5, 1], { message: 'Marks go in steps of 0.25, 0.5 or 1' }) mark_increment: number;
  @IsOptional() @IsString() @MaxLength(40) numeric_answer?: string | null;
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000) numeric_tolerance?: number;
  @IsOptional() @IsString() @MaxLength(20) unit?: string | null;
}

export class CriterionDto {
  @IsString() @MinLength(1) @MaxLength(6) id: string;
  @IsString() @MinLength(1) @MaxLength(400) name: string;
  @IsNumber() @Min(0) @Max(100) max_marks: number;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
}

export class RubricDto {
  @IsArray() @ArrayMaxSize(12) @ValidateNested({ each: true }) @Type(() => CriterionDto) criteria: CriterionDto[];
  @IsOptional() @IsString() @MaxLength(8000) reference_answer?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(40) @IsString({ each: true }) expected_concepts?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(40) @IsString({ each: true }) alternatives?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(40) @IsString({ each: true }) misconceptions?: string[];
  @IsOptional() @IsString() @MaxLength(2000) partial_credit_rules?: string;
  @IsOptional() @IsString() @MaxLength(1000) required_elements?: string;
  @IsOptional() @IsString() @MaxLength(1000) ignore_criteria?: string;
  @IsOptional() @IsString() @MaxLength(1000) subject_rules?: string;
  @IsOptional() @IsIn(['teacher', 'ai_draft']) source?: 'teacher' | 'ai_draft';
}

export class DraftAllDto {
  @IsOptional() @IsBoolean() only_missing?: boolean;
}

/** Multipart fields (strings) of the question-paper upload. */
export class ImportFieldsDto {
  @IsOptional() @IsString() default_marks?: string;
  @IsOptional() @IsString() draft_rubrics?: string;
}

/** Multipart fields of an answer-sheet upload. */
export class SheetFieldsDto {
  @IsOptional() @IsUUID('all', { message: 'Choose the student' }) student_id?: string;
  @IsOptional() @IsString() auto_process?: string;
}

export class EvaluateDto {
  @IsOptional() @IsBoolean() force?: boolean;
}

export class IdentityDto {
  @IsBoolean() verified: boolean;
  @IsOptional() @IsUUID('all', { message: 'Choose a student' }) student_id?: string;
}

export class PageOrderDto {
  @IsArray() @ArrayUnique() @ArrayMaxSize(200) @IsUUID('all', { each: true }) page_ids: string[];
}

export class RotateDto {
  @IsInt() @IsIn([90, 180, 270, -90]) degrees: number;
}

export class TextDto {
  @IsString() @MaxLength(20000) text: string;
}

export class MarksDto {
  @IsObject() criterion_marks: Record<string, number>;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
  @IsOptional() @IsString() @MaxLength(2000) feedback?: string;
}

export class ReasonDto {
  @IsString() @MinLength(1, { message: 'Enter a reason' }) @MaxLength(500) reason: string;
}

export class PushDto {
  @IsUUID('all', { message: 'Choose an assessment' }) assessmentId: string;
}

export class AiChangesDto {
  @IsOptional() @IsBoolean() claude_enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(400) claude_api_key?: string;
  @IsOptional() @IsString() @MaxLength(80) claude_vision_model?: string;
  @IsOptional() @IsString() @MaxLength(80) claude_eval_model?: string;
  @IsOptional() @IsIn(['low', 'medium', 'high']) claude_effort?: string;
  @IsOptional() @IsInt() @Min(10, { message: 'At least 10 seconds' }) @Max(900) claude_timeout?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(5) max_retries?: number | null;
  @IsOptional() @IsBoolean() claude_refusal_fallback?: boolean;
  @IsOptional() @IsBoolean() external_processing_acknowledged?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(50, { message: 'At most 50%' }) redact_top_percent?: number | null;
}

export class AiSettingsDto {
  @ValidateNested() @Type(() => AiChangesDto) changes: AiChangesDto;
}

export class TestQuery {
  @IsOptional() @IsString() sample?: string;
}
