import { faker } from '@faker-js/faker';
import { inArray, notInArray, sql } from 'drizzle-orm';

import { addSeedCredentials } from '@/modules/auth/backend';
import {
  type getDefaultDbClient,
  isProdRuntimeEnvironment,
  user,
} from '@/modules/kernel/backend';

import { emphasis } from './_utils';

const seedOnboardedAt = new Date('2024-01-01T00:00:00.000Z');

export async function createUsers(
  db: ReturnType<typeof getDefaultDbClient>,
  {
    adminEmail,
    userEmail,
    password,
  }: { adminEmail: string; userEmail: string; password: string }
) {
  console.log(`⏳ Seeding users`);

  let createdCounter = 0;
  const [countRow] = await db
    .select({ count: sql<number>`cast(count(*) as integer)` })
    .from(user)
    .where(notInArray(user.email, [userEmail, adminEmail]));
  const existingRandomUserCount = countRow?.count ?? 0;

  const usersToSeed = Array.from(
    { length: Math.max(0, 98 - existingRandomUserCount) },
    () => ({
      name: faker.person.fullName(),
      email: faker.internet.email().toLowerCase(),
      emailVerified: true,
      role: 'user' as const,
    })
  );

  if (usersToSeed.length > 0) {
    const inserted = await db
      .insert(user)
      .values(usersToSeed)
      .onConflictDoNothing()
      .returning({ id: user.id });
    createdCounter += inserted.length;
  }

  const [insertedUser] = await db
    .insert(user)
    .values({
      name: 'User',
      email: userEmail,
      emailVerified: true,
      onboardedAt: seedOnboardedAt,
      role: 'user',
    })
    .onConflictDoNothing()
    .returning({ id: user.id });
  if (insertedUser) {
    createdCounter += 1;
  }

  const [insertedAdmin] = await db
    .insert(user)
    .values({
      name: 'Admin',
      email: adminEmail,
      emailVerified: true,
      role: 'admin',
      onboardedAt: seedOnboardedAt,
    })
    .onConflictDoNothing()
    .returning({ id: user.id });
  if (insertedAdmin) {
    createdCounter += 1;
  }

  console.log(
    `✅ ${existingRandomUserCount} existing random users 👉 ${createdCounter} users created`
  );

  // Never disclose seeded credentials on a production runtime.
  if (!isProdRuntimeEnvironment()) {
    const seeded = await db
      .select({ id: user.id })
      .from(user)
      .where(inArray(user.email, [adminEmail, userEmail]));
    await addSeedCredentials(
      db,
      seeded.map(({ id }) => id),
      password
    );
    console.log(`👉 Admin connect with: ${emphasis(adminEmail)}`);
    console.log(`👉 User connect with: ${emphasis(userEmail)}`);
  }
}
