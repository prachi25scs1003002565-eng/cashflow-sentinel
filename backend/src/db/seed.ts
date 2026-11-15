import fs from 'fs';
import path from 'path';
import { Database } from './index';

export async function runSeeds() {
  console.log('Seeding demo dataset for Kavita\'s Kirana Store (Pune)...');

  const seedPath = path.resolve(__dirname, '../../../database/seeds/demo_seed.sql');
  if (!fs.existsSync(seedPath)) {
    throw new Error(`Seed file not found: ${seedPath}`);
  }

  const sql = fs.readFileSync(seedPath, 'utf-8');

  await Database.withTransaction(async (client) => {
    await client.query(sql);
  });

  console.log('Demo seed data loaded successfully!');
}

if (require.main === module) {
  runSeeds()
    .then(() => {
      console.log('Seeding completed.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Seeding failed:', err);
      process.exit(1);
    });
}
