import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrationSources } from '../../src/db/migrate';
import {
  normalizeSql,
  parseSchemaDefinition,
  splitSqlStatements,
} from '../../src/db/schema-verifier';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('migration source validation', () => {
  it('accepts the pinned migration checksums and extracts the cumulative schema', () => {
    const sources = loadMigrationSources();
    const schema = parseSchemaDefinition(sources);

    expect(sources.map((source) => source.version)).toEqual([
      '001_initial_schema.sql',
      '002_triggers_and_checks.sql',
    ]);
    expect(schema.extensions).toEqual(['pgcrypto']);
    expect(schema.tables.length).toBeGreaterThan(0);
    expect(schema.functions.map((definition) => definition.name)).toEqual([
      'fn_check_transaction_category_direction',
      'fn_protect_sales_invoice_total',
      'fn_protect_supplier_bill_total',
      'fn_check_receivable_allocation_caps',
      'fn_check_payable_allocation_caps',
    ]);
    expect(schema.triggers).toHaveLength(5);
  });

  it('rejects a migration whose bytes no longer match its pinned checksum', () => {
    const sourceDirectory = path.resolve(__dirname, '../../../database/migrations');
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cashflow-sentinel-migrations-'));
    temporaryDirectories.push(temporaryDirectory);

    for (const version of ['001_initial_schema.sql', '002_triggers_and_checks.sql']) {
      fs.copyFileSync(path.join(sourceDirectory, version), path.join(temporaryDirectory, version));
    }
    fs.appendFileSync(path.join(temporaryDirectory, '002_triggers_and_checks.sql'), '\n-- changed\n');

    expect(() => loadMigrationSources(temporaryDirectory)).toThrow('Migration checksum mismatch');
  });

  it('does not split statements on quoted or dollar-quoted semicolons', () => {
    const sql = `
      SELECT 'literal;value';
      CREATE FUNCTION sample() RETURNS trigger AS $body$
      BEGIN
        RAISE NOTICE 'inside;body';
        RETURN NEW;
      END;
      $body$ LANGUAGE plpgsql;
      SELECT 3;
    `;

    expect(splitSqlStatements(sql)).toHaveLength(3);
  });

  it('normalizes SQL formatting without treating string literal case as equivalent', () => {
    expect(normalizeSql("CHECK (status IN ('ACTIVE', 'PENDING'))"))
      .toBe(normalizeSql(" check(status = any(array['ACTIVE','PENDING'])) "));
    expect(normalizeSql("DEFAULT 'Active'")).not.toBe(normalizeSql("DEFAULT 'active'"));
  });
});
