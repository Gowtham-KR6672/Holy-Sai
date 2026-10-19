import { Injectable, Logger } from '@nestjs/common';
import type { CurriculumStage } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { asDate, loadTerms, round1, schoolToday, termOf } from './academics.util';

/** Cambridge stages the school runs (reference catalog; the screens cannot create stages). */
const STAGES = [
  { name: 'Cambridge Primary', gradeFrom: 1, gradeTo: 5, keywords: ['primary'], sortOrder: 1 },
  { name: 'Cambridge Lower Secondary', gradeFrom: 6, gradeTo: 8, keywords: ['lower secondary', 'checkpoint'], sortOrder: 2 },
  { name: 'Cambridge IGCSE', gradeFrom: 9, gradeTo: 10, keywords: ['igcse'], sortOrder: 3 },
  { name: 'Cambridge AS & A Level', gradeFrom: 11, gradeTo: 12, keywords: ['as & a', 'as and a', 'a level', 'a-level', 'as level'], sortOrder: 4 },
];

@Injectable()
export class CurriculumService {
  private readonly log = new Logger(CurriculumService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Inserts the stage catalog when the table is empty. */
  async seedDefaults() {
    try {
      if ((await this.prisma.curriculumStage.count()) > 0) return;
      await this.prisma.curriculumStage.createMany({ data: STAGES, skipDuplicates: true });
      this.log.log(`Seeded ${STAGES.length} curriculum stages`);
    } catch (err) {
      this.log.warn(`Curriculum stages not seeded: ${(err as Error).message}`);
    }
  }

  stages() {
    return this.prisma.curriculumStage.findMany({ orderBy: [{ sortOrder: 'asc' }, { gradeFrom: 'asc' }] });
  }

  /** The stage a class belongs to: its configured stage name first, else its grade level. */
  stageForClass(stages: CurriculumStage[], cls: { gradeLevel: number; stage: string | null }): CurriculumStage | undefined {
    const label = (cls.stage ?? '').toLowerCase();
    return (label ? stages.find((s) => s.keywords.some((k) => label.includes(k)) || label === s.name.toLowerCase()) : undefined)
      ?? stages.find((s) => cls.gradeLevel >= s.gradeFrom && cls.gradeLevel <= s.gradeTo);
  }

  /** The stage of an objective label such as "Primary 5" or "Stage 7". */
  stageForLabel(stages: CurriculumStage[], label: string): CurriculumStage | undefined {
    const l = label.toLowerCase();
    const byWord = stages.find((s) => s.keywords.some((k) => l.includes(k)));
    if (byWord) return byWord;
    const n = Number(l.match(/\d+/)?.[0]);
    return Number.isFinite(n) ? stages.find((s) => n >= s.gradeFrom && n <= s.gradeTo) : undefined;
  }

  /** Records this term's coverage and mastery for the trend chart (called after objectives change). */
  async snapshot() {
    const terms = await loadTerms(this.prisma);
    const term = termOf(terms, schoolToday());
    if (!term) return;
    const agg = await this.prisma.curriculumObjective.aggregate({ _avg: { coveragePct: true, masteryPct: true }, _count: { _all: true } });
    const data = {
      termStart: asDate(term.start),
      coverage: round1(agg._avg.coveragePct ?? 0),
      mastery: round1(agg._avg.masteryPct ?? 0),
      objectives: agg._count._all,
    };
    await this.prisma.curriculumSnapshot.upsert({ where: { termLabel: term.label }, create: { termLabel: term.label, ...data }, update: data });
  }
}
