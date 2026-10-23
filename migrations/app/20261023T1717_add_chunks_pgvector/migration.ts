#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/02f392844389ef46e12e2330e88408bf94ec03226e5fd5f103097376b11f3a77/contract';
import startContract from '../../snapshots/02f392844389ef46e12e2330e88408bf94ec03226e5fd5f103097376b11f3a77/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/672597b628f9dfd4607980009b307615683fe7684993b316c8fc15a30f31ec69/contract';
import endContract from '../../snapshots/672597b628f9dfd4607980009b307615683fe7684993b316c8fc15a30f31ec69/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropColumn({ schema: 'public', table: 'manuals', column: 'file_path' }),
      this.createTable({
        schema: 'public',
        table: 'chunks',
        columns: [
          col('chunk_id', 'SERIAL', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('content', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('embedding', 'vector(1536)', {
            notNull: true,
            codecRef: { codecId: 'pg/vector@1', typeParams: { length: 1536 } },
          }),
          col('manual_id', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('page', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('section_title', 'text', { codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['chunk_id'])],
      }),
      this.createIndex({
        schema: 'public',
        table: 'chunks',
        index: 'chunks_manual_id_idx_221772fa',
        columns: ['manual_id'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'chunks',
        foreignKey: {
          name: 'chunks_manual_id_fkey',
          columns: ['manual_id'],
          references: { schema: 'public', table: 'manuals', columns: ['manual_id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
