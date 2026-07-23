import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

const adapter = new PrismaBetterSqlite3({ url: 'file:./prisma/dev.db' });
export const prisma = new PrismaClient({ adapter });

export async function initUser(telegramId: bigint) {
  let user = await prisma.user.findUnique({
    where: { telegramId }
  });

  if (!user) {
    user = await prisma.user.create({
      data: {
        telegramId,
        settings: JSON.stringify({
          format: 'mp3',
          quality: 'high',
          outputDir: 'downloads'
        })
      }
    });
  }

  return user;
}
