import { PoolClient } from 'pg';

export interface ColumnDefinition {
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
}

export interface ConstraintDefinition {
  name: string | null;
  definition: string;
  type: 'p' | 'u' | 'f' | 'c';
}

export interface TableDefinition {
  name: string;
  columns: ColumnDefinition[];
  constraints: ConstraintDefinition[];
}

export interface IndexDefinition {
  name: string;
  table: string;
  definition: string;
}

export interface FunctionDefinition {
  name: string;
  identityArguments: string;
  result: string;
  language: string;
  body: string;
}

export interface TriggerDefinition {
  name: string;
  table: string;
  functionName: string;
  definition: string;
}

export interface SchemaDefinition {
  extensions: string[];
  tables: TableDefinition[];
  indexes: IndexDefinition[];
  functions: FunctionDefinition[];
  triggers: TriggerDefinition[];
}

export interface MigrationSource {
  version: string;
  sql: string;
}

type CatalogRow = Record<string, unknown>;

const COLUMN_CONSTRAINTS = /\b(?:NOT\s+NULL|NULL|DEFAULT|PRIMARY\s+KEY|UNIQUE|REFERENCES|CHECK|COLLATE|GENERATED)\b/i;

export class SchemaVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaVerificationError';
  }
}

function assertMatch(value: string, expression: RegExp, message: string): RegExpExecArray {
  const match = expression.exec(value);
  if (!match) {
    throw new Error(message);
  }
  return match;
}

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let index = 0;
  let quote: "'" | '"' | null = null;
  let dollarTag: string | null = null;
  let lineComment = false;
  let blockCommentDepth = 0;
  let parenthesisDepth = 0;

  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];

    if (lineComment) {
      if (character === '\n') lineComment = false;
      index += 1;
      continue;
    }

    if (blockCommentDepth > 0) {
      if (character === '/' && next === '*') {
        blockCommentDepth += 1;
        index += 2;
      } else if (character === '*' && next === '/') {
        blockCommentDepth -= 1;
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }

    if (dollarTag) {
      if (sql.startsWith(dollarTag, index)) {
        index += dollarTag.length;
        dollarTag = null;
      } else {
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (character === quote && next === quote) {
        index += 2;
      } else if (character === quote) {
        quote = null;
        index += 1;
      } else if (character === '\\' && quote === "'") {
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }

    if (character === '-' && next === '-') {
      lineComment = true;
      index += 2;
    } else if (character === '/' && next === '*') {
      blockCommentDepth = 1;
      index += 2;
    } else if (character === "'" || character === '"') {
      quote = character;
      index += 1;
    } else if (character === '$') {
      const tag = /^\$[A-Za-z_][A-Za-z_0-9]*\$|^\$\$/.exec(sql.slice(index));
      if (tag) {
        dollarTag = tag[0];
        index += dollarTag.length;
      } else {
        index += 1;
      }
    } else if (character === '(') {
      parenthesisDepth += 1;
      index += 1;
    } else if (character === ')') {
      parenthesisDepth -= 1;
      if (parenthesisDepth < 0) throw new Error('Unbalanced migration SQL parentheses');
      index += 1;
    } else if (character === ';' && parenthesisDepth === 0) {
      const statement = sql.slice(start, index).trim();
      if (statement) statements.push(statement);
      start = index + 1;
      index += 1;
    } else {
      index += 1;
    }
  }

  if (quote || dollarTag || blockCommentDepth > 0 || parenthesisDepth !== 0) {
    throw new Error('Unterminated token in migration SQL');
  }

  const finalStatement = sql.slice(start).trim();
  if (finalStatement) statements.push(finalStatement);
  return statements;
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const next = value[index + 1];
    if (quote) {
      if (character === quote && next === quote) {
        index += 1;
      } else if (character === quote) {
        quote = null;
      } else if (character === '\\' && quote === "'") {
        index += 1;
      }
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
    } else if (character === ',' && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }

  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function canonicalType(type: string): string {
  const normalized = type.trim().replace(/\s+/g, ' ').toLowerCase();
  const characterType = /^char\((\d+)\)$/.exec(normalized);
  if (characterType) return `character(${characterType[1]})`;
  const aliases: Record<string, string> = {
    char: 'character',
    'char(3)': 'character(3)',
    int: 'integer',
    int4: 'integer',
    int8: 'bigint',
    int2: 'smallint',
    timestamptz: 'timestamp with time zone',
    timestamp: 'timestamp without time zone',
    bool: 'boolean',
    decimal: 'numeric',
  };
  return aliases[normalized] || normalized;
}

function findConstraintStart(value: string): number {
  const match = COLUMN_CONSTRAINTS.exec(value);
  return match ? match.index : value.length;
}

function extractInlineConstraints(
  column: string,
  definition: string
): ConstraintDefinition[] {
  const constraints: ConstraintDefinition[] = [];
  const primaryKey = /\bPRIMARY\s+KEY\b/i.test(definition);
  const unique = /\bUNIQUE\b/i.test(definition);
  const check = /\bCHECK\s*(\([\s\S]*\))\s*$/i.exec(definition);
  const references = /\bREFERENCES\s+([A-Za-z_][A-Za-z_0-9]*)\s*(\([^)]*\))(?:\s+(ON\s+DELETE\s+(?:CASCADE|RESTRICT|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION)))?/i.exec(definition);

  if (primaryKey) {
    constraints.push({ name: null, definition: `PRIMARY KEY (${column})`, type: 'p' });
  }
  if (unique) {
    constraints.push({ name: null, definition: `UNIQUE (${column})`, type: 'u' });
  }
  if (check) {
    constraints.push({ name: null, definition: `CHECK ${check[1]}`, type: 'c' });
  }
  if (references) {
    const deleteAction = references[3] ? ` ${references[3]}` : '';
    constraints.push({
      name: null,
      definition: `FOREIGN KEY (${column}) REFERENCES ${references[1]}${references[2]}${deleteAction}`,
      type: 'f',
    });
  }
  return constraints;
}

function constraintType(definition: string): ConstraintDefinition['type'] {
  if (/^PRIMARY\s+KEY\b/i.test(definition)) return 'p';
  if (/^UNIQUE\b/i.test(definition)) return 'u';
  if (/^FOREIGN\s+KEY\b/i.test(definition)) return 'f';
  if (/^CHECK\b/i.test(definition)) return 'c';
  throw new Error(`Unsupported migration constraint: ${definition.slice(0, 60)}`);
}

function parseTable(statement: string): TableDefinition {
  const match = assertMatch(
    statement,
    /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z_0-9]*)\s*\(([\s\S]*)\)$/i,
    'Unsupported CREATE TABLE statement in migration'
  );
  const name = match[1];
  const columns: ColumnDefinition[] = [];
  const constraints: ConstraintDefinition[] = [];

  for (const part of splitTopLevel(match[2])) {
    const namedConstraint = /^CONSTRAINT\s+([A-Za-z_][A-Za-z_0-9]*)\s+([\s\S]+)$/i.exec(part);
    if (namedConstraint) {
      constraints.push({
        name: namedConstraint[1],
        definition: namedConstraint[2].trim(),
        type: constraintType(namedConstraint[2].trim()),
      });
      continue;
    }

    if (/^(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK)\b/i.test(part)) {
      constraints.push({ name: null, definition: part, type: constraintType(part) });
      continue;
    }

    const columnMatch = assertMatch(
      part,
      /^("?)([A-Za-z_][A-Za-z_0-9]*)\1\s+([\s\S]+)$/,
      `Unsupported column definition in table ${name}`
    );
    const columnName = columnMatch[2];
    const columnDefinition = columnMatch[3].trim();
    const constraintStart = findConstraintStart(columnDefinition);
    const type = canonicalType(columnDefinition.slice(0, constraintStart));
    if (!type) throw new Error(`Missing column type for ${name}.${columnName}`);

    const defaultMatch = /\bDEFAULT\s+('(?:''|[^'])*'|[A-Za-z_][A-Za-z_0-9]*\s*\([^)]*\)|[+-]?\d+(?:\.\d+)?|true|false|null)(?=\s|$)/i.exec(columnDefinition);
    columns.push({
      name: columnName,
      type,
      notNull: /\bNOT\s+NULL\b/i.test(columnDefinition) || /\bPRIMARY\s+KEY\b/i.test(columnDefinition),
      defaultValue: defaultMatch ? defaultMatch[1].trim() : null,
    });
    constraints.push(...extractInlineConstraints(columnName, columnDefinition));
  }

  return { name, columns, constraints };
}

function parseIndex(statement: string): IndexDefinition {
  const match = assertMatch(
    statement,
    /^CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z_0-9]+)\s+ON\s+([A-Za-z_][A-Za-z_0-9]*)\s*\([\s\S]+\)(?:\s+WHERE\s+[\s\S]+)?$/i,
    `Unsupported CREATE INDEX statement in migration: ${statement.slice(0, 100)}`
  );
  return { name: match[2], table: match[3], definition: statement };
}

function parseFunction(statement: string): FunctionDefinition {
  const signature = assertMatch(
    statement,
    /^CREATE\s+OR\s+REPLACE\s+FUNCTION\s+([A-Za-z_][A-Za-z_0-9]*)\s*\(([^)]*)\)\s*RETURNS\s+([A-Za-z_][A-Za-z_0-9]*)\s+AS\s+/i,
    'Unsupported function definition in migration'
  );
  const body = assertMatch(statement, /\$\$([\s\S]*?)\$\$\s*LANGUAGE\s+([A-Za-z_][A-Za-z_0-9]*)\s*$/i, 'Unsupported function body in migration');
  return {
    name: signature[1],
    identityArguments: signature[2].trim(),
    result: signature[3].toLowerCase(),
    language: body[2].toLowerCase(),
    body: body[1],
  };
}

function parseTrigger(statement: string): TriggerDefinition {
  const match = assertMatch(
    statement,
    /^CREATE\s+TRIGGER\s+([A-Za-z_][A-Za-z_0-9]+)[\s\S]*?\bON\s+([A-Za-z_][A-Za-z_0-9]+)[\s\S]*?\bEXECUTE\s+FUNCTION\s+([A-Za-z_][A-Za-z_0-9]*)\s*\(\s*\)\s*$/i,
    'Unsupported CREATE TRIGGER statement in migration'
  );
  return { name: match[1], table: match[2], functionName: match[3], definition: statement };
}

export function parseSchemaDefinition(migrations: MigrationSource[]): SchemaDefinition {
  const schema: SchemaDefinition = {
    extensions: [],
    tables: [],
    indexes: [],
    functions: [],
    triggers: [],
  };

  for (const migration of migrations) {
    for (const rawStatement of splitSqlStatements(migration.sql)) {
      const statement = stripComments(rawStatement).trim();
      if (/^CREATE\s+EXTENSION\b/i.test(statement)) {
        const extension = assertMatch(statement, /^CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+"?([A-Za-z_][A-Za-z_0-9]*)"?$/i, 'Unsupported CREATE EXTENSION statement');
        if (!schema.extensions.includes(extension[1])) schema.extensions.push(extension[1]);
      } else if (/^CREATE\s+TABLE\b/i.test(statement)) {
        schema.tables.push(parseTable(statement));
      } else if (/^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(statement)) {
        schema.indexes.push(parseIndex(statement));
      } else if (/^CREATE\s+OR\s+REPLACE\s+FUNCTION\b/i.test(statement)) {
        schema.functions.push(parseFunction(statement));
      } else if (/^CREATE\s+TRIGGER\b/i.test(statement)) {
        schema.triggers.push(parseTrigger(statement));
      } else if (!/^DROP\s+TRIGGER\b/i.test(statement)) {
        throw new Error(`Unsupported migration statement: ${statement.slice(0, 80)}`);
      }
    }
  }

  return schema;
}

function stripComments(value: string): string {
  return value
    .replace(/--[^\r\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

function stripRedundantComparisonParens(input: string): string {
  let str = input;
  let changed = true;
  while (changed) {
    changed = false;
    let i = 0;
    while (i < str.length) {
      if (str[i] === '(') {
        let depth = 1;
        let j = i + 1;
        let hasTopLevelAndOr = false;
        while (j < str.length && depth > 0) {
          if (str[j] === '(') depth += 1;
          else if (str[j] === ')') depth -= 1;
          else if (depth === 1) {
            const rest = str.slice(j);
            if (/^(?:\s+and\s+|\s+or\s+)/i.test(rest)) {
              hasTopLevelAndOr = true;
            }
          }
          j += 1;
        }
        if (depth === 0) {
          const inner = str.slice(i + 1, j - 1).trim();
          if (!hasTopLevelAndOr && /(?:=|<|>|is null|is not null)/i.test(inner)) {
            str = (str.slice(0, i) + ' ' + inner + ' ' + str.slice(j)).replace(/\s+/g, ' ');
            changed = true;
            break;
          }
        }
      }
      i += 1;
    }
  }
  return str;
}

export function normalizeSql(value: string): string {
  const input = stripComments(value).replace(/;+\s*$/, '');
  let result = '';
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const next = input[index + 1];
    if (quote === "'") {
      result += character;
      if (character === "'" && next === "'") {
        result += next;
        index += 1;
      } else if (character === "'") {
        quote = null;
      }
    } else if (character === '"') {
      quote = quote ? null : '"';
    } else if (character === "'") {
      quote = "'";
      result += character;
    } else {
      result += character.toLowerCase();
    }
  }

  let text = result
    .replace(/\bpublic\./g, '')
    .replace(/\bpg_catalog\./g, '')
    .replace(/\s+using\s+btree\b/g, '')
    .replace(/\s+if\s+not\s+exists\b/g, '')
    .replace(/::(?:text|character varying|character|bpchar|integer|bigint|smallint|numeric|boolean|jsonb|date|timestamp with time zone)\b(?:\[\])?/g, '')
    .replace(/\((\d+(?:\.\d+)?)\)/g, '$1')
    .replace(/\btrim\s*\(\s*both\s+from\s+([^()]+)\)/gi, 'trim($1)')
    .replace(/\b([a-z_][a-z_0-9.]*)\s+in\s*\(([^()]*)\)/g, '$1 = any (array[$2])')
    .replace(/\bwhere\s*\(([^()]+)\)/gi, 'where $1');

  return text
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),.=<>])\s*/g, '$1')
    .trim();
}

function checkConstraintBody(definition: string): string {
  const match = assertMatch(definition, /^CHECK\s*\(([\s\S]*)\)$/i, 'Invalid CHECK constraint definition');
  let body = match[1].trim();
  while (body.startsWith('(') && body.endsWith(')')) {
    let depth = 0;
    let wrapsWholeExpression = true;
    for (let index = 0; index < body.length; index += 1) {
      if (body[index] === '(') depth += 1;
      if (body[index] === ')') depth -= 1;
      if (depth === 0 && index < body.length - 1) {
        wrapsWholeExpression = false;
        break;
      }
    }
    if (!wrapsWholeExpression) break;
    body = body.slice(1, -1).trim();
  }
  return normalizeSql(stripRedundantComparisonParens(body));
}

function constraintDefinitionMatches(expected: ConstraintDefinition, actual: CatalogRow): boolean {
  if (actual.constraint_type !== expected.type ||
      actual.validated !== true ||
      actual.deferrable !== false ||
      actual.initially_deferred !== false) return false;
  if (expected.name && actual.name !== expected.name) return false;

  const actualDefinition = String(actual.definition);
  if (expected.type === 'c') {
    return checkConstraintBody(expected.definition) === checkConstraintBody(actualDefinition);
  }
  return normalizeSql(expected.definition) === normalizeSql(actualDefinition);
}

function sameStrings(expected: string[], actual: string[]): boolean {
  if (expected.length !== actual.length) return false;
  const remaining = [...actual];
  for (const value of expected) {
    const index = remaining.indexOf(value);
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return remaining.length === 0;
}

function unexpected(items: string[]): never {
  throw new SchemaVerificationError(`Schema verification failed: unexpected or missing database objects (${items.join(', ')})`);
}

async function queryRows(client: PoolClient, sql: string, parameters: unknown[] = []): Promise<CatalogRow[]> {
  const result = await client.query(sql, parameters);
  return result.rows as CatalogRow[];
}

async function verifyNoUnexpectedTypes(client: PoolClient): Promise<void> {
  const rows = await queryRows(client, `
    SELECT n.nspname AS schema_name, t.typname AS name
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname <> 'information_schema'
      AND n.nspname <> 'pg_catalog'
      AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
      AND t.typrelid = 0
      AND t.typelem = 0
      AND t.typtype <> 'p'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend d
        JOIN pg_extension e ON e.oid = d.refobjid
        WHERE d.classid = 'pg_type'::regclass
          AND d.objid = t.oid
          AND d.deptype = 'e'
      )
  `);
  if (rows.length) unexpected(rows.map((row) => `${row.schema_name}.${row.name}`));
}

async function verifyNoUnexpectedSchemas(client: PoolClient): Promise<void> {
  const rows = await queryRows(client, `
    SELECT nspname AS schema_name
    FROM pg_namespace
    WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'public')
      AND nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
  `);
  if (rows.length) unexpected(rows.map((row) => String(row.schema_name)));
}

async function verifyNoUnexpectedCatalogObjects(client: PoolClient): Promise<void> {
  const rows = await queryRows(client, `
    SELECT objects.schema_name, objects.object_type, objects.object_name
    FROM (
      SELECT n.nspname AS schema_name, 'operator' AS object_type, o.oprname AS object_name
      FROM pg_operator o JOIN pg_namespace n ON n.oid = o.oprnamespace
      UNION ALL
      SELECT n.nspname, 'collation', c.collname
      FROM pg_collation c JOIN pg_namespace n ON n.oid = c.collnamespace
      UNION ALL
      SELECT n.nspname, 'conversion', c.conname
      FROM pg_conversion c JOIN pg_namespace n ON n.oid = c.connamespace
      UNION ALL
      SELECT n.nspname, 'operator class', c.opcname
      FROM pg_opclass c JOIN pg_namespace n ON n.oid = c.opcnamespace
      UNION ALL
      SELECT n.nspname, 'operator family', f.opfname
      FROM pg_opfamily f JOIN pg_namespace n ON n.oid = f.opfnamespace
      UNION ALL
      SELECT n.nspname, 'text search dictionary', d.dictname
      FROM pg_ts_dict d JOIN pg_namespace n ON n.oid = d.dictnamespace
      UNION ALL
      SELECT n.nspname, 'text search configuration', c.cfgname
      FROM pg_ts_config c JOIN pg_namespace n ON n.oid = c.cfgnamespace
      UNION ALL
      SELECT n.nspname, 'text search parser', p.prsname
      FROM pg_ts_parser p JOIN pg_namespace n ON n.oid = p.prsnamespace
      UNION ALL
      SELECT n.nspname, 'text search template', t.tmplname
      FROM pg_ts_template t JOIN pg_namespace n ON n.oid = t.tmplnamespace
    ) objects
    WHERE objects.schema_name <> 'information_schema'
      AND objects.schema_name <> 'pg_catalog'
      AND objects.schema_name NOT LIKE 'pg\\_%' ESCAPE '\\'
  `);
  if (rows.length) {
    unexpected(rows.map((row) => `${row.schema_name}.${row.object_type}:${row.object_name}`));
  }
}

async function verifyNoUnexpectedPoliciesRulesOrEventTriggers(client: PoolClient): Promise<void> {
  const rows = await queryRows(client, `
    SELECT n.nspname AS schema_name, c.relname AS relation_name,
           'policy' AS object_type, p.polname AS object_name
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname <> 'information_schema'
      AND n.nspname <> 'pg_catalog'
      AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
    UNION ALL
    SELECT n.nspname, c.relname, 'rule', r.rulename
    FROM pg_rewrite r
    JOIN pg_class c ON c.oid = r.ev_class
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE r.rulename <> '_RETURN'
      AND n.nspname <> 'information_schema'
      AND n.nspname <> 'pg_catalog'
      AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
    UNION ALL
    SELECT NULL, NULL, 'event trigger', e.evtname
    FROM pg_event_trigger e
  `);
  if (rows.length) {
    unexpected(rows.map((row) => (
      [row.schema_name, row.relation_name, row.object_type, row.object_name]
        .filter(Boolean)
        .join('.')
    )));
  }
}

export async function verifySchema(
  client: PoolClient,
  definition: SchemaDefinition,
  includeVersionTwoObjects: boolean
): Promise<void> {
  const expectedTables = definition.tables.map((table) => table.name);
  const relationRows = await queryRows(client, `
    SELECT n.nspname AS schema_name, c.relname AS object_name, c.relkind, c.relpersistence
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname <> 'information_schema'
      AND n.nspname <> 'pg_catalog'
      AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S', 'c')
      AND NOT (n.nspname = 'public' AND c.relname = 'schema_migrations')
  `);
  const relationNames = relationRows.map((row) => `${row.schema_name}.${row.object_name}`);
  const expectedRelationNames = expectedTables.map((name) => `public.${name}`);
  if (!sameStrings(expectedRelationNames, relationNames)) unexpected([...relationNames, ...expectedRelationNames]);
  if (relationRows.some((row) => row.schema_name !== 'public' || row.relkind !== 'r' || row.relpersistence !== 'p')) {
    unexpected(relationNames);
  }
  await verifyNoUnexpectedSchemas(client);
  await verifyNoUnexpectedTypes(client);
  await verifyNoUnexpectedCatalogObjects(client);
  await verifyNoUnexpectedPoliciesRulesOrEventTriggers(client);

  const columnRows = await queryRows(client, `
    SELECT c.relname AS table_name, a.attname AS column_name,
           format_type(a.atttypid, a.atttypmod) AS data_type,
           a.attnotnull AS not_null,
           a.attcollation = t.typcollation AS default_collation,
           a.attidentity AS identity_kind,
           a.attgenerated AS generated_kind,
           pg_get_expr(d.adbin, d.adrelid) AS default_value
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_type t ON t.oid = a.atttypid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum
  `, [expectedTables]);

  for (const table of definition.tables) {
    const actualColumns = columnRows.filter((row) => row.table_name === table.name);
    if (actualColumns.length !== table.columns.length) unexpected([`columns:${table.name}`]);
    for (const expected of table.columns) {
      const actual = actualColumns.find((row) => row.column_name === expected.name);
      if (!actual ||
          canonicalType(String(actual.data_type)) !== expected.type ||
          actual.not_null !== expected.notNull ||
          actual.default_collation !== true ||
          actual.identity_kind !== '' ||
          actual.generated_kind !== '' ||
          (expected.defaultValue === null
            ? actual.default_value !== null
            : normalizeSql(String(actual.default_value)) !== normalizeSql(expected.defaultValue))) {
        unexpected([`column:${table.name}.${expected.name}`]);
      }
    }
  }

  const expectedConstraints = definition.tables.flatMap((table) => (
    table.constraints.map((constraint) => ({ table: table.name, constraint }))
  ));
  const constraintRows = await queryRows(client, `
    SELECT c.relname AS table_name, con.conname AS name, con.contype AS constraint_type,
           con.convalidated AS validated, con.condeferrable AS deferrable,
           con.condeferred AS initially_deferred,
           pg_get_constraintdef(con.oid, false) AS definition
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) AND con.contype <> 'n'
    ORDER BY c.relname, con.conname
  `, [expectedTables]);
  if (constraintRows.length !== expectedConstraints.length) unexpected(['constraints']);
  const unmatchedConstraints = [...constraintRows];
  for (const expected of expectedConstraints) {
    const index = unmatchedConstraints.findIndex((actual) => (
      actual.table_name === expected.table &&
      constraintDefinitionMatches(expected.constraint, actual)
    ));
    if (index < 0) unexpected([`constraint:${expected.table}.${expected.constraint.name || expected.constraint.type}`]);
    unmatchedConstraints.splice(index, 1);
  }

  const functions = includeVersionTwoObjects ? definition.functions : [];
  const expectedFunctionKeys = functions.map((item) => `${item.name}(${item.identityArguments})`);
  const functionRows = await queryRows(client, `
    SELECT n.nspname AS schema_name, p.proname AS name,
           pg_get_function_identity_arguments(p.oid) AS identity_arguments,
           pg_get_function_result(p.oid) AS result, l.lanname AS language,
           p.prosrc AS body, p.provolatile AS volatility,
           p.proisstrict AS is_strict, p.prosecdef AS security_definer,
           p.proconfig AS configuration, p.proparallel AS parallel_safety,
           p.proleakproof AS leakproof, p.prokind AS function_kind,
           p.proretset AS returns_set, p.procost AS cost, p.prorows AS rows_estimate
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    WHERE n.nspname <> 'information_schema'
      AND n.nspname <> 'pg_catalog'
      AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend d
        JOIN pg_extension e ON e.oid = d.refobjid
        WHERE d.classid = 'pg_proc'::regclass
          AND d.objid = p.oid
          AND d.deptype = 'e'
      )
  `);
  const actualFunctionKeys = functionRows.map((item) => `${item.name}(${item.identity_arguments})`);
  if (!sameStrings(expectedFunctionKeys, actualFunctionKeys)) unexpected([...expectedFunctionKeys, ...actualFunctionKeys]);
  for (const expected of functions) {
    const actual = functionRows.find((item) => (
      item.schema_name === 'public' &&
      item.name === expected.name &&
      normalizeSql(String(item.identity_arguments)) === normalizeSql(expected.identityArguments)
    ));
    if (!actual ||
        normalizeSql(String(actual.result)) !== normalizeSql(expected.result) ||
        actual.language !== expected.language ||
        normalizeSql(String(actual.body)) !== normalizeSql(expected.body) ||
        actual.volatility !== 'v' ||
        actual.is_strict !== false ||
        actual.security_definer !== false ||
        actual.parallel_safety !== 'u' ||
        actual.leakproof !== false ||
        actual.function_kind !== 'f' ||
        actual.returns_set !== false ||
        Number(actual.cost) !== 100 ||
        Number(actual.rows_estimate) !== 0 ||
        (actual.configuration !== null && actual.configuration !== undefined)) {
      unexpected([`routine:${expected.name}(${expected.identityArguments})`]);
    }
  }

  const triggerDefinitions = includeVersionTwoObjects ? definition.triggers : [];
  const expectedTriggerKeys = triggerDefinitions.map((item) => `${item.table}.${item.name}`);
  const triggerRows = await queryRows(client, `
    SELECT n.nspname AS schema_name, pn.nspname AS function_schema,
           c.relname AS table_name, t.tgname AS name,
           p.proname AS function_name, t.tgenabled AS enabled,
           t.tgisinternal AS is_internal, t.tgconstraint AS constraint_oid,
           t.tgdeferrable AS deferrable, t.tginitdeferred AS initially_deferred,
           pg_get_triggerdef(t.oid, false) AS definition
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    JOIN pg_namespace pn ON pn.oid = p.pronamespace
    WHERE NOT t.tgisinternal AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
  `);
  const actualTriggerKeys = triggerRows.map((item) => `${item.table_name}.${item.name}`);
  if (!sameStrings(expectedTriggerKeys, actualTriggerKeys)) unexpected([...expectedTriggerKeys, ...actualTriggerKeys]);
  for (const expected of triggerDefinitions) {
    const actual = triggerRows.find((item) => item.table_name === expected.table && item.name === expected.name);
    if (!actual ||
        actual.schema_name !== 'public' ||
        actual.function_schema !== 'public' ||
        actual.function_name !== expected.functionName ||
        actual.enabled !== 'O' ||
        actual.is_internal !== false ||
        Number(actual.constraint_oid) !== 0 ||
        actual.deferrable !== false ||
        actual.initially_deferred !== false ||
        normalizeSql(String(actual.definition)) !== normalizeSql(expected.definition)) {
      unexpected([`trigger:${expected.table}.${expected.name}`]);
    }
  }

  const explicitIndexes = definition.indexes;
  const indexRows = await queryRows(client, `
    SELECT n.nspname AS schema_name, t.relname AS table_name, irel.relname AS name,
           pg_get_indexdef(i.indexrelid, 0, false) AS definition,
           i.indisunique AS is_unique, i.indisvalid AS is_valid, i.indisready AS is_ready,
           i.indisprimary AS is_primary, i.indimmediate AS is_immediate, i.indislive AS is_live,
           am.amname AS access_method, con.conname AS constraint_name,
           con.contype AS constraint_type
    FROM pg_index i
    JOIN pg_class irel ON irel.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_am am ON am.oid = irel.relam
    LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid AND con.contype IN ('p', 'u')
    WHERE n.nspname <> 'information_schema'
      AND n.nspname <> 'pg_catalog'
      AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
      AND NOT (n.nspname = 'public' AND t.relname = 'schema_migrations')
  `);
  const constraintIndexRows = indexRows.filter((item) => item.constraint_name !== null);
  const expectedIndexCount = explicitIndexes.length + expectedConstraints.filter(
    (item) => item.constraint.type === 'p' || item.constraint.type === 'u'
  ).length;
  if (indexRows.length !== expectedIndexCount) unexpected(indexRows.map((item) => `${item.table_name}.${item.name}`));

  for (const expected of explicitIndexes) {
    const actual = indexRows.find((item) => item.name === expected.name);
    if (!actual ||
        actual.schema_name !== 'public' ||
        actual.table_name !== expected.table ||
        actual.access_method !== 'btree' ||
        actual.is_valid !== true ||
        actual.is_ready !== true ||
        actual.is_primary !== false ||
        actual.is_immediate !== true ||
        actual.is_live !== true ||
        normalizeSql(String(actual.definition)) !== normalizeSql(expected.definition)) {
      unexpected([`index:${expected.table}.${expected.name}`]);
    }
  }
  if (constraintIndexRows.length !== expectedConstraints.filter(
    (item) => item.constraint.type === 'p' || item.constraint.type === 'u'
  ).length || constraintIndexRows.some((item) => (
    item.schema_name !== 'public' ||
    item.access_method !== 'btree' ||
    item.is_valid !== true ||
    item.is_ready !== true ||
    item.is_unique !== true ||
    item.is_primary !== (item.constraint_type === 'p') ||
    item.is_immediate !== true ||
    item.is_live !== true
  ))) {
    unexpected(['constraint indexes']);
  }

  const extensionRows = await queryRows(client, `
    SELECT e.extname AS name, n.nspname AS schema_name, e.extversion AS version,
           EXISTS (
             SELECT 1 FROM pg_available_extension_versions v
             WHERE v.name = e.extname AND v.version = e.extversion
           ) AS version_available
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
  `);
  const actualExtensionNames = extensionRows.map((item) => String(item.name)).sort();
  const expectedExtensionNames = [...new Set([...definition.extensions, 'plpgsql'])].sort();
  if (!sameStrings(expectedExtensionNames, actualExtensionNames)) unexpected(actualExtensionNames);
  const pgcrypto = extensionRows.find((item) => item.name === 'pgcrypto');
  if (!pgcrypto ||
      pgcrypto.schema_name !== 'public' ||
      !pgcrypto.version ||
      pgcrypto.version_available !== true) {
    unexpected(['extension:pgcrypto schema/version']);
  }
}

export async function verifyFreshDatabase(client: PoolClient): Promise<void> {
  const relations = await queryRows(client, `
    SELECT n.nspname AS schema_name, c.relname AS object_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname <> 'information_schema'
      AND n.nspname <> 'pg_catalog'
      AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S', 'c')
      AND NOT (n.nspname = 'public' AND c.relname = 'schema_migrations')
  `);
  if (relations.length) unexpected(relations.map((row) => `${row.schema_name}.${row.object_name}`));
  await verifyNoUnexpectedSchemas(client);
  await verifyNoUnexpectedTypes(client);
  await verifyNoUnexpectedCatalogObjects(client);
  await verifyNoUnexpectedPoliciesRulesOrEventTriggers(client);

  const indexes = await queryRows(client, `
    SELECT irel.relname AS name, n.nspname AS schema_name
    FROM pg_index i
    JOIN pg_class irel ON irel.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname <> 'information_schema'
      AND n.nspname <> 'pg_catalog'
      AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
      AND NOT (n.nspname = 'public' AND t.relname = 'schema_migrations')
  `);
  if (indexes.length) unexpected(indexes.map((row) => `${row.schema_name}.${row.name}`));

  const routines = await queryRows(client, `
    SELECT n.nspname AS schema_name, p.proname AS name
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname <> 'information_schema'
      AND n.nspname <> 'pg_catalog'
      AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend d
        JOIN pg_extension e ON e.oid = d.refobjid
        WHERE d.classid = 'pg_proc'::regclass
          AND d.objid = p.oid
          AND d.deptype = 'e'
      )
  `);
  if (routines.length) unexpected(routines.map((row) => `${row.schema_name}.${row.name}`));

  const triggers = await queryRows(client, `
    SELECT n.nspname AS schema_name, c.relname AS table_name, t.tgname AS name
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal
      AND n.nspname <> 'information_schema'
      AND n.nspname <> 'pg_catalog'
      AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
      AND NOT (n.nspname = 'public' AND c.relname = 'schema_migrations')
  `);
  if (triggers.length) unexpected(triggers.map((row) => `${row.schema_name}.${row.table_name}.${row.name}`));

  const extensions = await queryRows(client, `
    SELECT e.extname AS name, n.nspname AS schema_name, e.extversion AS version,
           EXISTS (
             SELECT 1 FROM pg_available_extension_versions v
             WHERE v.name = e.extname AND v.version = e.extversion
           ) AS version_available
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
  `);
  const unexpectedExtensions = extensions.filter((extension) => (
    extension.name !== 'plpgsql' && extension.name !== 'pgcrypto'
  ));
  if (unexpectedExtensions.length) unexpected(unexpectedExtensions.map((row) => String(row.name)));
  const pgcrypto = extensions.find((extension) => extension.name === 'pgcrypto');
  if (pgcrypto && (
    pgcrypto.schema_name !== 'public' ||
    !pgcrypto.version ||
    pgcrypto.version_available !== true
  )) {
    unexpected(['extension:pgcrypto schema/version']);
  }
}

