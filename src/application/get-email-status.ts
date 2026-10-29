import type { EmailRepository, StoredEmail } from './ports/email-repository';

export interface GetEmailStatusInput {
  clientId: string;
  emailId: string;
}

export class GetEmailStatus {
  constructor(private readonly deps: { emails: EmailRepository }) {}

  // Un mensaje de otro cliente se trata igual que uno inexistente: no se revela que existe
  async execute(input: GetEmailStatusInput): Promise<StoredEmail | null> {
    const email = await this.deps.emails.findById(input.emailId);
    return email?.clientId === input.clientId ? email : null;
  }
}
