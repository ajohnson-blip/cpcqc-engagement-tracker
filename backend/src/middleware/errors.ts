import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { logger } from '@/config/logger.js';

export class HttpError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const notFound = (_req: Request, res: Response) => {
  res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
};

export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: { code: 'validation_error', message: 'Invalid request', details: err.flatten() },
    });
    return;
  }
  if (err instanceof HttpError) {
    res
      .status(err.status)
      .json({ error: { code: err.status === 401 ? 'unauthorized' : 'http_error', message: err.message, details: err.details } });
    return;
  }
  // body-parser's own failures (body too large, malformed JSON) are the
  // client's, not ours: answer with their 4xx rather than a 500 a well-behaved
  // client would retry. Fixed messages, because a JSON parse error quotes a
  // fragment of the body it could not parse.
  const bodyErr = err as { status?: unknown; expose?: unknown; type?: unknown };
  if (
    typeof bodyErr?.type === 'string' &&
    typeof bodyErr.status === 'number' &&
    bodyErr.status >= 400 &&
    bodyErr.status < 500 &&
    bodyErr.expose === true
  ) {
    const message =
      bodyErr.type === 'entity.too.large'
        ? 'Request body too large.'
        : bodyErr.type === 'entity.parse.failed'
          ? 'Malformed JSON body.'
          : 'Bad request body.';
    res.status(bodyErr.status).json({ error: { code: 'bad_request', message } });
    return;
  }
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } });
};
