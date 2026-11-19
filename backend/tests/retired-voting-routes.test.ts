import express from 'express';
import request from 'supertest';
import pollsRouter from '../src/routes/polls';
import authRouter from '../src/routes/auth';
import NonceService from '../src/services/nonce';
import { requireCredential } from '../src/middleware/auth';
import { errorHandler } from '../src/middleware/errorHandler';

jest.mock('../src/services/polls', () => ({ getEligiblePolls: jest.fn(), getPollById: jest.fn() }));
jest.mock('../src/middleware/auth', () => ({ requireCredential: jest.fn((_req, _res, next) => next()) }));
jest.mock('../src/services/nonce', () => ({ __esModule: true, default: { generateNonce: jest.fn() } }));

function app() {
  const server = express();
  server.use(express.json());
  server.use('/api/v1/polls', pollsRouter);
  server.use('/api/v1/auth', authRouter);
  server.use(errorHandler);
  return server;
}

describe('retired voting protocol routes', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(['vote', 'survey-submit'])('has no %s submission handler even with a credential', async suffix => {
    const response = await request(app()).post(`/api/v1/polls/synthetic-poll/${suffix}`)
      .set('Authorization', 'Bearer synthetic-credential')
      .send({ optionId: 'synthetic-option', responses: [], signature: 'synthetic-evidence' });
    expect(response.status).toBe(404);
    expect(requireCredential).not.toHaveBeenCalled();
    expect(NonceService.generateNonce).not.toHaveBeenCalled();
  });

  it('rejects the retired vote challenge without reserving a nonce', async () => {
    const response = await request(app()).post('/api/v1/auth/challenge')
      .send({ deviceId: 'synthetic-device', purpose: 'vote' });
    expect(response.status).toBe(400);
    expect(NonceService.generateNonce).not.toHaveBeenCalled();
  });

  it('retains the authentication challenge contract', async () => {
    (NonceService.generateNonce as jest.Mock).mockResolvedValue('synthetic-challenge');
    const response = await request(app()).post('/api/v1/auth/challenge')
      .send({ deviceId: 'synthetic-device', purpose: 'challenge' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ nonce: 'synthetic-challenge', ttl: 60 });
    expect(NonceService.generateNonce).toHaveBeenCalledTimes(1);
  });
});
