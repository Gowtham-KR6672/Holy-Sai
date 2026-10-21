import { tenancy } from './tenancy.service';

/**
 * Runs a scheduled method once per workspace, inside that workspace. Put it below @Cron / @Interval:
 *
 *   @Cron('30 6 * * *')
 *   @ForEachWorkspace('early-warning-daily')
 *   async daily() { … }
 */
export function ForEachWorkspace(job: string): MethodDecorator {
  return (_target, _key, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as (...args: unknown[]) => unknown;
    descriptor.value = function (this: unknown, ...args: unknown[]) {
      return tenancy().forEachWorkspace(job, () => original.apply(this, args));
    };
    return descriptor;
  };
}
