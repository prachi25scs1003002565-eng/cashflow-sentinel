import { Response } from 'express';

export interface PaginationMeta {
  page?: number;
  limit?: number;
  page_size: number;
  total_items?: number;
  total_count?: number;
  total_pages?: number;
  next_cursor?: string | null;
}

export class ResponseUtil {
  static sendSuccess<T>(
    res: Response,
    data: T,
    statusCode = 200,
    pagination?: PaginationMeta
  ) {
    const requestId = (res.req as any)?.id || `req_${Date.now()}`;
    const meta: Record<string, any> = {
      request_id: requestId,
    };

    if (pagination) {
      meta.pagination = pagination;
    }

    return res.status(statusCode).json({
      data,
      meta,
    });
  }

  static sendNoContent(res: Response) {
    return res.status(204).send();
  }
}
