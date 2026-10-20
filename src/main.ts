import { existsSync } from 'node:fs';
import { createApp } from './app.js';
import { buildContainer } from './config/container.js';
import { loadEnv } from './config/env.js';

async function bootstrap(): Promise<void> {
  // Desenvolvimento: carrega o .env da raiz (em produção as variáveis vêm do ambiente/Docker).
  // Variáveis já definidas no ambiente têm prioridade sobre o arquivo.
  if (existsSync('.env')) process.loadEnvFile('.env');
  const env = loadEnv();
  const container = await buildContainer(env);
  const app = await createApp(container);
  await container.start();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  container.logger.info('açaínfe no ar', { port: env.PORT, docs: '/docs', mcp: '/mcp' });

  const shutdown = async (signal: string) => {
    container.logger.info('Encerrando', { signal });
    await app.close();
    await container.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
