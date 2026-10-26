import assert from "node:assert/strict";
import type { MutationCtx } from "../../convex/_generated/server.js";

export type Row = Record<string, unknown> & { _id: string };
type Snapshot = { rows: Map<string, Row>; nextId: number };
export function memoryDatabase() {
  let committed: Snapshot = { rows: new Map(), nextId: 0 };
  let version = 0;
  const scheduled: unknown[] = [];
  const fullScans: string[] = [];
  const context = (snapshot: Snapshot, effects: unknown[]): MutationCtx => {
    const tableRows = (table: string) =>
      [...snapshot.rows.values()].filter((row) => row["table"] === table);
    const db = {
      query(table: string) {
        const conditions: Array<(row: Row) => boolean> = [];
        const query = {
          withIndex(_index: string, build: (builder: object) => unknown) {
            const builder = {
              eq(field: string, value: unknown) {
                conditions.push((row) => row[field] === value);
                return builder;
              },
              lte(field: string, value: number) {
                conditions.push((row) => Number(row[field]) <= value);
                return builder;
              },
            };
            build(builder);
            return query;
          },
          async collect() {
            fullScans.push(table);
            return tableRows(table).filter((row) =>
              conditions.every((condition) => condition(row))
            );
          },
          async first() {
            return (
              tableRows(table).find((row) => conditions.every((condition) => condition(row))) ??
              null
            );
          },
          async unique() {
            const rows = tableRows(table).filter((row) =>
              conditions.every((condition) => condition(row))
            );
            if (rows.length > 1) throw new Error("Duplicate account counters");
            return rows[0] ?? null;
          },
          async take(count: number) {
            return (await query.collect()).slice(0, count);
          },
        };
        return query;
      },
      async get(id: string) {
        return snapshot.rows.get(id) ?? null;
      },
      async insert(table: string, input: object) {
        const id = `${table}:${++snapshot.nextId}`;
        snapshot.rows.set(id, { ...input, _id: id, table });
        return id;
      },
      async patch(id: string, input: object) {
        const row = snapshot.rows.get(id);
        assert.ok(row);
        Object.assign(row, input);
      },
      async delete(id: string) {
        snapshot.rows.delete(id);
      },
    };
    return {
      db,
      auth: { getUserIdentity: async () => ({ subject: "owner-a" }) },
      scheduler: {
        async runAfter(delay: number, reference: unknown, args: unknown) {
          effects.push({ delay, reference, args });
        },
      },
    } as unknown as MutationCtx;
  };
  return {
    // Model Convex's optimistic transaction retry. Both concurrent requests can
    // read the same snapshot; only one commits, and the loser rechecks admission.
    async transaction<T>(operation: (ctx: MutationCtx) => Promise<T>): Promise<T> {
      while (true) {
        const readVersion = version;
        const snapshot = structuredClone(committed);
        const effects: unknown[] = [];
        const result = await operation(context(snapshot, effects));
        if (version !== readVersion) continue;
        committed = snapshot;
        version += 1;
        scheduled.push(...effects);
        return result;
      }
    },
    rows: (table: string) => [...committed.rows.values()].filter((row) => row["table"] === table),
    scheduled,
    fullScans,
  };
}
