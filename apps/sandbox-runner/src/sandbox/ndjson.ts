import { Response } from 'express';

export function writeNdjson(res: Response, obj: Record<string, unknown>) {
  if (!res.writableEnded) {
    res.write(JSON.stringify(obj) + '\n');
  }
}
