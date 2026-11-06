#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/603bf5535ff2a2e860d35f68e5b87b4c514ab67976f594d6e7df684d244e6a4c/contract';
import endContract from '../../snapshots/603bf5535ff2a2e860d35f68e5b87b4c514ab67976f594d6e7df684d244e6a4c/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/84297d9e6d333fc3f2808eebe32bfc49d01e5bdfcaa2cec27d1b60f682f2e5d8/contract';
import startContract from '../../snapshots/84297d9e6d333fc3f2808eebe32bfc49d01e5bdfcaa2cec27d1b60f682f2e5d8/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'mcp_clients',
        columns: [
          col('client_id', 'SERIAL', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('hourly_limit', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
          col('key_hash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('key_prefix', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('last_used_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('revoked_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
        ],
        constraints: [primaryKey(['client_id'])],
      }),
      this.addUnique({
        schema: 'public',
        table: 'mcp_clients',
        constraint: 'mcp_clients_key_prefix_key',
        columns: ['key_prefix'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'mcp_clients',
        constraint: 'mcp_clients_key_hash_key',
        columns: ['key_hash'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
