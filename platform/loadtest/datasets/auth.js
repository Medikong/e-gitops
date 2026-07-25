import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';

// The source material is deterministic test data, not a supplied credential.
// It is never written to a file, Secret, result, or console output.
export function datasetAuthPassword(seed) {
  return createHash('sha256').update(`dropmong-loadtest-auth:${String(seed)}`).digest('hex');
}

export function datasetAuthPasswordHash(seed) {
  return bcrypt.hashSync(datasetAuthPassword(seed), 10);
}
