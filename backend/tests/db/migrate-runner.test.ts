import { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const verifier = vi.hoisted(() => ({
  verifyFreshDatabase: vi.fn(),
  verifySchema: vi.fn(),
}));

vi.mock('../../src/db/schema-verifier', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/schema-verifier')>();
  return {
    ...actual,
    verifyFreshDatabase: verifier.verifyFreshDatabase,
    verifySchema: verifier.verifySchema,
  };
});

import { loadMigrationSources, runMigrations } from '../../src/db/migrate';
import { SchemaVerificationError } from '../../src/db/schema-verifier';

interface FakeState {
  hasLedger: boolean;
  appVersion: number;
  entries: Array<{ version: string; checksum: string; applied_at: Date }>;
  executions: string[];
  applicationRows: number;
  failureVersion: string | null;
  drift: string | null;
}

class FakeDatabase {
  readonly state: FakeState;
  private lockTail: Promise<void> = Promise.resolve();

  constructor(initial: Partial<FakeState> = {}) {
    this.state = {
      hasLedger: false,
      appVersion: 0,
      entries: [],
      executions: [],
      applicationRows: 0,
      failureVersion: null,
      drift: null,
      ...initial,
    };
  }

  async withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const snapshot = {
      ...this.state,
      entries: [...this.state.entries],
      executions: [...this.state.executions],
    };
    const client = new FakeClient(this);
    try {
      await client.query('BEGIN');
      const result = await callback(client as unknown as PoolClient);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      Object.assign(this.state, snapshot);
      throw error;
    }
  }

  async acquireLock(): Promise<() => void> {
    const previous = this.lockTail;
    let release = (): void => undefined;
    this.lockTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }
}

class FakeClient {
  private releaseLock: (() => void) | null = null;
  private readonly sources = loadMigrationSources();

  constructor(private readonly database: FakeDatabase) {}

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = []
  ): Promise<QueryResult<T>> {
    const sql = text.trim();
    const lower = sql.toLowerCase();
    let rows: Record<string, unknown>[] = [];

    if (lower === 'begin') {
      return { rows } as QueryResult<T>;
    }
    if (lower === 'commit' || lower === 'rollback') {
      this.releaseLock?.();
      this.releaseLock = null;
      return { rows } as QueryResult<T>;
    }
    if (lower.includes('pg_advisory_xact_lock')) {
      this.releaseLock = await this.database.acquireLock();
      return { rows } as QueryResult<T>;
    }
    if (lower.startsWith('set local search_path')) {
      return { rows } as QueryResult<T>;
    }
    if (lower.includes('from pg_class c') && lower.includes('c.relname = $1')) {
      if (this.database.state.hasLedger) {
        rows = [{ schema_name: 'public', relkind: 'r', relpersistence: 'p' }];
      }
      return { rows } as QueryResult<T>;
    }
    if (lower.includes('from pg_attribute a')) {
      rows = [
        { name: 'version', data_type: 'text', not_null: true, default_collation: true, identity_kind: '', generated_kind: '', default_value: null },
        { name: 'checksum', data_type: 'character(64)', not_null: true, default_collation: true, identity_kind: '', generated_kind: '', default_value: null },
        { name: 'applied_at', data_type: 'timestamp with time zone', not_null: true, default_collation: true, identity_kind: '', generated_kind: '', default_value: 'now()' },
      ];
      return { rows } as QueryResult<T>;
    }
    if (lower.includes('from pg_constraint con') && lower.includes('c.relname = $1')) {
      rows = [{
        name: 'schema_migrations_pkey',
        constraint_type: 'p',
        validated: true,
        deferrable: false,
        initially_deferred: false,
        definition: 'PRIMARY KEY (version)',
      }];
      return { rows } as QueryResult<T>;
    }
    if (lower.includes('from pg_index i') && lower.includes('table_rel.relname = $1')) {
      rows = [{
        name: 'schema_migrations_pkey',
        definition: 'CREATE UNIQUE INDEX schema_migrations_pkey ON public.schema_migrations USING btree (version)',
        is_unique: true,
        is_valid: true,
        is_ready: true,
        is_primary: true,
        is_immediate: true,
        is_live: true,
        access_method: 'btree',
      }];
      return { rows } as QueryResult<T>;
    }
    if (lower.includes('from pg_trigger t') && lower.includes('c.relname = $1')) {
      return { rows } as QueryResult<T>;
    }
    if (lower.startsWith('select version, checksum, applied_at')) {
      rows = this.database.state.entries;
      return { rows } as QueryResult<T>;
    }
    if (lower.startsWith('create table public.schema_migrations')) {
      this.database.state.hasLedger = true;
      return { rows } as QueryResult<T>;
    }
    if (lower.startsWith('insert into public.schema_migrations')) {
      this.database.state.entries.push({
        version: String(values[0]),
        checksum: String(values[1]),
        applied_at: new Date(),
      });
      return { rows } as QueryResult<T>;
    }

    const migration = this.sources.find((source) => source.sql === text);
    if (migration) {
      if (this.database.state.failureVersion === migration.version) {
        throw new Error('simulated migration failure');
      }
      this.database.state.executions.push(migration.version);
      this.database.state.appVersion = migration.version.startsWith('001') ? 1 : 2;
      return { rows } as QueryResult<T>;
    }

    throw new Error(`Unexpected fake database query: ${sql.slice(0, 100)}`);
  }
}

let activeDatabase: FakeDatabase;

beforeEach(() => {
  vi.clearAllMocks();
  verifier.verifyFreshDatabase.mockImplementation(async () => {
    if (activeDatabase.state.appVersion !== 0 || activeDatabase.state.drift) {
      throw new SchemaVerificationError('unexpected database state');
    }
  });
  verifier.verifySchema.mockImplementation(async (
    _client: PoolClient,
    _definition: unknown,
    includesVersionTwo: boolean
  ) => {
    const expectedVersion = includesVersionTwo ? 2 : 1;
    if (activeDatabase.state.appVersion !== expectedVersion || activeDatabase.state.drift) {
      throw new SchemaVerificationError('unexpected database state');
    }
  });
});

describe('migration runner state transitions', () => {
  it('migrates a fresh database and records each version in the same transaction', async () => {
    activeDatabase = new FakeDatabase();

    await runMigrations(activeDatabase);

    expect(activeDatabase.state.executions).toEqual([
      '001_initial_schema.sql',
      '002_triggers_and_checks.sql',
    ]);
    expect(activeDatabase.state.entries.map((entry) => entry.version)).toEqual([
      '001_initial_schema.sql',
      '002_triggers_and_checks.sql',
    ]);
  });

  it('baselines an existing schema without re-executing migrations or changing application data', async () => {
    activeDatabase = new FakeDatabase({ appVersion: 2, applicationRows: 7 });

    await runMigrations(activeDatabase);

    expect(activeDatabase.state.executions).toEqual([]);
    expect(activeDatabase.state.entries).toHaveLength(2);
    expect(activeDatabase.state.applicationRows).toBe(7);
  });

  it('leaves a valid existing ledger unchanged', async () => {
    const sources = loadMigrationSources();
    activeDatabase = new FakeDatabase({
      hasLedger: true,
      appVersion: 2,
      entries: sources.map((source) => ({
        version: source.version,
        checksum: source.version.startsWith('001')
          ? '4116e33791e607164d7af823fb8de0835f61db4470e297637f06760e3b0bc96a'
          : '91dd72e26e33363356ce4d2f12ade47946f7aeedfc69504838a140614e45b0bd',
        applied_at: new Date(),
      })),
    });

    await runMigrations(activeDatabase);

    expect(activeDatabase.state.executions).toEqual([]);
    expect(activeDatabase.state.entries).toHaveLength(2);
  });

  it('rolls back the migration state when a migration fails', async () => {
    activeDatabase = new FakeDatabase({ failureVersion: '002_triggers_and_checks.sql' });

    await expect(runMigrations(activeDatabase)).rejects.toThrow('simulated migration failure');

    expect(activeDatabase.state.hasLedger).toBe(false);
    expect(activeDatabase.state.appVersion).toBe(0);
    expect(activeDatabase.state.entries).toEqual([]);
  });

  it.each(['table', 'index', 'routine', 'extension'])(
    'fails closed for unexpected %s drift without recording baseline history',
    async (drift) => {
      activeDatabase = new FakeDatabase({ appVersion: 2, drift });

      await expect(runMigrations(activeDatabase)).rejects.toThrow(SchemaVerificationError);

      expect(activeDatabase.state.entries).toEqual([]);
      expect(activeDatabase.state.executions).toEqual([]);
    }
  );

  it('serializes concurrent runners behind the transaction advisory lock', async () => {
    activeDatabase = new FakeDatabase();

    await Promise.all([
      runMigrations(activeDatabase),
      runMigrations(activeDatabase),
    ]);

    expect(activeDatabase.state.executions).toEqual([
      '001_initial_schema.sql',
      '002_triggers_and_checks.sql',
    ]);
    expect(activeDatabase.state.entries).toHaveLength(2);
  });
});
