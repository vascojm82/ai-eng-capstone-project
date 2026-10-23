#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/672597b628f9dfd4607980009b307615683fe7684993b316c8fc15a30f31ec69/contract';
import startContract from '../../snapshots/672597b628f9dfd4607980009b307615683fe7684993b316c8fc15a30f31ec69/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/b2836d39d80b94afd1e9de968455bc3fa804d5865bb6ba34b0c08e050bc7bf88/contract';
import endContract from '../../snapshots/b2836d39d80b94afd1e9de968455bc3fa804d5865bb6ba34b0c08e050bc7bf88/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, sql } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropCheckConstraint({
        schema: 'public',
        table: 'manuals',
        constraint: 'manuals_format_check_b07f7c0c',
      }),
      this.dropCheckConstraint({
        schema: 'public',
        table: 'manuals',
        constraint: 'manuals_manual_type_check_939c4278',
      }),
      this.dropColumn({ schema: 'public', table: 'manuals', column: 'format' }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'manuals',
        constraint: 'manuals_manual_type_check_7816d067',
        expression: sql`"manual_type" IN ('owner', 'navigation')`,
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
