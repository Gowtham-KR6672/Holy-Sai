import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { TenancyService } from './tenancy.service';

type Seed = () => Promise<unknown>;

/**
 * Reference catalogues a school needs but cannot create in the UI (leave types, fee heads, curriculum stages…).
 * Modules register an idempotent seed in onModuleInit; seeds run for every workspace at start-up and for a new
 * workspace when it is created.
 */
@Injectable()
export class WorkspaceSeeds implements OnApplicationBootstrap {
  private readonly log = new Logger('WorkspaceSeeds');
  private readonly seeds = new Map<string, Seed>();

  constructor(private readonly tenancy: TenancyService) {}

  register(name: string, seed: Seed) {
    this.seeds.set(name, seed);
  }

  /** Runs every seed for the current workspace; a failing seed is logged and the rest still run. */
  async runAll() {
    for (const [name, seed] of this.seeds) {
      try {
        await seed();
      } catch (err) {
        this.log.warn(`${name} not seeded: ${(err as Error).message.split('\n')[0]}`);
      }
    }
  }

  async onApplicationBootstrap() {
    await this.tenancy.forEachWorkspace('workspace seeds', () => this.runAll());
  }
}
