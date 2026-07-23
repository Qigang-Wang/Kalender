export interface ReplyMailbox {
  readonly address: string;
  readonly name?: string;
}

export interface ReplyRecipientInput {
  readonly senderAddress: string;
  readonly to: readonly ReplyMailbox[];
  readonly cc: readonly ReplyMailbox[];
  readonly selfAddresses: readonly string[];
}

export interface ReplyRecipients {
  readonly to: readonly string[];
  readonly cc: readonly string[];
}

function normalizedAddress(address: string): string {
  return address.trim().toLocaleLowerCase();
}

export function resolveReplyRecipients(input: ReplyRecipientInput): ReplyRecipients {
  const self = new Set(input.selfAddresses.map(normalizedAddress).filter(Boolean));
  const seen = new Set<string>();
  const to: string[] = [];
  const cc: string[] = [];

  const append = (target: string[], address: string) => {
    const normalized = normalizedAddress(address);
    if (!normalized || !normalized.includes("@") || self.has(normalized) || seen.has(normalized)) return;
    seen.add(normalized);
    target.push(address.trim());
  };

  append(to, input.senderAddress);
  input.to.forEach((mailbox) => append(to, mailbox.address));
  input.cc.forEach((mailbox) => append(cc, mailbox.address));

  return { to, cc };
}
