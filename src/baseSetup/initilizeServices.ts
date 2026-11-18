import { initializeBullMQ } from "libs/bullmq";
import { initializeConsumers } from "libs/rabbitmq/consumers";
import { rabbitMQService } from "libs/rabbitmq/rabbitmq.service";
import { connectRedis } from "libs/redis";
import config from "config/env";
import createDefaultData from "seeders";
import { startStudioWorkers } from "libs/jobs/runner";
import { seedPricing } from "libs/pricing/pricing.service";

const initializeServices=async()=>{
    try {
    // Versioned provider price lists (src/config/pricing/*.json)
    console.log(`✅ Pricing configuration: ${await seedPricing()} price rows`);
    // Initialize RabbitMQ
    await rabbitMQService.initialize();
        // Connect Redis
    await connectRedis();
    // console.log('✅ Redis connected');
    await  initializeConsumers()
    // // Initialize BullMQ before migrations
    await initializeBullMQ();
    console.log('✅ BullMQ initialized');

    // Studio job processors run in-process unless a dedicated worker
    // process is used (`npm run worker`, WORKERS_IN_PROCESS=false)
    if (config.WORKERS_IN_PROCESS) {
        await import("workers/register");
        await startStudioWorkers();
    }

    // Seed default data on boot when enabled (SEED_ON_BOOT=true)
    if (config.SEED_ON_BOOT) {
        await createDefaultData();
    }
    } catch (error) {
        console.log(error,"Failed to initialize services")
    }
}
export default initializeServices