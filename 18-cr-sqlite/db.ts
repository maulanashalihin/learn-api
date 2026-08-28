/**
 * db.ts — cr-sqlite database setup.
 *
 * Library: load crsqlite extension, mark tables as CRR.
 * App pakai ini untuk write/read NORMAL — tidak lewat HTTP.
 *
 * Usage:
 *   import { openDB } from "./db.ts";
 *   const { db, close } = openDB({ dbPath: "app.db", extensionPath: "./crsqlite.so" });
 *   db.query("INSERT INTO users VALUES (?, ?, ?)").run(1, "Alice", "Singapore");
 *   db.query("SELECT * FROM users").all();
 */

import { Database } from "bun:sqlite";

export interface DBConfig {
  dbPath: string;
  extensionPath: string;
  /** Tables to mark as CRR (conflict-free replicated relation). */
  tables?: string[];
  /** SQL schema to execute before marking CRR tables. */
  schema?: string;
}

export interface DBContext {
  db: Database;
  close: () => void;
}

export function openDB(config: DBConfig): DBContext {
  const db = new Database(config.dbPath);

  // Load crsqlite extension — in-app, bukan sidecar
  db.loadExtension(config.extensionPath);

  // Performance pragmas
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");

  // Create schema (pure SQLite, before CRR marking)
  if (config.schema) {
    db.exec(config.schema);
  }

  // Mark tables as CRR — CRDT metadata auto-tracked on every write
  for (const table of config.tables ?? []) {
    db.exec(`SELECT crsql_as_crr("${table}")`);
  }

  const close = () => {
    db.exec("SELECT crsql_finalize()");
    db.close();
  };

  return { db, close };
}
