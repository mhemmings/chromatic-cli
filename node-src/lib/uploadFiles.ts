import retry from 'async-retry';
import { createReadStream } from 'fs';
import pLimit from 'p-limit';
import progress from 'progress-stream';
import { Context } from '../types';

interface File {
  path: string;
  url: string;
  contentType: string;
  contentLength: number;
}

export default async function uploadFiles(
  ctx: Context,
  files: File[],
  onProgress: (progress: number) => void
) {
  const { experimental_abortSignal: signal } = ctx.options;
  const limitConcurrency = pLimit(10);
  let totalProgress = 0;

  await Promise.all(
    files.map(({ path, url, contentType, contentLength }) => {
      let fileProgress = 0; // The bytes uploaded for this this particular file

      ctx.log.debug(`Uploading ${contentLength} bytes of ${contentType} for '${path}' to '${url}'`);

      return limitConcurrency(() =>
        retry(
          async (bail) => {
            if (signal?.aborted) {
              return bail(signal.reason || new Error('Aborted'));
            }

            const progressStream = progress();

            progressStream.on('progress', ({ delta }) => {
              fileProgress += delta; // We upload multiple files so we only care about the delta
              totalProgress += delta;
              onProgress(totalProgress);
            });

            const res = await ctx.http.fetch(
              url,
              {
                method: 'PUT',
                body: createReadStream(path).pipe(progressStream),
                headers: {
                  'content-type': contentType,
                  'content-length': contentLength.toString(),
                  'cache-control': 'max-age=31536000',
                },
                signal,
              },
              { retries: 0 } // already retrying the whole operation
            );

            if (!res.ok) {
              ctx.log.debug(`Uploading '${path}' failed: %O`, res);
              throw new Error(path);
            }
            ctx.log.debug(`Uploaded '${path}'.`);
          },
          {
            retries: ctx.env.CHROMATIC_RETRIES,
            onRetry: (err: Error) => {
              totalProgress -= fileProgress;
              fileProgress = 0;
              ctx.log.debug('Retrying upload %s, %O', url, err);
              onProgress(totalProgress);
            },
          }
        )
      );
    })
  );
}
