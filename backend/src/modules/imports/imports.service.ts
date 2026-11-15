import crypto from 'crypto';
import { parse } from 'csv-parse/sync';
import { Database } from '../../db';
import { MoneyUtil } from '../../utils/money';
import { AuditLogger } from '../../middleware/audit';
import { NotFoundError, ValidationError, ConflictError } from '../../utils/errors';

export interface ColumnMapping {
  date_column?: string;
  amount_column?: string;
  description_column?: string;
  direction_column?: string;
  reference_column?: string;
}

export class ImportsService {
  static async processCsvUpload(
    businessId: string,
    userId: string,
    dataSourceId: string,
    fileBuffer: Buffer,
    originalFilename: string,
    mapping?: ColumnMapping,
    requestId?: string
  ) {
    const fileContent = fileBuffer.toString('utf-8');
    const contentSha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    // Parse CSV records
    let records: any[];
    try {
      records = parse(fileContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });
    } catch (err: any) {
      throw new ValidationError(`CSV parsing failed: ${err.message}`);
    }

    if (records.length === 0) {
      throw new ValidationError('CSV file is empty or contains no data rows.');
    }

    if (records.length > 25000) {
      throw new ValidationError('CSV file exceeds maximum limit of 25,000 rows.');
    }

    // Auto-detect columns if not explicitly provided
    const headers = Object.keys(records[0] || {});
    const dateCol = mapping?.date_column || headers.find((h) => /date/i.test(h)) || headers[0];
    const amountCol = mapping?.amount_column || headers.find((h) => /amount|paise|inr/i.test(h)) || headers[1];
    const descCol = mapping?.description_column || headers.find((h) => /desc|narrat|detail|particular/i.test(h)) || headers[2];
    const refCol = mapping?.reference_column || headers.find((h) => /ref|utr|id|cheque|chq/i.test(h));

    return Database.withTransaction(async (client) => {
      // 1. Create import_batch
      const batchRes = await client.query(
        `INSERT INTO import_batches (
          business_id, data_source_id, uploaded_by_user_id, original_filename,
          content_sha256, status, row_count, mapping_snapshot
        )
        VALUES ($1, $2, $3, $4, $5, 'REVIEW_REQUIRED', $6, $7)
        RETURNING *`,
        [
          businessId,
          dataSourceId,
          userId,
          originalFilename,
          contentSha256,
          records.length,
          JSON.stringify({ dateCol, amountCol, descCol, refCol }),
        ]
      );
      const batch = batchRes.rows[0];

      // 2. Parse and insert each row into import_rows
      let rowNum = 1;
      for (const rec of records) {
        const rawDate = rec[dateCol]?.trim();
        const rawAmount = rec[amountCol]?.trim();
        const rawDesc = descCol ? rec[descCol]?.trim() : null;
        const rawRef = refCol ? rec[refCol]?.trim() : null;

        let parsedDate: string | null = null;
        let parsedAmountPaise: string | null = null;
        let parsedDirection: 'INFLOW' | 'OUTFLOW' | null = null;
        const validationErrors: Array<{ field: string; issue: string }> = [];

        // Parse Date
        if (rawDate) {
          const d = new Date(rawDate);
          if (!isNaN(d.getTime())) {
            parsedDate = d.toISOString().split('T')[0];
          } else {
            validationErrors.push({ field: 'date', issue: 'invalid_date_format' });
          }
        } else {
          validationErrors.push({ field: 'date', issue: 'missing_date' });
        }

        // Parse Amount & Direction
        if (rawAmount) {
          try {
            const cleanAmount = rawAmount.replace(/[₹,$\s]/g, '');
            const isNeg = cleanAmount.startsWith('-') || /\(.*\)/.test(cleanAmount);
            const num = cleanAmount.replace(/[\(\)]/g, '');
            const paise = MoneyUtil.rupeesToPaise(num);
            parsedAmountPaise = (paise < 0n ? -paise : paise).toString();
            parsedDirection = isNeg || paise < 0n ? 'OUTFLOW' : 'INFLOW';
          } catch (e: any) {
            validationErrors.push({ field: 'amount', issue: 'invalid_amount_format' });
          }
        } else {
          validationErrors.push({ field: 'amount', issue: 'missing_amount' });
        }

        const fingerprint = crypto
          .createHash('sha256')
          .update(`${parsedDate}|${parsedAmountPaise}|${parsedDirection}|${rawRef || rawDesc}`)
          .digest('hex');

        // Check if duplicate candidate
        let reviewStatus = validationErrors.length > 0 ? 'REJECTED' : 'PENDING';
        if (reviewStatus === 'PENDING') {
          const dupCheck = await client.query(
            `SELECT id FROM import_rows
             WHERE business_id = $1 AND row_fingerprint = $2 AND review_status = 'ACCEPTED'
             LIMIT 1`,
            [businessId, fingerprint]
          );
          if (dupCheck.rows.length > 0) {
            reviewStatus = 'DUPLICATE_CANDIDATE';
          }
        }

        await client.query(
          `INSERT INTO import_rows (
            business_id, import_batch_id, source_row_number, row_fingerprint,
            parsed_transaction_date, parsed_amount_paise, parsed_direction,
            parsed_description, source_reference, review_status, validation_errors
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            businessId,
            batch.id,
            rowNum++,
            fingerprint,
            parsedDate,
            parsedAmountPaise,
            parsedDirection,
            rawDesc,
            rawRef,
            reviewStatus,
            JSON.stringify(validationErrors),
          ]
        );
      }

      await AuditLogger.log(
        {
          businessId,
          actorUserId: userId,
          action: 'CSV_IMPORTED',
          entityName: 'import_batches',
          entityId: batch.id,
          requestId,
          metadata: { row_count: records.length, filename: originalFilename },
        },
        client
      );

      return {
        id: batch.id,
        data_source_id: batch.data_source_id,
        status: batch.status,
        row_count: records.length,
        accepted_count: 0,
        rejected_count: 0,
        content_sha256: batch.content_sha256,
        error_summary: null,
        created_at: batch.created_at,
      };
    });
  }

  static async getBatch(businessId: string, batchId: string) {
    const res = await Database.query(
      'SELECT * FROM import_batches WHERE business_id = $1 AND id = $2',
      [businessId, batchId]
    );
    if (res.rows.length === 0) {
      throw new NotFoundError('RESOURCE_NOT_FOUND', 'Import batch not found.');
    }
    return res.rows[0];
  }

  static async getBatchRows(businessId: string, batchId: string, reviewStatus?: string) {
    let query = `
      SELECT id, source_row_number, row_fingerprint, parsed_transaction_date,
             parsed_amount_paise, parsed_direction, parsed_description,
             source_reference, review_status, validation_errors
      FROM import_rows
      WHERE business_id = $1 AND import_batch_id = $2
    `;
    const params: any[] = [businessId, batchId];

    if (reviewStatus) {
      query += ` AND review_status = $3`;
      params.push(reviewStatus);
    }

    query += ` ORDER BY source_row_number ASC`;
    const res = await Database.query(query, params);
    return res.rows.map((row) => ({
      ...row,
      parsed_amount_paise: row.parsed_amount_paise ? row.parsed_amount_paise.toString() : null,
    }));
  }

  static async confirmBatch(
    businessId: string,
    batchId: string,
    userId: string,
    acceptedRowIds: string[],
    duplicateOverrideRowIds: string[],
    rejectedRowIds: string[],
    accountId: string,
    requestId?: string
  ) {
    return Database.withTransaction(async (client) => {
      const batchRes = await client.query(
        'SELECT * FROM import_batches WHERE business_id = $1 AND id = $2 FOR UPDATE',
        [businessId, batchId]
      );
      if (batchRes.rows.length === 0) {
        throw new NotFoundError('RESOURCE_NOT_FOUND', 'Import batch not found.');
      }
      const batch = batchRes.rows[0];
      if (batch.status === 'COMPLETED') {
        throw new ConflictError('STATE_CONFLICT', 'Import batch has already been confirmed.');
      }

      // Mark rejected rows
      if (rejectedRowIds.length > 0) {
        await client.query(
          `UPDATE import_rows
           SET review_status = 'REJECTED', updated_at = now()
           WHERE business_id = $1 AND import_batch_id = $2 AND id = ANY($3)`,
          [businessId, batchId, rejectedRowIds]
        );
      }

      // Rows to accept (accepted + overridden duplicates)
      const toAcceptIds = [...new Set([...acceptedRowIds, ...duplicateOverrideRowIds])];
      const createdTxIds: string[] = [];

      if (toAcceptIds.length > 0) {
        const rowsToAccept = await client.query(
          `SELECT * FROM import_rows
           WHERE business_id = $1 AND import_batch_id = $2 AND id = ANY($3)`,
          [businessId, batchId, toAcceptIds]
        );

        for (const row of rowsToAccept.rows) {
          if (!row.parsed_transaction_date || !row.parsed_amount_paise || !row.parsed_direction) {
            continue;
          }

          // Create posted transaction
          const txRes = await client.query(
            `INSERT INTO transactions (
              business_id, account_id, data_source_id, import_row_id, source_reference,
              transaction_date, occurred_at, transaction_type, cash_direction,
              amount_paise, description, record_status, created_by_user_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8, $9, $10, 'POSTED', $11)
            RETURNING id`,
            [
              businessId,
              accountId,
              batch.data_source_id,
              row.id,
              row.source_reference,
              row.parsed_transaction_date,
              row.parsed_direction,
              row.parsed_direction,
              row.parsed_amount_paise,
              row.parsed_description || 'Imported statement transaction',
              userId,
            ]
          );

          createdTxIds.push(txRes.rows[0].id);

          // Mark row as ACCEPTED
          await client.query(
            "UPDATE import_rows SET review_status = 'ACCEPTED', updated_at = now() WHERE business_id = $1 AND id = $2",
            [businessId, row.id]
          );
        }
      }

      // Update batch to COMPLETED
      await client.query(
        `UPDATE import_batches
         SET status = 'COMPLETED',
             accepted_count = $1,
             rejected_count = $2,
             updated_at = now()
         WHERE business_id = $3 AND id = $4`,
        [createdTxIds.length, rejectedRowIds.length, businessId, batchId]
      );

      await AuditLogger.log(
        {
          businessId,
          actorUserId: userId,
          action: 'IMPORT_BATCH_CONFIRMED',
          entityName: 'import_batches',
          entityId: batchId,
          requestId,
          metadata: {
            accepted_count: createdTxIds.length,
            rejected_count: rejectedRowIds.length,
          },
        },
        client
      );

      return {
        import_batch_id: batchId,
        status: 'COMPLETED',
        accepted_count: createdTxIds.length,
        rejected_count: rejectedRowIds.length,
        created_transaction_ids: createdTxIds,
      };
    });
  }
}
