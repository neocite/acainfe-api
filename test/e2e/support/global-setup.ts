import { MongoMemoryServer } from 'mongodb-memory-server';

let mongo: MongoMemoryServer | undefined;

/** Sobe um MongoDB real (binário oficial) para os testes e2e. Use E2E_MONGODB_URI para apontar para outro. */
export async function setup(): Promise<void> {
  if (process.env.E2E_MONGODB_URI) return;
  mongo = await MongoMemoryServer.create();
  process.env.E2E_MONGODB_URI = mongo.getUri();
}

export async function teardown(): Promise<void> {
  await mongo?.stop();
}
