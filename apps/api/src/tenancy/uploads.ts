import path from 'node:path';
import { env } from '../config/env';
import { currentWorkspace } from './context';

/** The local upload folder of the current school: UPLOAD_DIR/<workspace code>. */
export function workspaceUploadDir(): string {
  return path.join(path.resolve(env().uploadDir), currentWorkspace().code);
}
