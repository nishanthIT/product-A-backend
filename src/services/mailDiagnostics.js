// Never return raw SMTP responses: they can contain addresses, identifiers or
// credentials. Only known diagnostic labels and protocol status codes escape.
export function mailFailureDetails(error) {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,40}$/.test(error.code)
    ? error.code : 'UNKNOWN';
  const response = typeof error?.response === 'string' ? error.response : '';
  const reasons = [
    [/unusual.*(activity|sending)/i, 'UNUSUAL_SENDING_ACTIVITY'],
    [/(outgoing|sending|sender|account).*(block|suspend|disabled)|blocked.*(sender|account)/i, 'SENDING_BLOCKED'],
    [/(limit|quota|too many|exceeded)/i, 'SENDING_LIMIT'],
    [/relay|sender.*(verif|authori)|address.*mismatch/i, 'SENDER_NOT_AUTHORIZED'],
    [/spam|policy|blacklist|reputation/i, 'MAIL_POLICY'],
    [/recipient|mailbox|user unknown|no such user/i, 'RECIPIENT_REJECTED'],
  ].filter(([pattern]) => pattern.test(response)).map(([, label]) => label);
  return {
    code,
    ...(Number.isInteger(error?.httpStatus) && error.httpStatus >= 400 && error.httpStatus <= 599
      ? { httpStatus: error.httpStatus } : {}),
    ...(typeof error?.providerCode === 'string' && /^(EM|TM)_[0-9]{1,8}$/.test(error.providerCode) ? { providerCode: error.providerCode } : {}),
    ...(Number.isInteger(error?.responseCode) && error.responseCode >= 400 && error.responseCode <= 599
      ? { smtpStatus: error.responseCode } : {}),
    ...(['CONN', 'EHLO', 'HELO', 'STARTTLS', 'AUTH PLAIN', 'AUTH LOGIN', 'MAIL FROM', 'RCPT TO', 'DATA', 'API'].includes(error?.command)
      ? { stage: error.command } : {}),
    ...(reasons.length ? { reasons } : {}),
  };
}
