import { Response } from 'express';

export interface PaginationMeta {
  next_cursor: string | null;
  page_size: number;
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
