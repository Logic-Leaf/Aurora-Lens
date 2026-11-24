import { DataApiClient } from './dataApi';
import { explainError } from './explain';
import { SQL_IDENTITY } from './metadata';
import { Connection, connectionFieldErrors } from './validate';

export type StepStatus = 'pending' | 'running' | 'ok' | 'fail' | 'skip';

export interface Step {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
  fix?: string;
}

/**
 * Checks a connection one layer at a time and stops at the first failure, so the user sees
 * exactly which layer is broken (settings, AWS sign-in, Data API/secret/database, read-only mode).
 */
export async function diagnose(conn: Connection, client: DataApiClient | undefined, onUpdate: (steps: Step[]) => void): Promise<boolean> {
  const steps: Step[] = [
    { id: 'settings', label: 'Connection settings are valid', status: 'pending' },
    { id: 'credentials', label: `AWS credentials for profile "${conn.profile}"`, status: 'pending' },
    { id: 'query', label: 'Data API, database secret and database', status: 'pending' },
    { id: 'readonly', label: 'Read-only transactions', status: 'pending' },
    { id: 'catalog', label: 'Schema browsing', status: 'pending' },
  ];
  const emit = () => onUpdate(steps.map((s) => ({ ...s })));
  const run = async (i: number, fn: () => Promise<string>): Promise<boolean> => {
    steps[i].status = 'running';
    emit();
    try {
      steps[i].detail = await fn();
      steps[i].status = 'ok';
      emit();
      return true;
    } catch (err) {
      const why = explainError(err, conn);
      steps[i].status = 'fail';
      steps[i].detail = why.title;
      steps[i].fix = why.fix === (err as Error)?.message ? why.fix : `${why.fix}\n\nAWS said: ${(err as Error)?.message ?? String(err)}`;
      for (let j = i + 1; j < steps.length; j++) {
        steps[j].status = 'skip';
      }
      emit();
      return false;
    }
  };

  const ok =
    (await run(0, async () => {
      const errors = Object.entries(connectionFieldErrors(conn));
      if (errors.length) {
        throw new Error(errors.map(([f, m]) => `${f}: ${m}`).join('; '));
      }
      return 'All fields look correct';
    })) &&
    (await run(1, async () => {
      const creds = await client!.credentials();
      const mins = creds.expiration ? Math.round((creds.expiration.getTime() - Date.now()) / 60000) : undefined;
      return mins !== undefined ? `Signed in · session valid for about ${mins} min` : 'Credentials resolved';
    })) &&
    (await run(2, async () => {
      const r = await client!.catalogObjects<{ db_user: string; database: string; version: string }>(SQL_IDENTITY);
      const who = r[0];
      return who ? `Connected as ${who.db_user} to ${who.database} · ${who.version}` : 'Connected';
    })) &&
    (await run(3, async () => {
      await client!.query('SELECT 1', { readOnly: true, timeoutSeconds: 10 });
      return 'BEGIN · SET TRANSACTION READ ONLY · ROLLBACK all succeeded';
    })) &&
    (await run(4, async () => {
      const schemas = await client!.schemas();
      return `${schemas.length} schema${schemas.length === 1 ? '' : 's'} visible`;
    }));
  return ok;
}
