import { PrismaClient } from '@prisma/client';

/**
 * The current school's database, injected everywhere. The provider is a proxy that forwards each call to the
 * workspace selected for the request or job (see tenancy/prisma.proxy.ts); this class is only the type and token.
 */
export abstract class PrismaService extends PrismaClient {}
