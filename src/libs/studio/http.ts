import { NextFunction, Request, RequestHandler, Response } from 'express';
import { isValidObjectId } from 'mongoose';
import { AppError } from 'middlewares/error';
import { Role } from 'microservices/auth-service/types';

/** Forward async errors to the global error handler. */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

export const ok = (res: Response, data: unknown, statusCode = 200, message?: string) =>
  res.status(statusCode).json({ success: true, statusCode, message, data });

export const isAdmin = (req: Request) =>
  [Role.ADMIN, Role.SUPERADMIN].includes(req.user?.role as Role);

/** Mongo filter restricting documents to the requesting user (admins see everything). */
export const ownerFilter = (req: Request): Record<string, unknown> =>
  isAdmin(req) ? {} : { owner: req.user._id };

export const assertObjectId = (id: unknown, label = 'id'): string => {
  if (typeof id !== 'string' || !isValidObjectId(id)) {
    throw new AppError(`Invalid ${label}`, 400);
  }
  return id;
};

export const notFound = (what: string) => new AppError(`${what} not found`, 404);

export const parseIntQuery = (value: unknown, fallback: number, max?: number) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  const v = Number.isFinite(n) && n > 0 ? n : fallback;
  return max ? Math.min(v, max) : v;
};
