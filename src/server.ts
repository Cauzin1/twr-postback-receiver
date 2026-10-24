import { buildApp } from "./app";
import { config } from "./config";

/**
 * Ponto de entrada: sobe o servidor HTTP e trata shutdown gracioso.
 */
async function main() {
  const app = buildApp();

  // Fecha a conexão/limpa recursos ao receber sinal de término (deploy/restart).
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      app.log.info(`recebido ${signal}, encerrando...`);
      await app.close();
      process.exit(0);
    });
  }

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
