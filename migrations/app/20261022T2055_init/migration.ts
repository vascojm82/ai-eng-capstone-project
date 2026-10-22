#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/02f392844389ef46e12e2330e88408bf94ec03226e5fd5f103097376b11f3a77/contract';
import endContract from '../../snapshots/02f392844389ef46e12e2330e88408bf94ec03226e5fd5f103097376b11f3a77/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  checkExpression,
  col,
  lit,
  primaryKey,
  sql,
} from '@prisma/orm-postgres/migration';

export default class M extends Migration<never, End> {
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createSchema({ schema: 'public' }),
      this.createTable({
        schema: 'public',
        table: 'manuals',
        columns: [
          col('doc_code', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('edition', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('file_path', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('format', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('ingested_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('language', 'text', {
            notNull: true,
            default: lit('en-US'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('manual_id', 'SERIAL', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('manual_type', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('page_count', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
          col('sha256', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('source_url', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('title', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('year', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [
          primaryKey(['manual_id']),
          checkExpression('manuals_format_check_b07f7c0c', sql`"format" IN ('pdf', 'html')`),
          checkExpression(
            'manuals_manual_type_check_939c4278',
            sql`"manual_type" IN ('owner', 'navigation', 'interactive')`,
          ),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'vehicle_manuals',
        columns: [
          col('manual_id', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('vehicle_id', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [primaryKey(['vehicle_id', 'manual_id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'vehicles',
        columns: [
          col('make', 'text', {
            notNull: true,
            default: lit('Acura'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('market', 'text', {
            notNull: true,
            default: lit('US'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('model', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('model_code', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('trim', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('vehicle_id', 'SERIAL', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('year', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [primaryKey(['vehicle_id'])],
      }),
      this.addUnique({
        schema: 'public',
        table: 'manuals',
        constraint: 'manuals_doc_code_key',
        columns: ['doc_code'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'manuals',
        constraint: 'manuals_sha256_key',
        columns: ['sha256'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'vehicles',
        constraint: 'vehicles_year_model_trim_market_key',
        columns: ['year', 'model', 'trim', 'market'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'vehicle_manuals',
        index: 'vehicle_manuals_manual_id_idx_221772fa',
        columns: ['manual_id'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'vehicle_manuals',
        index: 'vehicle_manuals_vehicle_id_idx_fbbcb34b',
        columns: ['vehicle_id'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'vehicle_manuals',
        foreignKey: {
          name: 'vehicle_manuals_vehicle_id_fkey',
          columns: ['vehicle_id'],
          references: { schema: 'public', table: 'vehicles', columns: ['vehicle_id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'vehicle_manuals',
        foreignKey: {
          name: 'vehicle_manuals_manual_id_fkey',
          columns: ['manual_id'],
          references: { schema: 'public', table: 'manuals', columns: ['manual_id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
