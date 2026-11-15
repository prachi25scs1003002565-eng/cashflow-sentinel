import { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';
import { loadMigrationSources } from '../../src/db/migrate';
import {
  MigrationSource,
  SchemaDefinition,
  parseSchemaDefinition,
  verifySchema,
} from '../../src/db/schema-verifier';

class CatalogClient {
  readonly schema: SchemaDefinition;
  private readonly fullSchema: SchemaDefinition;
  private readonly overrides: Record<string, Array<Record<string, unknown>>>;

  constructor(
    sources: MigrationSource[],
    overrides: Record<string, Array<Record<string, unknown>>> = {}
  ) {
    this.schema = parseSchemaDefinition(sources);
    this.fullSchema = parseSchemaDefinition(loadMigrationSources());
    this.overrides = overrides;
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string
  ): Promise<QueryResult<T>> {
    const sql = text.toLowerCase();
    let rows: Array<Record<string, unknown>>;

    if (sql.includes('from pg_class c') && sql.includes('as object_name')) {
      rows = this.relationRows();
    } else if (sql.includes('format_type(a.atttypid')) {
      rows = this.schema.tables.flatMap((table) => table.columns.map((column) => ({
        table_name: table.name,
        column_name: column.name,
        data_type: column.type,
        not_null: column.notNull,
        default_collation: true,
        identity_kind: '',
        generated_kind: '',
        default_value: column.defaultValue,
      })));
    } else if (sql.includes('con.convalidated')) {
      rows = this.schema.tables.flatMap((table) => table.constraints.map((constraint, index) => ({
        table_name: table.name,
        name: constraint.name || `${table.name}_auto_constraint_${index}`,
        constraint_type: constraint.type,
        validated: true,
        deferrable: false,
        initially_deferred: false,
        definition: constraint.definition,
      })));
    } else if (sql.includes('p.prosrc')) {
      rows = this.functionRows();
    } else if (sql.includes('pg_get_triggerdef(t.oid')) {
      rows = this.schema.triggers.map((definition) => ({
        schema_name: 'public',
        function_schema: 'public',
        table_name: definition.table,
        name: definition.name,
        function_name: definition.functionName,
        enabled: 'O',
        is_internal: false,
        constraint_oid: 0,
        deferrable: false,
        initially_deferred: false,
        definition: definition.definition,
      }));
    } else if (sql.includes('pg_get_indexdef(i.indexrelid')) {
      rows = this.indexRows();
    } else if (sql.includes('select nspname as schema_name')) {
      rows = [];
    } else if (sql.includes('from pg_policy p')) {
      rows = [];
    } else if (sql.includes('from pg_type t')) {
      rows = [];
    } else if (sql.includes('select objects.schema_name')) {
      rows = [];
    } else if (sql.includes('pg_available_extension_versions')) {
      rows = this.extensionRows();
    } else {
      throw new Error(`Unexpected catalog query: ${text.slice(0, 100)}`);
    }

    const overrideKey = Object.keys(this.overrides).find((key) => sql.includes(key));
    if (overrideKey) rows = this.overrides[overrideKey];
    return { rows } as QueryResult<T>;
  }

  get migrationCount(): number {
    return this.fullSchema.tables.length;
  }

  relationRows(): Array<Record<string, unknown>> {
    return this.schema.tables.map((table) => ({
      schema_name: 'public',
      object_name: table.name,
      relkind: 'r',
      relpersistence: 'p',
    }));
  }

  indexRows(): Array<Record<string, unknown>> {
    const explicitIndexes = this.schema.indexes.map((definition) => ({
      schema_name: 'public',
      table_name: definition.table,
      name: definition.name,
      definition: definition.definition,
      is_unique: /^CREATE UNIQUE/i.test(definition.definition),
      is_valid: true,
      is_ready: true,
      is_primary: false,
      is_immediate: true,
      is_live: true,
      access_method: 'btree',
      constraint_name: null,
      constraint_type: null,
    }));
    const constraintIndexes = this.schema.tables.flatMap((table) => table.constraints
      .filter((constraint) => constraint.type === 'p' || constraint.type === 'u')
      .map((constraint, index) => ({
        schema_name: 'public',
        table_name: table.name,
        name: constraint.name || `${table.name}_unique_${index}`,
        definition: '',
        is_unique: true,
        is_valid: true,
        is_ready: true,
        is_primary: constraint.type === 'p',
        is_immediate: true,
        is_live: true,
        access_method: 'btree',
        constraint_name: constraint.name || `${table.name}_unique_${index}`,
        constraint_type: constraint.type,
      })));
    return [...explicitIndexes, ...constraintIndexes];
  }

  functionRows(): Array<Record<string, unknown>> {
    return this.schema.functions.map((definition) => ({
      schema_name: 'public',
      name: definition.name,
      identity_arguments: definition.identityArguments,
      result: definition.result,
      language: definition.language,
      body: definition.body,
      volatility: 'v',
      is_strict: false,
      security_definer: false,
      configuration: null,
      parallel_safety: 'u',
      leakproof: false,
      function_kind: 'f',
      returns_set: false,
      cost: 100,
      rows_estimate: 0,
    }));
  }

  extensionRows(): Array<Record<string, unknown>> {
    return [
      { name: 'plpgsql', schema_name: 'pg_catalog', version: '1.0', version_available: true },
      { name: 'pgcrypto', schema_name: 'public', version: '1.3', version_available: true },
    ];
  }
}

function clientWith(
  overrideKey: string,
  overrideRows: Array<Record<string, unknown>>,
  sources = loadMigrationSources()
): PoolClient {
  return new CatalogClient(sources, { [overrideKey]: overrideRows }) as unknown as PoolClient;
}

describe('migration schema verification', () => {
  it('accepts the exact cumulative definitions and the first migration state', async () => {
    const allSources = loadMigrationSources();
    const fullSchema = new CatalogClient(allSources);
    await expect(verifySchema(fullSchema as unknown as PoolClient, parseSchemaDefinition(allSources), true))
      .resolves.toBeUndefined();

    const firstMigration = new CatalogClient(allSources.slice(0, 1));
    await expect(verifySchema(
      firstMigration as unknown as PoolClient,
      parseSchemaDefinition(allSources.slice(0, 1)),
      false
    )).resolves.toBeUndefined();
  });

  it('requires all 36 expected application tables', () => {
    expect(new CatalogClient(loadMigrationSources()).migrationCount).toBe(36);
  });

  it('extracts every expected constraint from the pinned SQL', () => {
    const schema = parseSchemaDefinition(loadMigrationSources());
    const constraints = schema.tables.flatMap((table) => table.constraints);
    expect({
      primaryKeys: constraints.filter((constraint) => constraint.type === 'p').length,
      uniqueConstraints: constraints.filter((constraint) => constraint.type === 'u').length,
      foreignKeys: constraints.filter((constraint) => constraint.type === 'f').length,
      checks: constraints.filter((constraint) => constraint.type === 'c').length,
    }).toEqual({ primaryKeys: 36, uniqueConstraints: 50, foreignKeys: 67, checks: 86 });
  });

  it('rejects a missing expected table', async () => {
    const sources = loadMigrationSources();
    const base = new CatalogClient(sources);
    const rows = base.schema.tables.slice(1).map((table) => ({
      schema_name: 'public',
      object_name: table.name,
      relkind: 'r',
      relpersistence: 'p',
    }));

    await expect(verifySchema(
      clientWith('as object_name', rows),
      parseSchemaDefinition(sources),
      true
    )).rejects.toThrow('Schema verification failed');
  });

  it('rejects unlogged relations', async () => {
    const sources = loadMigrationSources();
    const definition = parseSchemaDefinition(sources);
    const base = new CatalogClient(sources);
    const relations = base.schema.tables.map((table, index) => ({
      schema_name: 'public',
      object_name: table.name,
      relkind: 'r',
      relpersistence: index === 0 ? 'u' : 'p',
    }));

    await expect(verifySchema(
      clientWith('as object_name', relations),
      definition,
      true
    )).rejects.toThrow('Schema verification failed');
  });

  it.each([
    ['table', 'as object_name', { schema_name: 'public', object_name: 'extra_table', relkind: 'r', relpersistence: 'p' }],
    ['index', 'pg_get_indexdef(i.indexrelid', { schema_name: 'public', table_name: 'users', name: 'extra_index', definition: 'CREATE INDEX extra_index ON public.users USING btree (email)', is_unique: false, is_valid: true, is_ready: true, is_primary: false, is_immediate: true, is_live: true, access_method: 'btree', constraint_name: null, constraint_type: null }],
    ['routine', 'p.prosrc', { schema_name: 'public', name: 'extra_routine', identity_arguments: '', result: 'integer', language: 'sql', body: 'SELECT 1', volatility: 'v', is_strict: false, security_definer: false, configuration: null }],
    ['extension', 'pg_available_extension_versions', { name: 'postgis', schema_name: 'public', version: '3.0', version_available: true }],
  ])('rejects an unexpected %s', async (objectType, key, extraRow) => {
    const sources = loadMigrationSources();
    const definition = parseSchemaDefinition(sources);
    const base = new CatalogClient(sources);
    const originalRows = key === 'as object_name'
      ? base.relationRows()
      : key === 'pg_get_indexdef(i.indexrelid'
        ? base.indexRows()
        : key === 'p.prosrc'
          ? base.functionRows()
          : base.extensionRows();

    await expect(verifySchema(
      clientWith(key, [...originalRows, extraRow], sources),
      definition,
      true
    )).rejects.toThrow('Schema verification failed');
  });

  it('rejects a missing expected index', async () => {
    const sources = loadMigrationSources();
    const definition = parseSchemaDefinition(sources);
    const base = new CatalogClient(sources);

    await expect(verifySchema(
      clientWith('pg_get_indexdef(i.indexrelid', base.indexRows().slice(1), sources),
      definition,
      true
    )).rejects.toThrow('Schema verification failed');
  });

  it('fails closed when a required extension version or schema differs', async () => {
    const sources = loadMigrationSources();
    const definition = parseSchemaDefinition(sources);
    const client = new CatalogClient(sources, {
      'pg_available_extension_versions': [
        { name: 'plpgsql', schema_name: 'pg_catalog', version: '1.0', version_available: true },
        { name: 'pgcrypto', schema_name: 'public', version: '1.2', version_available: false },
      ],
    });

    await expect(verifySchema(client as unknown as PoolClient, definition, true))
      .rejects.toThrow('Schema verification failed');
  });
});
