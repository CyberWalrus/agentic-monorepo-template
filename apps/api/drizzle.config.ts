import { defineConfig } from 'drizzle-kit';

// `drizzle-kit generate` читает только схему: подключение к базе не нужно.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/tasks/schema.ts',
  out: './src/tasks/migrations',
});
