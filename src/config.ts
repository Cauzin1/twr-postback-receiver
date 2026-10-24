/**
 * Configuração central da aplicação, lida de variáveis de ambiente.
 * Mantida em um único lugar para ficar fácil de auditar o que o serviço
 * depende do ambiente.
 */
export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "0.0.0.0",
  databasePath: process.env.DATABASE_PATH ?? "./data/sales.db",
  // Se vazio, a verificação de assinatura é desligada (ver routes/webhooks.ts).
  webhookSecret: process.env.WEBHOOK_SECRET ?? "",
};
