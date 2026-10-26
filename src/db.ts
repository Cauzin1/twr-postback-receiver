import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";

mkdirSync(dirname(config.databasePath), { recursive: true });

export const db = new Database(config.databasePath);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS sales (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id      TEXT    NOT NULL UNIQUE,
    event_type    TEXT    NOT NULL,
    transaction_id TEXT   NOT NULL,
    product_id    TEXT,
    product_name  TEXT,
    customer_email TEXT,
    customer_name TEXT,
    amount_cents  INTEGER NOT NULL DEFAULT 0,
    currency      TEXT    NOT NULL DEFAULT 'BRL',
    occurred_at   TEXT,
    received_at   TEXT    NOT NULL,
    raw_payload   TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sales_event_type ON sales(event_type);
  CREATE INDEX IF NOT EXISTS idx_sales_received_at ON sales(received_at);
  CREATE INDEX IF NOT EXISTS idx_sales_product_id ON sales(product_id);
`);
