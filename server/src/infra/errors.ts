export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new AppError('NOT_FOUND', 404, `${what} not found`);
export const badRequest = (message: string, details?: unknown) => new AppError('VALIDATION_ERROR', 400, message, details);
export const conflict = (message: string, code = 'CONFLICT') => new AppError(code, 409, message);
