#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/84297d9e6d333fc3f2808eebe32bfc49d01e5bdfcaa2cec27d1b60f682f2e5d8/contract';
import endContract from '../../snapshots/84297d9e6d333fc3f2808eebe32bfc49d01e5bdfcaa2cec27d1b60f682f2e5d8/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/b2836d39d80b94afd1e9de968455bc3fa804d5865bb6ba34b0c08e050bc7bf88/contract';
import startContract from '../../snapshots/b2836d39d80b94afd1e9de968455bc3fa804d5865bb6ba34b0c08e050bc7bf88/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'manuals',
        column: col('previous_sha256', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'manuals',
        column: col('source_last_modified', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'manuals',
        column: col('source_size', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'manuals',
        column: col('updated_at', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-string@1' },
        }),
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
