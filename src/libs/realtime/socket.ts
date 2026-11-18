import type { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import config from 'config/env';
import { verifyToken, verifyTokenInDatabase } from 'libs/jwt';
import User from 'models/user.model';
import MangaProject from 'models/manga-project.model';
import { EVENTS_CHANNEL, StudioEvent, subscribe } from './events';

let io: Server | null = null;

/**
 * Socket.IO server for real-time job progress. Clients authenticate with
 * the same JWT access token used for REST (DB-tracked, revocable), join
 * their personal room automatically and may join rooms of projects they own.
 */
export const initRealtime = async (server: HttpServer): Promise<Server> => {
  io = new Server(server, {
    cors: { origin: config.CORS_ORIGIN, credentials: config.CORS_CREDENTIALS },
  });

  io.use(async (socket, next) => {
    try {
      const token = String(socket.handshake.auth?.token || '');
      const decoded = verifyToken(token, false);
      if (!(await verifyTokenInDatabase(token, 'access'))) throw new Error('revoked');
      const user = await User.findById(decoded.userId).select('_id role isActive isBlocked');
      if (!user || !user.isActive || user.isBlocked) throw new Error('inactive');
      socket.data.userId = String(user._id);
      socket.data.role = user.role;
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(`user:${socket.data.userId}`);

    socket.on('project:join', async (projectId: string, ack?: (ok: boolean) => void) => {
      const isAdmin = ['admin', 'superadmin'].includes(socket.data.role);
      const owned = await MangaProject.exists({
        _id: projectId,
        ...(isAdmin ? {} : { owner: socket.data.userId }),
      }).catch(() => null);
      if (owned) socket.join(`project:${projectId}`);
      ack?.(!!owned);
    });
    socket.on('project:leave', (projectId: string) => socket.leave(`project:${projectId}`));
  });

  await subscribe(EVENTS_CHANNEL, (message) => {
    try {
      const evt = JSON.parse(message) as StudioEvent;
      if (evt.rooms?.length) io?.to(evt.rooms).emit(evt.event, evt.data);
    } catch (error) {
      console.error('Invalid studio event payload:', error);
    }
  });

  console.log('✅ Socket.IO realtime server ready');
  return io;
};

export const getIO = () => io;
