import redisClient from 'libs/redis/redisClient';

/**
 * Cross-process event bus. Workers may run in a separate process, so they
 * publish to Redis; the API process relays events to Socket.IO rooms.
 */
export const EVENTS_CHANNEL = 'studio:events';
export const CANCEL_CHANNEL = 'studio:job-cancel';

export interface StudioEvent {
  /** Socket.IO event name, e.g. "job:update", "chapter:update" */
  event: string;
  /** Rooms to emit to, e.g. ["user:<id>", "project:<id>"] */
  rooms: string[];
  data: unknown;
}

export const publishEvent = async (evt: StudioEvent): Promise<void> => {
  if (!redisClient.isOpen) return;
  try {
    await redisClient.publish(EVENTS_CHANNEL, JSON.stringify(evt));
  } catch (error) {
    console.error('Failed to publish studio event:', error);
  }
};

export const emitToUser = (userId: unknown, event: string, data: unknown, projectId?: unknown) =>
  publishEvent({
    event,
    rooms: [`user:${userId}`, ...(projectId ? [`project:${projectId}`] : [])],
    data,
  });

export const publishCancel = async (jobId: string): Promise<void> => {
  if (!redisClient.isOpen) return;
  await redisClient.publish(CANCEL_CHANNEL, jobId);
};

/** Subscribe on a dedicated connection (a subscribed client can't run commands). */
export const subscribe = async (
  channel: string,
  handler: (message: string) => void
): Promise<void> => {
  const sub = redisClient.duplicate();
  sub.on('error', (err) => console.error(`Redis subscriber (${channel}) error:`, err));
  await sub.connect();
  await sub.subscribe(channel, handler);
};
