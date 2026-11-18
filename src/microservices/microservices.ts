/**
 * Centralized microservices configuration
 * Imports all microservice config.json files and organizes them by service key
 */

// Import all microservice configs
import authServiceConfig from 'microservices/auth-service/config.json';
import userServiceConfig from 'microservices/user-service/config.json';
import mangaServiceConfig from 'microservices/manga-service/config.json';
import jobServiceConfig from 'microservices/job-service/config.json';
import mediaServiceConfig from 'microservices/media-service/config.json';
import videoServiceConfig from 'microservices/video-service/config.json';
import voiceServiceConfig from 'microservices/voice-service/config.json';
import storyServiceConfig from 'microservices/story-service/config.json';
import pdfServiceConfig from 'microservices/pdf-service/config.json';
// Define the interface for microservice config
interface MicroserviceConfig {
  baseUrl: string;
  author: string;
  service: string;
  CreatedAt: string;
  UpdateddAt: string;
}

// Centralized microservices configuration object
export const microservicesConfig: Record<string, MicroserviceConfig> = {
 
  auth: authServiceConfig  as MicroserviceConfig,
  user: userServiceConfig  as MicroserviceConfig,
  manga: mangaServiceConfig as MicroserviceConfig,
  jobs: jobServiceConfig as MicroserviceConfig,
  media: mediaServiceConfig as MicroserviceConfig,
  video: videoServiceConfig as MicroserviceConfig,
  voice: voiceServiceConfig as MicroserviceConfig,
  story: storyServiceConfig as MicroserviceConfig,
  pdf: pdfServiceConfig as MicroserviceConfig,
};
// Default export
export default microservicesConfig;
