import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../../common/auth-user';

export interface SearchHit {
  group: string;
  label: string;
  meta: string;
  icon: string;
  route: string;
}

export type SearchProvider = (user: AuthUser, q: string) => Promise<SearchHit[]>;

/** Global search (Ctrl K). Each module registers a provider for its own records. */
@Injectable()
export class SearchService {
  private providers: SearchProvider[] = [];

  register(provider: SearchProvider) {
    this.providers.push(provider);
  }

  async search(user: AuthUser, q: string): Promise<SearchHit[]> {
    const term = q.trim();
    if (term.length < 2) return [];
    const results = await Promise.all(this.providers.map((p) => p(user, term).catch(() => [] as SearchHit[])));
    return results.flat().slice(0, 12);
  }
}
