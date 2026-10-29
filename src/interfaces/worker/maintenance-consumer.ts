import type { Job } from 'bullmq';
import type { ApplyRetention, RetentionResult } from '../../application/apply-retention';
import type { SweepPendingEmails, SweepResult } from '../../application/sweep-pending-emails';
import { MAINTENANCE_JOBS } from '../../infrastructure/queue/queue-names';

export type MaintenanceJob = Pick<Job, 'name'>;

export interface MaintenanceUseCases {
  sweepPendingEmails: SweepPendingEmails;
  applyRetention: ApplyRetention;
}

// Los job schedulers de la cola maintenance crean un job por intervalo; el nombre decide la tarea
export function createMaintenanceProcessor(useCases: MaintenanceUseCases) {
  return async (job: MaintenanceJob): Promise<SweepResult | RetentionResult> => {
    switch (job.name) {
      case MAINTENANCE_JOBS.sweepPendingEmails:
        return useCases.sweepPendingEmails.execute();
      case MAINTENANCE_JOBS.applyRetention:
        return useCases.applyRetention.execute();
      default:
        throw new Error(`Unknown maintenance job: ${job.name}`);
    }
  };
}
