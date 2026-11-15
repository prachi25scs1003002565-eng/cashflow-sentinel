import { Request, Response, NextFunction } from 'express';
import { ImportsService } from './imports.service';
import { ResponseUtil } from '../../utils/response';
import { ValidationError } from '../../utils/errors';
import { z } from 'zod';
import { getUuidPathParam } from '../../utils/request';

const confirmBatchSchema = z.object({
  accepted_row_ids: z.array(z.string().uuid()).default([]),
  duplicate_override_row_ids: z.array(z.string().uuid()).default([]),
  rejected_row_ids: z.array(z.string().uuid()).default([]),
  account_id: z.string().uuid(),
});

export class ImportsController {
  static async upload(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.file) {
        throw new ValidationError('CSV file is required in multipart form data under "file" field.');
      }

      const dataSourceId = req.body.data_source_id;
      if (!dataSourceId) {
        throw new ValidationError('data_source_id is required.');
      }

      let mapping: any = undefined;
      if (req.body.mapping) {
        try {
          mapping = typeof req.body.mapping === 'string' ? JSON.parse(req.body.mapping) : req.body.mapping;
        } catch (e) {
          throw new ValidationError('Invalid JSON in mapping field.');
        }
      }

      const result = await ImportsService.processCsvUpload(
        req.business!.id,
        req.user!.id,
        dataSourceId,
        req.file.buffer,
        req.file.originalname,
        mapping,
        req.id
      );

      return ResponseUtil.sendSuccess(res, result, 201);
    } catch (err) {
      return next(err);
    }
  }

  static async getBatch(req: Request, res: Response, next: NextFunction) {
    try {
      const batch = await ImportsService.getBatch(req.business!.id, getUuidPathParam(req, 'importBatchId'));
      return ResponseUtil.sendSuccess(res, batch, 200);
    } catch (err) {
      return next(err);
    }
  }

  static async getRows(req: Request, res: Response, next: NextFunction) {
    try {
      const status = req.query.review_status as string | undefined;
      const rows = await ImportsService.getBatchRows(req.business!.id, getUuidPathParam(req, 'importBatchId'), status);
      return ResponseUtil.sendSuccess(res, rows, 200);
    } catch (err) {
      return next(err);
    }
  }

  static async confirm(req: Request, res: Response, next: NextFunction) {
    try {
      const validated = confirmBatchSchema.parse(req.body);
      const result = await ImportsService.confirmBatch(
        req.business!.id,
        getUuidPathParam(req, 'importBatchId'),
        req.user!.id,
        validated.accepted_row_ids,
        validated.duplicate_override_row_ids,
        validated.rejected_row_ids,
        validated.account_id,
        req.id
      );
      return ResponseUtil.sendSuccess(res, result, 200);
    } catch (err) {
      return next(err);
    }
  }
}
