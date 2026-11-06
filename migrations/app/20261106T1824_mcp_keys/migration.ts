#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/603bf5535ff2a2e860d35f68e5b87b4c514ab67976f594d6e7df684d244e6a4c/contract';
import startContract from '../../snapshots/603bf5535ff2a2e860d35f68e5b87b4c514ab67976f594d6e7df684d244e6a4c/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/f16d28cb8ebace063a3dd084a0904fb3be753924919ea7a753020b331f57abf8/contract';
import endContract from '../../snapshots/f16d28cb8ebace063a3dd084a0904fb3be753924919ea7a753020b331f57abf8/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropTable({ schema: 'public', table: 'mcp_clients' }),
      this.createTable({
        schema: 'public',
        table: 'mcp_keys',
        columns: [
          col('created_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('hourly_limit', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
          col('key_hash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('key_id', 'SERIAL', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('key_prefix', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('last_used_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('revoked_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
        ],
        constraints: [primaryKey(['key_id'])],
      }),
      this.addUnique({
        schema: 'public',
        table: 'mcp_keys',
        constraint: 'mcp_keys_key_prefix_key',
        columns: ['key_prefix'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'mcp_keys',
        constraint: 'mcp_keys_key_hash_key',
        columns: ['key_hash'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
