


import { Router } from "express";

import authRoutes from "microservices/auth-service/route";
import userRoutes from "microservices/user-service/route";
import mangaRoutes from "microservices/manga-service/route";
import jobRoutes from "microservices/job-service/route";
import mediaRoutes from "microservices/media-service/route";
import videoRoutes from "microservices/video-service/route";
import voiceRoutes from "microservices/voice-service/route";
import storyRoutes from "microservices/story-service/route";
import pdfRoutes from "microservices/pdf-service/route";
import { microservicesConfig } from "microservices/microservices";

const rootRouter = Router();

rootRouter.use(microservicesConfig.auth.baseUrl, authRoutes);
rootRouter.use(microservicesConfig.user.baseUrl, userRoutes);
rootRouter.use(microservicesConfig.manga.baseUrl, mangaRoutes);
rootRouter.use(microservicesConfig.jobs.baseUrl, jobRoutes);
rootRouter.use(microservicesConfig.media.baseUrl, mediaRoutes);
rootRouter.use(microservicesConfig.video.baseUrl, videoRoutes);
rootRouter.use(microservicesConfig.voice.baseUrl, voiceRoutes);
rootRouter.use(microservicesConfig.story.baseUrl, storyRoutes);
rootRouter.use(microservicesConfig.pdf.baseUrl, pdfRoutes);

export default rootRouter;
