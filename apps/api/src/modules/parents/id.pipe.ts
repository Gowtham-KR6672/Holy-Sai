import { Injectable, PipeTransform } from '@nestjs/common';
import { notFound } from '../../common/errors';
import { UUID } from './parents.util';

/** Record ids are UUIDs; anything else is simply "not found" (instead of a database error). */
@Injectable()
export class IdPipe implements PipeTransform<string, string> {
  transform(value: string) {
    if (!UUID.test(value ?? '')) throw notFound();
    return value;
  }
}
