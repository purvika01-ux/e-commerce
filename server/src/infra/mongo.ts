import mongoose from 'mongoose';
import type { Logger } from './logger';

export async function connectMongo(uri: string, logger: Logger): Promise<typeof mongoose> {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  logger.info('mongo connected', { db: mongoose.connection.name });
  return mongoose;
}

export async function pingMongo(): Promise<{ status: 'connected' | 'disconnected'; latencyMs?: number }> {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) return { status: 'disconnected' };
  const started = Date.now();
  try {
    await mongoose.connection.db.admin().ping();
    return { status: 'connected', latencyMs: Date.now() - started };
  } catch {
    return { status: 'disconnected' };
  }
}
