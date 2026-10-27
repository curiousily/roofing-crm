import type { DatabaseSync, SQLInputValue } from "node:sqlite";

interface FakeStatement {
  sql: string;
  values: SQLInputValue[];
}

export function sqliteD1(database: DatabaseSync): D1Database {
  const statement = (sql: string, values: SQLInputValue[] = []) => ({
    sql,
    values,
    bind: (...next: SQLInputValue[]) => statement(sql, next),
    all: async () => ({ results: database.prepare(sql).all(...values), success: true, meta: {} }),
    first: async () => database.prepare(sql).get(...values) ?? null,
    run: async () => {
      database.prepare(sql).run(...values);
      return { results: [], success: true, meta: {} };
    },
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: FakeStatement[]) => {
      database.exec("BEGIN");
      try {
        for (const { sql, values } of statements) database.prepare(sql).run(...values);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return statements.map(() => ({ results: [], success: true, meta: {} }));
    },
  } as unknown as D1Database;
}
