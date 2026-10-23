import 'dotenv/config';
import { defineConfig as composer } from '@prisma/composer/config';
import { nodeBuild } from '@prisma/composer/node/control';
import { prismaCloud, prismaState } from '@prisma/composer-prisma-cloud/control';
import pgvector from '@prisma/orm-extension-pgvector/control';
import { defineConfig as ormConfig } from '@prisma/orm-postgres/config';
import { definePrismaConfig } from 'prisma/config';

export default definePrismaConfig({
  orm: ormConfig({
    contract: "./src/prisma/contract.prisma",
    extensions: [pgvector],
    db: {
      connection: process.env['DATABASE_URL']!,
    },
  }),
  composer: composer({
    extensions: [prismaCloud({ region: "us-east-1" }), nodeBuild()],
    state: prismaState(),
  }),
});
