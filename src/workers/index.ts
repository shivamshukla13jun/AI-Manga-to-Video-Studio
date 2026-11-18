/**
 * Standalone worker process: `npm run worker` (dev) / `npm run worker:prod`.
 * Use with WORKERS_IN_PROCESS=false on the API so heavy jobs (extraction,
 * PDF, AI, TTS, rendering) never compete with HTTP request handling.
 */
import connectDB from 'config/database';
import { connectRedis } from 'libs/redis';
import { bullMQService } from 'libs/bullmq/bullmq.service';
import { startStudioWorkers, stopStudioWorkers } from 'libs/jobs/runner';
import './register';
import { seedPricing } from 'libs/pricing/pricing.service';

const main = async () => {
  await connectDB();
  await connectRedis();
  await seedPricing();
  await bullMQService.initialize();
  await startStudioWorkers();
  console.log('🧵 Studio worker process ready');

  const shutdown = async (signal: string) => {
    console.log(`${signal} received — stopping workers`);
    await stopStudioWorkers();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
};

main().catch((error) => {
  console.error('Worker process failed to start:', error);
  process.exit(1);
});
