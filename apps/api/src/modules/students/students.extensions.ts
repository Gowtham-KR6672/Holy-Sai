// Hooks other modules can register so the Student 360 profile shows their data without the students
// module depending on their tables (the intelligence module owns skills, talent, activities and Early
// Warning interventions). Register from your module's onModuleInit:
//
//   StudentsExtensions.registerProfile(async (studentId, viewer) => ({
//     skills: [...], interests: [...], activities: [...], talent: { strengths: [...] },
//     interventions: [...],            // include only when the viewer may see Early Warning (earlywarning.read)
//     timeline: [...],                 // extra growth-timeline entries (interventions, certifications, competitions)
//   }));
//
// Several contributors may register; their arrays are concatenated. A contributor that throws is ignored.
import type { AuthUser } from '../../common/auth-user';

export interface ProfileSkill { name: string; value: number; confidence: string | null; evidence: string[] }
export interface ProfileActivity { name: string; category: string; role: string; since: string; hours: number; status: string }
export interface ProfileIntervention {
  id: string; code: string; signal: string; signalType: string; stage: number; opened: string;
  action: string | null; next: string | null; decision: string | null; closedAt: string | null; owner: string | null;
}
export interface ProfileTimelineItem { date: string; title: string; body: string | null; category: string; tone: string }
export interface ProfileStrength { name: string; score: number; confidence: string | null; evidence: string[] }

export interface ProfileExtras {
  skills?: ProfileSkill[];
  interests?: string[];
  activities?: ProfileActivity[];
  /** Present (even empty) only when the viewer may see Early Warning; the page then shows the Interventions tab. */
  interventions?: ProfileIntervention[];
  talent?: { strengths: ProfileStrength[] };
  timeline?: ProfileTimelineItem[];
}

export type ProfileContributor = (studentId: string, viewer: AuthUser) => Promise<ProfileExtras | null | undefined>;

const contributors: ProfileContributor[] = [];

export const StudentsExtensions = {
  registerProfile(fn: ProfileContributor) {
    contributors.push(fn);
  },

  /** Merged extras from every registered contributor. */
  async profile(studentId: string, viewer: AuthUser): Promise<Required<Omit<ProfileExtras, 'interventions'>> & { interventions?: ProfileIntervention[] }> {
    const out: Required<Omit<ProfileExtras, 'interventions'>> & { interventions?: ProfileIntervention[] } = {
      skills: [], interests: [], activities: [], talent: { strengths: [] }, timeline: [],
    };
    const results = await Promise.all(contributors.map(async (fn) => {
      try {
        return await fn(studentId, viewer);
      } catch {
        return null;
      }
    }));
    for (const r of results) {
      if (!r) continue;
      if (r.skills) out.skills.push(...r.skills);
      if (r.interests) out.interests.push(...r.interests.filter((i) => !out.interests.includes(i)));
      if (r.activities) out.activities.push(...r.activities);
      if (r.talent?.strengths) out.talent.strengths.push(...r.talent.strengths);
      if (r.timeline) out.timeline.push(...r.timeline);
      if (r.interventions) out.interventions = [...(out.interventions ?? []), ...r.interventions];
    }
    // Strongest first: the page reads skills[0] as the strongest and the last talent entry as the development area.
    out.skills.sort((a, b) => b.value - a.value);
    out.talent.strengths.sort((a, b) => b.score - a.score);
    return out;
  },
};
