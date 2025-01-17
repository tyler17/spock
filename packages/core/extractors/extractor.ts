import { withConnection, DbTransactedConnection } from '../db/db';
import { findConsecutiveSubsets, delay } from '../utils';
import { matchMissingForeignKeyError, RetryableError } from './common';
import { getLogger } from '../utils/logger';
import { Services, TransactionalServices, LocalServices } from '../types';
import { get } from 'lodash';
import { PersistedBlock } from '../db/models/Block';

const logger = getLogger('extractor/index');

export interface BlockExtractor {
  name: string;
  extractorDependencies?: string[];
  disablePerfBoost?: boolean;

  // @note: blocks are always consecutive
  // get data from node to database
  extract: (services: TransactionalServices, blocks: PersistedBlock[]) => Promise<void>;

  // get data from database
  getData(services: LocalServices, blocks: PersistedBlock[]): Promise<any>;
}

type PersistedBlockWithExtractedBlockId = PersistedBlock & {
  extracted_block_id: number;
};

export async function queueNewBlocksToExtract(
  tx: DbTransactedConnection,
  extractors: BlockExtractor[],
  blocks: PersistedBlock[],
): Promise<any> {
  const sql = `
  INSERT INTO vulcan2x.extracted_block (
    block_id, extractor_name, status
) VALUES 
  ${blocks.map(b => extractors.map(e => `(${b.id}, '${e.name}', 'new') `)).join(',')}

ON CONFLICT(block_id, extractor_name) DO NOTHING;
  `;

  return tx.none(sql);
}

export async function extract(services: Services, extractors: BlockExtractor[]): Promise<void> {
  logger.debug('Spawning extractors: ', extractors.length);

  while (extractors.length > 0) {
    // NOTE: no two extractors extract at the same
    for (const extractor of extractors) {
      await extractBlocks(services, extractor);
    }

    await delay(1000);
  }
  logger.warn('Extracting done');
}

async function extractBlocks(services: Services, extractor: BlockExtractor): Promise<void> {
  const blocks = await getNextBlocks(services, extractor);
  if (blocks.length === 0) {
    return;
  }

  // We can speed up whole process (process blocks in batches) if we don't have a risk of reorg.
  // Otherwise we process blocks separately to avoid problems with reorgs while processing tip of the blockchain.
  const closeToTheTipOfBlockchain =
    ((get(blocks, '[0].number') as number) || 0) +
      services.config.extractorWorker.batch -
      services.networkState.latestEthereumBlockOnStart +
      1000 >
    0;

  const processInBatch = !closeToTheTipOfBlockchain || extractor.disablePerfBoost || false;
  let consecutiveBlocks: PersistedBlockWithExtractedBlockId[][];
  if (processInBatch) {
    consecutiveBlocks = findConsecutiveSubsets(blocks, 'number');
  } else {
    consecutiveBlocks = blocks.map(b => [b]);
  }

  logger.debug(
    `Processing ${blocks.length} blocks with ${extractor.name}. ProcessInBatch: ${processInBatch}`,
  );

  await Promise.all(
    consecutiveBlocks.map(async blocks => {
      logger.debug(`Extracting blocks: ${blocks.map(b => b.number).join(', ')}`);

      try {
        await services.db.tx(async tx => {
          const txServices: TransactionalServices = {
            ...services,
            tx,
          };
          await extractor.extract(txServices, blocks);

          logger.debug(
            `Marking blocks as processed from ${blocks[0].number} to ${blocks[0].number +
              blocks.length}`,
          );
          await markBlocksExtracted(services, tx, blocks, extractor, 'done');
          logger.debug(
            `Closing db transaction for ${blocks[0].number} to ${blocks[0].number + blocks.length}`,
          );
        });
      } catch (e) {
        logger.error(
          `ERROR[]: Error occured while processing: ${blocks[0].number} - ${blocks[0].number +
            blocks.length}`,
          e,
        );
        //there is a class of error that we want to retry so we don't mark the blocks as processed
        if (e instanceof RetryableError || matchMissingForeignKeyError(e)) {
          logger.debug(
            `Retrying processing for ${blocks[0].number} - ${blocks[0].number + blocks.length}`,
          );
        } else {
          // @todo error handling could be (perhaps) simpler here
          try {
            await withConnection(services.db, c =>
              markBlocksExtracted(services, c, blocks, extractor, 'error'),
            );
          } catch (e) {
            // @todo match name of the foreign key as well
            // + logging
            if (!matchMissingForeignKeyError(e)) {
              throw e;
            }
          }
        }
      }
    }),
  );
}

export async function getNextBlocks(
  services: Services,
  extractor: BlockExtractor,
): Promise<PersistedBlockWithExtractedBlockId[]> {
  const { db, config } = services;

  return withConnection(db, async c => {
    while (true) {
      const nextBlocks: PersistedBlockWithExtractedBlockId[] | null = await c.manyOrNone<
        PersistedBlockWithExtractedBlockId
      >(
        `
      SELECT b.*, eb.id as extracted_block_id
      FROM vulcan2x.block b
      JOIN vulcan2x.extracted_block eb ON b.id=eb.block_id 
      ${(extractor.extractorDependencies || [])
        .map((_, i) => `JOIN vulcan2x.extracted_block eb${i} ON b.id = eb${i}.block_id`)
        .join('\n')}
      WHERE 
        eb.extractor_name=\${extractorName} AND eb.status = 'new'
        ${(extractor.extractorDependencies || [])
          .map((t, i) => `AND eb${i}.extractor_name='${t}' AND eb${i}.status = 'done'`)
          .join('\n')}
      ORDER BY b.number
      LIMIT \${batch};
      `,
        { extractorName: extractor.name, batch: config.extractorWorker.batch },
      );

      if (nextBlocks && nextBlocks.length > 0) {
        return nextBlocks;
      } else {
        return [];
      }
    }
  });
}

async function markBlocksExtracted(
  { pg, columnSets }: Services,
  connection: any,
  blocks: PersistedBlockWithExtractedBlockId[],
  extractor: BlockExtractor,
  status: 'done' | 'error',
): Promise<void> {
  const updates = blocks.map(b => {
    return {
      id: b.extracted_block_id,
      extractor: extractor.name,
      status,
    };
  });

  let query: string;
  if (status === 'error') {
    // we don't want transition from 'done' to 'error' to ever happening that's why we need additional
    query =
      (await pg.helpers.update(updates, columnSets.extracted_block)) +
      ` WHERE v.id = t.id AND t.status = 'new'`;
  } else {
    query = (await pg.helpers.update(updates, columnSets.extracted_block)) + ' WHERE v.id = t.id';
  }

  await connection.none(query);
}
