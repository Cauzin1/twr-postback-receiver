export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "0.0.0.0",
  databasePath: process.env.DATABASE_PATH ?? "./data/sales.db",
  webhookSecret: process.env.WEBHOOK_SECRET ?? "",
};
