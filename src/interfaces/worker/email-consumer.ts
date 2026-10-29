import { UnrecoverableError, type Job } from 'bullmq';
import type { ProcessEmailJob } from '../../application/process-email-job';
import { EmailRequestRejectedError, PermanentProviderError } from '../../domain/errors';
import type { EmailJobData } from '../../infrastructure/queue/queue-names';

export type EmailJob = Pick<Job<EmailJobData>, 'data' | 'attemptsMade' | 'opts'>;

// Traduce entre BullMQ y el caso de uso: attemptsMade cuenta los intentos fallidos (0 en el
// primero) y los errores que no deben reintentarse pasan a UnrecoverableError
export function createEmailProcessor(processEmailJob: ProcessEmailJob) {
  return async (job: EmailJob): Promise<void> => {
    try {
      await processEmailJob.execute({
        messageId: job.data.messageId,
        attempt: job.attemptsMade + 1,
        // BullMQ deja attempts a 0 si no se configuró: equivale a un único intento
        maxAttempts: Math.max(job.opts.attempts ?? 1, 1),
      });
    } catch (error) {
      if (error instanceof PermanentProviderError || error instanceof EmailRequestRejectedError) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  };
}
