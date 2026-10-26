import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { silentLogger } from '../../src/infra/logger';
import type { ServiceStatus } from '../../src/routes/api';
import { connectTestDb, dropTestDb, makeServices, resetData, seedFixtures } from '../helpers/harness';

const here = path.dirname(fileURLToPath(import.meta.url));
const STATUS: ServiceStatus = {
  aiMode: 'fallback_only',
  model: null,
  telegram: { enabled: true, botUsername: 'test_bot', status: 'polling' },
  release: 'abc1234',
};

let app: ReturnType<typeof buildApp>;

beforeAll(connectTestDb);
afterAll(dropTestDb);
beforeEach(async () => {
  await resetData();
  await seedFixtures();
  const { services, clock } = makeServices();
  app = buildApp({ services, clock, logger: silentLogger, status: () => STATUS });
});

describe('same-origin deployment (no CORS)', () => {
  it('never grants cross-origin access, so other websites cannot read the API from a browser', async () => {
    const evil = 'https://evil.example';
    const get = await request(app).get('/api/health').set('Origin', evil);
    expect(get.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await request(app)
      .options('/api/recommendations')
      .set('Origin', evil)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-requested-with');
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    expect(preflight.headers['access-control-allow-headers']).toBeUndefined();
  });
});

describe('health check for the host', () => {
  it('reports the deployed release and uptime, and answers quickly', async () => {
    const started = Date.now();
    const res = await request(app).get('/api/health');
    expect(Date.now() - started).toBeLessThan(5000); // hosts time health checks out at ~5 s
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', release: 'abc1234', telegram: { status: 'polling' } });
    expect(typeof res.body.uptimeSec).toBe('number');
  });
});

describe('client bundle contains no secrets', () => {
  const dist = path.resolve(here, '../../../client/dist');
  const envFile = path.resolve(here, '../../.env');
  const built = fs.existsSync(dist);

  // Variable *names* may appear in help text (the dashboard tells you to set ANTHROPIC_API_KEY);
  // what must never appear are credential values.
  it.skipIf(!built)('has no credential patterns and none of the local secret values', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(js|css|html|map)$/.test(e.name)) files.push(p);
      }
    };
    walk(dist);
    const bundle = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    expect(/sk-ant-[A-Za-z0-9]/.test(bundle)).toBe(false);
    expect(/scrypt:\d+:\d+:\d+:/.test(bundle)).toBe(false);
    expect(/mongodb(\+srv)?:\/\/[^\s"'`]*@/.test(bundle)).toBe(false);
    expect(/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/.test(bundle)).toBe(false);

    // If a local server/.env exists, none of its secret values may appear in the bundle (values are never printed).
    if (fs.existsSync(envFile)) {
      const secrets = fs
        .readFileSync(envFile, 'utf8')
        .split(/\r?\n/)
        .map((l) => /^(ANTHROPIC_API_KEY|TELEGRAM_BOT_TOKEN|MONGODB_URI|SESSION_SECRET|ADMIN_PASSWORD_HASH)=(.+)$/.exec(l)?.[2]?.trim())
        .filter((v): v is string => Boolean(v && v.length >= 8));
      const leaked = secrets.filter((v) => bundle.includes(v)).length;
      expect(leaked).toBe(0);
    }
  });
});
