export const QUEUE_NAMES = {
    NOTIFICATION: 'notification',
    // AI Manga-to-Video Studio
    CBZ_EXTRACTION: 'studio-cbz-extraction',
    PDF_CONVERSION: 'studio-pdf-conversion',
    IMAGE_PROCESSING: 'studio-image-processing',
    SCENE_DETECTION: 'studio-scene-detection',
    STORY_GENERATION: 'studio-story-generation',
    TTS_GENERATION: 'studio-tts-generation',
    VIDEO_RENDERING: 'studio-video-rendering',
    CLEANUP: 'studio-cleanup',
};

export const JOB_NAMES = {
    NOTIFICATION: {
        SEND: 'notification.send'
    },
};

export const JOB_PRIORITIES = {
    HIGH: 10,
    MEDIUM: 5,
    LOW: 1
};

export const JOB_DELAYS = {
    IMMEDIATE: 0,
    SECONDS_30: 30 * 1000,
    MINUTES_1: 60 * 1000,
    MINUTES_2: 2 * 60 * 1000,
    MINUTES_5: 5 * 60 * 1000,
    MINUTES_15: 15 * 60 * 1000,
    MINUTES_30: 30 * 60 * 1000,
    HOURS_1: 60 * 60 * 1000,
    HOURS_6: 6 * 60 * 60 * 1000,
    HOURS_24: 24 * 60 * 1000
} as const;
