import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../../common/auth-user';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ok } from '../../common/envelope';
import { badRequest, conflict, fieldError, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';

class CampusDto {
  @Matches(/^[a-z0-9]{2,8}$/, { message: 'Use 2–8 lowercase letters or digits' }) code: string;
  @IsString() @MinLength(2) @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(40) shortName?: string;
  @IsString() @MinLength(2) @MaxLength(80) place: string;
  @IsOptional() @IsString() @MaxLength(160) curriculum?: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1800) @Max(2100) establishedYear?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100000) staffingTarget?: number;
  @IsOptional() @Type(() => Number) @IsNumber() latitude?: number;
  @IsOptional() @Type(() => Number) @IsNumber() longitude?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(50) @Max(5000) radiusM?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class YearDto {
  @IsString() @MinLength(4) @MaxLength(20) label: string;
  @IsDateString() startsOn: string;
  @IsDateString() endsOn: string;
}

class ClassDto {
  @IsUUID() campusId: string;
  @IsString() @MinLength(1) @MaxLength(40) name: string;
  @Type(() => Number) @IsInt() @Min(-3) @Max(14) gradeLevel: number;
  @IsOptional() @IsString() @MaxLength(80) stage?: string;
  /** Section names to create with the class, e.g. ["A","B","C"]. */
  @IsOptional() @IsArray() @ArrayMaxSize(26) @IsString({ each: true }) sections?: string[];
}

class SectionDto {
  @IsUUID() classId: string;
  @IsString() @MinLength(1) @MaxLength(20) name: string;
  @IsOptional() @IsString() @MaxLength(40) room?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) capacity?: number;
  @IsOptional() @IsUUID() classTeacherId?: string;
}

class SubjectDto {
  @Matches(/^[A-Z0-9]{2,8}$/, { message: 'Use 2–8 capital letters or digits, e.g. MAT' }) code: string;
  @IsString() @MinLength(2) @MaxLength(80) name: string;
  @IsOptional() @IsString() @MaxLength(80) stageScope?: string;
  @IsOptional() @IsBoolean() isElective?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class HouseDto {
  @IsString() @MinLength(2) @MaxLength(40) name: string;
  @IsOptional() @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'Use a colour like #E8A93A' }) color?: string;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** School setup for a fresh installation: campuses, academic years, classes and sections, subjects and houses. */
@Controller('setup')
@RequirePermissions('settings.manage')
export class SetupController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async overview() {
    const [campuses, years, classes, subjects, houses, staff, students, routes] = await Promise.all([
      this.prisma.campus.findMany({ orderBy: [{ establishedYear: 'asc' }, { name: 'asc' }], include: { _count: { select: { students: true, classes: true } } } }),
      this.prisma.academicYear.findMany({ orderBy: { startsOn: 'desc' } }),
      this.prisma.schoolClass.findMany({
        orderBy: [{ gradeLevel: 'asc' }, { name: 'asc' }],
        include: { sections: { orderBy: { name: 'asc' }, include: { classTeacher: true, _count: { select: { students: true } } } } },
      }),
      this.prisma.subject.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.house.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.employee.count({ where: { archivedAt: null } }),
      this.prisma.student.count({ where: { status: 'active' } }),
      this.prisma.transportRoute.count({ where: { isActive: true } }),
    ]);
    const sections = classes.reduce((n, c) => n + c.sections.length, 0);
    return {
      checklist: [
        { key: 'campuses', label: 'Campuses', done: campuses.length > 0, count: campuses.length, to: '/admin/setup?tab=campuses' },
        { key: 'years', label: 'Academic year', done: years.some((y) => y.isCurrent), count: years.length, to: '/admin/setup?tab=years' },
        { key: 'classes', label: 'Classes and sections', done: sections > 0, count: sections, to: '/admin/setup?tab=classes' },
        { key: 'subjects', label: 'Subjects', done: subjects.length > 0, count: subjects.length, to: '/admin/setup?tab=subjects' },
        { key: 'houses', label: 'Houses', done: houses.length > 0, count: houses.length, to: '/admin/setup?tab=houses' },
        { key: 'staff', label: 'Staff records', done: staff > 0, count: staff, to: '/workforce' },
        { key: 'routes', label: 'Transport routes', done: routes > 0, count: routes, to: '/routes' },
        { key: 'students', label: 'Students', done: students > 0, count: students, to: '/students' },
      ],
      campuses: campuses.map((c) => ({
        id: c.id, code: c.code, name: c.name, shortName: c.shortName, place: c.place, curriculum: c.curriculum, address: c.address,
        establishedYear: c.establishedYear, staffingTarget: c.staffingTarget, latitude: c.latitude, longitude: c.longitude, radiusM: c.radiusM,
        isActive: c.isActive, students: c._count.students, classes: c._count.classes,
      })),
      years: years.map((y) => ({ id: y.id, label: y.label, startsOn: day(y.startsOn), endsOn: day(y.endsOn), isCurrent: y.isCurrent, status: y.status })),
      classes: classes.map((c) => ({
        id: c.id, campusId: c.campusId, name: c.name, gradeLevel: c.gradeLevel, stage: c.stage,
        sections: c.sections.map((s) => ({ id: s.id, name: s.name, room: s.room, capacity: s.capacity, classTeacherId: s.classTeacherId, classTeacher: s.classTeacher?.fullName ?? null, students: s._count.students })),
      })),
      subjects: subjects.map((s) => ({ id: s.id, code: s.code, name: s.name, stageScope: s.stageScope, isElective: s.isElective, isActive: s.isActive })),
      houses: houses.map((h) => ({ id: h.id, name: h.name, color: h.color })),
    };
  }

  // ---- Campuses ----

  @Post('campuses')
  async createCampus(@Body() dto: CampusDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    if (await this.prisma.campus.findUnique({ where: { code: dto.code } })) throw fieldError('code', 'A campus with this code already exists');
    const c = await this.prisma.campus.create({
      data: {
        code: dto.code, name: dto.name.trim(), shortName: dto.shortName?.trim() || dto.name.trim().split(/\s+/).slice(0, 2).join(' '),
        place: dto.place.trim(), curriculum: dto.curriculum?.trim() ?? '', address: dto.address?.trim() || null,
        establishedYear: dto.establishedYear ?? null, staffingTarget: dto.staffingTarget ?? 0,
        latitude: dto.latitude ?? null, longitude: dto.longitude ?? null, radiusM: dto.radiusM ?? 250,
      },
    });
    await this.audit.record({ user, action: 'create', module: 'group', entityType: 'campus', entityId: c.id, description: `Created campus ${c.name} (${c.code})`, req });
    return ok({ id: c.id }, `Campus ${c.name} created`);
  }

  @Put('campuses/:id')
  async updateCampus(@Param('id') id: string, @Body() dto: CampusDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const existing = await this.prisma.campus.findUnique({ where: { id } });
    if (!existing) throw notFound('Campus');
    if (dto.code !== existing.code && (await this.prisma.campus.findUnique({ where: { code: dto.code } }))) throw fieldError('code', 'A campus with this code already exists');
    await this.prisma.campus.update({
      where: { id },
      data: {
        code: dto.code, name: dto.name.trim(), shortName: dto.shortName?.trim() || existing.shortName, place: dto.place.trim(),
        curriculum: dto.curriculum?.trim() ?? existing.curriculum, address: dto.address?.trim() || null,
        establishedYear: dto.establishedYear ?? null, staffingTarget: dto.staffingTarget ?? existing.staffingTarget,
        latitude: dto.latitude ?? null, longitude: dto.longitude ?? null, radiusM: dto.radiusM ?? existing.radiusM,
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
    await this.audit.record({ user, action: 'update', module: 'group', entityType: 'campus', entityId: id, description: `Updated campus ${dto.name}`, req });
    return ok({ id }, 'Campus updated');
  }

  // ---- Academic years ----

  @Post('academic-years')
  async createYear(@Body() dto: YearDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    if (dto.endsOn <= dto.startsOn) throw fieldError('endsOn', 'The year must end after it starts');
    if (await this.prisma.academicYear.findUnique({ where: { label: dto.label.trim() } })) throw fieldError('label', 'This academic year already exists');
    const first = (await this.prisma.academicYear.count()) === 0;
    const y = await this.prisma.academicYear.create({
      data: { label: dto.label.trim(), startsOn: new Date(dto.startsOn), endsOn: new Date(dto.endsOn), isCurrent: first, status: first ? 'active' : 'planned' },
    });
    await this.audit.record({ user, action: 'create', module: 'settings', entityType: 'academic_year', entityId: y.id, description: `Created academic year ${y.label}`, req });
    return ok({ id: y.id }, `Academic year ${y.label} created${first ? ' and made current' : ''}`);
  }

  @Put('academic-years/:id')
  async updateYear(@Param('id') id: string, @Body() dto: YearDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const y = await this.prisma.academicYear.findUnique({ where: { id } });
    if (!y) throw notFound('Academic year');
    if (y.status === 'archived') throw badRequest('Archived years are read-only');
    if (dto.endsOn <= dto.startsOn) throw fieldError('endsOn', 'The year must end after it starts');
    await this.prisma.academicYear.update({ where: { id }, data: { label: dto.label.trim(), startsOn: new Date(dto.startsOn), endsOn: new Date(dto.endsOn) } });
    await this.audit.record({ user, action: 'update', module: 'settings', entityType: 'academic_year', entityId: id, description: `Updated academic year ${dto.label}`, req });
    return ok({ id }, 'Academic year updated');
  }

  /** Makes a year current. The previous current year is archived and becomes read-only. */
  @Post('academic-years/:id/make-current')
  @HttpCode(200)
  async makeCurrent(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const y = await this.prisma.academicYear.findUnique({ where: { id } });
    if (!y) throw notFound('Academic year');
    if (y.isCurrent) return ok({ id }, `${y.label} is already the current year`);
    await this.prisma.$transaction([
      this.prisma.academicYear.updateMany({ where: { isCurrent: true }, data: { isCurrent: false, status: 'archived' } }),
      this.prisma.academicYear.update({ where: { id }, data: { isCurrent: true, status: 'active' } }),
    ]);
    await this.audit.record({ user, action: 'update', module: 'settings', entityType: 'academic_year', entityId: id, description: `Made ${y.label} the current academic year`, req });
    return ok({ id }, `${y.label} is now the current academic year`);
  }

  // ---- Classes and sections ----

  @Post('classes')
  async createClass(@Body() dto: ClassDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    if (!(await this.prisma.campus.findUnique({ where: { id: dto.campusId } }))) throw fieldError('campusId', 'Choose a campus');
    if (await this.prisma.schoolClass.findUnique({ where: { campusId_name: { campusId: dto.campusId, name: dto.name.trim() } } })) throw fieldError('name', 'This class already exists on the campus');
    const names = [...new Set((dto.sections ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean))];
    const c = await this.prisma.schoolClass.create({
      data: {
        campusId: dto.campusId, name: dto.name.trim(), gradeLevel: dto.gradeLevel, stage: dto.stage?.trim() || null,
        sections: { create: names.map((name) => ({ name, campusId: dto.campusId })) },
      },
    });
    await this.audit.record({ user, action: 'create', module: 'academics', entityType: 'class', entityId: c.id, description: `Created ${c.name}${names.length ? ` with sections ${names.join(', ')}` : ''}`, req });
    return ok({ id: c.id }, `${c.name} created`);
  }

  @Put('classes/:id')
  async updateClass(@Param('id') id: string, @Body() dto: ClassDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const c = await this.prisma.schoolClass.findUnique({ where: { id } });
    if (!c) throw notFound('Class');
    await this.prisma.schoolClass.update({ where: { id }, data: { name: dto.name.trim(), gradeLevel: dto.gradeLevel, stage: dto.stage?.trim() || null } });
    await this.audit.record({ user, action: 'update', module: 'academics', entityType: 'class', entityId: id, description: `Updated class ${dto.name}`, req });
    return ok({ id }, 'Class updated');
  }

  @Delete('classes/:id')
  async deleteClass(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const c = await this.prisma.schoolClass.findUnique({ where: { id }, include: { sections: { include: { _count: { select: { students: true } } } } } });
    if (!c) throw notFound('Class');
    if (c.sections.some((s) => s._count.students > 0)) throw conflict('This class has students. Move them to another section first.');
    await this.prisma.schoolClass.delete({ where: { id } });
    await this.audit.record({ user, action: 'delete', module: 'academics', entityType: 'class', entityId: id, description: `Deleted class ${c.name}`, req });
    return ok(null, `${c.name} deleted`);
  }

  @Post('sections')
  async createSection(@Body() dto: SectionDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const c = await this.prisma.schoolClass.findUnique({ where: { id: dto.classId } });
    if (!c) throw fieldError('classId', 'Choose a class');
    const name = dto.name.trim().toUpperCase();
    if (await this.prisma.section.findUnique({ where: { classId_name: { classId: c.id, name } } })) throw fieldError('name', 'This section already exists');
    const s = await this.prisma.section.create({
      data: { classId: c.id, campusId: c.campusId, name, room: dto.room?.trim() || null, capacity: dto.capacity ?? 40, classTeacherId: dto.classTeacherId ?? null },
    });
    await this.audit.record({ user, action: 'create', module: 'academics', entityType: 'section', entityId: s.id, description: `Created section ${c.name}${name}`, req });
    return ok({ id: s.id }, `Section ${c.name}${name} created`);
  }

  @Delete('sections/:id')
  async deleteSection(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const s = await this.prisma.section.findUnique({ where: { id }, include: { class: true, _count: { select: { students: true } } } });
    if (!s) throw notFound('Section');
    if (s._count.students > 0) throw conflict('This section has students. Move them first.');
    await this.prisma.section.delete({ where: { id } });
    await this.audit.record({ user, action: 'delete', module: 'academics', entityType: 'section', entityId: id, description: `Deleted section ${s.class.name}${s.name}`, req });
    return ok(null, 'Section deleted');
  }

  // ---- Subjects ----

  @Post('subjects')
  async createSubject(@Body() dto: SubjectDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    if (await this.prisma.subject.findUnique({ where: { code: dto.code } })) throw fieldError('code', 'A subject with this code already exists');
    const s = await this.prisma.subject.create({
      data: { code: dto.code, name: dto.name.trim(), stageScope: dto.stageScope?.trim() || 'All', isElective: dto.isElective ?? false },
    });
    await this.audit.record({ user, action: 'create', module: 'academics', entityType: 'subject', entityId: s.id, description: `Created subject ${s.name} (${s.code})`, req });
    return ok({ id: s.id }, `${s.name} created`);
  }

  @Put('subjects/:id')
  async updateSubject(@Param('id') id: string, @Body() dto: SubjectDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const s = await this.prisma.subject.findUnique({ where: { id } });
    if (!s) throw notFound('Subject');
    if (dto.code !== s.code && (await this.prisma.subject.findUnique({ where: { code: dto.code } }))) throw fieldError('code', 'A subject with this code already exists');
    await this.prisma.subject.update({
      where: { id },
      data: { code: dto.code, name: dto.name.trim(), stageScope: dto.stageScope?.trim() || 'All', isElective: dto.isElective ?? s.isElective, ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}) },
    });
    await this.audit.record({ user, action: 'update', module: 'academics', entityType: 'subject', entityId: id, description: `Updated subject ${dto.name}`, req });
    return ok({ id }, 'Subject updated');
  }

  // ---- Houses ----

  @Post('houses')
  async createHouse(@Body() dto: HouseDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const name = dto.name.trim();
    if (await this.prisma.house.findUnique({ where: { name } })) throw fieldError('name', 'This house already exists');
    const h = await this.prisma.house.create({ data: { name, color: dto.color ?? null } });
    await this.audit.record({ user, action: 'create', module: 'students', entityType: 'house', entityId: h.id, description: `Created house ${name}`, req });
    return ok({ id: h.id }, `${name} house created`);
  }

  @Delete('houses/:id')
  async deleteHouse(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const h = await this.prisma.house.findUnique({ where: { id } });
    if (!h) throw notFound('House');
    const used = await this.prisma.student.count({ where: { house: h.name } });
    if (used > 0) throw conflict(`${used} students are in ${h.name}. Move them to another house first.`);
    await this.prisma.house.delete({ where: { id } });
    await this.audit.record({ user, action: 'delete', module: 'students', entityType: 'house', entityId: id, description: `Deleted house ${h.name}`, req });
    return ok(null, `${h.name} removed`);
  }
}
